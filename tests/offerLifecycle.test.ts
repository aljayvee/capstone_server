import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * An offer's life: accepted, declined, or expired (2026-10-09).
 *
 * acceptErrand and declineErrand both used to read the status and then write
 * unconditionally, so a cancellation between the two was overwritten (an
 * accept brought a CANCELLED errand back as IN_TRANSIT), and an expiry racing
 * an accept would pull an errand the rider had just taken. Nothing took back an
 * offer nobody answered, either; it stayed on that rider forever.
 */

const { state, groupBy } = vi.hoisted(() => ({
  state: { errand: {} as any, acceptCount: 1, releaseCount: 1, stale: [] as any[] },
  // assignRider's first query on the automatic path. Failing it stops the
  // reassignment there, so a call to it is the sign one was attempted.
  groupBy: vi.fn(async () => {
    throw new Error("no riders in this test");
  }),
}));

vi.mock("../src/lib/prisma.js", () => ({ prisma: { errand: { groupBy } } }));
vi.mock("../src/repositories/errandRepository.js", () => ({
  errandRepository: {
    findStatusAndRiderById: vi.fn(async () => ({ status: state.errand.status, riderId: state.errand.riderId })),
    findById: vi.fn(async () => state.errand),
    countInTransitForRider: vi.fn(async () => 0),
    acceptOffer: vi.fn(async () => state.acceptCount),
    releaseOffer: vi.fn(async () => state.releaseCount),
    findOffersAssignedBefore: vi.fn(async () => state.stale),
  },
  dispatchLogRepository: {},
}));
vi.mock("../src/services/etaService.js", () => ({ recomputeInBackground: vi.fn() }));
vi.mock("../src/lib/eventPublisher.js", () => ({
  eventPublisher: { emit: vi.fn(), emitToErrand: vi.fn(), emitToErrandParties: vi.fn(), emitToRole: vi.fn(), emitToRider: vi.fn(), emitToCustomer: vi.fn() },
}));
vi.mock("../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { acceptErrand, declineErrand, expireStaleOffers, OFFER_EXPIRY_MS } = await import("../src/services/errandService.js");
const { errandRepository } = await import("../src/repositories/errandRepository.js");

const NOW = new Date("2026-10-09T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

beforeEach(() => {
  vi.clearAllMocks();
  state.errand = { id: "ERR-1", status: "ASSIGNED", riderId: 7, customerId: 5 };
  state.acceptCount = 1;
  state.releaseCount = 1;
  state.stale = [];
});

describe("acceptErrand", () => {
  it("accepts through the conditional write, as this rider's open offer", async () => {
    await acceptErrand("ERR-1", 7);
    expect(errandRepository.acceptOffer).toHaveBeenCalledWith("ERR-1", 7, expect.any(Date));
  });

  it("refuses with 409, and does not resurrect it, when a cancellation landed first", async () => {
    state.acceptCount = 0;
    // The read before the write still saw ASSIGNED; the write found CANCELLED.
    errandRepository.findById = vi.fn(async () => ({ ...state.errand, status: "CANCELLED" })) as any;
    await expect(acceptErrand("ERR-1", 7)).rejects.toMatchObject({ status: 409 });
    errandRepository.findById = vi.fn(async () => state.errand) as any;
  });

  it("treats a retried accept that already went through as a success", async () => {
    state.acceptCount = 0;
    state.errand = { ...state.errand, status: "IN_TRANSIT" };
    const result = await acceptErrand("ERR-1", 7);
    expect(result).toMatchObject({ id: "ERR-1", status: "IN_TRANSIT" });
  });
});

describe("declineErrand", () => {
  it("refuses with 409 when the offer was accepted or expired in the same instant", async () => {
    state.releaseCount = 0;
    await expect(declineErrand("ERR-1", 7, "busy")).rejects.toMatchObject({ status: 409 });
    expect(groupBy).not.toHaveBeenCalled();
  });

  it("hands the offer back and tries the next rider", async () => {
    await declineErrand("ERR-1", 7, "busy");
    expect(errandRepository.releaseOffer).toHaveBeenCalledWith("ERR-1", 7);
    expect(groupBy).toHaveBeenCalled();
  });

  it("leaves it with the dispatcher when asked not to reassign", async () => {
    await declineErrand("ERR-1", 7, "busy", { reassign: false });
    expect(errandRepository.releaseOffer).toHaveBeenCalled();
    expect(groupBy).not.toHaveBeenCalled();
  });
});

describe("expireStaleOffers", () => {
  it("looks for offers older than the expiry window", async () => {
    await expireStaleOffers(NOW);
    expect(errandRepository.findOffersAssignedBefore).toHaveBeenCalledWith(ago(OFFER_EXPIRY_MS));
  });

  it("sends a fresh expired offer on to the next rider", async () => {
    state.stale = [{ id: "ERR-1", riderId: 7, assignedAt: ago(75_000) }];
    expect(await expireStaleOffers(NOW)).toBe(1);
    expect(errandRepository.releaseOffer).toHaveBeenCalledWith("ERR-1", 7);
    expect(groupBy).toHaveBeenCalledTimes(1);
  });

  it("returns an hours-old ghost offer to the dispatcher instead of sending a rider out on it", async () => {
    state.stale = [{ id: "ERR-1", riderId: 7, assignedAt: ago(3 * 60 * 60_000) }];
    expect(await expireStaleOffers(NOW)).toBe(1);
    expect(errandRepository.releaseOffer).toHaveBeenCalledWith("ERR-1", 7);
    expect(groupBy).not.toHaveBeenCalled();
  });

  it("lets the rider's own answer stand when it lands in the same instant", async () => {
    state.stale = [{ id: "ERR-1", riderId: 7, assignedAt: ago(75_000) }];
    state.releaseCount = 0;
    expect(await expireStaleOffers(NOW)).toBe(0);
  });
});
