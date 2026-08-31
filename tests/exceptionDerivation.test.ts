import { describe, expect, it } from "vitest";
import { exceptionsFor } from "../src/services/exceptionService.js";

/**
 * The derivation, exercised on errand shapes rather than through the database.
 *
 * `exceptionsFor` takes one row of evidence and returns what did not reconcile,
 * so every case below is an errand that either balances or does not.
 */

const RIDER = { firstName: "Mark", lastName: "Reyes" };
const T = (iso: string) => new Date(iso);

const errand = (over: Record<string, any> = {}): any => ({
  id: "ERR-1",
  createdAt: T("2026-08-25T01:00:00Z"),
  totalCost: 293,
  estimatedCost: 176,
  status: "DELIVERED",
  riderId: 7,
  rider: RIDER,
  settlement: null,
  pinpoints: [],
  proofImages: [],
  dwellObservations: [],
  exceptionReviews: [],
  ...over,
});

const kinds = (list: ReturnType<typeof exceptionsFor>) => list.map((e) => e.kind).sort();

describe("an errand that reconciles", () => {
  it("raises nothing when the cash matches and every stop has a receipt", () => {
    const clean = errand({
      settlement: {
        collectedAmount: 293, expectedAmount: 293, variance: 0,
        status: "MATCHED", shortReason: null, settledAt: T("2026-08-25T02:00:00Z"),
      },
      pinpoints: [{ id: 1, storeName: "Jollibee", mismatchDetectedAt: null, observedPlace: null, items: [{ id: 1 }] }],
      proofImages: [{
        id: 1, kind: "RECEIPT", pinpointId: 1, verified: true, declaredTotal: null,
        capturedAt: T("2026-08-25T01:30:00Z"),
        extraction: { extractedTotal: 176, confirmedTotal: 176 },
      }],
    });

    expect(exceptionsFor(clean)).toEqual([]);
  });
});

describe("cash that did not come back whole", () => {
  it("raises exactly one variance on a shortfall", () => {
    const short = errand({
      settlement: {
        collectedAmount: 250, expectedAmount: 293, variance: -43,
        status: "SHORT", shortReason: "Customer was short", settledAt: T("2026-08-25T02:00:00Z"),
      },
    });

    const found = exceptionsFor(short);
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe("CASH_VARIANCE");
    expect(found[0].amountAtRisk).toBe(43);
    // The rider's stated reason travels with it — a variance with no explanation
    // is a number nobody can act on.
    expect(found[0].detail).toContain("Customer was short");
  });

  it("treats an over-collection as an exception too", () => {
    const over = errand({
      settlement: {
        collectedAmount: 400, expectedAmount: 293, variance: 107,
        status: "OVER", shortReason: null, settledAt: T("2026-08-25T02:00:00Z"),
      },
    });

    const found = exceptionsFor(over);
    expect(found[0].kind).toBe("CASH_VARIANCE");
    // Never negative: at-risk is exposure, not direction.
    expect(found[0].amountAtRisk).toBe(107);
    expect(found[0].detail).toContain("over");
  });

  it("stays quiet on a rounding variance", () => {
    const trivial = errand({
      settlement: {
        collectedAmount: 293, expectedAmount: 294, variance: -1,
        status: "SHORT", shortReason: null, settledAt: T("2026-08-25T02:00:00Z"),
      },
    });
    expect(exceptionsFor(trivial)).toEqual([]);
  });
});

describe("evidence that does not agree with itself", () => {
  it("raises divergence when the rider's figure is far from the reading", () => {
    const diverged = errand({
      proofImages: [{
        id: 1, kind: "RECEIPT", pinpointId: null, verified: true, declaredTotal: null,
        capturedAt: T("2026-08-25T01:30:00Z"),
        extraction: { extractedTotal: 176, confirmedTotal: 900 },
      }],
    });

    const found = exceptionsFor(diverged);
    expect(found[0].kind).toBe("RECEIPT_DIVERGENCE");
    expect(found[0].amountAtRisk).toBe(724);
  });

  it("says nothing about a corrected digit", () => {
    const corrected = errand({
      proofImages: [{
        id: 1, kind: "RECEIPT", pinpointId: null, verified: true, declaredTotal: null,
        capturedAt: T("2026-08-25T01:30:00Z"),
        extraction: { extractedTotal: 176, confirmedTotal: 180 },
      }],
    });
    expect(exceptionsFor(corrected)).toEqual([]);
  });

  it("flags a purchase nothing corroborates, at any amount", () => {
    const declared = errand({
      proofImages: [{
        id: 1, kind: "NO_RECEIPT", pinpointId: null, verified: false, declaredTotal: 40,
        capturedAt: T("2026-08-25T01:30:00Z"), extraction: null,
      }],
    });

    const found = exceptionsFor(declared);
    expect(found[0].kind).toBe("UNVERIFIED_PURCHASE");
    // ₱40 is below the money threshold, and this still surfaces — it is about
    // conduct, not the amount.
    expect(found[0].amountAtRisk).toBe(40);
  });
});

describe("where the rider actually went", () => {
  it("flags a settled visit to a different branch", () => {
    const wrongBranch = errand({
      pinpoints: [{
        id: 1, storeName: "Jollibee DT", mismatchDetectedAt: T("2026-08-25T01:20:00Z"),
        observedPlace: { name: "Jollibee Center" }, items: [],
      }],
    });

    const found = exceptionsFor(wrongBranch);
    expect(found[0].kind).toBe("WRONG_BRANCH");
    expect(found[0].amountAtRisk).toBe(0);
    expect(found[0].detail).toContain("Jollibee Center");
  });

  it("flags a finished stop that produced no evidence at all", () => {
    const noProof = errand({
      pinpoints: [{ id: 1, storeName: "Save More", mismatchDetectedAt: null, observedPlace: null, items: [{ id: 1 }, { id: 2 }] }],
      proofImages: [],
    });

    expect(kinds(exceptionsFor(noProof))).toEqual(["MISSING_RECEIPT"]);
  });

  it("does not flag a stop the rider has not reached yet", () => {
    // An errand in flight has stops with no proof by definition. Flagging those
    // would make the queue nothing but errands still being worked.
    const inFlight = errand({
      status: "IN_TRANSIT",
      pinpoints: [{ id: 1, storeName: "Save More", mismatchDetectedAt: null, observedPlace: null, items: [{ id: 1 }] }],
    });
    expect(exceptionsFor(inFlight)).toEqual([]);
  });

  it("flags a dwell that ran long, without putting money at risk", () => {
    const stalled = errand({
      pinpoints: [{ id: 1, storeName: "Save More", mismatchDetectedAt: null, observedPlace: null, items: [] }],
      dwellObservations: [{ pinpointId: 1, dwellSeconds: 3600, stalled: true, departedAt: T("2026-08-25T02:00:00Z") }],
    });

    const found = exceptionsFor(stalled);
    expect(found[0].kind).toBe("STALLED_STOP");
    expect(found[0].amountAtRisk).toBe(0);
    expect(found[0].detail).toContain("60 min");
  });

  it("ignores an ordinary dwell", () => {
    const normal = errand({
      pinpoints: [{ id: 1, storeName: "Save More", mismatchDetectedAt: null, observedPlace: null, items: [] }],
      dwellObservations: [{ pinpointId: 1, dwellSeconds: 400, stalled: false, departedAt: T("2026-08-25T02:00:00Z") }],
    });
    expect(exceptionsFor(normal)).toEqual([]);
  });
});

describe("once someone has cleared it", () => {
  const shortfall = {
    collectedAmount: 250, expectedAmount: 293, variance: -43,
    status: "SHORT", shortReason: null, settledAt: T("2026-08-25T02:00:00Z"),
  };

  it("carries who cleared it and what they said", () => {
    const reviewed = errand({
      settlement: shortfall,
      exceptionReviews: [{
        kind: "CASH_VARIANCE", reason: "Customer paid the balance by GCash the next day.",
        amountAtRisk: 43, resolvedAt: T("2026-08-26T09:00:00Z"),
        reviewer: { firstName: "Ana", lastName: "Cruz" },
      }],
    });

    const found = exceptionsFor(reviewed);
    expect(found[0].resolvedBy).toBe("Ana Cruz");
    expect(found[0].resolutionReason).toContain("GCash");
  });

  it("shows the most recent word when two people looked", () => {
    // An owner reviewing what a dispatcher already closed adds a row rather than
    // replacing one, so the sequence survives — and the latest is what stands.
    const twice = errand({
      settlement: shortfall,
      exceptionReviews: [
        { kind: "CASH_VARIANCE", reason: "Dispatcher: written off.", amountAtRisk: 43,
          resolvedAt: T("2026-08-26T09:00:00Z"), reviewer: { firstName: "Ana", lastName: "Cruz" } },
        { kind: "CASH_VARIANCE", reason: "Owner: recovered from the rider's payout.", amountAtRisk: 43,
          resolvedAt: T("2026-08-27T09:00:00Z"), reviewer: { firstName: "Jo", lastName: "Santos" } },
      ],
    });

    expect(exceptionsFor(twice)[0].resolvedBy).toBe("Jo Santos");
  });

  it("does not let a review of one kind clear another", () => {
    const mixed = errand({
      settlement: shortfall,
      proofImages: [{
        id: 1, kind: "NO_RECEIPT", pinpointId: null, verified: false, declaredTotal: 176,
        capturedAt: T("2026-08-25T01:30:00Z"), extraction: null,
      }],
      exceptionReviews: [{
        kind: "CASH_VARIANCE", reason: "Settled separately.", amountAtRisk: 43,
        resolvedAt: T("2026-08-26T09:00:00Z"), reviewer: { firstName: "Ana", lastName: "Cruz" },
      }],
    });

    const found = exceptionsFor(mixed);
    const cash = found.find((e) => e.kind === "CASH_VARIANCE");
    const unverified = found.find((e) => e.kind === "UNVERIFIED_PURCHASE");

    expect(cash?.resolvedAt).not.toBeNull();
    expect(unverified?.resolvedAt).toBeNull();
  });
});

describe("an errand that went wrong in several ways at once", () => {
  it("raises each one separately", () => {
    const bad = errand({
      settlement: {
        collectedAmount: 100, expectedAmount: 293, variance: -193,
        status: "SHORT", shortReason: null, settledAt: T("2026-08-25T02:00:00Z"),
      },
      pinpoints: [{
        id: 1, storeName: "Jollibee DT", mismatchDetectedAt: T("2026-08-25T01:20:00Z"),
        observedPlace: { name: "Jollibee Center" }, items: [{ id: 1 }],
      }],
      proofImages: [{
        id: 1, kind: "NO_RECEIPT", pinpointId: 1, verified: false, declaredTotal: 176,
        capturedAt: T("2026-08-25T01:30:00Z"), extraction: null,
      }],
    });

    expect(kinds(exceptionsFor(bad))).toEqual(["CASH_VARIANCE", "UNVERIFIED_PURCHASE", "WRONG_BRANCH"]);
  });
});
