import type { ExceptionKind } from "./exceptionRules.js";
import { argmax, predict, type Network } from "./neuralNetwork.js";

/**
 * Suggests why an exception can be cleared, from the evidence on the errand.
 *
 * The network picks one of a fixed set of reasons, and the reason's template is
 * filled with this errand's own figures. It never writes free text, so it can
 * never invent a number that is not on the errand, and every answer it gives is
 * one a dispatcher has a template for.
 *
 * Pure: no database. The service turns an errand row into a ReasonContext;
 * everything from there (encoding, the network, the threshold, the wording)
 * lives here, so the training script and the live API share one encoder and
 * cannot drift apart. A model trained on one feature layout and served another
 * would still answer, confidently and wrongly, which is why the shipped model
 * records the feature names it was trained on and is refused when they differ.
 */

/**
 * Below this the model says nothing.
 *
 * A suggested reason ends up as the audit record for money held against a
 * customer. A guess that is right two times in three would be worse than no
 * suggestion, because a busy dispatcher accepts what is put in the box.
 */
export const CONFIDENCE_THRESHOLD = 0.65;

/**
 * Everything the model may know about one exception, in plain fields.
 *
 * Flat and human-readable on purpose: the training set is a CSV of exactly these
 * columns, so anyone can open it and see what a row claims.
 */
export interface ReasonContext {
  kind: ExceptionKind;
  /** As the queue shows it. Zero for conduct kinds. */
  amountAtRisk: number;
  /** errand.totalCost: goods plus fees. */
  billTotal: number;
  /** errand.estimatedCost: goods only. */
  basket: number;
  plan: "COD" | "DOWNPAYMENT" | "OTHER";
  /** Which way the settled cash missed, when it did. */
  cashDirection: "SHORT" | "OVER" | "NONE";
  /** What the rider typed when settling short. Empty when nothing. */
  riderNote: string;
  receiptPhotos: number;
  noReceiptPhotos: number;
  hasCashPhoto: boolean;
  hasDeliveryPhoto: boolean;
  /**
   * The customer's own GCash/Maya screenshots, replaced ones left out. A
   * count, not a flag: on a downpayment errand the upfront payment is always
   * one, so only a second one says the customer paid something more.
   */
  transferProofs: number;
  /** The rider's photo of the customer's balance transfer, taken at the door. */
  hasRiderBalanceProof: boolean;
  /** The settlement matched to the peso. */
  settledInFull: boolean;
  /** Net of refunds, from the payment ledger. */
  paidUpFront: number;
  /** For a receipt divergence: what the machine read. Zero otherwise. */
  scannedTotal: number;
  /** For a receipt divergence: what the rider confirmed. Zero otherwise. */
  confirmedTotal: number;
  /** The pinned stop this exception is about. Empty when it is not about one. */
  storeName: string;
  /** Where the rider actually settled, for a wrong-branch visit. */
  observedName: string;
  itemsAtStop: number;
  /** Purchase proofs across the errand, as a share of the goods basket. */
  receiptsCoverBasket: number;
  dwellMinutes: number;
}

export const EXCEPTION_KIND_ORDER: readonly ExceptionKind[] = [
  "CASH_VARIANCE",
  "RECEIPT_DIVERGENCE",
  "UNVERIFIED_PURCHASE",
  "WRONG_BRANCH",
  "MISSING_RECEIPT",
  "STALLED_STOP",
  "OVERAGE_PENDING",
  "UNPAID_BALANCE",
];

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const flag = (b: boolean) => (b ? 1 : 0);

// Word lists, matched case-insensitively. Riders type Taglish, so the notes
// lists carry both.
const NOTE_CHANGE = /\b(change|sukli|barya|panukli|exact)\b/i;
const NOTE_TRANSFER = /\b(gcash|g-cash|maya|paymaya|transfer|bank|online)\b/i;
const NOTE_TIP = /\b(tip|keep the change)\b/i;
// Word-bounded where it matters: an unbounded "market" read KCC Supermarket as
// a market stall.
const SMALL_SHOP =
  /sari[\s-]?sari|\bmarket\b|\bstall\b|talipapa|bakeshop|bakery|panaderia|carinderia|tindahan|kiosk|\bvariety\b/i;
const COOKS_TO_ORDER =
  /jollibee|mcdo|mcdonald|chowking|inasal|kfc|greenwich|lechon|grill|carinderia|restaurant|resto|kitchen|eatery|pizza|burger|shawarma|milk\s?tea|cafe|coffee/i;

/** First word of a shop name, for spotting two branches of one chain. */
function chainOf(name: string): string {
  return name.trim().toLowerCase().split(/[\s,]+/)[0] ?? "";
}

export const FEATURE_NAMES: readonly string[] = [
  ...EXCEPTION_KIND_ORDER.map((k) => `kind:${k}`),
  "amount_log",
  "amount_share_of_bill",
  "plan_downpayment",
  "plan_other",
  "cash_short",
  "cash_over",
  "note_mentions_change",
  "note_mentions_transfer",
  "note_mentions_tip",
  "note_empty",
  "receipt_photos",
  "no_receipt_photos",
  "has_cash_photo",
  "has_delivery_photo",
  "transfer_proofs",
  "has_rider_balance_proof",
  "settled_in_full",
  "paid_fraction",
  "divergence_ratio",
  "confirmed_above_scan",
  "decimal_slip",
  "store_is_small_shop",
  "store_cooks_to_order",
  "same_chain_as_pinned",
  "observed_place_unknown",
  "items_at_stop",
  "receipts_cover_basket",
  "dwell_log",
];

/**
 * One exception as the network's input: 36 numbers, each roughly in [0, 1].
 *
 * Scaled rather than raw, because a ₱900 bill and a yes/no flag entering the
 * same weighted sum would let the peso figure drown out everything else.
 */
export function encodeReasonContext(c: ReasonContext): number[] {
  const kind = EXCEPTION_KIND_ORDER.map((k) => flag(c.kind === k));
  const note = c.riderNote.trim();
  const divergent = c.scannedTotal > 0 && c.confirmedTotal > 0;
  const ratio = divergent ? Math.abs(c.confirmedTotal - c.scannedTotal) / c.scannedTotal : 0;
  // A misplaced decimal point reads ₱185.00 as ₱18.50 or ₱1,850: off by a
  // clean power of ten, which is a scanner fault, not a pricing dispute.
  const orders = divergent ? Math.abs(Math.log10(c.confirmedTotal / c.scannedTotal)) : 0;
  const decimalSlip = divergent && (Math.abs(orders - 1) < 0.08 || Math.abs(orders - 2) < 0.08);
  const store = c.storeName;
  const observed = c.observedName.trim();

  const features = [
    ...kind,
    clamp(Math.log1p(Math.max(0, c.amountAtRisk)) / Math.log1p(1000), 0, 1.5),
    clamp(c.amountAtRisk / Math.max(c.billTotal, 1), 0, 2),
    flag(c.plan === "DOWNPAYMENT"),
    flag(c.plan === "OTHER"),
    flag(c.cashDirection === "SHORT"),
    flag(c.cashDirection === "OVER"),
    flag(NOTE_CHANGE.test(note)),
    flag(NOTE_TRANSFER.test(note)),
    flag(NOTE_TIP.test(note)),
    flag(note.length === 0),
    Math.min(c.receiptPhotos, 4) / 4,
    Math.min(c.noReceiptPhotos, 4) / 4,
    flag(c.hasCashPhoto),
    flag(c.hasDeliveryPhoto),
    Math.min(c.transferProofs, 3) / 3,
    flag(c.hasRiderBalanceProof),
    flag(c.settledInFull),
    clamp(c.paidUpFront / Math.max(c.billTotal, 1), 0, 1.5),
    clamp(ratio, 0, 3) / 3,
    flag(divergent && c.confirmedTotal > c.scannedTotal),
    flag(decimalSlip),
    flag(SMALL_SHOP.test(store)),
    flag(COOKS_TO_ORDER.test(store)),
    flag(observed.length > 0 && chainOf(observed) === chainOf(store) && chainOf(store).length > 0),
    flag(observed.length === 0),
    Math.min(c.itemsAtStop, 20) / 20,
    clamp(c.receiptsCoverBasket, 0, 1.5),
    c.dwellMinutes > 0 ? clamp(Math.log1p(c.dwellMinutes) / Math.log1p(120), 0, 1.5) : 0,
  ];

  if (features.length !== FEATURE_NAMES.length) {
    throw new Error(`Encoder produced ${features.length} features for ${FEATURE_NAMES.length} names.`);
  }
  return features;
}

/** ₱57, ₱18.50, ₱1,850: whole pesos without decimals, anything else with two. */
const peso = (n: number) => {
  const v = Math.round(Math.abs(n) * 100) / 100;
  const places = Number.isInteger(v) ? 0 : 2;
  return `₱${v.toLocaleString("en-PH", { minimumFractionDigits: places, maximumFractionDigits: places })}`;
};

/** "Julie's Bakeshop Mabini-Dona Alicia, Poblacion, Tacurong" -> up to the first comma. */
const shop = (name: string, fallback: string) => name.split(",")[0].trim() || fallback;

const minutes = (c: ReasonContext) => `${Math.round(c.dwellMinutes)} min`;

export interface ReasonClass {
  code: string;
  kind: ExceptionKind;
  write: (c: ReasonContext) => string;
}

/**
 * The reasons the model can choose between, in output order.
 *
 * Order is part of the trained model: appending is a retrain, reordering or
 * removing is a retrain AND a code change the model check below will catch.
 */
export const REASONS: readonly ReasonClass[] = [
  // ── cash back against what was owed ─────────────────────────────────────
  {
    code: "CASH_NO_EXACT_CHANGE",
    kind: "CASH_VARIANCE",
    write: (c) =>
      `Short by ${peso(c.amountAtRisk)} because the customer had no exact change at the door. Small enough to write off.`,
  },
  {
    code: "CASH_PAID_BY_TRANSFER",
    kind: "CASH_VARIANCE",
    write: (c) =>
      `The customer sent the ${peso(c.amountAtRisk)} difference by GCash or Maya instead of paying it in cash.`,
  },
  {
    code: "CASH_RIDER_TO_REMIT",
    kind: "CASH_VARIANCE",
    write: (c) =>
      `The rider came back ${peso(c.amountAtRisk)} short and will remit it. To be deducted from the rider's next payout.`,
  },
  {
    code: "CASH_OVER_TIP",
    kind: "CASH_VARIANCE",
    write: (c) =>
      `The customer paid ${peso(c.amountAtRisk)} over the bill and told the rider to keep it as a tip.`,
  },
  {
    code: "CASH_OVER_TO_RETURN",
    kind: "CASH_VARIANCE",
    write: (c) =>
      `The rider collected ${peso(c.amountAtRisk)} more than the bill. The excess goes back to the customer.`,
  },
  // ── the rider's figure against the machine's ────────────────────────────
  {
    code: "RECEIPT_SCAN_MISREAD",
    kind: "RECEIPT_DIVERGENCE",
    write: (c) =>
      `The scanner misread the receipt as ${peso(c.scannedTotal)}. The photo shows ${peso(c.confirmedTotal)}, the figure the rider confirmed.`,
  },
  {
    code: "RECEIPT_PARTLY_READ",
    kind: "RECEIPT_DIVERGENCE",
    write: (c) =>
      `The receipt photo was cut off, so the scan caught only ${peso(c.scannedTotal)}. The full receipt comes to the ${peso(c.confirmedTotal)} the rider confirmed.`,
  },
  {
    code: "RECEIPT_DISCOUNT_APPLIED",
    kind: "RECEIPT_DIVERGENCE",
    write: (c) =>
      `The store took a discount off the ${peso(c.scannedTotal)} subtotal. The rider paid the discounted ${peso(c.confirmedTotal)}.`,
  },
  // ── a purchase nothing corroborates ─────────────────────────────────────
  {
    code: "UNVERIFIED_SMALL_SHOP",
    kind: "UNVERIFIED_PURCHASE",
    write: (c) =>
      `${shop(c.storeName, "The shop")} is a small shop that prints no receipt. The ${peso(c.amountAtRisk)} fits the items bought, and the photo of the goods is on the errand.` +
      // A fact from the settlement, not a guess: stated only when it is on the errand.
      (c.settledInFull ? " The customer paid the full bill, this included." : ""),
  },
  {
    code: "UNVERIFIED_PAID_IN_FULL",
    kind: "UNVERIFIED_PURCHASE",
    write: (c) =>
      `The customer received the goods and paid the full bill, which included this ${peso(c.amountAtRisk)}. Nothing is disputed.`,
  },
  {
    code: "UNVERIFIED_RECEIPT_LOST",
    kind: "UNVERIFIED_PURCHASE",
    write: (c) =>
      `The rider lost the receipt from ${shop(c.storeName, "the shop")}. The ${peso(c.amountAtRisk)} matches what that shop charges for these items.`,
  },
  // ── settled at a different branch than the one pinned ───────────────────
  {
    code: "BRANCH_SAME_CHAIN",
    kind: "WRONG_BRANCH",
    write: (c) =>
      `${shop(c.observedName, "The shop visited")} is another branch of the same chain as ${shop(c.storeName, "the pinned shop")}. Same items at the same prices, so the switch cost the customer nothing.`,
  },
  {
    code: "BRANCH_PINNED_UNAVAILABLE",
    kind: "WRONG_BRANCH",
    write: (c) =>
      `${shop(c.storeName, "The pinned shop")} was closed or out of stock, so the rider bought at ${shop(c.observedName, "another shop")} instead.`,
  },
  // ── a stop with items and nothing to show for it ────────────────────────
  {
    code: "MISSING_ITEMS_UNAVAILABLE",
    kind: "MISSING_RECEIPT",
    write: (c) =>
      `The items at ${shop(c.storeName, "this stop")} were not available, so nothing was bought there and there is no receipt.`,
  },
  {
    code: "MISSING_ON_OTHER_RECEIPT",
    kind: "MISSING_RECEIPT",
    write: (c) =>
      `The items for ${shop(c.storeName, "this stop")} were bought at another stop and are on that stop's receipt.`,
  },
  // ── far longer inside a shop than that kind of shop takes ───────────────
  {
    code: "STALL_COOKED_TO_ORDER",
    kind: "STALLED_STOP",
    write: (c) =>
      `${shop(c.storeName, "The shop")} cooks orders on the spot, so the ${minutes(c)} stop was the wait for the food.`,
  },
  {
    code: "STALL_LONG_QUEUE",
    kind: "STALLED_STOP",
    write: (c) =>
      `Long queue at ${shop(c.storeName, "the shop")}. The rider waited ${minutes(c)} to be served.`,
  },
  {
    code: "STALL_LARGE_ORDER",
    kind: "STALLED_STOP",
    write: (c) =>
      `Large order at ${shop(c.storeName, "the shop")}, ${c.itemsAtStop} items to pick. The ${minutes(c)} went into shopping.`,
  },
  // ── goods held for an overage nobody has arranged ───────────────────────
  {
    code: "OVERAGE_CUSTOMER_AGREED",
    kind: "OVERAGE_PENDING",
    write: (c) => `Called the customer. They agreed to pay the extra ${peso(c.amountAtRisk)} on delivery.`,
  },
  {
    code: "OVERAGE_TOPUP_PAID",
    kind: "OVERAGE_PENDING",
    write: (c) =>
      `The customer paid the ${peso(c.amountAtRisk)} top-up. The transfer screenshot is on the errand.`,
  },
  {
    code: "OVERAGE_ITEMS_REMOVED",
    kind: "OVERAGE_PENDING",
    write: () =>
      `Called the customer. Items were taken off the order to bring it back within the agreed budget.`,
  },
  // ── delivered, and the money never came ─────────────────────────────────
  {
    code: "BALANCE_CASH_AT_DOOR",
    kind: "UNPAID_BALANCE",
    write: (c) =>
      `The customer paid the ${peso(c.amountAtRisk)} balance in cash at the door. The cash photo is on the errand.`,
  },
  {
    code: "BALANCE_TRANSFER_UNRECORDED",
    kind: "UNPAID_BALANCE",
    write: (c) =>
      `The customer paid the ${peso(c.amountAtRisk)} balance by GCash or Maya. The transfer went through but was never recorded against the errand.`,
  },
  {
    code: "BALANCE_COLLECT_LATER",
    kind: "UNPAID_BALANCE",
    write: (c) => `The customer will settle the ${peso(c.amountAtRisk)} balance later. A follow-up is agreed with them.`,
  },
];

export const REASON_CODES: readonly string[] = REASONS.map((r) => r.code);

/** Which outputs a given kind may take. The network's softmax runs over these only. */
export function maskForKind(kind: ExceptionKind): boolean[] {
  return REASONS.map((r) => r.kind === kind);
}

/** A trained network plus what it was trained against. */
export interface TrainedReasonModel {
  version: string;
  trainedAt: string;
  featureNames: readonly string[];
  classes: readonly string[];
  network: Network;
  metrics: {
    trainingRows: number;
    testRows: number;
    testAccuracy: number;
    /** Share of test rows at or above the threshold. */
    coverageAtThreshold: number;
    /** Accuracy on just those rows: how often a suggestion that is shown is right. */
    accuracyWhenConfident: number;
  };
}

/**
 * Whether a model can be served by THIS code. A model trained before a feature
 * was added or a reason reordered would still produce an answer, confidently
 * and wrongly, so it is refused instead.
 */
export function isModelCompatible(model: TrainedReasonModel): boolean {
  return (
    model.featureNames.length === FEATURE_NAMES.length &&
    model.featureNames.every((name, i) => name === FEATURE_NAMES[i]) &&
    model.classes.length === REASON_CODES.length &&
    model.classes.every((code, i) => code === REASON_CODES[i]) &&
    model.network.output === "softmax" &&
    model.network.layers.length > 0 &&
    model.network.layers[0].inputSize === FEATURE_NAMES.length &&
    model.network.layers[model.network.layers.length - 1].outputSize === REASON_CODES.length
  );
}

// ── a second opinion: Gemini, then Gemma, through the category service ─────

/**
 * What the second opinion is asked about one exception (POST /advise on the
 * category service, which holds the Gemini key): the question, the errand's
 * figures as sentences, the rider's own words, and this kind's reasons.
 *
 * The options are the same templates the network's answer is written from,
 * filled with this errand's figures. Whichever model chooses, the text that
 * reaches the reason box is one a dispatcher has a template for, and every
 * figure in it is the errand's own: a large model choosing never writes.
 */
export interface AdviceRequest {
  question: string;
  facts: string[];
  note: string;
  options: Array<{ code: string; text: string }>;
}

/** The second opinion's answer, as the category service returned it. */
export interface SecondOpinion {
  /** A reason of this exception's kind, or null: none of them fits the evidence. */
  reasonCode: string | null;
  confidence: number;
  /** The model that answered, e.g. "gemini-3.8-flash". */
  model: string;
  /** Its name for a sentence, e.g. "Gemini 3.8 Flash". */
  label: string;
}

/**
 * The second opinion's share of the pooled probabilities, in two cases,
 * chosen on validation rows (ml/exception-reasons/GEMINI.md,
 * scripts/exception-reasons/secondOpinion.ts).
 *
 * The network reads a rider's note only through its three word lists. A note
 * none of them catches ("wala sinsilyo si customer", "remit ko ugma") is
 * unread: the network's pick there comes from the figures alone and ignores
 * the one thing the rider said. There the model that read the note decides
 * (0.8): on the test rows the network was right 4 times and wrong 4, pooled
 * 9 and 0.
 *
 * Everywhere else the network has seen what the model has, and any weight on
 * the model cost right suggestions on validation (0.3 lost 18 of 84) for no
 * fewer wrong ones: where the evidence is only suggestive, the model rightly
 * hedges and the pooled pick drops under 0.75. So 0, and the service does not
 * ask at all (exceptionReasonService.askSecondOpinion is skipped).
 */
export const SECOND_OPINION_WEIGHT = 0;
export const SECOND_OPINION_WEIGHT_UNREAD_NOTE = 0.8;
export const SECOND_OPINION_WEIGHT_LOW_CONFIDENCE = 0.65;

/** A note is there, and none of the network's word lists catches it. */
export function noteUnread(c: ReasonContext): boolean {
  const note = c.riderNote.trim();
  return note.length > 0 && !NOTE_CHANGE.test(note) && !NOTE_TRANSFER.test(note) && !NOTE_TIP.test(note);
}

/**
 * The weight suggestReason uses for this exception when none is given.
 *
 * Consults Gemini 3.8 Flash (via the sidecar) whenever:
 * 1. The rider wrote a note that the fixed regex lists cannot read (0.80 weight).
 * 2. The rider wrote any custom note or the local network is uncertain (< 0.75, 0.65 weight).
 */
export function secondOpinionWeight(c: ReasonContext, localConfidence?: number): number {
  if (noteUnread(c)) return SECOND_OPINION_WEIGHT_UNREAD_NOTE;
  if (c.riderNote.trim().length > 0) return SECOND_OPINION_WEIGHT_LOW_CONFIDENCE;
  if (typeof localConfidence === "number" && localConfidence < 0.75) return SECOND_OPINION_WEIGHT_LOW_CONFIDENCE;
  return SECOND_OPINION_WEIGHT;
}

const QUESTION: Record<ExceptionKind, (c: ReasonContext) => string> = {
  CASH_VARIANCE: (c) => `The cash the rider handed over differs from the errand's total by ${peso(c.amountAtRisk)}.`,
  RECEIPT_DIVERGENCE: () => "The receipt total the rider confirmed is far from what the receipt scanner read.",
  UNVERIFIED_PURCHASE: (c) =>
    `A ${peso(c.amountAtRisk)} purchase at ${shop(c.storeName, "a shop")} has no receipt behind it, only the rider's word.`,
  WRONG_BRANCH: (c) => `The rider settled at a different place than the pinned ${shop(c.storeName, "shop")}.`,
  MISSING_RECEIPT: (c) =>
    `The stop at ${shop(c.storeName, "a shop")} has items but no receipt or photo of any kind behind it.`,
  STALLED_STOP: (c) =>
    `The rider stayed ${minutes(c)} at ${shop(c.storeName, "a shop")}, far longer than that kind of shop usually takes.`,
  OVERAGE_PENDING: (c) =>
    `The receipt came to ${peso(c.amountAtRisk)} more than the customer agreed to, and nobody has arranged the difference yet.`,
  UNPAID_BALANCE: (c) =>
    `The errand was delivered on the downpayment plan, but the ${peso(c.amountAtRisk)} balance is not recorded as collected.`,
};

const PLAN: Record<ReasonContext["plan"], string> = {
  COD: "cash on delivery",
  DOWNPAYMENT: "a downpayment up front, the balance on delivery",
  OTHER: "paid online",
};

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One exception as the second opinion reads it. Pure, like everything here. */
export function adviceRequest(c: ReasonContext): AdviceRequest {
  const facts = [
    `Bill: ${peso(c.billTotal)} in all, ${peso(c.basket)} of it goods.`,
    `Payment plan: ${PLAN[c.plan]}.`,
  ];
  if (c.paidUpFront > 0) facts.push(`Paid up front: ${peso(c.paidUpFront)}.`);
  if (c.settledInFull) facts.push("The rider's cash settlement matched the bill to the peso.");
  else if (c.cashDirection !== "NONE") {
    facts.push(`The rider's cash settlement came back ${c.cashDirection === "SHORT" ? "short" : "over"}.`);
  }
  facts.push(
    `Photos on the errand: ${count(c.receiptPhotos, "receipt")}, ${count(c.noReceiptPhotos, "photo")} of goods ` +
      `bought without a receipt, ${c.hasCashPhoto ? "a" : "no"} photo of the cash collected, ` +
      `${c.hasDeliveryPhoto ? "a" : "no"} proof-of-delivery photo.`
  );
  if (c.transferProofs > 0) {
    facts.push(`GCash or Maya screenshots from the customer: ${c.transferProofs}.`);
  }
  if (c.hasRiderBalanceProof) facts.push("The rider photographed the customer's balance transfer at the door.");
  if (c.kind === "RECEIPT_DIVERGENCE") {
    facts.push(`The scanner read ${peso(c.scannedTotal)}; the rider confirmed ${peso(c.confirmedTotal)}.`);
  }
  if (c.storeName) facts.push(`The stop: ${c.storeName}, ${count(c.itemsAtStop, "item")}.`);
  if (c.observedName) facts.push(`Where the rider actually settled: ${c.observedName}.`);
  facts.push(`Receipts and receiptless purchases add up to ${Math.round(c.receiptsCoverBasket * 100)}% of the goods.`);
  if (c.dwellMinutes > 0) facts.push(`Time at the stop: ${minutes(c)}.`);

  return {
    question: QUESTION[c.kind](c),
    facts,
    note: c.riderNote.trim(),
    options: REASONS.filter((r) => r.kind === c.kind).map((r) => ({ code: r.code, text: r.write(c) })),
  };
}

/**
 * A linear opinion pool: (1 - w) * ours + w * theirs, over this kind's reasons.
 *
 * Theirs is one answer and a confidence, spread into a distribution: the
 * confidence on its reason, the rest shared in proportion to ours. "None of
 * them fits" puts its confidence on no reason at all, so every reason loses
 * mass and a sure "none" pulls the network's pick under the 0.75 line: the
 * one real case the network gets confidently wrong (a customer paying a
 * balance in cash, which no cash reason describes) is the case it exists for.
 * An answer naming another kind's reason is ignored.
 */
export function poolWithSecondOpinion(
  probs: readonly number[],
  allowed: readonly boolean[],
  opinion: SecondOpinion,
  weight = SECOND_OPINION_WEIGHT
): number[] {
  const index = opinion.reasonCode === null ? -1 : REASON_CODES.indexOf(opinion.reasonCode);
  if (opinion.reasonCode !== null && (index < 0 || !allowed[index])) return [...probs];
  const sure = clamp(opinion.confidence, 0, 1);
  const w = clamp(weight, 0, 1);
  const others = probs.reduce((sum, p, i) => (allowed[i] && i !== index ? sum + p : sum), 0);
  const otherCount = allowed.filter((a, i) => a && i !== index).length;
  return probs.map((p, i) => {
    if (!allowed[i]) return 0;
    const theirs = i === index ? sure : (1 - sure) * (others > 0 ? p / others : 1 / Math.max(otherCount, 1));
    return (1 - w) * p + w * theirs;
  });
}

export interface ReasonSuggestion {
  /** True only at or above CONFIDENCE_THRESHOLD. */
  confident: boolean;
  /** The probability for the best reason, 0 to 1: pooled when a second opinion was. */
  confidence: number;
  threshold: number;
  /** Null when not confident: below the threshold nothing is suggested. */
  reasonCode: string | null;
  suggestion: string | null;
  modelVersion: string;
  /** "model" for the network alone; "model+gemini" or "model+gemma" with a second opinion pooled in. */
  source: string;
  /** The network's own probability for its best reason, before any pooling. */
  localConfidence: number;
  /** What the second opinion said, or null when there was none (no key, service down). */
  secondOpinion: SecondOpinion | null;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function suggestReason(
  model: TrainedReasonModel,
  context: ReasonContext,
  opinion: SecondOpinion | null = null,
  weight = secondOpinionWeight(context)
): ReasonSuggestion {
  if (!isModelCompatible(model)) {
    throw new Error("The reason model was trained for a different feature layout. Retrain it.");
  }

  const allowed = maskForKind(context.kind);
  const local = predict(model.network, encodeReasonContext(context), allowed);
  const probs = opinion ? poolWithSecondOpinion(local, allowed, opinion, weight) : local;
  const best = argmax(probs);
  const confidence = round3(probs[best]);
  const confident = probs[best] >= CONFIDENCE_THRESHOLD;
  const family = opinion ? (/^(gemini|gemma)/.exec(opinion.model)?.[1] ?? "llm") : null;

  return {
    confident,
    confidence,
    threshold: CONFIDENCE_THRESHOLD,
    reasonCode: confident ? REASONS[best].code : null,
    suggestion: confident ? REASONS[best].write(context) : null,
    modelVersion: model.version,
    source: family ? `model+${family}` : "model",
    localConfidence: round3(local[argmax(local)]),
    secondOpinion: opinion ? { ...opinion, confidence: round3(opinion.confidence) } : null,
  };
}
