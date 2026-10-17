import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/repositories/errandRepository.js", () => ({
  errandRepository: {
    findById: vi.fn(),
    update: vi.fn(),
  },
  dispatchLogRepository: {
    findUnverifiedByDispatcherId: vi.fn(),
    deleteUnverifiedForErrand: vi.fn(),
  },
}));

vi.mock("../src/lib/chatAccess.js", () => ({
  setChatDispatcher: vi.fn(),
  grantCustomerChat: vi.fn(),
}));

vi.mock("../src/lib/eventPublisher.js", () => ({
  eventPublisher: {
    emit: vi.fn(),
    emitToErrand: vi.fn(),
    emitToErrandParties: vi.fn(),
    emitToRole: vi.fn(),
    emitToRider: vi.fn(),
    emitToCustomer: vi.fn(),
  },
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    errand: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    dwellObservation: {
      findMany: vi.fn(),
    },
    errandPinpoint: {
      findMany: vi.fn(),
    },
    errandDeclineReason: {
      findMany: vi.fn(),
    },
    dispatchLog: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("../src/services/exceptionService.js", () => ({
  findExceptions: vi.fn().mockResolvedValue([]),
}));

import { errandRepository, dispatchLogRepository } from "../src/repositories/errandRepository.js";
import { releaseAllUnverifiedForDispatcher } from "../src/services/errandService.js";
import { setChatDispatcher } from "../src/lib/chatAccess.js";
import { eventPublisher } from "../src/lib/eventPublisher.js";
import { prisma } from "../src/lib/prisma.js";
import { getDispatcherDashboardSummary } from "../src/controllers/dispatcherDashboardController.js";

describe("Shift Handover: releaseAllUnverifiedForDispatcher", () => {
  const DISPATCHER_ID = 5;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(errandRepository.findById).mockImplementation((id: string) =>
      Promise.resolve({
        id,
        customerId: 10,
        riderId: null,
        status: "AVAILABLE",
      } as never)
    );
    vi.mocked(errandRepository.update).mockResolvedValue({} as never);
    vi.mocked(dispatchLogRepository.deleteUnverifiedForErrand).mockResolvedValue({ count: 1 } as never);
    vi.mocked(setChatDispatcher).mockResolvedValue(undefined as never);
  });

  it("releases all unverified, unassigned pending orders claimed by the logging-out dispatcher", async () => {
    vi.mocked(dispatchLogRepository.findUnverifiedByDispatcherId).mockResolvedValue([
      {
        id: 1,
        errandId: "err-1",
        dispatcherId: DISPATCHER_ID,
        verifiedAt: null,
        errand: { id: "err-1", status: "PENDING", riderId: null },
      },
      {
        id: 2,
        errandId: "err-2",
        dispatcherId: DISPATCHER_ID,
        verifiedAt: null,
        errand: { id: "err-2", status: "PENDING", riderId: null },
      },
    ] as never);

    const released = await releaseAllUnverifiedForDispatcher(DISPATCHER_ID);

    expect(released).toBe(2);
    expect(dispatchLogRepository.deleteUnverifiedForErrand).toHaveBeenCalledWith("err-1", DISPATCHER_ID);
    expect(dispatchLogRepository.deleteUnverifiedForErrand).toHaveBeenCalledWith("err-2", DISPATCHER_ID);
    expect(setChatDispatcher).toHaveBeenCalledWith("err-1", null);
    expect(setChatDispatcher).toHaveBeenCalledWith("err-2", null);
    expect(errandRepository.update).toHaveBeenCalledWith("err-1", { status: "AVAILABLE" });
    expect(errandRepository.update).toHaveBeenCalledWith("err-2", { status: "AVAILABLE" });
    expect(eventPublisher.emitToRole).toHaveBeenCalledWith("DISPATCHER", "order:new", expect.objectContaining({ id: "err-1" }));
    expect(eventPublisher.emitToRole).toHaveBeenCalledWith("DISPATCHER", "order:new", expect.objectContaining({ id: "err-2" }));
  });

  it("skips orders that have already been assigned to a rider or have verified reviews", async () => {
    vi.mocked(dispatchLogRepository.findUnverifiedByDispatcherId).mockResolvedValue([
      {
        id: 1,
        errandId: "err-assigned",
        dispatcherId: DISPATCHER_ID,
        verifiedAt: null,
        errand: { id: "err-assigned", status: "PENDING", riderId: 42 }, // Rider assigned
      },
      {
        id: 2,
        errandId: "err-in-transit",
        dispatcherId: DISPATCHER_ID,
        verifiedAt: null,
        errand: { id: "err-in-transit", status: "IN_TRANSIT", riderId: null },
      },
    ] as never);

    const released = await releaseAllUnverifiedForDispatcher(DISPATCHER_ID);

    expect(released).toBe(0);
    expect(dispatchLogRepository.deleteUnverifiedForErrand).not.toHaveBeenCalled();
    expect(errandRepository.update).not.toHaveBeenCalled();
  });
});

describe("Dispatcher Dashboard Aggregation: getDispatcherDashboardSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("aggregates operational pulse metrics and deduplicates attention radar items", async () => {
    vi.mocked(prisma.errand.count)
      .mockResolvedValueOnce(4) // unclaimedCount
      .mockResolvedValueOnce(2) // urgentUnclaimedCount
      .mockResolvedValueOnce(18); // deliveredTodayCount

    vi.mocked(prisma.errand.findMany)
      .mockResolvedValueOnce([
        {
          id: "e1",
          status: "PENDING",
          itemsPurchasedAt: null,
          halfPaymentRequestedAt: null,
          proximityAlertSentAt: null,
        },
        {
          id: "e2",
          status: "ASSIGNED",
          itemsPurchasedAt: null,
          halfPaymentRequestedAt: null,
          proximityAlertSentAt: null,
        },
        {
          id: "e3",
          status: "IN_TRANSIT",
          itemsPurchasedAt: new Date(),
          halfPaymentRequestedAt: null,
          proximityAlertSentAt: null,
        },
      ] as never) // activeErrands
      .mockResolvedValueOnce([
        {
          id: "stale-1",
          category: "Grocery",
          pickupAddress: "KCC",
          deliveryAddress: "Poblacion",
          createdAt: new Date(Date.now() - 5 * 60 * 1000),
          pinpoints: [{ storeName: "KCC Supermarket" }],
        },
      ] as never) // staleUnclaimedErrands
      .mockResolvedValueOnce([
        {
          id: "stale-1", // duplicate errand id with overage dispute
          status: "CANCELLED",
          overageEscalatedAt: null,
          updatedAt: new Date(),
          pinpoints: [{ storeName: "KCC Supermarket" }],
        },
      ] as never); // disputedErrands

    vi.mocked(prisma.dwellObservation.findMany).mockResolvedValueOnce([
      {
        id: 101,
        errandId: "e-dwell",
        dwellSeconds: 1500,
        createdAt: new Date(),
        pinpoint: { storeName: "Mercury Drug" },
      },
    ] as never);

    vi.mocked(prisma.errandPinpoint.findMany).mockResolvedValueOnce([
      { storeName: "KCC Supermarket" },
      { storeName: "KCC Supermarket" },
      { storeName: "Mercury Drug" },
    ] as never);

    vi.mocked(prisma.errandDeclineReason.findMany).mockResolvedValueOnce([
      { reason: "Store closed" },
    ] as never);

    vi.mocked(prisma.dispatchLog.findMany).mockResolvedValueOnce([
      {
        dispatchedAt: new Date(Date.now() - 10 * 1000),
        verifiedAt: new Date(),
        errand: { createdAt: new Date(Date.now() - 70 * 1000) },
      },
      {
        dispatchedAt: new Date(Date.now() - 5 * 1000),
        verifiedAt: null, // claimed but not verified
        errand: { createdAt: new Date(Date.now() - 35 * 1000) },
      },
    ] as never);

    const req: any = { user: { id: 5, role: "DISPATCHER" } };
    let jsonResult: any = null;
    const next = vi.fn((err) => {
      if (err) console.error("Error in getDispatcherDashboardSummary:", err);
    });
    const res: any = {
      json: vi.fn((data) => {
        jsonResult = data;
      }),
    };

    getDispatcherDashboardSummary(req, res, next);
    await vi.waitFor(() => expect(res.json).toHaveBeenCalled());

    expect(next).not.toHaveBeenCalled();
    expect(jsonResult).not.toBeNull();
    expect(jsonResult.unclaimedCount).toBe(4);
    expect(jsonResult.urgentUnclaimedCount).toBe(2);
    // Active in motion excludes PENDING review errands:
    expect(jsonResult.activeInMotionCount).toBe(2);
    expect(jsonResult.deliveredTodayCount).toBe(18);

    // Pipeline phases:
    expect(jsonResult.pipeline.claimed).toBe(1);
    expect(jsonResult.pipeline.toStore).toBe(1);
    expect(jsonResult.pipeline.bought).toBe(1);

    // Attention radar items: 'stale-1' was in stale unclaimed and dispute, deduplicated to 1!
    const staleItems = jsonResult.attentionItems.filter((i: any) => i.errandId === "stale-1");
    expect(staleItems).toHaveLength(1);

    // Shift stats: myHandledToday counts verified orders only (1 verified, 1 unverified)
    expect(jsonResult.myShiftStats.myHandledToday).toBe(1);
    // Average claim latency across both claims: (60s + 30s) / 2 = 45s
    expect(jsonResult.myShiftStats.myAvgClaimLatencySeconds).toBe(45);
  });
});
