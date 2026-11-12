import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Who may read a staff member's profile and photo (2026-10-09).
 *
 * The old guard only refused a RIDER reading someone else, so a CUSTOMER fell
 * through and could read any rider's name, phone and email, and list the whole
 * online fleet. Photos are looser on purpose: both apps show the dispatcher's
 * face in chat, so a dispatcher's or owner's photo is for any signed-in user.
 */

vi.mock("../src/lib/prisma.js", () => ({ prisma: {} }));
vi.mock("../src/middleware/rateLimiters.js", () => ({
  readLimiter: function readLimiterStub(_req: unknown, _res: unknown, next: () => void) { next(); },
  userApiLimiter: function userApiLimiterStub(_req: unknown, _res: unknown, next: () => void) { next(); },
  trackingLimiter: function trackingLimiterStub(_req: unknown, _res: unknown, next: () => void) { next(); },
}));

const { getRiderProfileSvc, getRiderPhotoSvc, isStaffMember } = vi.hoisted(() => ({
  getRiderProfileSvc: vi.fn(async (id: number) => ({ id, phone: "09170000000" })),
  getRiderPhotoSvc: vi.fn(async () => ({ photoData: "data:image/png;base64,AAAA" })),
  isStaffMember: vi.fn(async (_id: number) => false),
}));
vi.mock("../src/services/userService.js", () => ({
  getRiderProfile: getRiderProfileSvc,
  getRiderPhoto: getRiderPhotoSvc,
  isStaffMember,
}));

const { getRiderProfile, getRiderPhoto } = await import("../src/controllers/riderController.js");
const riderRoutes = (await import("../src/routes/riderRoutes.js")).default;

/** Runs an asyncHandler-wrapped controller; resolves to the status sent or the error passed on. */
function call(handler: any, user: { id: number; role: string }, riderId: number) {
  return new Promise<{ status?: number; error?: any }>((resolve) => {
    const res: any = {
      status(code: number) {
        resolve({ status: code });
        return { json: () => undefined };
      },
    };
    handler({ user, params: { riderId: String(riderId) } }, res, (error: unknown) => resolve({ error }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  isStaffMember.mockResolvedValue(false);
});

describe("GET /riders/profile/:riderId", () => {
  it.each([
    ["a dispatcher", { id: 3, role: "DISPATCHER" }],
    ["the owner", { id: 1, role: "OWNER" }],
    ["the rider themself", { id: 9, role: "RIDER" }],
  ])("lets %s read it", async (_who, user) => {
    expect((await call(getRiderProfile, user, 9)).status).toBe(200);
  });

  it.each([
    ["a customer", { id: 4, role: "CUSTOMER" }],
    ["a customer whose id matches the rider's", { id: 9, role: "CUSTOMER" }],
    ["another rider", { id: 8, role: "RIDER" }],
  ])("refuses %s", async (_who, user) => {
    const result = await call(getRiderProfile, user, 9);
    expect(result.error).toMatchObject({ status: 403 });
    expect(getRiderProfileSvc).not.toHaveBeenCalled();
  });
});

describe("GET /riders/:riderId/photo", () => {
  it("shows a dispatcher's face to a customer, which both apps' chat depends on", async () => {
    isStaffMember.mockResolvedValue(true);
    expect((await call(getRiderPhoto, { id: 4, role: "CUSTOMER" }, 3)).status).toBe(200);
  });

  it("shows a dispatcher's face to a rider, for the rider app's chat", async () => {
    isStaffMember.mockResolvedValue(true);
    expect((await call(getRiderPhoto, { id: 9, role: "RIDER" }, 3)).status).toBe(200);
  });

  it("keeps a rider's face from customers", async () => {
    const result = await call(getRiderPhoto, { id: 9, role: "CUSTOMER" }, 9);
    expect(result.error).toMatchObject({ status: 403 });
    expect(getRiderPhotoSvc).not.toHaveBeenCalled();
  });

  it("still shows a rider their own photo, and staff anyone's", async () => {
    expect((await call(getRiderPhoto, { id: 9, role: "RIDER" }, 9)).status).toBe(200);
    expect((await call(getRiderPhoto, { id: 3, role: "DISPATCHER" }, 9)).status).toBe(200);
  });
});

describe("GET /riders/online", () => {
  it("is role-guarded right after authentication", () => {
    const layer = (riderRoutes as any).stack.find((l: any) => l.route?.path === "/online" && l.route.methods.get);
    const names = layer.route.stack.map((h: any) => h.name);
    // authenticateToken, requireRole's guard, the access-group guard (Admins
    // need tracking.view), the limiter, the controller. Express names unnamed
    // handlers "<anonymous>"; the controller is one too, since asyncHandler
    // wraps it. Before the fix the chain was three long.
    expect(names).toEqual([
      "authenticateToken",
      "<anonymous>",
      "requirePermissionGuard",
      "readLimiterStub",
      "<anonymous>",
    ]);
  });
});
