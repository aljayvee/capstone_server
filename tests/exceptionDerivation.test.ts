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
  // An ordinary COD errand: no downpayment ledger, no receipt overage. The
  // downpayment cases below override these.
  payments: [],
  paymentSelection: null,
  overageEscalatedAt: null,
  overageResolvedAt: null,
  quotedHandlingBasket: null,
  ...over,
});

/** The catalogue name, exactly as payment_modes holds it. */
const DOWNPAYMENT_SELECTION = { paymentMode: { name: "Non-COD — 50% Downpayment" } };

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

// ───────────────────────────────────────────────────────────────────────────
// THE DOWNPAYMENT PLAN
//
// Two ways it fails, and they are not the same emergency. Goods held is a rider
// standing still right now; an uncollected balance is money already gone.
// ───────────────────────────────────────────────────────────────────────────

describe("goods held for an overage the customer never approved", () => {
  const held = (over: Record<string, any> = {}) =>
    errand({
      status: "IN_TRANSIT",
      estimatedCost: 1200,
      quotedHandlingBasket: 1000,
      overageEscalatedAt: T("2026-08-25T01:40:00Z"),
      paymentSelection: DOWNPAYMENT_SELECTION,
      payments: [{ kind: "UPFRONT", amount: 500 }],
      ...over,
    });

  it("raises the amount the customer has not agreed to", () => {
    const found = exceptionsFor(held());
    const overage = found.find((e) => e.kind === "OVERAGE_PENDING");

    expect(overage?.amountAtRisk).toBe(200);
    expect(overage?.detail).toContain("Goods held");
  });

  it("ages from when the hold was raised, not when the errand was placed", () => {
    // The queue ranks by amount then by age; an overage dated to the errand
    // would look older than it is and outrank a genuinely stale one.
    expect(exceptionsFor(held())[0]?.occurredAt).toEqual(T("2026-08-25T01:40:00Z"));
  });

  it("goes quiet once the customer covers it", () => {
    const resolved = held({
      overageResolvedAt: T("2026-08-25T02:00:00Z"),
      payments: [
        { kind: "UPFRONT", amount: 500 },
        { kind: "TOP_UP", amount: 200 },
      ],
    });

    expect(kinds(exceptionsFor(resolved))).not.toContain("OVERAGE_PENDING");
  });

  it("raises again when a second receipt overruns after the first was settled", () => {
    // A resolution older than the escalation it is meant to clear belongs to the
    // previous round. Treating it as current would silently release the goods.
    const reEscalated = held({
      overageResolvedAt: T("2026-08-25T01:20:00Z"),
      overageEscalatedAt: T("2026-08-25T01:40:00Z"),
    });

    expect(kinds(exceptionsFor(reEscalated))).toContain("OVERAGE_PENDING");
  });
});

describe("delivered without the balance", () => {
  it("raises what is still outstanding", () => {
    const unpaid = errand({
      status: "DELIVERED",
      totalCost: 1120,
      paymentSelection: DOWNPAYMENT_SELECTION,
      payments: [{ kind: "UPFRONT", amount: 500 }],
    });

    const found = exceptionsFor(unpaid).find((e) => e.kind === "UNPAID_BALANCE");
    expect(found?.amountAtRisk).toBe(620);
  });

  it("counts the cash the rider actually settled", () => {
    const settled = errand({
      status: "DELIVERED",
      totalCost: 1120,
      paymentSelection: DOWNPAYMENT_SELECTION,
      payments: [{ kind: "UPFRONT", amount: 500 }],
      settlement: {
        collectedAmount: 620, expectedAmount: 620, variance: 0,
        status: "MATCHED", shortReason: null, settledAt: T("2026-08-25T02:00:00Z"),
      },
    });

    expect(kinds(exceptionsFor(settled))).not.toContain("UNPAID_BALANCE");
  });

  it("nets a refund off what was paid", () => {
    const refunded = errand({
      status: "DELIVERED",
      totalCost: 1120,
      paymentSelection: DOWNPAYMENT_SELECTION,
      payments: [
        { kind: "UPFRONT", amount: 500 },
        { kind: "REFUND", amount: 500 },
      ],
    });

    expect(exceptionsFor(refunded).find((e) => e.kind === "UNPAID_BALANCE")?.amountAtRisk).toBe(1120);
  });

  it("says nothing about an errand still in flight", () => {
    // Every downpayment errand has an outstanding balance until the rider
    // reaches the door. Flagging those would drown the queue in normality.
    const inFlight = errand({
      status: "IN_TRANSIT",
      totalCost: 1120,
      paymentSelection: DOWNPAYMENT_SELECTION,
      payments: [{ kind: "UPFRONT", amount: 500 }],
    });

    expect(kinds(exceptionsFor(inFlight))).not.toContain("UNPAID_BALANCE");
  });

  it("ignores an ordinary COD errand, which has no ledger", () => {
    expect(kinds(exceptionsFor(errand({ status: "DELIVERED" })))).not.toContain("UNPAID_BALANCE");
  });
});

describe("a mode that captures no payment at all", () => {
  // GCash / PayMaya, Bank Transfer and Card have no gateway and no ledger. They
  // record nothing and cannot be settled, so a delivered one used to be
  // invisible in every queue: goods gone, no money, nobody told.
  it.each(["GCash / PayMaya", "Bank Transfer", "Debit/Credit Card"])(
    "flags a delivered %s errand with nothing recorded",
    (mode) => {
      const ghost = errand({
        status: "DELIVERED",
        totalCost: 1120,
        paymentSelection: { paymentMode: { name: mode } },
      });

      const found = exceptionsFor(ghost).find((e) => e.kind === "UNPAID_BALANCE");
      expect(found?.amountAtRisk).toBe(1120);
      expect(found?.detail).toContain("captures no payment");
    }
  );

  it("leaves COD to the settlement report", () => {
    // An unsettled COD errand already shows as awaiting collection there.
    // Raising it here too would say the same thing twice.
    const cod = errand({
      status: "DELIVERED",
      totalCost: 1120,
      paymentSelection: { paymentMode: { name: "Cash on Delivery" } },
    });

    expect(kinds(exceptionsFor(cod))).not.toContain("UNPAID_BALANCE");
  });
});
