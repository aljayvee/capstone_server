/**
 * Writes ml/exception-reasons/dataset.csv: labelled examples of why a
 * Conflict Management exception gets cleared.
 *
 *   npx tsx scripts/exception-reasons/generateDataset.ts
 *
 * WHY THE ROWS ARE GENERATED. On 2026-09-24 production held 4 cleared
 * exceptions across 17 errands. A network cannot learn 24 reasons from 4
 * examples, so this writes scenario rows instead: for each reason, the evidence
 * an errand cleared for that reason typically carries (a sari-sari store, a
 * short settlement with "walang barya" in the note, a second GCash screenshot).
 *
 * The data is deliberately NOT clean. Real reasons overlap: a ₱40 shortfall
 * with no note could be missing change or a rider who will pay it back, and
 * nothing on the errand says which. Those regions get rows under both labels,
 * plus a few percent of labels flipped to a sibling reason, so the network
 * learns to be unsure exactly where a person would be. That is what makes its
 * confidence mean something, and the 0.75 threshold worth having.
 *
 * Seeded, so running it twice writes the same file.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { seededRandom } from "../../src/services/patterns/neuralNetwork.js";
import { REASONS, type ReasonContext } from "../../src/services/patterns/exceptionReasonModel.js";
import type { ExceptionKind } from "../../src/services/patterns/exceptionRules.js";
import { toCsv, type LabelledRow } from "./dataset.js";

const ROWS_PER_REASON = 90;
const LABEL_NOISE = 0.03;
const SEED = 20260924;

const rand = seededRandom(SEED);
const between = (a: number, b: number) => a + (b - a) * rand();
const int = (a: number, b: number) => Math.floor(between(a, b + 1));
const chance = (p: number) => rand() < p;
const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)];
const pesos = (n: number) => Math.round(n);
const cents = (n: number) => Math.round(n * 100) / 100;

// ── shops around Tacurong, by what they are like to buy from ───────────────
const SMALL_SHOPS = [
  "Aling Nena Sari-Sari Store",
  "Tacurong Public Market Stall 14",
  "Mang Ben Tindahan",
  "Julie's Bakeshop Poblacion",
  "Kusina ni Lola Carinderia",
  "Rosa Variety Store",
  "Talipapa sa Kanto",
  "Panaderia de Tacurong",
  "Lito's Fruit Stall",
  "Tacurong Fish Market",
];
const CHAINS: Record<string, readonly string[]> = {
  Jollibee: ["Jollibee Tacurong", "Jollibee Mabini", "Jollibee KCC"],
  "Mercury Drug": ["Mercury Drug Tacurong", "Mercury Drug Alunan", "Mercury Drug Poblacion"],
  "7-Eleven": ["7-Eleven Alunan", "7-Eleven Bonifacio", "7-Eleven National Highway"],
  "Mang Inasal": ["Mang Inasal Tacurong", "Mang Inasal KCC"],
  Chowking: ["Chowking Tacurong", "Chowking Alunan"],
  Watsons: ["Watsons Tacurong", "Watsons KCC"],
  Puregold: ["Puregold Tacurong", "Puregold Isulan"],
};
const COOKED_TO_ORDER = [
  "Jollibee Tacurong",
  "Mang Inasal Tacurong",
  "Chowking Alunan",
  "Lechon Manok ni Kuya",
  "Greenwich Tacurong",
  "Kusina ni Lola Carinderia",
  "Shawarma Bros Tacurong",
  "Milk Tea Station Tacurong",
];
const BIG_STORES = [
  "Puregold Tacurong",
  "Gaisano Grand Tacurong",
  "Savemore Tacurong",
  "KCC Supermarket Tacurong",
  "Mercury Drug Tacurong",
  "7-Eleven Alunan",
  "Watsons Tacurong",
];
const CHAIN_BRANCHES = Object.values(CHAINS).flat();
const NOT_SMALL = [...new Set([...CHAIN_BRANCHES, ...BIG_STORES])];
const ANY_SHOP = [...new Set([...SMALL_SHOPS, ...NOT_SMALL, ...COOKED_TO_ORDER])];

// ── what riders type when they settle short or over ─────────────────────────
const NOTES_CHANGE = [
  "walang barya si customer",
  "no exact change",
  "kulang ang sukli",
  "customer had no change",
  "wala syang panukli",
];
const NOTES_TRANSFER = [
  "nag gcash si customer",
  "paid the rest via gcash",
  "customer sent it by maya",
  "bank transfer daw",
  "online payment na lang",
];
const NOTES_TIP = ["tip daw sabi ni customer", "keep the change daw", "customer gave a tip"];
const NOTES_REMIT = [
  "kulang ang pera ko",
  "I will pay tomorrow",
  "nawala ang 100",
  "short, babayaran ko",
  "ako na bahala",
];
const NOTES_OTHER = ["late na", "customer not home at first", "traffic", "ok na"];

/** An ordinary errand, before the scenario says what went wrong with it. */
function baseErrand(kind: ExceptionKind): ReasonContext {
  const basket = pesos(between(80, 1200));
  const billTotal = basket + pesos(between(50, 130));
  const roll = rand();
  const plan = roll < 0.7 ? "COD" : roll < 0.95 ? "DOWNPAYMENT" : "OTHER";

  return {
    kind,
    amountAtRisk: 0,
    billTotal,
    basket,
    plan,
    cashDirection: "NONE",
    riderNote: "",
    receiptPhotos: int(0, 3),
    noReceiptPhotos: chance(0.2) ? 1 : 0,
    hasCashPhoto: plan === "COD" && chance(0.8),
    hasDeliveryPhoto: chance(0.9),
    // The upfront payment's screenshot, on every plan that takes one.
    transferProofs: plan === "COD" ? 0 : chance(0.9) ? 1 : 0,
    hasRiderBalanceProof: false,
    settledInFull: plan === "COD" && chance(0.7),
    paidUpFront: plan === "DOWNPAYMENT" ? pesos(billTotal / 2) : plan === "OTHER" && chance(0.5) ? billTotal : 0,
    scannedTotal: 0,
    confirmedTotal: 0,
    storeName: "",
    observedName: "",
    itemsAtStop: 0,
    receiptsCoverBasket: cents(between(0.9, 1.1)),
    dwellMinutes: 0,
  };
}

function cod(c: ReasonContext): ReasonContext {
  return { ...c, plan: "COD", transferProofs: 0, paidUpFront: 0 };
}

function downpayment(c: ReasonContext): ReasonContext {
  return { ...c, plan: "DOWNPAYMENT", transferProofs: 1, paidUpFront: pesos(c.billTotal / 2), hasCashPhoto: false };
}

function shortBy(c: ReasonContext, amount: number, note: string): ReasonContext {
  return { ...c, amountAtRisk: pesos(amount), cashDirection: "SHORT", riderNote: note, settledInFull: false };
}

function overBy(c: ReasonContext, amount: number, note: string): ReasonContext {
  return { ...c, amountAtRisk: pesos(amount), cashDirection: "OVER", riderNote: note, settledInFull: false };
}

function diverged(c: ReasonContext, confirmed: number, scanned: number): ReasonContext {
  return {
    ...c,
    receiptPhotos: Math.max(1, c.receiptPhotos),
    confirmedTotal: cents(confirmed),
    scannedTotal: cents(scanned),
    amountAtRisk: cents(Math.abs(confirmed - scanned)),
  };
}

function otherBranch(store: string): string {
  const chain = Object.values(CHAINS).find((branches) => branches.includes(store));
  const others = chain?.filter((b) => b !== store) ?? [];
  return others.length ? pick(others) : pick(ANY_SHOP);
}

/** One errand cleared for the given reason. */
const SCENARIOS: Record<string, (c: ReasonContext) => ReasonContext> = {
  // ── cash ─────────────────────────────────────────────────────────────────
  CASH_NO_EXACT_CHANGE: (c) =>
    shortBy(cod(c), between(20, 60), chance(0.6) ? pick(NOTES_CHANGE) : ""),
  CASH_PAID_BY_TRANSFER: (c) =>
    shortBy(
      cod(c),
      Math.min(between(40, 600), c.billTotal),
      chance(0.75) ? pick(NOTES_TRANSFER) : chance(0.3) ? pick(NOTES_OTHER) : ""
    ),
  CASH_RIDER_TO_REMIT: (c) =>
    shortBy(cod(c), Math.min(between(25, 500), c.billTotal), chance(0.45) ? pick(NOTES_REMIT) : ""),
  CASH_OVER_TIP: (c) => overBy(cod(c), between(20, 70), chance(0.6) ? pick(NOTES_TIP) : ""),
  CASH_OVER_TO_RETURN: (c) => overBy(cod(c), between(40, 500), chance(0.15) ? pick(NOTES_OTHER) : ""),

  // ── receipts ─────────────────────────────────────────────────────────────
  RECEIPT_SCAN_MISREAD: (c) => {
    const confirmed = between(80, 1500);
    if (chance(0.55)) {
      // The decimal point landed in the wrong place.
      return diverged(c, confirmed, chance(0.5) ? confirmed / 10 : confirmed * 10);
    }
    // One digit read wrong: 185 as 165, 240 as 290.
    const slip = pick([10, 20, 30, 50, 100]) * (chance(0.5) ? 1 : -1);
    return diverged(c, confirmed, Math.max(10, confirmed + slip));
  },
  RECEIPT_PARTLY_READ: (c) => {
    const confirmed = between(120, 1500);
    return diverged(c, confirmed, confirmed * between(0.3, 0.8));
  },
  RECEIPT_DISCOUNT_APPLIED: (c) => {
    const scanned = between(100, 1500);
    return diverged(c, scanned * between(0.6, 0.92), scanned);
  },

  // ── purchases nothing corroborates ───────────────────────────────────────
  //
  // Split by the shop first, because the three must not overlap: a small shop
  // whose customer also paid in full is the small-shop reason (its wording adds
  // the payment), never a coin toss between two reasons that are both true.
  UNVERIFIED_SMALL_SHOP: (c) => {
    const base = chance(0.5) ? cod(c) : c;
    return {
      ...base,
      noReceiptPhotos: int(1, 2),
      storeName: chance(0.95) ? pick(SMALL_SHOPS) : pick(NOT_SMALL),
      amountAtRisk: pesos(between(20, Math.max(40, base.basket * 0.8))),
      settledInFull: chance(0.5),
    };
  },
  // A shop that normally prints receipts, and the customer paid the whole bill.
  UNVERIFIED_PAID_IN_FULL: (c) => ({
    ...c,
    noReceiptPhotos: int(1, 3),
    storeName: chance(0.95) ? pick(NOT_SMALL) : pick(SMALL_SHOPS),
    amountAtRisk: pesos(between(20, Math.max(40, c.basket * 0.9))),
    settledInFull: true,
    hasDeliveryPhoto: true,
  }),
  // A shop that normally prints receipts, and nothing settled the bill.
  UNVERIFIED_RECEIPT_LOST: (c) => ({
    ...c,
    noReceiptPhotos: int(1, 3),
    storeName: chance(0.95) ? pick(NOT_SMALL) : pick(SMALL_SHOPS),
    amountAtRisk: pesos(between(60, Math.max(80, c.basket))),
    settledInFull: chance(0.1),
  }),

  // ── wrong branch ─────────────────────────────────────────────────────────
  BRANCH_SAME_CHAIN: (c) => {
    const store = pick(CHAIN_BRANCHES);
    return { ...c, storeName: store, observedName: chance(0.95) ? otherBranch(store) : pick(SMALL_SHOPS) };
  },
  BRANCH_PINNED_UNAVAILABLE: (c) => {
    const store = pick(ANY_SHOP);
    const observed = chance(0.1)
      ? otherBranch(store)
      : chance(0.8)
        ? pick(ANY_SHOP.filter((s) => s.split(" ")[0] !== store.split(" ")[0]))
        : "";
    return { ...c, storeName: store, observedName: observed, receiptPhotos: Math.max(1, c.receiptPhotos) };
  },

  // ── a stop with nothing to show for it ───────────────────────────────────
  MISSING_ITEMS_UNAVAILABLE: (c) => ({
    ...c,
    storeName: pick(ANY_SHOP),
    itemsAtStop: int(1, 3),
    receiptsCoverBasket: cents(between(0.3, 0.92)),
    receiptPhotos: int(0, 2),
  }),
  MISSING_ON_OTHER_RECEIPT: (c) => ({
    ...c,
    storeName: pick(ANY_SHOP),
    itemsAtStop: int(1, 8),
    receiptsCoverBasket: cents(between(0.88, 1.3)),
    receiptPhotos: int(1, 3),
  }),

  // ── long stops ───────────────────────────────────────────────────────────
  STALL_COOKED_TO_ORDER: (c) => ({
    ...c,
    storeName: chance(0.9) ? pick(COOKED_TO_ORDER) : pick(BIG_STORES),
    dwellMinutes: pesos(between(20, 60)),
    itemsAtStop: int(1, 6),
  }),
  STALL_LONG_QUEUE: (c) => ({
    ...c,
    storeName: chance(0.85) ? pick(BIG_STORES) : pick([...SMALL_SHOPS, ...COOKED_TO_ORDER]),
    dwellMinutes: pesos(between(20, 75)),
    itemsAtStop: int(1, 7),
  }),
  STALL_LARGE_ORDER: (c) => ({
    ...c,
    storeName: chance(0.8) ? pick(BIG_STORES) : pick(SMALL_SHOPS),
    dwellMinutes: pesos(between(30, 100)),
    itemsAtStop: int(9, 30),
  }),

  // ── overage held ─────────────────────────────────────────────────────────
  OVERAGE_CUSTOMER_AGREED: (c) => {
    const base = downpayment(c);
    return { ...base, amountAtRisk: pesos(base.basket * between(0.05, 0.3)), transferProofs: chance(0.9) ? 1 : 2 };
  },
  OVERAGE_TOPUP_PAID: (c) => {
    const base = downpayment(c);
    const shownByRider = chance(0.15);
    return {
      ...base,
      amountAtRisk: pesos(base.basket * between(0.05, 0.8)),
      transferProofs: shownByRider ? 1 : 2,
      hasRiderBalanceProof: shownByRider,
    };
  },
  OVERAGE_ITEMS_REMOVED: (c) => {
    const base = downpayment(c);
    return { ...base, amountAtRisk: pesos(base.basket * between(0.3, 1.0)), transferProofs: chance(0.95) ? 1 : 2 };
  },

  // ── balance never collected ──────────────────────────────────────────────
  BALANCE_CASH_AT_DOOR: (c) => {
    const base = chance(0.8) ? downpayment(c) : { ...c, plan: "OTHER" as const, paidUpFront: 0 };
    return {
      ...base,
      amountAtRisk: pesos(base.billTotal - base.paidUpFront),
      hasCashPhoto: chance(0.9),
      hasRiderBalanceProof: chance(0.05),
    };
  },
  BALANCE_TRANSFER_UNRECORDED: (c) => {
    const base = chance(0.8) ? downpayment(c) : { ...c, plan: "OTHER" as const, paidUpFront: 0 };
    const riderShot = chance(0.6);
    return {
      ...base,
      amountAtRisk: pesos(base.billTotal - base.paidUpFront),
      hasRiderBalanceProof: riderShot,
      transferProofs: riderShot ? base.transferProofs : base.transferProofs + 1,
      hasCashPhoto: chance(0.05),
    };
  },
  BALANCE_COLLECT_LATER: (c) => {
    const base = chance(0.8) ? downpayment(c) : { ...c, plan: "OTHER" as const, paidUpFront: 0 };
    return {
      ...base,
      amountAtRisk: pesos(base.billTotal - base.paidUpFront),
      hasCashPhoto: chance(0.08),
      hasRiderBalanceProof: chance(0.05),
    };
  },
};

function main() {
  const missing = REASONS.filter((r) => !SCENARIOS[r.code]).map((r) => r.code);
  if (missing.length) throw new Error(`No scenario for: ${missing.join(", ")}`);

  const rows: LabelledRow[] = [];
  for (const reason of REASONS) {
    const siblings = REASONS.filter((r) => r.kind === reason.kind && r.code !== reason.code);
    for (let n = 0; n < ROWS_PER_REASON; n++) {
      const context = SCENARIOS[reason.code](baseErrand(reason.kind));
      // Two dispatchers do not always pick the same reason for the same errand.
      const label = siblings.length && chance(LABEL_NOISE) ? pick(siblings).code : reason.code;
      rows.push({ context, label, source: "scenario" });
    }
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const out = resolve(here, "../../ml/exception-reasons/dataset.csv");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, toCsv(rows));
  console.log(`Wrote ${rows.length} rows (${REASONS.length} reasons x ${ROWS_PER_REASON}) to ${out}`);
}

main();
