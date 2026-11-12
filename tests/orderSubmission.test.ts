import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ rows: new Map<string, any>(), sequence: 0 }));
vi.mock("../src/repositories/errandRepository.js", () => ({
  errandRepository: {
    findBySubmission: vi.fn(async (customerId: number, id: string) => db.rows.get(`${customerId}:${id}`) ?? null),
    create: vi.fn(async (data: any) => {
      await Promise.resolve(); // Let simultaneous requests both miss the initial read.
      const key = `${data.customerId}:${data.submissionId}`;
      if (data.submissionId && db.rows.has(key)) throw Object.assign(new Error("Unique constraint"), { code: "P2002" });
      const row = { ...data, id: `order-${++db.sequence}`, pabiliDetails: [], pabiliItemRequests: [], pinpoints: [] };
      if (data.submissionId) db.rows.set(key, row);
      return row;
    }),
  }, dispatchLogRepository: {},
}));
vi.mock("../src/lib/rateConfigCache.js", () => ({ getCachedRateConfig: vi.fn(async () => null) }));
vi.mock("../src/repositories/customerTransactionRepository.js", () => ({ customerTransactionRepository: { create: vi.fn() } }));
vi.mock("../src/services/patterns/categoryFeeModes.js", () => ({ modesForCategoryNames: vi.fn(async () => []), resolveCategoryModes: vi.fn() }));
vi.mock("../src/lib/category/categoryServiceClient.js", () => ({ warmItemCategories: vi.fn() }));
vi.mock("../src/lib/eventPublisher.js", () => ({ eventPublisher: { emitToErrandParties: vi.fn() } }));
vi.mock("../src/lib/chatAccess.js", () => ({ grantCustomerChat: vi.fn(async () => true), setChatDispatcher: vi.fn() }));
vi.mock("../src/lib/riderWatch.js", () => ({ isWatchable: () => false, scheduleRiderWatchReconcile: vi.fn(), grantRiderWatch: vi.fn() }));
vi.mock("../src/lib/serviceArea.js", () => ({ isServiceAreaConfigured: () => false, isWithinServiceBuffer: () => true, isWithinServiceArea: () => true }));
vi.mock("../src/lib/prisma.js", () => ({ prisma: {} }));

import { createErrand, getSubmissionForCustomer } from "../src/services/errandService.js";
import { createErrand as placeOrder, getSubmissionStatus } from "../src/controllers/errandController.js";
import { errandRepository } from "../src/repositories/errandRepository.js";
import { customerTransactionRepository } from "../src/repositories/customerTransactionRepository.js";
import { eventPublisher } from "../src/lib/eventPublisher.js";
import { grantCustomerChat } from "../src/lib/chatAccess.js";
import { createErrandSchema } from "../src/validators/errandValidators.js";
import { submissionHash } from "../src/services/patterns/submissionIdentity.js";

const id = "submission-abcdefghijklmnopqrst";
const order = (extra: Record<string, unknown> = {}) => createErrandSchema.parse({
  submissionId: id, deliveryAddress: "Customer's saved address", storeCount: 1,
  pabiliItems: [{ itemName: "Rice", quantity: 2, size: "1 kg" }], ...extra,
});

beforeEach(() => { vi.clearAllMocks(); db.rows.clear(); db.sequence = 0; });

describe("safe order submission", () => {
  it("returns the original order after a lost confirmation without repeating creation effects", async () => {
    const first = await createErrand(7, order());
    const retried = await createErrand(7, order());
    expect(retried.id).toBe(first.id);
    expect(errandRepository.create).toHaveBeenCalledTimes(1);
    expect(grantCustomerChat).toHaveBeenCalledTimes(1);
    expect(eventPublisher.emitToErrandParties).toHaveBeenCalledTimes(1);
    expect(customerTransactionRepository.create).not.toHaveBeenCalled();
    expect(vi.mocked(errandRepository.create).mock.calls[0][0]).toMatchObject({
      submissionId: id, submissionHash: expect.any(String),
      transaction: { create: { customerId: 7, amount: 80, paymentMethod: "PENDING" } },
    });
  });

  it("resolves simultaneous creates to one order and one dispatcher event", async () => {
    const result = await Promise.all(Array.from({ length: 8 }, () => createErrand(7, order())));
    expect(new Set(result.map((r) => r.id)).size).toBe(1);
    expect(db.rows.size).toBe(1);
    expect(eventPublisher.emitToErrandParties).toHaveBeenCalledTimes(1);
  });

  it("refuses a changed basket under an existing identity", async () => {
    await createErrand(7, order());
    await expect(createErrand(7, order({ pabiliItems: [{ itemName: "Bread", quantity: 1 }] }))).rejects.toMatchObject({ status: 409 });
    expect(errandRepository.create).toHaveBeenCalledTimes(1);
  });

  it("also detects different concurrent baskets using the same identity", async () => {
    const results = await Promise.allSettled([
      createErrand(7, order()), createErrand(7, order({ deliveryAddress: "A different address" })),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { status: 409 } });
  });

  it("scopes identities and status to the customer", async () => {
    const a = await createErrand(7, order());
    expect(await getSubmissionForCustomer(8, id)).toBeNull();
    const b = await createErrand(8, order());
    expect(a.id).not.toBe(b.id);
  });

  it("keeps older clients without an identity compatible", async () => {
    const a = await createErrand(7, order({ submissionId: undefined }));
    const b = await createErrand(7, order({ submissionId: undefined }));
    expect(a.id).not.toBe(b.id);
    expect(customerTransactionRepository.create).toHaveBeenCalledTimes(2);
  });

  it("does not reinterpret infrastructure errors as successful creation", async () => {
    vi.mocked(errandRepository.create).mockRejectedValueOnce(new Error("Database unavailable"));
    await expect(createErrand(7, order())).rejects.toThrow("Database unavailable");
    expect(eventPublisher.emitToErrandParties).not.toHaveBeenCalled();
  });

  it("hashes parsed object contents independently of key order, preserving item order", () => {
    expect(submissionHash({ x: 1, nested: { a: 2, b: 3 } })).toBe(submissionHash({ nested: { b: 3, a: 2 }, x: 1 }));
    expect(submissionHash({ items: [1, 2] })).not.toBe(submissionHash({ items: [2, 1] }));
  });

  it("validates identity before querying", () => {
    expect(createErrandSchema.safeParse({ submissionId: "../invalid" }).success).toBe(false);
    expect(createErrandSchema.safeParse({ submissionId: "x".repeat(81) }).success).toBe(false);
  });
});

async function handle(handler: any, req: any) {
  const next = vi.fn();
  const res = { status: vi.fn(() => res), json: vi.fn() };
  handler(req, res, next);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { res, next };
}

describe("authenticated submission endpoints", () => {
  it("refuses an identified basket replayed under a different account", async () => {
    const result = await handle(placeOrder, { user: { id: 7, role: "CUSTOMER" }, body: order({ customerId: 99 }) });
    expect(result.next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(await getSubmissionForCustomer(7, id)).toBeNull();
    expect(await getSubmissionForCustomer(99, id)).toBeNull();
  });

  it("returns NOT_FOUND without leaking another customer's order", async () => {
    await createErrand(7, order());
    const result = await handle(getSubmissionStatus, { user: { id: 8 }, params: { submissionId: id } });
    expect(result.res.json).toHaveBeenCalledWith({ submissionId: id, status: "NOT_FOUND", errand: null });
  });

  it("returns the authenticated customer's confirmed order", async () => {
    const created = await createErrand(7, order());
    const result = await handle(getSubmissionStatus, { user: { id: 7 }, params: { submissionId: id } });
    expect(result.res.json).toHaveBeenCalledWith(expect.objectContaining({ status: "CONFIRMED", errand: expect.objectContaining({ id: created.id }) }));
  });
});
