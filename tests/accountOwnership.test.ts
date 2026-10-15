import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every account is its own (2026-10-07). Customers are rows in
 * `customer_accounts` and staff and riders rows in `users`, two sequences that
 * both start at 1, so customer 9 and dispatcher 9 are different people with
 * the same number. Each test here is one place where a bare number used to be
 * taken for a person: two dispatchers and two customers registered together
 * received each other's notifications.
 */

const { tx, record } = vi.hoisted(() => {
  const tx = { ops: [] as Array<{ table: string; op: string; args: unknown }> };
  const record = (table: string, op: string) => (args: unknown) => {
    tx.ops.push({ table, op, args });
    return { table, op, args };
  };
  return { tx, record };
});

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    customerAccount: { updateMany: record("customer", "updateMany"), update: record("customer", "update") },
    user: { updateMany: record("user", "updateMany"), update: record("user", "update") },
    $transaction: async (ops: unknown[]) => ops,
    errand: { findMany: async () => watchErrands.rows },
  },
}));
vi.mock("../src/middleware/rateLimiters.js", () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
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
vi.mock("../src/repositories/errandRepository.js", () => ({ errandRepository: {} }));
vi.mock("../src/services/customerService.js", () => ({ registerPushToken: vi.fn(async () => ({ success: true })) }));

const db = vi.hoisted(() => ({
  updates: [] as Array<{ path: string; value: unknown }>,
  sets: [] as Array<{ path: string; value: unknown }>,
  fail: false,
}));
const watchErrands = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));
vi.mock("../src/lib/firebaseAdmin.js", async (original) => ({
  ...(await original<typeof import("../src/lib/firebaseAdmin.js")>()),
  getFirebaseAdminApp: () => ({ name: "app" }),
}));
vi.mock("firebase-admin/database", () => ({
  getDatabaseWithUrl: () => ({
    ref: (path: string) => ({
      update: async (value: unknown) => {
        if (db.fail) throw new Error("firebase down");
        db.updates.push({ path, value });
      },
      set: async (value: unknown) => {
        if (db.fail) throw new Error("firebase down");
        db.sets.push({ path, value });
      },
    }),
  }),
}));

import { identityRooms, io, notifySessionRevoked } from "../src/lib/socket.js";
import { eventPublisher } from "../src/lib/eventPublisher.js";
import { assignPushToken, pushTokenOwnerFor, releasePushToken } from "../src/services/pushTokenOwnership.js";
import { grantCustomerChat, setChatDispatcher } from "../src/lib/chatAccess.js";
import { grantRiderWatch, reconcileRiderWatchers, watchTree } from "../src/lib/riderWatch.js";
import { registerCustomerPushToken } from "../src/controllers/customerController.js";
import userRoutes from "../src/routes/userRoutes.js";
import riderRoutes from "../src/routes/riderRoutes.js";
import customerLocationRoutes from "../src/routes/customerLocationRoutes.js";

beforeEach(() => {
  tx.ops = [];
  db.updates = [];
  db.sets = [];
  db.fail = false;
  watchErrands.rows = [];
});

/** Rooms an io emit was addressed to. */
function roomsOfNextEmit(run: () => void): string[] {
  const rooms: string[] = [];
  const chain = { to: (room: string) => (rooms.push(room), chain), emit: vi.fn() };
  const spy = vi.spyOn(io, "to").mockImplementation(((room: string) => chain.to(room)) as never);
  run();
  spy.mockRestore();
  return rooms;
}

describe("socket rooms", () => {
  it("never puts a customer in the user room of the staff member with its number", () => {
    expect(identityRooms(9, "CUSTOMER")).toEqual(["customer:9", "role:CUSTOMER"]);
    expect(identityRooms(9, "DISPATCHER")).toEqual(["user:9", "role:DISPATCHER"]);
    expect(identityRooms(9, "RIDER")).toEqual(["user:9", "rider:9", "role:RIDER"]);
  });

  it("sends a customer's notification to that customer only", () => {
    expect(roomsOfNextEmit(() => eventPublisher.emitToCustomer(9, "notification:new", {}))).toEqual(["customer:9"]);
  });

  it("sends an errand's news to its people and staff, never to user rooms", () => {
    const rooms = roomsOfNextEmit(() =>
      eventPublisher.emitToErrandParties("e1", { riderId: 4, customerId: 9 }, "order:updated", {})
    );
    expect(rooms).toEqual(expect.arrayContaining(["errand:e1", "role:DISPATCHER", "role:OWNER", "rider:4", "customer:9"]));
    expect(rooms.some((r) => r.startsWith("user:"))).toBe(false);
  });

  it("signs out the right account when a session is revoked", () => {
    expect(roomsOfNextEmit(() => notifySessionRevoked(9, { reason: "x" }, "CUSTOMER"))).toEqual(["customer:9"]);
    expect(roomsOfNextEmit(() => notifySessionRevoked(9, { reason: "x" }, "DISPATCHER"))).toEqual(["user:9"]);
    expect(roomsOfNextEmit(() => notifySessionRevoked(9, { reason: "x" }))).toEqual(["user:9"]);
  });
});

describe("errand events", () => {
  it("are never broadcast to every connected app", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const dir = new URL("../src/services/", import.meta.url);
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .flatMap((f) =>
        readFileSync(new URL(f, dir), "utf8")
          .split("\n")
          .filter((line) => /eventPublisher\.emit\(\s*["'](order|errand|payment):/.test(line))
          .map((line) => `${f}: ${line.trim()}`)
      );
    expect(offenders).toEqual([]);
  });
});

describe("push tokens", () => {
  it("belong to the last account that registered them, in either table", async () => {
    await assignPushToken({ kind: "customer", id: 9 }, "tok");
    expect(tx.ops).toEqual([
      { table: "customer", op: "updateMany", args: { where: { expoPushToken: "tok", NOT: { id: 9 } }, data: { expoPushToken: null } } },
      { table: "user", op: "updateMany", args: { where: { expoPushToken: "tok" }, data: { expoPushToken: null } } },
      { table: "customer", op: "update", args: { where: { id: 9 }, data: { expoPushToken: "tok" } } },
    ]);
  });

  it("are released from the account that signs out, in its own table", async () => {
    await releasePushToken(pushTokenOwnerFor("CUSTOMER", 9));
    await releasePushToken(pushTokenOwnerFor("RIDER", 9));
    expect(tx.ops.map((o) => [o.table, (o.args as { where: unknown }).where])).toEqual([
      ["customer", { id: 9 }],
      ["user", { id: 9 }],
    ]);
  });
});

describe("customer routes", () => {
  it("refuse a dispatcher whose id matches the customer's", async () => {
    const next = vi.fn();
    registerCustomerPushToken(
      { params: { id: "9" }, body: { token: "tok" }, user: { id: 9, role: "DISPATCHER" } } as never,
      { json: vi.fn() } as never,
      next
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
  });
});

type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Function }> } };

/** Runs a route's role guard (the handler after authenticateToken) as `role`. */
function guardAllows(router: unknown, method: string, path: string, role: string): boolean {
  const layer = (router as { stack: Layer[] }).stack.find((l) => l.route?.path === path && l.route?.methods[method]);
  if (!layer?.route) throw new Error(`No ${method} ${path}`);
  let allowed = false;
  const res = { status: () => ({ json: () => undefined }) };
  layer.route.stack[1].handle({ user: { id: 9, role } }, res, () => (allowed = true));
  return allowed;
}

describe("route role guards", () => {
  it.each([
    [userRoutes, "put", "/profile/:userId"],
    [userRoutes, "put", "/password/:userId"],
    [riderRoutes, "put", "/:riderId/photo"],
    [riderRoutes, "delete", "/:riderId/photo"],
  ])("keep customers off staff and rider self-service: %#", (router, method, path) => {
    expect(guardAllows(router, method as string, path as string, "CUSTOMER")).toBe(false);
  });

  it("still let staff and riders edit their own profile", () => {
    expect(guardAllows(userRoutes, "put", "/profile/:userId", "RIDER")).toBe(true);
    expect(guardAllows(userRoutes, "put", "/profile/:userId", "DISPATCHER")).toBe(true);
    expect(guardAllows(riderRoutes, "put", "/:riderId/photo", "RIDER")).toBe(true);
  });

  it.each([
    ["post", "/"],
    ["put", "/:id"],
    ["delete", "/:id"],
  ])("keep staff and riders off a customer's saved addresses: %s %s", (method, path) => {
    expect(guardAllows(customerLocationRoutes, method, path, "DISPATCHER")).toBe(false);
    expect(guardAllows(customerLocationRoutes, method, path, "RIDER")).toBe(false);
    expect(guardAllows(customerLocationRoutes, method, path, "CUSTOMER")).toBe(true);
  });
});

describe("chat access in the Realtime Database", () => {
  it("names the customer on a new errand, then the claiming dispatcher, then nobody on release", async () => {
    await grantCustomerChat("e1", 9);
    await setChatDispatcher("e1", 9);
    await setChatDispatcher("e1", null);
    expect(db.updates).toEqual([
      { path: "chat_access/e1", value: { customer: "customer_9", dispatcher: null } },
      { path: "chat_access/e1", value: { dispatcher: "staff_9" } },
      { path: "chat_access/e1", value: { dispatcher: null } },
    ]);
  });

  it("never fails the order when Firebase does", async () => {
    db.fail = true;
    await expect(grantCustomerChat("e1", 9)).resolves.toBe(false);
  });
});

describe("who may watch a rider in the Realtime Database", () => {
  const errand = (id: string, riderId: number | null, customerId: number, status: string) => ({ id, riderId, customerId, status });

  it("lists a customer only for a rider working their errand now", () => {
    expect(
      watchTree([
        errand("e1", 4, 9, "ASSIGNED"),
        errand("e2", 4, 9, "IN_TRANSIT"),
        errand("e3", 4, 10, "DELIVERED"),
        errand("e4", null, 11, "PENDING"),
        errand("e5", 5, 12, "in_transit"),
      ])
    ).toEqual({
      "4": { customer_9: { e1: true, e2: true } },
      "5": { customer_12: { e5: true } },
    });
  });

  it("grants a new assignment at once, and nothing for an errand not being worked", async () => {
    await expect(grantRiderWatch(errand("e1", 4, 9, "ASSIGNED"))).resolves.toBe(true);
    await expect(grantRiderWatch(errand("e2", 4, 9, "COMPLETED"))).resolves.toBe(false);
    expect(db.sets).toEqual([{ path: "rider_watchers/4/customer_9/e1", value: true }]);
  });

  it("rebuilds the whole list from the errands being worked, so a finished one drops out", async () => {
    watchErrands.rows = [errand("e1", 4, 9, "IN_TRANSIT")];
    await expect(reconcileRiderWatchers()).resolves.toBe(1);
    expect(db.sets).toEqual([{ path: "rider_watchers", value: { "4": { customer_9: { e1: true } } } }]);
  });

  it("never fails an errand change when Firebase does", async () => {
    db.fail = true;
    await expect(grantRiderWatch(errand("e1", 4, 9, "ASSIGNED"))).resolves.toBe(false);
  });
});
