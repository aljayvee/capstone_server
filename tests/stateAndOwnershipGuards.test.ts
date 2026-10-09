import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Guards added after the 2026-10-09 audit: who may confirm an order, when a
 * rating may be left, and when cash may be settled and on what terms.
 */

const { errand, findSettlement, createSettlement, findRating, createRating } = vi.hoisted(() => ({
  errand: {} as any,
  findSettlement: vi.fn(),
  createSettlement: vi.fn(async (data: object) => data),
  findRating: vi.fn(),
  createRating: vi.fn(async () => ({ id: 1 })),
}));

vi.mock("../src/repositories/errandRepository.js", () => ({
  errandRepository: {
    findById: vi.fn(async () => errand),
    findByIdBasic: vi.fn(async () => errand),
    update: vi.fn(async (_: string, data: object) => ({ ...errand, ...data })),
  },
  dispatchLogRepository: {},
}));
vi.mock("../src/repositories/settlementRepository.js", () => ({
  settlementRepository: { findByErrandId: findSettlement, create: createSettlement },
}));
vi.mock("../src/repositories/ratingRepository.js", () => ({
  ratingRepository: { findByErrandId: findRating, create: createRating },
}));
vi.mock("../src/repositories/paymentSelectionRepository.js", () => ({
  paymentSelectionRepository: { findByErrandId: vi.fn(async () => null) },
}));
vi.mock("../src/repositories/errandPaymentRepository.js", () => ({
  errandPaymentRepository: { findAmountsByErrandId: vi.fn(async () => []) },
}));
vi.mock("../src/services/patterns/paymentModes.js", async (orig) => ({
  ...(await orig<object>()),
  riderCollectsCash: vi.fn(() => true),
  hasPaymentLedger: vi.fn(() => false),
}));
vi.mock("../src/services/transactionStatusService.js", () => ({
  syncTransactionStatusQuietly: vi.fn(),
  syncTransactionStatus: vi.fn(async () => undefined),
}));
vi.mock("../src/lib/eventPublisher.js", () => ({
  eventPublisher: { emit: vi.fn(), emitToErrand: vi.fn(), emitToErrandParties: vi.fn(), emitToRole: vi.fn(), emitToRider: vi.fn(), emitToCustomer: vi.fn() },
}));
vi.mock("../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { submitSettlement } = await import("../src/services/settlementService.js");
const { submitRating } = await import("../src/services/ratingService.js");
const { confirmOrder } = await import("../src/services/errandService.js");
const { errandRepository } = await import("../src/repositories/errandRepository.js");
const { syncTransactionStatusQuietly } = await import("../src/services/transactionStatusService.js");

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(errand, {
    id: "ERR-1",
    customerId: 5,
    riderId: 7,
    status: "DELIVERED",
    totalCost: 1500,
    deliveryFee: 70,
    groceryFee: null,
    estimatedCost: 1430,
  });
  findSettlement.mockResolvedValue(null);
  findRating.mockResolvedValue(null);
});

describe("confirmOrder", () => {
  it("refuses an order that belongs to another customer, and stamps nothing", async () => {
    await expect(confirmOrder("ERR-1", 6)).rejects.toMatchObject({ status: 403 });
    expect(errandRepository.update).not.toHaveBeenCalled();
  });

  it("stamps the quote for the errand's own customer", async () => {
    await confirmOrder("ERR-1", 5);
    expect(errandRepository.update).toHaveBeenCalledWith("ERR-1", { quotedDeliveryFee: 70 });
  });
});

describe("submitRating", () => {
  it.each(["ASSIGNED", "IN_TRANSIT", "CANCELLED"])("refuses a rating while the errand is %s", async (status) => {
    errand.status = status;
    await expect(submitRating("ERR-1", 5, { stars: 1 } as any)).rejects.toMatchObject({ status: 400 });
    expect(createRating).not.toHaveBeenCalled();
  });

  it("accepts one once delivered", async () => {
    await submitRating("ERR-1", 5, { stars: 5 } as any);
    expect(createRating).toHaveBeenCalled();
  });
});

describe("submitSettlement", () => {
  it.each(["ASSIGNED", "IN_TRANSIT"])("refuses to settle while the errand is %s", async (status) => {
    errand.status = status;
    await expect(submitSettlement("ERR-1", 7, { collectedInFull: true })).rejects.toMatchObject({ status: 409 });
    expect(createSettlement).not.toHaveBeenCalled();
  });

  it("refuses a shortfall that gives no reason", async () => {
    await expect(submitSettlement("ERR-1", 7, { collectedAmount: 0 })).rejects.toMatchObject({ status: 400 });
    await expect(submitSettlement("ERR-1", 7, { collectedAmount: 900, shortReason: "   " })).rejects.toMatchObject({
      status: 400,
    });
    expect(createSettlement).not.toHaveBeenCalled();
  });

  it("records a shortfall that explains itself", async () => {
    await submitSettlement("ERR-1", 7, { collectedAmount: 1400, shortReason: "Walang barya si customer" });
    expect(createSettlement).toHaveBeenCalledWith(expect.objectContaining({ status: "SHORT", variance: -100 }));
  });

  it("still settles in full with no reason at all", async () => {
    await submitSettlement("ERR-1", 7, { collectedInFull: true });
    expect(createSettlement).toHaveBeenCalledWith(expect.objectContaining({ status: "MATCHED", shortReason: null }));
    expect(syncTransactionStatusQuietly).toHaveBeenCalledWith("ERR-1");
  });
});
