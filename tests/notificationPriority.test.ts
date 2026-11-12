import { beforeEach, describe, expect, it, vi } from "vitest";

const { create, findUnreadByRef, bump, findManyUsers, latestLog, countErrands } = vi.hoisted(() => ({
  create: vi.fn(async (data: any) => ({ id: Math.floor(Math.random() * 1e6), isRead: false, ...data })),
  findUnreadByRef: vi.fn(async (..._args: any[]) => null as any),
  bump: vi.fn(async (id: number, data: any) => ({ id, userId: 1, ...data })),
  // Owner 90; dispatchers 50 and 51. Honours an id filter, as Prisma would.
  findManyUsers: vi.fn(async ({ where }: any) =>
    (where.role === "OWNER" ? [{ id: 90 }] : [{ id: 50 }, { id: 51 }]).filter(
      (u) => !where.id?.in || where.id.in.includes(u.id)
    )
  ),
  latestLog: vi.fn(async (..._args: any[]) => ({ dispatcherId: 7 }) as any),
  countErrands: vi.fn(async (..._args: any[]) => 0),
}));

vi.mock("../src/repositories/notificationRepository.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/repositories/notificationRepository.js")>();
  return {
    ...original,
    notificationRepository: { create, findUnreadByRef, bump },
  };
});
vi.mock("../src/repositories/errandRepository.js", () => ({
  dispatchLogRepository: { findLatestByErrandId: latestLog },
  errandRepository: {},
}));
vi.mock("../src/lib/prisma.js", () => ({
  prisma: { user: { findMany: findManyUsers }, errand: { count: countErrands } },
}));
vi.mock("../src/lib/errandReference.js", () => ({ referenceLabel: vi.fn(async () => "261021-ABCDE-0001") }));
vi.mock("../src/lib/eventPublisher.js", () => ({
  eventPublisher: { emitToRole: vi.fn(), emitToUser: vi.fn(), emitToCustomer: vi.fn() },
}));
vi.mock("../src/lib/firebaseAdmin.js", () => ({ getFirebaseAdminApp: () => null }));

import { buildUserListQuery } from "../src/repositories/notificationRepository.js";
import { deliverToStaff, notifyStaff, notifyStaffAboutErrand, parseListQuery } from "../src/services/notificationService.js";
import { OWNER_HIDDEN_TYPES, STAFF_NOTIFICATIONS } from "../src/services/notificationCatalog.js";
import { handleRiderMessage, resetRiderChatWatch } from "../src/services/riderChatWatchService.js";

beforeEach(() => {
  vi.clearAllMocks();
  latestLog.mockImplementation(async () => ({ dispatcherId: 7 }));
  findUnreadByRef.mockImplementation(async () => null);
  countErrands.mockImplementation(async () => 0);
});

const rows = () => create.mock.calls.map((c: any[]) => c[0]);

describe("catalog", () => {
  it("gives every staff type one of the four levels", () => {
    for (const entry of Object.values(STAFF_NOTIFICATIONS)) {
      expect(["LOW", "NORMAL", "HIGH", "CRITICAL"]).toContain(entry.priority);
    }
  });

  it("does not carry the types the user ruled out", () => {
    expect(STAFF_NOTIFICATIONS).not.toHaveProperty("SUBSTITUTE_DECLINED");
    expect(STAFF_NOTIFICATIONS).not.toHaveProperty("PAYMENT_REFUNDED");
  });
});

describe("parseListQuery", () => {
  it("returns null when no list parameter was sent (older clients get every row)", () => {
    expect(parseListQuery({})).toBeNull();
  });

  it("reads search, sort, levels, types, unread and page", () => {
    expect(
      parseListQuery({
        q: "  signal ",
        sort: "priority",
        priority: "high,critical,bogus",
        type: "rider_chat_message,bad type",
        unread: "1",
        limit: "20",
        offset: "40",
      })
    ).toEqual({
      q: "signal",
      sort: "priority",
      priorities: ["HIGH", "CRITICAL"],
      types: ["RIDER_CHAT_MESSAGE"],
      unreadOnly: true,
      limit: 20,
      offset: 40,
    });
  });

  it("falls back to defaults on bad values instead of refusing", () => {
    expect(parseListQuery({ sort: "sideways", limit: "9999", offset: "-5", q: "x".repeat(200) })).toMatchObject({
      sort: "newest",
      limit: 100,
      offset: 0,
      q: "x".repeat(80),
    });
  });
});

describe("buildUserListQuery", () => {
  const base = { sort: "newest" as const, limit: 50, offset: 0 };

  it("sorts by priority first, newest within a level", () => {
    expect(buildUserListQuery(5, { ...base, sort: "priority" }).orderBy).toEqual([
      { priority: "desc" },
      { createdAt: "desc" },
      { id: "desc" },
    ]);
  });

  it("sorts by date both ways", () => {
    expect(buildUserListQuery(5, base).orderBy[0]).toEqual({ createdAt: "desc" });
    expect(buildUserListQuery(5, { ...base, sort: "oldest" }).orderBy[0]).toEqual({ createdAt: "asc" });
  });

  it("searches title and body, scoped to the caller", () => {
    const { where } = buildUserListQuery(5, { ...base, q: "milk", unreadOnly: true, priorities: ["HIGH"] });
    expect(where).toEqual({
      userId: 5,
      isRead: false,
      priority: { in: ["HIGH"] },
      OR: [{ title: { contains: "milk" } }, { body: { contains: "milk" } }],
    });
  });
});

describe("notifyStaff", () => {
  it("sends an errand event to that errand's dispatcher, at the catalog level", async () => {
    await notifyStaff("STOP_MISMATCH", { title: "t", body: "b" }, { errandId: "e1" });
    expect(rows()).toEqual([
      expect.objectContaining({ userId: 7, type: "STOP_MISMATCH", priority: "HIGH", refKey: "errand:e1" }),
    ]);
  });

  it("falls back to every dispatcher when nobody has the errand yet", async () => {
    latestLog.mockImplementation(async () => null);
    await notifyStaff("STOP_DELAYED", { title: "t", body: "b" }, { errandId: "e1" });
    expect(rows().map((r) => r.userId)).toEqual([50, 51]);
  });

  it("copies money events to the owners", async () => {
    await notifyStaff("RECEIPT_MISMATCH", { title: "t", body: "b" }, { errandId: "e1" });
    expect(rows().map((r) => r.userId).sort()).toEqual([7, 90]);
  });

  it("sends Critical errand trouble to every dispatcher and the owners", async () => {
    await notifyStaff("ALL_RIDERS_DECLINED", { title: "t", body: "b" }, { errandId: "e1" });
    expect(rows().map((r) => r.userId).sort()).toEqual([50, 51, 90]);
    expect(rows().every((r) => r.priority === "CRITICAL")).toBe(true);
  });

  it("tells a one-off event once per key", async () => {
    await notifyStaff("STOP_DELAYED", { title: "t", body: "b" }, { errandId: "e1", onceKey: "pin:1:100" });
    await notifyStaff("STOP_DELAYED", { title: "t", body: "b" }, { errandId: "e1", onceKey: "pin:1:100" });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("clips title and body to the 191-character columns", async () => {
    await notifyStaff("STOP_MISMATCH", { title: "t".repeat(300), body: "b".repeat(300) }, { errandId: "e1" });
    expect(rows()[0].title).toHaveLength(191);
    expect(rows()[0].body).toHaveLength(191);
  });

  it("never throws into the caller", async () => {
    create.mockRejectedValueOnce(new Error("db down"));
    await expect(notifyStaffAboutErrand("STOP_MISMATCH", "e1", (e) => ({ title: e, body: e }))).resolves.toEqual([]);
  });
});

describe("owners never get chat or out of stock", () => {
  it("lists the three the user ruled out for owners", () => {
    expect(OWNER_HIDDEN_TYPES).toEqual(
      expect.arrayContaining(["RIDER_CHAT_MESSAGE", "CUSTOMER_CHAT_MESSAGE", "ITEM_OUT_OF_STOCK"])
    );
    expect(OWNER_HIDDEN_TYPES).not.toContain("RECEIPT_MISMATCH");
    expect(OWNER_HIDDEN_TYPES).not.toContain("ALL_RIDERS_DECLINED");
  });

  it("holds an out-of-stock row back from an owner who has the errand", async () => {
    latestLog.mockImplementation(async () => ({ dispatcherId: 90 })); // 90 is an owner in this mock
    await deliverToStaff([90, 7], "ITEM_OUT_OF_STOCK", { title: "t", body: "b" }, "errand:e1");
    expect(rows().map((r) => r.userId)).toEqual([7]);
  });

  it("holds a rider's message back from an owner in the thread", async () => {
    resetRiderChatWatch(1_000);
    const to = await handleRiderMessage("12", "staff_90", { lastSender: "rider", lastMessage: "hi", updatedAt: 2_000 });
    expect(to).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it("filters them out of an owner's list, and only an owner's", () => {
    const base = { sort: "newest" as const, limit: 50, offset: 0 };
    expect(buildUserListQuery(90, { ...base, excludeTypes: OWNER_HIDDEN_TYPES }).where.type).toEqual({
      notIn: OWNER_HIDDEN_TYPES,
    });
    // The Chats tab asked for by an owner comes back empty rather than leaking.
    expect(
      buildUserListQuery(90, { ...base, types: ["RIDER_CHAT_MESSAGE"], excludeTypes: OWNER_HIDDEN_TYPES }).where.type
    ).toEqual({ in: [] });
    expect(buildUserListQuery(7, base).where.type).toBeUndefined();
  });

  it("still copies a money event to the owner", async () => {
    await notifyStaff("UNVERIFIED_PURCHASE", { title: "t", body: "b" }, { errandId: "e1" });
    expect(rows().map((r) => r.userId).sort()).toEqual([7, 90]);
  });
});

describe("rider chat watch", () => {
  beforeEach(() => resetRiderChatWatch(1_000));

  it("puts a threads-mode message in that dispatcher's bell only", async () => {
    const to = await handleRiderMessage("12", "staff_7", {
      lastSender: "rider",
      senderName: "Renen",
      lastMessage: "Out of milk here",
      updatedAt: 2_000,
    });
    expect(to).toEqual([7]);
    expect(rows()[0]).toMatchObject({
      type: "RIDER_CHAT_MESSAGE",
      title: "Message from Renen",
      body: "Out of milk here",
      refKey: "rider:12",
      priority: "NORMAL",
    });
  });

  it("puts a shared-mode message in every dispatcher's bell, High while the rider has an errand", async () => {
    countErrands.mockImplementation(async () => 1);
    const to = await handleRiderMessage("12", null, { lastSender: "rider", lastMessage: "hi", updatedAt: 2_000 });
    expect(to).toEqual([50, 51]);
    expect(rows()[0].priority).toBe("HIGH");
  });

  it("ignores the dispatcher's own messages, writes from before start, and repeats", async () => {
    await handleRiderMessage("12", "staff_7", { lastSender: "dispatcher", updatedAt: 2_000 });
    await handleRiderMessage("12", "staff_7", { lastSender: "rider", updatedAt: 500 });
    await handleRiderMessage("12", "staff_7", { lastSender: "rider", updatedAt: 2_000 });
    await handleRiderMessage("12", "staff_7", { lastSender: "rider", updatedAt: 2_000 });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("folds the next message into the unread row", async () => {
    findUnreadByRef.mockImplementation(async () => ({ id: 33, title: "Message from Renen (2 new)" }));
    await handleRiderMessage("12", "staff_7", { lastSender: "rider", senderName: "Renen", lastMessage: "again", updatedAt: 3_000 });
    expect(create).not.toHaveBeenCalled();
    expect(bump).toHaveBeenCalledWith(33, { title: "Message from Renen (3 new)", body: "again", priority: "NORMAL" });
  });
});
