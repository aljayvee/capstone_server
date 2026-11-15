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
  state: { errand: {} as any, acceptCount: 1, releaseCount: 1, stale: [] as any[], declines: [] as any[] },
  // assignRider's first query on the automatic path. Failing it stops the
  // reassignment there, so a call to it is the sign one was attempted.
  groupBy: vi.fn(async () => {
    throw new Error("no riders in this test");
  }),
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: { errand: { groupBy }, user: { findUnique: vi.fn(async () => ({ firstName: "Ana", lastName: "Cruz" })) } },
}));
vi.mock("../src/repositories/riderOfferDeclineRepository.js", () => ({
  riderOfferDeclineRepository: {
    create: vi.fn(async () => ({})),
    findForErrand: vi.fn(async () => state.declines),
  },
}));
vi.mock("../src/repositories/errandRepository.js", () => ({
  errandRepository: {
    findStatusAndRiderById: vi.fn(async () => ({
      status: state.errand.status,
      riderId: state.errand.riderId,
      assignedAt: state.errand.assignedAt ?? null,
    })),
    findById: vi.fn(async () => state.errand),
    countInTransitForRider: vi.fn(async () => 0),
    acceptOffer: vi.fn(async () => state.acceptCount),
    releaseOffer: vi.fn(async () => state.releaseCount),
    findOffersAssignedBefore: vi.fn(async () => state.stale),
  },
  dispatchLogRepository: {},
}));
vi.mock("../src/services/etaService.js", () => ({ recomputeInBackground: vi.fn() }));
// Nobody is reachable: the assign tests below only need the exclusion to run.
vi.mock("../src/services/riderBeaconService.js", () => ({ availabilityForRiders: vi.fn(async () => new Map()) }));
vi.mock("../src/lib/eventPublisher.js", () => ({
  eventPublisher: { emit: vi.fn(), emitToErrand: vi.fn(), emitToErrandParties: vi.fn(), emitToRole: vi.fn(), emitToRider: vi.fn(), emitToCustomer: vi.fn() },
}));
vi.mock("../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  acceptErrand,
  assignRider,
  declineErrand,
  expireStaleOffers,
  AUTO_REASSIGN_DECLINE_CAP,
  OFFER_EXPIRY_MS,
  OFFER_EXPIRED_REASON,
} = await import("../src/services/errandService.js");
const { eventPublisher } = await import("../src/lib/eventPublisher.js");
const { errandRepository } = await import("../src/repositories/errandRepository.js");
const { riderOfferDeclineRepository } = await import("../src/repositories/riderOfferDeclineRepository.js");
const { logger } = await import("../src/lib/logger.js");

const NOW = new Date("2026-10-09T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

beforeEach(() => {
  vi.clearAllMocks();
  state.errand = { id: "ERR-1", status: "ASSIGNED", riderId: 7, customerId: 5 };
  state.acceptCount = 1;
  state.releaseCount = 1;
  state.stale = [];
  // This decline only, as declineErrand's own create would leave it.
  state.declines = [{ riderId: 7, kind: "DECLINED" }];
});

// The announcement is fire-and-forget (it looks the rider's name up first).
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const declinedEvents = () =>
  vi.mocked(eventPublisher.emitToRole).mock.calls.filter(([, event]) => event === "errand:rider_declined");

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

// The permanent record (2026-10-25): releaseOffer clears riderId, so this row
// is the only thing left that ties the rider to the offer they refused.
describe("declineErrand records the decline", () => {
  it("keeps who declined, which errand, the reason and when it was offered", async () => {
    const offeredAt = ago(20_000);
    state.errand = { ...state.errand, assignedAt: offeredAt };
    await declineErrand("ERR-1", 7, "  flat tyre  ");
    expect(riderOfferDeclineRepository.create).toHaveBeenCalledWith({
      riderId: 7,
      errandId: "ERR-1",
      kind: "DECLINED",
      reason: "flat tyre",
      offeredAt,
    });
  });

  it("records nothing when the offer was no longer open", async () => {
    state.releaseCount = 0;
    await expect(declineErrand("ERR-1", 7, "busy")).rejects.toMatchObject({ status: 409 });
    expect(riderOfferDeclineRepository.create).not.toHaveBeenCalled();
  });

  it("records the rider app's own countdown running out as a lapse, not a refusal", async () => {
    await declineErrand("ERR-1", 7, OFFER_EXPIRED_REASON);
    expect(riderOfferDeclineRepository.create).toHaveBeenCalledWith(expect.objectContaining({ kind: "EXPIRED" }));
  });

  it("still hands the offer on when the record cannot be written", async () => {
    vi.mocked(riderOfferDeclineRepository.create).mockRejectedValueOnce(new Error("db down"));
    await declineErrand("ERR-1", 7, "busy");
    expect(logger.error).toHaveBeenCalled();
    expect(groupBy).toHaveBeenCalled();
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

  it("records an expired offer as a lapse against the rider", async () => {
    state.stale = [{ id: "ERR-1", riderId: 7, assignedAt: ago(75_000) }];
    await expireStaleOffers(NOW);
    expect(riderOfferDeclineRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ riderId: 7, errandId: "ERR-1", kind: "EXPIRED" })
    );
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

// 2026-11-14: a rider who declined is never offered that errand again by the
// server, and after AUTO_REASSIGN_DECLINE_CAP refusals a dispatcher decides.
describe("declined riders stay off the errand", () => {
  it("does not hand it back to an earlier decliner when the next rider declines too", async () => {
    // Rider 3 declined first; rider 7 now declines. groupBy is the repeat-customer
    // query and the first place the exclusion list is applied.
    state.declines = [
      { riderId: 3, kind: "DECLINED" },
      { riderId: 7, kind: "DECLINED" },
    ];
    groupBy.mockResolvedValueOnce([
      { riderId: 3, _count: { _all: 1 } },
      { riderId: 7, _count: { _all: 1 } },
    ] as any);
    const { prisma } = await import("../src/lib/prisma.js");
    const findMany = vi.fn(async () => []);
    (prisma as any).user.findMany = findMany;
    // A drop-off, so ranking gets as far as the roster query.
    state.errand = { ...state.errand, deliveryLatitude: 6.69, deliveryLongitude: 124.67 };
    await declineErrand("ERR-1", 7, "busy");
    expect(riderOfferDeclineRepository.findForErrand).toHaveBeenCalledWith("ERR-1");
    // Both decliners were filtered out before the repeat-customer lookup, so the
    // only rider query is the general roster one (no `id: { in: [...] }`).
    expect(findMany).toHaveBeenCalled();
    expect(findMany.mock.calls.some(([args]: any) => args?.where?.id)).toBe(false);
    delete (prisma as any).user.findMany;
  });

  it("refuses the dispatcher's automatic assign with a sentence that names the decliners", async () => {
    state.declines = [
      { riderId: 3, kind: "DECLINED" },
      { riderId: 4, kind: "DECLINED" },
    ];
    groupBy.mockResolvedValueOnce([] as any);
    const { prisma } = await import("../src/lib/prisma.js");
    (prisma as any).user.findMany = vi.fn(async () => [
      { id: 3, firstName: "Ana", lastName: "Cruz", errandsAsRider: [] },
      { id: 4, firstName: "Leo", lastName: "Reyes", errandsAsRider: [] },
    ]);
    state.errand = { ...state.errand, status: "PENDING", riderId: null, deliveryLatitude: 6.69, deliveryLongitude: 124.67 };
    await expect(assignRider("ERR-1")).rejects.toMatchObject({
      status: 404,
      message: expect.stringContaining("2 riders have already declined this errand."),
    });
    delete (prisma as any).user.findMany;
  });

  it("keeps a rider whose offer only lapsed eligible", async () => {
    state.declines = [{ riderId: 3, kind: "EXPIRED" }, { riderId: 7, kind: "DECLINED" }];
    groupBy.mockResolvedValueOnce([{ riderId: 3, _count: { _all: 1 } }] as any);
    const { prisma } = await import("../src/lib/prisma.js");
    const findMany = vi.fn(async () => []);
    (prisma as any).user.findMany = findMany;
    await declineErrand("ERR-1", 7, "busy");
    // Rider 3 reached the repeat-customer lookup: a lapse is not a refusal.
    expect(findMany.mock.calls[0]?.[0]).toMatchObject({ where: { id: { in: [3] } } });
    delete (prisma as any).user.findMany;
  });
});

describe("the auto re-assign cap", () => {
  it("re-offers below the cap and tells dispatchers who declined", async () => {
    await declineErrand("ERR-1", 7, "busy");
    await flush();
    expect(groupBy).toHaveBeenCalled();
    const [[, , payload]] = declinedEvents() as any;
    expect(payload).toMatchObject({
      errandId: "ERR-1",
      riderId: 7,
      riderName: "Ana Cruz",
      kind: "DECLINED",
      reason: "busy",
      attempts: 1,
      cap: AUTO_REASSIGN_DECLINE_CAP,
      // groupBy throws in this suite, so the re-offer finds nobody.
      outcome: "NEEDS_DISPATCHER",
      why: "NO_RIDER",
    });
  });

  it("stops at the cap, counting lapses, and hands the errand to a dispatcher", async () => {
    state.declines = [
      { riderId: 3, kind: "DECLINED" },
      { riderId: 4, kind: "EXPIRED" },
      { riderId: 7, kind: "DECLINED" },
    ];
    await declineErrand("ERR-1", 7, "busy");
    await flush();
    expect(groupBy).not.toHaveBeenCalled();
    expect(declinedEvents()[0]?.[2]).toMatchObject({ attempts: 3, outcome: "NEEDS_DISPATCHER", why: "CAP_REACHED" });
  });

  it("goes to dispatchers and owners only, never through the customer's errand rooms", async () => {
    await declineErrand("ERR-1", 7, "busy");
    await flush();
    expect(declinedEvents().map(([role]) => role).sort()).toEqual(["DISPATCHER", "OWNER"]);
    const partyEvents = vi.mocked(eventPublisher.emitToErrandParties).mock.calls.map(([, , event]) => event);
    expect(partyEvents).not.toContain("errand:rider_declined");
  });

  it("says an hours-old lapse was too old to send on", async () => {
    state.stale = [{ id: "ERR-1", riderId: 7, assignedAt: ago(3 * 60 * 60_000) }];
    state.declines = [{ riderId: 7, kind: "EXPIRED" }];
    await expireStaleOffers(NOW);
    await flush();
    expect(declinedEvents()[0]?.[2]).toMatchObject({ kind: "EXPIRED", why: "OFFER_TOO_OLD" });
  });
});
