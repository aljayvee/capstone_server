import { describe, expect, it } from "vitest";
import { exceptionsFor } from "../src/services/exceptionService.js";
import { toReasonContext } from "../src/services/exceptionReasonService.js";
import {
  CONFIDENCE_THRESHOLD,
  FEATURE_NAMES,
  REASONS,
  REASON_CODES,
  encodeReasonContext,
  isModelCompatible,
  suggestReason,
  type ReasonContext,
  type TrainedReasonModel,
} from "../src/services/patterns/exceptionReasonModel.js";
import { EXCEPTION_REASON_MODEL } from "../src/services/patterns/exceptionReasonWeights.js";

/**
 * The Conflict Management reason suggestion: the encoder, the 0.65 rule, the
 * shipped model, and the join from an errand row to what the model reads.
 */

const T = (iso: string) => new Date(iso);

const errand = (over: Record<string, any> = {}): any => ({
  id: "ERR-1",
  createdAt: T("2026-09-24T09:00:00Z"),
  totalCost: 132,
  estimatedCost: 57,
  status: "DELIVERED",
  riderId: 7,
  rider: { firstName: "Renen", lastName: "Cadungog" },
  settlement: null,
  pinpoints: [],
  proofImages: [],
  dwellObservations: [],
  exceptionReviews: [],
  payments: [],
  paymentSelection: null,
  overageEscalatedAt: null,
  overageResolvedAt: null,
  quotedHandlingBasket: null,
  ...over,
});

const context = (over: Partial<ReasonContext>): ReasonContext => ({
  kind: "CASH_VARIANCE",
  amountAtRisk: 0,
  billTotal: 250,
  basket: 180,
  plan: "COD",
  cashDirection: "NONE",
  riderNote: "",
  receiptPhotos: 0,
  noReceiptPhotos: 0,
  hasCashPhoto: true,
  hasDeliveryPhoto: true,
  transferProofs: 0,
  hasRiderBalanceProof: false,
  settledInFull: false,
  paidUpFront: 0,
  scannedTotal: 0,
  confirmedTotal: 0,
  storeName: "",
  observedName: "",
  itemsAtStop: 0,
  receiptsCoverBasket: 1,
  dwellMinutes: 0,
  ...over,
});

/** A model whose weights are all zero, then biased towards one reason. */
function riggedModel(favour: string, bias: number): TrainedReasonModel {
  const h = 2;
  return {
    version: "rigged",
    trainedAt: "2026-09-24T00:00:00Z",
    featureNames: [...FEATURE_NAMES],
    classes: [...REASON_CODES],
    network: {
      hiddenActivation: "relu",
      output: "softmax",
      layers: [
        {
          inputSize: FEATURE_NAMES.length,
          outputSize: h,
          weights: new Array(FEATURE_NAMES.length * h).fill(0),
          biases: new Array(h).fill(0),
        },
        {
          inputSize: h,
          outputSize: REASON_CODES.length,
          weights: new Array(REASON_CODES.length * h).fill(0),
          biases: REASON_CODES.map((code) => (code === favour ? bias : 0)),
        },
      ],
    },
    metrics: { trainingRows: 0, testRows: 0, testAccuracy: 0, coverageAtThreshold: 0, accuracyWhenConfident: 0 },
  };
}

// Lowered from 0.75 on 2026-09-26 (server AGENT_HANDSHAKE.md, "65% Confidence
// Threshold"). Pinned here so a change to it is a decision, not a drift.
describe("the 0.65 rule", () => {
  it("is 0.65", () => {
    expect(CONFIDENCE_THRESHOLD).toBe(0.65);
  });

  it("suggests nothing below 0.65", () => {
    // Five cash reasons, all equal: 0.2 each.
    const s = suggestReason(riggedModel("CASH_NO_EXACT_CHANGE", 0), context({ amountAtRisk: 40, cashDirection: "SHORT" }));
    expect(s.confidence).toBeCloseTo(0.2, 3);
    expect(s.confident).toBe(false);
    expect(s.reasonCode).toBeNull();
    expect(s.suggestion).toBeNull();
    expect(s.threshold).toBe(CONFIDENCE_THRESHOLD);
  });

  it("still says nothing just under the line", () => {
    // e^b / (e^b + 4) = 0.64
    const bias = Math.log((0.64 * 4) / 0.36);
    const s = suggestReason(riggedModel("CASH_NO_EXACT_CHANGE", bias), context({ amountAtRisk: 40, cashDirection: "SHORT" }));
    expect(s.confidence).toBeCloseTo(0.64, 3);
    expect(s.suggestion).toBeNull();
  });

  it("suggests just over the line", () => {
    const bias = Math.log((0.66 * 4) / 0.34);
    const s = suggestReason(riggedModel("CASH_NO_EXACT_CHANGE", bias), context({ amountAtRisk: 40, cashDirection: "SHORT" }));
    expect(s.confidence).toBeCloseTo(0.66, 3);
    expect(s.confident).toBe(true);
    expect(s.reasonCode).toBe("CASH_NO_EXACT_CHANGE");
  });

  it("suggests well above it, filled with this errand's figures", () => {
    const bias = Math.log((0.8 * 4) / 0.2);
    const s = suggestReason(riggedModel("CASH_NO_EXACT_CHANGE", bias), context({ amountAtRisk: 40, cashDirection: "SHORT" }));
    expect(s.confident).toBe(true);
    expect(s.reasonCode).toBe("CASH_NO_EXACT_CHANGE");
    expect(s.suggestion).toContain("₱40");
  });

  it("never offers a reason that belongs to another kind of exception", () => {
    // Rigged hard towards a cash reason, asked about a wrong-branch visit.
    const s = suggestReason(riggedModel("CASH_NO_EXACT_CHANGE", 50), context({ kind: "WRONG_BRANCH" }));
    expect(s.reasonCode === null || s.reasonCode.startsWith("BRANCH_")).toBe(true);
  });

  it("refuses a model trained for a different feature layout", () => {
    const stale = { ...riggedModel("CASH_NO_EXACT_CHANGE", 0), featureNames: FEATURE_NAMES.slice(1) };
    expect(isModelCompatible(stale)).toBe(false);
    expect(() => suggestReason(stale, context({}))).toThrow(/Retrain/);
  });
});

describe("the shipped model", () => {
  it("was trained on this encoder and these reasons", () => {
    expect(isModelCompatible(EXCEPTION_REASON_MODEL)).toBe(true);
    expect(encodeReasonContext(context({}))).toHaveLength(FEATURE_NAMES.length);
  });

  it("clears the bar it was held to on rows it never saw", () => {
    expect(EXCEPTION_REASON_MODEL.metrics.accuracyWhenConfident).toBeGreaterThan(0.9);
    expect(EXCEPTION_REASON_MODEL.metrics.coverageAtThreshold).toBeGreaterThan(0.6);
  });

  it("reads a rider's note about missing change", () => {
    const s = suggestReason(
      EXCEPTION_REASON_MODEL,
      context({ amountAtRisk: 40, cashDirection: "SHORT", riderNote: "walang barya si customer" })
    );
    expect(s.reasonCode).toBe("CASH_NO_EXACT_CHANGE");
  });

  it("stays quiet when nothing on the errand tells two reasons apart", () => {
    // ₱40 short, no note, no transfer: missing change, or a rider who will pay
    // it back? The errand cannot say, so the model must not pretend to.
    const s = suggestReason(EXCEPTION_REASON_MODEL, context({ amountAtRisk: 40, cashDirection: "SHORT" }));
    expect(s.confident).toBe(false);
    expect(s.suggestion).toBeNull();
  });

  it("spots a decimal point the scanner put in the wrong place", () => {
    const s = suggestReason(
      EXCEPTION_REASON_MODEL,
      context({ kind: "RECEIPT_DIVERGENCE", amountAtRisk: 166.5, scannedTotal: 18.5, confirmedTotal: 185, receiptPhotos: 1 })
    );
    expect(s.reasonCode).toBe("RECEIPT_SCAN_MISREAD");
    expect(s.suggestion).toContain("₱18.50");
  });

  it("recognises two branches of one chain", () => {
    const s = suggestReason(
      EXCEPTION_REASON_MODEL,
      context({ kind: "WRONG_BRANCH", storeName: "Mercury Drug Tacurong", observedName: "Mercury Drug Alunan", receiptPhotos: 1 })
    );
    expect(s.reasonCode).toBe("BRANCH_SAME_CHAIN");
  });

  it("does not read a supermarket as a market stall", () => {
    const small = FEATURE_NAMES.indexOf("store_is_small_shop");
    expect(encodeReasonContext(context({ storeName: "KCC Supermarket Tacurong" }))[small]).toBe(0);
    expect(encodeReasonContext(context({ storeName: "Tacurong Public Market Stall 14" }))[small]).toBe(1);
  });

  it("writes every reason without an em dash", () => {
    for (const r of REASONS) expect(r.write(context({ kind: r.kind, storeName: "Shop" }))).not.toContain("—");
  });
});

describe("from an errand row to a suggestion", () => {
  // Errand 812843d3 in production: one receiptless stop at a bakeshop, the
  // customer's cash photographed at the door, and a settlement that matched.
  const bakeshop = errand({
    settlement: {
      collectedAmount: 132, expectedAmount: 132, variance: 0, status: "MATCHED",
      shortReason: null, settledAt: T("2026-09-24T09:48:00Z"),
    },
    pinpoints: [
      {
        id: 29,
        storeName: "Julie's Bakeshop Mabini-Dona Alicia, Poblacion, Tacurong",
        mismatchDetectedAt: null,
        observedPlace: null,
        items: [{ id: 1 }, { id: 2 }],
      },
    ],
    proofImages: [
      {
        id: 14, kind: "NO_RECEIPT", pinpointId: 29, verified: false, declaredTotal: 57,
        capturedAt: T("2026-09-24T09:42:44Z"), supersededAt: null, extraction: null,
      },
      {
        id: 15, kind: "CASH_COLLECTED", pinpointId: null, verified: false, declaredTotal: 132,
        capturedAt: T("2026-09-24T09:46:55Z"), supersededAt: null, extraction: null,
      },
      {
        id: 16, kind: "PROOF_OF_DELIVERY", pinpointId: null, verified: true, declaredTotal: null,
        capturedAt: T("2026-09-24T09:47:29Z"), supersededAt: null, extraction: null,
      },
    ],
  });

  it("finds the stop the exception is about and reads its evidence", () => {
    const [unverified] = exceptionsFor(bakeshop);
    const c = toReasonContext(bakeshop, unverified);

    expect(c.kind).toBe("UNVERIFIED_PURCHASE");
    expect(c.amountAtRisk).toBe(57);
    expect(c.storeName).toContain("Julie's Bakeshop");
    expect(c.itemsAtStop).toBe(2);
    expect(c.noReceiptPhotos).toBe(1);
    expect(c.hasCashPhoto).toBe(true);
    expect(c.hasDeliveryPhoto).toBe(true);
    expect(c.plan).toBe("COD");
    expect(c.settledInFull).toBe(true);
  });

  it("suggests the small-shop reason, naming the shop, the amount and the payment", () => {
    // Both "a small shop" and "the customer paid in full" are true here. They
    // used to be rival reasons, and the model split 0.63 / 0.35 between two
    // right answers and suggested nothing. The small-shop reason now carries
    // the payment as a clause instead.
    const [unverified] = exceptionsFor(bakeshop);
    const s = suggestReason(EXCEPTION_REASON_MODEL, toReasonContext(bakeshop, unverified));

    expect(s.confident).toBe(true);
    expect(s.reasonCode).toBe("UNVERIFIED_SMALL_SHOP");
    expect(s.suggestion).toContain("Julie's Bakeshop Mabini-Dona Alicia is a small shop");
    expect(s.suggestion).toContain("₱57");
    expect(s.suggestion).toContain("The customer paid the full bill");
  });

  it("does not count a replaced payment screenshot as a second payment", () => {
    const withReupload = errand({
      paymentSelection: { paymentMode: { name: "Non-COD — 50% Downpayment" } },
      proofImages: [
        { id: 1, kind: "PAYMENT_PROOF", pinpointId: null, verified: true, declaredTotal: null,
          capturedAt: T("2026-09-24T08:00:00Z"), supersededAt: T("2026-09-24T08:05:00Z"), extraction: null },
        { id: 2, kind: "PAYMENT_PROOF", pinpointId: null, verified: true, declaredTotal: null,
          capturedAt: T("2026-09-24T08:05:00Z"), supersededAt: null, extraction: null },
      ],
    });
    const c = toReasonContext(withReupload, {
      errandId: "ERR-1", kind: "UNPAID_BALANCE", amountAtRisk: 66, detail: "", riderId: 7, riderName: null,
      occurredAt: T("2026-09-24T09:00:00Z"), resolvedAt: null, resolvedBy: null, resolutionReason: null,
    });

    expect(c.transferProofs).toBe(1);
    expect(c.plan).toBe("DOWNPAYMENT");
  });
});
