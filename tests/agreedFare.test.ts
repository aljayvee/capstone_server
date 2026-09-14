import { describe, expect, it } from "vitest";
import { fareAfterAgreement } from "../src/services/patterns/agreedFare.js";

/**
 * The real case this exists for: a Tacurong errand quoted at ₱90 that was
 * charged ₱80 after the rider uploaded a receipt. Base ₱70, ₱10/km beyond the
 * first 2 km, billed in whole started kilometres — so 3.1 km prices at ₱90 and
 * 2.724 km at ₱80, and a re-measurement that crossed the boundary moved the fare
 * with nobody deciding it.
 */
const QUOTED_FARE = 90;
const LIVE_REPRICE = { deliveryFee: 80, totalCost: 140 };

describe("a fare the customer has agreed to", () => {
  it("does not move when the route is measured again", () => {
    const fare = fareAfterAgreement({
      agreedFare: QUOTED_FARE,
      livePrice: LIVE_REPRICE,
      estimatedCost: 60,
      tip: 0,
    });

    expect(fare.deliveryFee).toBe(90);
    expect(fare.frozen).toBe(true);
  });

  it("does not move upward either", () => {
    // The same mechanism that charged ₱80 against a ₱90 quote charges ₱100 just
    // as easily. Frozen means frozen, not "capped".
    const fare = fareAfterAgreement({
      agreedFare: QUOTED_FARE,
      livePrice: { deliveryFee: 100, totalCost: 160 },
      estimatedCost: 60,
      tip: 0,
    });

    expect(fare.deliveryFee).toBe(90);
  });

  it("still bills the real basket, because only the fare was agreed", () => {
    // A receipt that beats the estimate is the customer's to pay — that is what
    // checkReceiptOverage stops if it is too big. Freezing the fare must not
    // freeze the item money with it.
    const fare = fareAfterAgreement({
      agreedFare: QUOTED_FARE,
      livePrice: LIVE_REPRICE,
      estimatedCost: 250,
      tip: 20,
    });

    expect(fare.totalCost).toBe(360);
  });

  it("keeps the total to the centavo", () => {
    // 90 + 49.9 + 0.2 is 140.10000000000002 in floating point, and a total that
    // prints like that on a receipt is its own bug report.
    const fare = fareAfterAgreement({
      agreedFare: QUOTED_FARE,
      livePrice: LIVE_REPRICE,
      estimatedCost: 49.9,
      tip: 0.2,
    });

    expect(fare.totalCost).toBe(140.1);
  });

  it("is stable when applied repeatedly", () => {
    // recalculateFee runs on every status change, not once.
    const once = fareAfterAgreement({
      agreedFare: QUOTED_FARE,
      livePrice: LIVE_REPRICE,
      estimatedCost: 60,
      tip: 0,
    });
    const twice = fareAfterAgreement({
      agreedFare: QUOTED_FARE,
      livePrice: { deliveryFee: 70, totalCost: 130 },
      estimatedCost: 60,
      tip: 0,
    });

    expect(twice).toEqual(once);
  });
});

describe("an errand with no agreed fare", () => {
  it("prices live, exactly as it did before this rule existed", () => {
    const fare = fareAfterAgreement({
      agreedFare: null,
      livePrice: LIVE_REPRICE,
      estimatedCost: 60,
      tip: 0,
    });

    expect(fare.deliveryFee).toBe(80);
    expect(fare.totalCost).toBe(140);
    expect(fare.frozen).toBe(false);
  });

  it("treats an errand older than the column the same way", () => {
    // quotedDeliveryFee is null on every errand that predates it, and undefined
    // on any caller reading a partial row. Neither is an agreement.
    for (const missing of [null, undefined]) {
      const fare = fareAfterAgreement({
        agreedFare: missing,
        livePrice: LIVE_REPRICE,
        estimatedCost: 60,
        tip: 0,
      });
      expect(fare.frozen).toBe(false);
      expect(fare.deliveryFee).toBe(80);
    }
  });

  it("does not treat a genuine zero fare as unset", () => {
    // A ₱0 fare is a decision (a waived delivery), not a missing value. Using a
    // falsy check here instead of a null check would silently reprice it.
    const fare = fareAfterAgreement({
      agreedFare: 0,
      livePrice: LIVE_REPRICE,
      estimatedCost: 60,
      tip: 0,
    });

    expect(fare.frozen).toBe(true);
    expect(fare.deliveryFee).toBe(0);
    expect(fare.totalCost).toBe(60);
  });
});
