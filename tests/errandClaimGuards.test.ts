import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Two errand guards the Codex security scan (2026-11-02) found missing:
 * - confirming a payment mode is the customer's choice, and the service only
 *   compared a bare id, which rider 9 or dispatcher 9 shares with customer 9;
 * - a dispatcher's review decline cancels the errand, and it skipped the claim
 *   check every other dispatcher mutation makes.
 */

const { errand, createDecline } = vi.hoisted(() => ({
  errand: {} as Record<string, unknown>,
  createDecline: vi.fn(async () => ({})),
}));

vi.mock("../src/lib/prisma.js", () => ({ prisma: {} }));
vi.mock("../src/middleware/rateLimiters.js", () => {
  const pass = (_q: unknown, _s: unknown, next: () => void) => next();
  return {
    loginLimiter: pass,
    readLimiter: pass,
    userApiLimiter: pass,
    verificationLimiter: pass,
    passwordResetLimiter: pass,
    trackingLimiter: pass,
    itemTidyLimiter: pass,
    itemStoreCheckLimiter: pass,
  };
});
vi.mock("../src/repositories/errandRepository.js", async (orig) => ({
  ...(await orig<typeof import("../src/repositories/errandRepository.js")>()),
  errandRepository: {
    findById: vi.fn(async () => errand),
    // Stops the decline right after its guard and its first write.
    update: vi.fn(async () => {
      throw new Error("stop here");
    }),
  },
}));
vi.mock("../src/repositories/errandDeclineRepository.js", () => ({
  errandDeclineRepository: { create: createDecline, findByErrandId: vi.fn() },
}));

import errandRoutes from "../src/routes/errandRoutes.js";
import { declineErrandReview } from "../src/controllers/errandController.js";

type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Function }> } };

/** Runs a route's role guard (the handler after authenticateToken) as `role`. */
function guardAllows(method: string, path: string, role: string): boolean {
  const layer = (errandRoutes as unknown as { stack: Layer[] }).stack.find(
    (l) => l.route?.path === path && l.route?.methods[method]
  );
  if (!layer?.route) throw new Error(`No ${method} ${path}`);
  let allowed = false;
  const res = { status: () => ({ json: () => undefined }) };
  layer.route.stack[1].handle({ user: { id: 9, role } }, res, () => (allowed = true));
  return allowed;
}

async function decline(callerId: number, role = "DISPATCHER") {
  const next = vi.fn();
  declineErrandReview(
    { params: { id: "E1" }, body: { reason: "Store is closed" }, user: { id: callerId, role } } as never,
    { json: vi.fn() } as never,
    next
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  return next;
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(errand, {
    id: "E1",
    status: "PENDING",
    customerId: 9,
    riderId: null,
    dispatchLogs: [{ dispatcherId: 2, dispatcher: { firstName: "Ana", lastName: "Reyes" } }],
  });
});

describe("confirming a payment mode", () => {
  it("is the customer's step only", () => {
    expect(guardAllows("post", "/:id/payment-selection", "CUSTOMER")).toBe(true);
    expect(guardAllows("post", "/:id/payment-selection", "RIDER")).toBe(false);
    expect(guardAllows("post", "/:id/payment-selection", "DISPATCHER")).toBe(false);
  });
});

describe("a dispatcher's review decline", () => {
  it("refuses a dispatcher who did not claim the errand, and records nothing", async () => {
    const next = await decline(3);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(createDecline).not.toHaveBeenCalled();
  });

  it("lets the claiming dispatcher through", async () => {
    await decline(2);
    expect(createDecline).toHaveBeenCalledWith(expect.objectContaining({ errandId: "E1", dispatcherId: 2 }));
  });

  it("lets the owner through on anyone's claim", async () => {
    await decline(1, "OWNER");
    expect(createDecline).toHaveBeenCalled();
  });
});
