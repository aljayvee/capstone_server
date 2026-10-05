import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Conflict Management second opinion: what the large model is asked, how
 * its answer is pooled with the network's, and that a missing answer changes
 * nothing. The category service is stubbed; the pooling and the network are real.
 */

const mockAdvise = vi.fn();
vi.mock("../src/lib/category/categoryServiceClient.js", () => ({
  adviseChoice: (...args: unknown[]) => mockAdvise(...args),
}));

const mockFindErrand = vi.fn();
vi.mock("../src/repositories/errandRepository.js", () => ({
  errandRepository: { findWithReconciliationEvidenceById: (...args: unknown[]) => mockFindErrand(...args) },
}));

const { askSecondOpinion, suggestExceptionReason } = await import("../src/services/exceptionReasonService.js");
const {
  CONFIDENCE_THRESHOLD,
  REASONS,
  REASON_CODES,
  SECOND_OPINION_WEIGHT_UNREAD_NOTE,
  adviceRequest,
  maskForKind,
  noteUnread,
  poolWithSecondOpinion,
  secondOpinionWeight,
  suggestReason,
} = await import("../src/services/patterns/exceptionReasonModel.js");
const { EXCEPTION_REASON_MODEL } = await import("../src/services/patterns/exceptionReasonWeights.js");
type ReasonContext = import("../src/services/patterns/exceptionReasonModel.js").ReasonContext;

const context = (over: Partial<ReasonContext>): ReasonContext => ({
  kind: "CASH_VARIANCE",
  amountAtRisk: 40,
  billTotal: 250,
  basket: 180,
  plan: "COD",
  cashDirection: "SHORT",
  riderNote: "",
  receiptPhotos: 1,
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

const opinion = (reasonCode: string | null, confidence = 0.95) => ({
  reasonCode,
  confidence,
  model: "gemini-3.8-flash",
  label: "Gemini 3.8 Flash",
});

beforeEach(() => {
  mockAdvise.mockReset();
  mockFindErrand.mockReset();
});

describe("where the second opinion counts", () => {
  it("is a rider's note none of the network's word lists catches", () => {
    expect(noteUnread(context({ riderNote: "wala sinsilyo si customer" }))).toBe(true);
    expect(noteUnread(context({ riderNote: "remit ko ugma" }))).toBe(true);
    expect(noteUnread(context({ riderNote: "wala sukli" }))).toBe(false);
    expect(noteUnread(context({ riderNote: "sent via GCash" }))).toBe(false);
    expect(noteUnread(context({ riderNote: "   " }))).toBe(false);
  });

  it("gets the chosen weight there and none anywhere else", () => {
    expect(secondOpinionWeight(context({ riderNote: "remit ko ugma" }))).toBe(SECOND_OPINION_WEIGHT_UNREAD_NOTE);
    expect(secondOpinionWeight(context({ riderNote: "wala sukli" }))).toBe(0);
    expect(secondOpinionWeight(context({}))).toBe(0);
  });
});

describe("what the second opinion is asked", () => {
  it("states the exception, the errand's figures and the rider's own words", () => {
    const request = adviceRequest(context({ riderNote: "  wala sinsilyo si customer " }));
    expect(request.question).toBe("The cash the rider handed over differs from the errand's total by ₱40.");
    expect(request.facts).toContain("Payment plan: cash on delivery.");
    expect(request.facts).toContain("The rider's cash settlement came back short.");
    expect(request.note).toBe("wala sinsilyo si customer");
  });

  it("offers only this kind's reasons, already filled with the errand's figures", () => {
    const c = context({});
    const request = adviceRequest(c);
    const cash = REASONS.filter((r) => r.kind === "CASH_VARIANCE");
    expect(request.options.map((o) => o.code)).toEqual(cash.map((r) => r.code));
    expect(request.options.map((o) => o.text)).toEqual(cash.map((r) => r.write(c)));
  });

  it("has a question for every kind, and no em dash anywhere", () => {
    const kinds = [...new Set(REASONS.map((r) => r.kind))];
    for (const kind of kinds) {
      const request = adviceRequest(context({ kind, storeName: "Julie's Bakeshop, Poblacion", dwellMinutes: 42, itemsAtStop: 3 }));
      expect(request.question.length).toBeGreaterThan(20);
      expect([request.question, ...request.facts].join(" ")).not.toContain("—");
    }
  });
});

describe("pooling the answer with the network's", () => {
  const allowed = maskForKind("CASH_VARIANCE");
  const i = (code: string) => REASON_CODES.indexOf(code);
  const unsure = REASON_CODES.map((code) =>
    code === "CASH_NO_EXACT_CHANGE" ? 0.55 : code === "CASH_RIDER_TO_REMIT" ? 0.35 : code === "CASH_PAID_BY_TRANSFER" ? 0.1 : 0
  );

  it("lifts the network's unsure pick over the line when the model agrees", () => {
    const pooled = poolWithSecondOpinion(unsure, allowed, opinion("CASH_NO_EXACT_CHANGE", 0.95), 0.5);
    expect(pooled[i("CASH_NO_EXACT_CHANGE")]).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
  });

  it("can move the pick to the reason the rider's note names", () => {
    const pooled = poolWithSecondOpinion(unsure, allowed, opinion("CASH_RIDER_TO_REMIT", 0.95), 0.5);
    expect(pooled.indexOf(Math.max(...pooled))).toBe(i("CASH_RIDER_TO_REMIT"));
  });

  it("a sure 'none of them fits' pulls even a confident pick under the line", () => {
    const sure = REASON_CODES.map((code) => (code === "CASH_OVER_TO_RETURN" ? 0.88 : code === "CASH_OVER_TIP" ? 0.12 : 0));
    const pooled = poolWithSecondOpinion(sure, allowed, opinion(null, 0.9), 0.5);
    expect(Math.max(...pooled)).toBeLessThan(CONFIDENCE_THRESHOLD);
  });

  it("ignores an answer naming another kind's reason, and touches no other kind", () => {
    expect(poolWithSecondOpinion(unsure, allowed, opinion("STALL_LONG_QUEUE"), 0.5)).toEqual(unsure);
    const pooled = poolWithSecondOpinion(unsure, allowed, opinion("CASH_RIDER_TO_REMIT"), 0.5);
    REASON_CODES.forEach((_, k) => {
      if (!allowed[k]) expect(pooled[k]).toBe(0);
    });
    expect(pooled.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  });
});

describe("the suggestion", () => {
  it("is exactly the network's without a second opinion", () => {
    const c = context({ riderNote: "wala sukli" });
    const alone = suggestReason(EXCEPTION_REASON_MODEL, c);
    expect(alone.source).toBe("model");
    expect(alone.secondOpinion).toBeNull();
    expect(alone.localConfidence).toBe(alone.confidence);
  });

  it("follows the model that read a note the network could not, and says so", () => {
    // The network reads nothing in this note and picks the rider remitting.
    const c = context({ riderNote: "wala sinsilyo si customer" });
    expect(suggestReason(EXCEPTION_REASON_MODEL, c).reasonCode).not.toBe("CASH_NO_EXACT_CHANGE");
    const pooled = suggestReason(EXCEPTION_REASON_MODEL, c, opinion("CASH_NO_EXACT_CHANGE"));
    expect(pooled.confident).toBe(true);
    expect(pooled.source).toBe("model+gemini");
    expect(pooled.secondOpinion?.label).toBe("Gemini 3.8 Flash");
    expect(pooled.suggestion).toBe(REASONS[REASON_CODES.indexOf("CASH_NO_EXACT_CHANGE")].write(c));
  });

  it("goes quiet when that model finds that no reason fits the note", () => {
    // Over, and the note says it paid off an earlier order: no cash reason
    // describes that, and the network is 0.96 sure of the excess being returned.
    const c = context({ cashDirection: "OVER", amountAtRisk: 150, riderNote: "ginbayaran man niya ang utang sa previous order" });
    expect(suggestReason(EXCEPTION_REASON_MODEL, c).confident).toBe(true);
    const pooled = suggestReason(EXCEPTION_REASON_MODEL, c, opinion(null, 0.95));
    expect(pooled.confident).toBe(false);
    expect(pooled.suggestion).toBeNull();
  });
});

describe("suggesting for a queue row", () => {
  const T = (iso: string) => new Date(iso);
  const errandWithNote = (note: string) => ({
    id: "ERR-9",
    createdAt: T("2026-09-25T09:00:00Z"),
    totalCost: 250,
    estimatedCost: 180,
    status: "DELIVERED",
    riderId: 7,
    rider: { firstName: "Renen", lastName: "Cadungog" },
    settlement: {
      status: "SHORT",
      variance: -60,
      collectedAmount: 190,
      expectedAmount: 250,
      shortReason: note,
      settledAt: T("2026-09-25T10:00:00Z"),
    },
    pinpoints: [],
    proofImages: [],
    dwellObservations: [],
    exceptionReviews: [],
    payments: [],
    paymentSelection: null,
    overageEscalatedAt: null,
    overageResolvedAt: null,
    quotedHandlingBasket: null,
  });

  it("does not ask about a note the network already read", async () => {
    mockFindErrand.mockResolvedValue(errandWithNote("wala sukli si customer"));
    const s = await suggestExceptionReason("ERR-9", "CASH_VARIANCE");
    expect(mockAdvise).not.toHaveBeenCalled();
    expect(s.source).toBe("model");
  });

  it("asks about a note it could not read, and pools the answer", async () => {
    mockFindErrand.mockResolvedValue(errandWithNote("wala sinsilyo si customer"));
    mockAdvise.mockResolvedValue({ available: true, code: "CASH_NO_EXACT_CHANGE", confidence: 0.95, model: "gemini-3.8-flash", label: "Gemini 3.8 Flash" });
    const s = await suggestExceptionReason("ERR-9", "CASH_VARIANCE");
    expect(mockAdvise).toHaveBeenCalledTimes(1);
    expect(s.source).toBe("model+gemini");
    expect(s.reasonCode).toBe("CASH_NO_EXACT_CHANGE");
  });

  it("answers alone, as before, when the category service has nothing", async () => {
    mockFindErrand.mockResolvedValue(errandWithNote("wala sinsilyo si customer"));
    mockAdvise.mockResolvedValue(null);
    const s = await suggestExceptionReason("ERR-9", "CASH_VARIANCE");
    expect(s.source).toBe("model");
    expect(s.secondOpinion).toBeNull();
  });
});

describe("asking the category service", () => {
  it("turns an answer among the options into a second opinion", async () => {
    mockAdvise.mockResolvedValue({ available: true, code: "CASH_RIDER_TO_REMIT", confidence: 0.91, model: "gemini-3.8-flash", label: "Gemini 3.8 Flash" });
    const answer = await askSecondOpinion(context({ riderNote: "remit ko ugma" }));
    expect(answer).toEqual(opinion("CASH_RIDER_TO_REMIT", 0.91));
    const sent = mockAdvise.mock.calls[0][0];
    expect(sent.note).toBe("remit ko ugma");
    expect(sent.options).toHaveLength(5);
  });

  it("keeps 'none fits' as an answer", async () => {
    mockAdvise.mockResolvedValue({ available: true, code: null, confidence: 0.8, model: "gemma-4-26b-a4b-it", label: "Gemma 4" });
    expect((await askSecondOpinion(context({})))?.reasonCode).toBeNull();
  });

  it("has no opinion when the service is down, refuses, or names something it was not offered", async () => {
    mockAdvise.mockResolvedValueOnce(null);
    expect(await askSecondOpinion(context({}))).toBeNull();
    mockAdvise.mockResolvedValueOnce({ available: false, reason: "no key" });
    expect(await askSecondOpinion(context({}))).toBeNull();
    mockAdvise.mockResolvedValueOnce({ available: true, code: "STALL_LONG_QUEUE", confidence: 1, model: "gemini-3.8-flash" });
    expect(await askSecondOpinion(context({}))).toBeNull();
  });
});
