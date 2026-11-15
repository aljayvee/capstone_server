import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({ prisma: {} }));
vi.mock("../src/middleware/rateLimiters.js", () => ({
  readLimiter: function readLimiterStub(_req: unknown, _res: unknown, next: () => void) {
    next();
  },
  userApiLimiter: function userApiLimiterStub(_req: unknown, _res: unknown, next: () => void) {
    next();
  },
  trackingLimiter: function trackingLimiterStub(_req: unknown, _res: unknown, next: () => void) {
    next();
  },
}));

const h = vi.hoisted(() => ({
  findById: vi.fn(),
  recordTermsAcceptance: vi.fn(),
}));

vi.mock("../src/repositories/userRepository.js", () => ({
  userRepository: {
    findById: h.findById,
    recordTermsAcceptance: h.recordTermsAcceptance,
  },
}));

const { acceptRiderTerms } = await import("../src/controllers/riderController.js");
const riderRoutes = (await import("../src/routes/riderRoutes.js")).default;

function runAcceptTerms(user: { id: number; role: string } | undefined, body: unknown) {
  return new Promise<{ status?: number; json?: any; error?: any }>((resolve) => {
    const res: any = {
      status(code: number) {
        return {
          json(payload: unknown) {
            resolve({ status: code, json: payload });
          },
        };
      },
    };
    acceptRiderTerms({ user, body } as any, res, (error: unknown) => resolve({ error }));
  });
}

describe("POST /api/riders/accept-terms", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("mounts authenticateToken, RIDER role guard, userApiLimiter, and controller in order", () => {
    const layer = (riderRoutes as any).stack.find(
      (l: any) => l.route?.path === "/accept-terms" && l.route.methods.post
    );
    expect(layer).toBeTruthy();
    const names = layer.route.stack.map((handler: any) => handler.name);
    expect(names).toEqual([
      "authenticateToken",
      "<anonymous>",
      "userApiLimiterStub",
      "<anonymous>",
    ]);
  });

  it("records termsAcceptedAt and termsAcceptedVersion for a newly created active rider", async () => {
    const now = new Date("2026-11-13T15:00:00.000Z");
    h.findById.mockResolvedValue({
      id: 42,
      username: "rider_juan",
      passwordHash: "secret-hash",
      role: "RIDER",
      firstName: "Juan",
      lastName: "Dela Cruz",
      email: "juan@sugo.test",
      phone: "09171234567",
      status: "Active",
      termsAcceptedAt: null,
      termsAcceptedVersion: null,
    });
    h.recordTermsAcceptance.mockResolvedValue({
      id: 42,
      username: "rider_juan",
      passwordHash: "secret-hash",
      role: "RIDER",
      firstName: "Juan",
      lastName: "Dela Cruz",
      email: "juan@sugo.test",
      phone: "09171234567",
      status: "Active",
      termsAcceptedAt: now,
      termsAcceptedVersion: "2026-11-13",
    });

    const result = await runAcceptTerms({ id: 42, role: "RIDER" }, { version: "2026-11-13" });

    expect(result.status).toBe(200);
    expect(result.json.success).toBe(true);
    expect(result.json.termsAcceptedVersion).toBe("2026-11-13");
    expect(result.json.termsAcceptedAt).toEqual(now);
    expect(result.json.user.passwordHash).toBeUndefined();
    expect(result.json.user.name).toBe("Juan Dela Cruz");
    expect(h.recordTermsAcceptance).toHaveBeenCalledWith(42, "2026-11-13", expect.any(Date));
  });

  it("is idempotent for the same version and preserves the original acceptance timestamp", async () => {
    const originalTimestamp = new Date("2026-11-01T08:30:00.000Z");
    h.findById.mockResolvedValue({
      id: 42,
      username: "rider_juan",
      passwordHash: "secret-hash",
      role: "RIDER",
      firstName: "Juan",
      lastName: "Dela Cruz",
      email: "juan@sugo.test",
      phone: "09171234567",
      status: "Active",
      termsAcceptedAt: originalTimestamp,
      termsAcceptedVersion: "2026-11-13",
    });

    const result = await runAcceptTerms({ id: 42, role: "RIDER" }, { version: "2026-11-13" });

    expect(result.status).toBe(200);
    expect(result.json.termsAcceptedAt).toEqual(originalTimestamp);
    expect(h.recordTermsAcceptance).not.toHaveBeenCalled();
  });

  it("updates acceptance when a newer Terms version is accepted", async () => {
    const oldTimestamp = new Date("2026-11-01T08:30:00.000Z");
    const newTimestamp = new Date("2026-12-01T09:00:00.000Z");
    h.findById.mockResolvedValue({
      id: 42,
      username: "rider_juan",
      passwordHash: "secret-hash",
      role: "RIDER",
      firstName: "Juan",
      lastName: "Dela Cruz",
      email: "juan@sugo.test",
      phone: "09171234567",
      status: "Active",
      termsAcceptedAt: oldTimestamp,
      termsAcceptedVersion: "2026-11-13",
    });
    h.recordTermsAcceptance.mockResolvedValue({
      id: 42,
      username: "rider_juan",
      passwordHash: "secret-hash",
      role: "RIDER",
      firstName: "Juan",
      lastName: "Dela Cruz",
      email: "juan@sugo.test",
      phone: "09171234567",
      status: "Active",
      termsAcceptedAt: newTimestamp,
      termsAcceptedVersion: "2026-12-01",
    });

    const result = await runAcceptTerms({ id: 42, role: "RIDER" }, { version: "2026-12-01" });

    expect(result.status).toBe(200);
    expect(result.json.termsAcceptedVersion).toBe("2026-12-01");
    expect(result.json.termsAcceptedAt).toEqual(newTimestamp);
    expect(h.recordTermsAcceptance).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["empty version", { version: "" }],
    ["missing version", {}],
    ["invalid characters", { version: "2026 11 13!" }],
  ])("rejects %s with 400", async (_label, body) => {
    const result = await runAcceptTerms({ id: 42, role: "RIDER" }, body);
    expect(result.error).toMatchObject({ status: 400 });
    expect(h.findById).not.toHaveBeenCalled();
  });

  it("rejects non-RIDER accounts with 403", async () => {
    h.findById.mockResolvedValue({
      id: 1,
      username: "owner",
      passwordHash: "hash",
      role: "OWNER",
      firstName: "Owner",
      lastName: "User",
      status: "Active",
    });

    const result = await runAcceptTerms({ id: 1, role: "OWNER" }, { version: "2026-11-13" });
    expect(result.error).toMatchObject({ status: 403 });
    expect(h.recordTermsAcceptance).not.toHaveBeenCalled();
  });

  it("rejects inactive rider accounts with 403", async () => {
    h.findById.mockResolvedValue({
      id: 42,
      username: "rider_juan",
      passwordHash: "hash",
      role: "RIDER",
      firstName: "Juan",
      lastName: "Dela Cruz",
      status: "Inactive",
    });

    const result = await runAcceptTerms({ id: 42, role: "RIDER" }, { version: "2026-11-13" });
    expect(result.error).toMatchObject({ status: 403 });
    expect(h.recordTermsAcceptance).not.toHaveBeenCalled();
  });
});
