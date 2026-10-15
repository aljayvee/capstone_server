import { describe, expect, it } from "vitest";
import { exceptionsFor } from "../src/services/exceptionService.js";
import { EXCEPTION_KINDS, resolveExceptionSchema } from "../src/validators/exceptionValidators.js";

/**
 * Every row the dispatcher's queue can show must be clearable.
 *
 * The queue offers "Resolve" on every row. Until 2026-10-15 the resolve schema
 * left out OVERAGE_PENDING and UNPAID_BALANCE, so a reason written on either
 * came back as a 400 from zod and the row could never leave the queue.
 *
 * Each errand below raises one kind through the real derivation, and the kind it
 * raises goes through the real schema, so a kind added to the rules and not to
 * the schema fails here as well as at compile time.
 */

const T = (iso: string) => new Date(iso);

const errand = (over: Record<string, any> = {}): any => ({
  id: "ERR-1",
  createdAt: T("2026-10-01T01:00:00Z"),
  totalCost: 293,
  estimatedCost: 176,
  status: "DELIVERED",
  riderId: 7,
  rider: { firstName: "Mark", lastName: "Reyes" },
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
  itemsPurchasedAt: null,
  ...over,
});

const proof = (over: Record<string, any>) => ({
  id: 1, pinpointId: null, verified: true, declaredTotal: null, supersededAt: null,
  capturedAt: T("2026-10-01T01:30:00Z"), extraction: null,
  ...over,
});

const stop = (over: Record<string, any> = {}) => ({
  id: 1, storeName: "Save More", mismatchDetectedAt: null, observedPlace: null, items: [],
  ...over,
});

const ONE_OF_EACH: Record<(typeof EXCEPTION_KINDS)[number], any> = {
  CASH_VARIANCE: errand({
    settlement: {
      collectedAmount: 100, expectedAmount: 293, variance: -193,
      status: "SHORT", shortReason: null, settledAt: T("2026-10-01T02:00:00Z"),
    },
  }),
  RECEIPT_DIVERGENCE: errand({
    proofImages: [proof({ kind: "RECEIPT", extraction: { extractedTotal: 176, confirmedTotal: 900 } })],
  }),
  UNVERIFIED_PURCHASE: errand({
    proofImages: [proof({ kind: "NO_RECEIPT", verified: false, declaredTotal: 57 })],
  }),
  WRONG_BRANCH: errand({
    pinpoints: [stop({ mismatchDetectedAt: T("2026-10-01T01:20:00Z"), observedPlace: { name: "Save More Annex" } })],
  }),
  MISSING_RECEIPT: errand({ pinpoints: [stop({ items: [{ id: 1 }] })] }),
  STALLED_STOP: errand({
    pinpoints: [stop()],
    dwellObservations: [{ pinpointId: 1, dwellSeconds: 3600, stalled: true, departedAt: T("2026-10-01T02:00:00Z") }],
  }),
  // An escalation raised before the downpayment was retired and never cleared.
  OVERAGE_PENDING: errand({
    status: "IN_TRANSIT",
    estimatedCost: 1200,
    quotedHandlingBasket: 1000,
    overageEscalatedAt: T("2026-10-01T01:40:00Z"),
  }),
  UNPAID_BALANCE: errand({ totalCost: 1120, paymentSelection: { paymentMode: { name: "GCash / PayMaya" } } }),
  CANCELLED_AFTER_PURCHASE: errand({
    status: "CANCELLED",
    itemsPurchasedAt: T("2026-10-01T01:40:00Z"),
    proofImages: [proof({ kind: "RECEIPT", extraction: { extractedTotal: 176, confirmedTotal: 176 } })],
  }),
};

describe("every exception the queue can show", () => {
  it.each(Object.entries(ONE_OF_EACH))("can be cleared with a reason: %s", (kind, row) => {
    const raised = exceptionsFor(row).find((e) => e.kind === kind);
    expect(raised, `the fixture no longer raises ${kind}`).toBeDefined();

    const parsed = resolveExceptionSchema.safeParse({
      kind: raised!.kind,
      reason: "Called the customer and settled it.",
      amountAtRisk: raised!.amountAtRisk,
    });
    expect(parsed.success).toBe(true);
  });

  it("still refuses a kind nobody raises", () => {
    const parsed = resolveExceptionSchema.safeParse({ kind: "SOMETHING_ELSE", reason: "Because." });
    expect(parsed.success).toBe(false);
  });
});
