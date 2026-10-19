import { describe, expect, it } from "vitest";
import { holdingSiblingFor, sameDropOff, type HoldCandidate } from "../src/services/patterns/deliveryHold.js";

/**
 * A rider on the way with a customer's order is given that customer's second
 * order. The first waits ("held") while the rider shops the second, and both
 * go to the door in one trip, unless they are for different customers, or
 * different doors, in which case nothing changes.
 */

const DOOR = { deliveryLatitude: 6.6915, deliveryLongitude: 124.6772 };

const errand = (overrides: Partial<HoldCandidate> = {}): HoldCandidate => ({
  id: "A",
  customerId: 42,
  riderId: 7,
  status: "IN_TRANSIT",
  itemsPurchasedAt: null,
  acceptedAt: "2026-10-20T08:00:00.000Z",
  deliveryAddress: "Purok 5, Tacurong",
  ...DOOR,
  ...overrides,
});

const onTheWay = errand({ id: "A", itemsPurchasedAt: "2026-10-20T08:30:00.000Z" });
const secondOrder = errand({ id: "B", acceptedAt: "2026-10-20T08:35:00.000Z" });

describe("holding an order for the same customer's other one", () => {
  it("holds the bought order while the rider shops the second", () => {
    expect(holdingSiblingFor(onTheWay, [onTheWay, secondOrder])?.id).toBe("B");
  });

  it("releases it once the second is bought too", () => {
    const bought = { ...secondOrder, itemsPurchasedAt: "2026-10-20T08:50:00.000Z" };
    expect(holdingSiblingFor(onTheWay, [onTheWay, bought])).toBeNull();
  });

  it("does not hold an order that is still being shopped", () => {
    expect(holdingSiblingFor(secondOrder, [onTheWay, secondOrder])).toBeNull();
  });

  it("waits for the first accepted when two are still being shopped", () => {
    const third = errand({ id: "C", acceptedAt: "2026-10-20T08:33:00.000Z" });
    expect(holdingSiblingFor(onTheWay, [onTheWay, secondOrder, third])?.id).toBe("C");
  });
});

describe("safeguards: when an order is not held", () => {
  it("for a different customer", () => {
    expect(holdingSiblingFor(onTheWay, [{ ...secondOrder, customerId: 43 }])).toBeNull();
  });

  it("for a different door of the same customer", () => {
    // About 1.1 km away: home and work, two deliveries.
    const elsewhere = { ...secondOrder, deliveryLatitude: 6.7015 };
    expect(holdingSiblingFor(onTheWay, [elsewhere])).toBeNull();
  });

  it("while the second is only offered, not accepted", () => {
    expect(holdingSiblingFor(onTheWay, [{ ...secondOrder, status: "ASSIGNED" }])).toBeNull();
  });

  it("once the second is cancelled", () => {
    expect(holdingSiblingFor(onTheWay, [{ ...secondOrder, status: "CANCELLED" }])).toBeNull();
  });

  it("once the second is given to another rider", () => {
    expect(holdingSiblingFor(onTheWay, [{ ...secondOrder, riderId: 8 }])).toBeNull();
  });

  it("once the order itself is delivered", () => {
    expect(holdingSiblingFor({ ...onTheWay, status: "DELIVERED" }, [secondOrder])).toBeNull();
  });
});

describe("the same door", () => {
  it("is within 100 m", () => {
    // About 55 m north: the same compound.
    expect(sameDropOff(onTheWay, { ...secondOrder, deliveryLatitude: 6.692 })).toBe(true);
  });

  it("falls back to the written address when a pin is missing", () => {
    const unpinned = { ...secondOrder, deliveryLatitude: null, deliveryLongitude: null };
    expect(sameDropOff(onTheWay, { ...unpinned, deliveryAddress: "  purok 5, TACURONG " })).toBe(true);
    expect(sameDropOff(onTheWay, { ...unpinned, deliveryAddress: "Purok 6, Tacurong" })).toBe(false);
    expect(sameDropOff(onTheWay, { ...unpinned, deliveryAddress: null })).toBe(false);
  });
});
