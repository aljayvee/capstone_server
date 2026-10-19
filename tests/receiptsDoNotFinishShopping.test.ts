import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A receipt reprices the errand; only the rider says the shopping is done.
 *
 * Each confirmed receipt used to run markItemsPurchased, which stamps
 * itemsPurchasedAt. On a two-store errand that happened at store one, so the
 * customer was pushed "Your order is on the way" and shown the delivery map
 * while the rider still had a store to go.
 */

const ERRAND_ID = "ERR-TWO-STORES";
const RIDER_ID = 7;

let stored: { id: string; riderId: number; itemsPurchasedAt: Date | null };

vi.mock("../src/repositories/errandRepository.js", () => ({
  errandRepository: {
    findByIdBasic: vi.fn(async () => stored),
    findById: vi.fn(async () => ({ ...stored, pinpoints: [] })),
    update: vi.fn(async () => stored),
    // The customer's errands with this rider: just this one, unless a test
    // gives them another order at the same door (deliveryHold.ts).
    findHoldCandidates: vi.fn(async () => [stored]),
  },
  dispatchLogRepository: {},
}));

vi.mock("../src/repositories/rateConfigRepository.js", () => ({
  // No rate config: recalculateFee returns the errand as it stands.
  rateConfigRepository: { findFirst: vi.fn(async () => null) },
}));

vi.mock("../src/lib/eventPublisher.js", () => ({
  eventPublisher: { emit: vi.fn(), emitToErrand: vi.fn(), emitToErrandParties: vi.fn(), emitToRole: vi.fn(), emitToRider: vi.fn(), emitToCustomer: vi.fn() },
}));

vi.mock("../src/services/errandPaymentService.js", () => ({
  checkReceiptOverage: vi.fn(async () => undefined),
}));

vi.mock("../src/services/deliveryReminderService.js", () => ({
  inBackground: vi.fn(),
  notifyOnTheWay: vi.fn(async () => undefined),
  notifyDeliveryHeld: vi.fn(async () => undefined),
}));

vi.mock("../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { errandRepository } = await import("../src/repositories/errandRepository.js");
const errandPaymentService = await import("../src/services/errandPaymentService.js");
const deliveryReminders = await import("../src/services/deliveryReminderService.js");
const { applyReceiptTotal, markItemsPurchased } = await import("../src/services/errandService.js");

beforeEach(() => {
  vi.clearAllMocks();
  stored = { id: ERRAND_ID, riderId: RIDER_ID, itemsPurchasedAt: null };
});

describe("a confirmed receipt", () => {
  it("reprices the basket without saying everything is bought", async () => {
    await applyReceiptTotal(ERRAND_ID, RIDER_ID, 176);

    expect(errandRepository.update).toHaveBeenCalledWith(ERRAND_ID, { estimatedCost: 176 });
    const written = vi.mocked(errandRepository.update).mock.calls.flatMap(([, data]) => Object.keys(data as object));
    expect(written).not.toContain("itemsPurchasedAt");
  });

  it("sends the customer nothing", async () => {
    await applyReceiptTotal(ERRAND_ID, RIDER_ID, 176);
    expect(deliveryReminders.notifyOnTheWay).not.toHaveBeenCalled();
    expect(deliveryReminders.inBackground).not.toHaveBeenCalled();
  });

  it("still catches a basket that went over what the customer agreed to", async () => {
    await applyReceiptTotal(ERRAND_ID, RIDER_ID, 1170);
    expect(errandPaymentService.checkReceiptOverage).toHaveBeenCalledWith(ERRAND_ID, 1170);
  });

  it("refuses a rider the errand is not assigned to", async () => {
    await expect(applyReceiptTotal(ERRAND_ID, 99, 176)).rejects.toMatchObject({ status: 403 });
    expect(errandRepository.update).not.toHaveBeenCalled();
  });
});

describe("the rider heading to the customer", () => {
  it("is what marks the items bought and tells the customer", async () => {
    await markItemsPurchased(ERRAND_ID, RIDER_ID);

    expect(errandRepository.update).toHaveBeenCalledWith(
      ERRAND_ID,
      expect.objectContaining({ itemsPurchasedAt: expect.any(Date) })
    );
    await vi.waitFor(() =>
      expect(deliveryReminders.notifyOnTheWay).toHaveBeenCalledWith(ERRAND_ID, { together: 0 })
    );
  });

  it("tells the customer only once", async () => {
    stored.itemsPurchasedAt = new Date();
    await markItemsPurchased(ERRAND_ID, RIDER_ID);
    expect(deliveryReminders.notifyOnTheWay).not.toHaveBeenCalled();
  });
});

describe("bought while the same customer's other order is still being shopped", () => {
  const door = { customerId: 42, status: "IN_TRANSIT", deliveryLatitude: 6.6915, deliveryLongitude: 124.6772 };

  afterEach(() => {
    vi.mocked(errandRepository.findById).mockImplementation(async () => ({ ...stored, pinpoints: [] }) as any);
    vi.mocked(errandRepository.findHoldCandidates).mockImplementation(async () => [stored] as any);
  });

  it("says the two will come together, not that this one is on the way", async () => {
    const bought = { ...stored, ...door, itemsPurchasedAt: new Date() };
    const other = { ...bought, id: "ERR-SECOND", itemsPurchasedAt: null, acceptedAt: new Date() };
    vi.mocked(errandRepository.findById).mockResolvedValue({ ...bought, pinpoints: [] } as any);
    vi.mocked(errandRepository.findHoldCandidates).mockResolvedValue([bought, other] as any);

    await markItemsPurchased(ERRAND_ID, RIDER_ID);

    await vi.waitFor(() => expect(deliveryReminders.notifyDeliveryHeld).toHaveBeenCalledWith(ERRAND_ID));
    expect(deliveryReminders.notifyOnTheWay).not.toHaveBeenCalled();
  });

  it("brings the held order with it once the other is bought too", async () => {
    const second = { ...stored, ...door, itemsPurchasedAt: new Date() };
    const held = { ...second, id: "ERR-FIRST", itemsPurchasedAt: new Date(Date.now() - 600_000) };
    vi.mocked(errandRepository.findById).mockResolvedValue({ ...second, pinpoints: [] } as any);
    vi.mocked(errandRepository.findHoldCandidates).mockResolvedValue([held, second] as any);

    await markItemsPurchased(ERRAND_ID, RIDER_ID);

    await vi.waitFor(() =>
      expect(deliveryReminders.notifyOnTheWay).toHaveBeenCalledWith(ERRAND_ID, { together: 1 })
    );
    expect(deliveryReminders.notifyDeliveryHeld).not.toHaveBeenCalled();
  });
});
