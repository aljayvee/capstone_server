import { describe, expect, it, vi, beforeEach } from "vitest";

// Guards added after the 2026-11-02 OWASP review: saved places are readable by
// their customer only, ban addresses must be plain IPs before they reach
// nginx, and 401/403 refusals leave a log line.

const { logger, listLocations, prisma, writeFileSync, exec } = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  listLocations: vi.fn(),
  prisma: {
    blockedIp: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    whitelistedIp: { upsert: vi.fn() },
    sysAdmin: { findUnique: vi.fn() },
  },
  writeFileSync: vi.fn(),
  exec: vi.fn((_cmd: string, cb: (err: Error | null, stdout: string, stderr: string) => void) => cb(null, "", "")),
}));

vi.mock("../src/lib/logger.js", () => ({ logger }));
vi.mock("../src/services/locationService.js", () => ({ listLocations }));
vi.mock("../src/lib/prisma.js", () => ({ prisma }));
vi.mock("../src/lib/blocklistCache.js", () => ({ isRevoked: vi.fn(async () => false) }));
vi.mock("../src/services/sysAdminAlertService.js", () => ({
  sysAdminAlertService: { sendTelegramAlert: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("child_process", async (importOriginal) => ({ ...(await importOriginal<object>()), exec }));
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const patched = {
    ...actual,
    writeFileSync,
    existsSync: vi.fn(() => false),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
  return { ...patched, default: patched };
});

import { listLocations as listLocationsHandler } from "../src/controllers/customerLocationController.js";
import { sysAdminThreatService } from "../src/services/sysAdminThreatService.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { authenticateToken, requireRole } from "../src/middleware/auth.js";
import { verifySysAdminCsrf, verifyStepUpPassword } from "../src/middleware/sysAdminSecurity.js";
import { ServiceError } from "../src/services/ServiceError.js";
import { JWT_SECRET } from "../src/config/env.js";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";

function fakeRes() {
  const res: any = { headersSent: false };
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
}

async function callListLocations(user: { id: number; role: string }, userId: string) {
  const res = fakeRes();
  const next = vi.fn();
  listLocationsHandler({ params: { userId }, user } as any, res, next);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { res, next };
}

describe("saved locations are the customer's own", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listLocations.mockResolvedValue([{ id: 1, label: "Home" }]);
  });

  it("returns the list to the customer it belongs to", async () => {
    const { res, next } = await callListLocations({ id: 9, role: "CUSTOMER" }, "9");
    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith([{ id: 1, label: "Home" }]);
  });

  it.each(["RIDER", "DISPATCHER", "OWNER"])("refuses %s 9 asking for customer 9", async (role) => {
    const { next } = await callListLocations({ id: 9, role }, "9");
    expect(next.mock.calls[0][0]).toMatchObject({ status: 403 });
    expect(listLocations).not.toHaveBeenCalled();
  });

  it("refuses another customer", async () => {
    const { next } = await callListLocations({ id: 8, role: "CUSTOMER" }, "9");
    expect(next.mock.calls[0][0]).toMatchObject({ status: 403 });
  });
});

describe("ban addresses must be plain IPs", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["1.1.1.1;\nreturn 200 \"x\";", "1.1.1.1; allow all", "example.com", "10.0.0.0/8", ""])(
    "rejects %j before anything is stored",
    async (ipAddress) => {
      await expect(sysAdminThreatService.blockIp({ ipAddress, reason: "probe" })).rejects.toThrow(
        "Enter a single IPv4 or IPv6 address."
      );
      expect(prisma.blockedIp.create).not.toHaveBeenCalled();
    }
  );

  it("rejects the same input on the whitelist", async () => {
    await expect(
      sysAdminThreatService.addWhitelistedIp({ ipAddress: "1.1.1.1;\nallow all", description: "x" })
    ).rejects.toThrow("Enter a single IPv4 or IPv6 address.");
    expect(prisma.whitelistedIp.upsert).not.toHaveBeenCalled();
  });

  it("still bans a real address, IPv4 or IPv6", async () => {
    prisma.blockedIp.findFirst.mockResolvedValue(null);
    prisma.blockedIp.create.mockImplementation(({ data }) => Promise.resolve({ id: 1, ...data }));

    await sysAdminThreatService.blockIp({ ipAddress: "::ffff:203.0.113.7", reason: "probe" });
    await sysAdminThreatService.blockIp({ ipAddress: "2001:db8::1", reason: "probe" });

    expect(prisma.blockedIp.create.mock.calls.map(([arg]) => arg.data.ipAddress)).toEqual([
      "203.0.113.7",
      "2001:db8::1",
    ]);
  });

  it("leaves an old bad row out of the nginx file instead of failing every sync", async () => {
    prisma.blockedIp.findMany.mockResolvedValue([
      { ipAddress: "1.1.1.1;\nreturn 200 \"x\";", reason: "old row" },
      { ipAddress: "203.0.113.7", reason: "probe" },
    ]);

    await sysAdminThreatService.syncNginxBlocklist();

    const written = String(writeFileSync.mock.calls[0][1]);
    expect(written).toContain("deny 203.0.113.7; # probe\n");
    expect(written).not.toContain("return 200");
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Skipped a ban with an invalid address"));
  });
});

describe("refusals are logged", () => {
  beforeEach(() => vi.clearAllMocks());

  function handle(err: unknown, user?: { id: number; role: string }) {
    const res = fakeRes();
    const req: any = { method: "GET", originalUrl: "/api/thing/9?token=secret", ip: "203.0.113.7", user };
    errorHandler(err, req, res, vi.fn());
    return res;
  }

  it("writes a warning for a 403, without the query string", () => {
    const res = handle(new ServiceError(403, "Access denied"), { id: 9, role: "RIDER" });

    expect(res.status).toHaveBeenCalledWith(403);
    const line = logger.warn.mock.calls[0][0] as string;
    expect(line).toContain("403 on GET /api/thing/9 for RIDER #9 from 203.0.113.7");
    expect(line).not.toContain("secret");
  });

  it("writes a warning for a signed-out 401", () => {
    handle(new ServiceError(401, "Invalid credentials"));
    expect(logger.warn.mock.calls[0][0]).toContain("a signed-out caller");
  });

  it("stays quiet for an ordinary 400", () => {
    handle(new ServiceError(400, "Bad input"));
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("middleware refusals are logged too", () => {
  beforeEach(() => vi.clearAllMocks());

  function request(overrides: Record<string, unknown> = {}): any {
    return { method: "GET", originalUrl: "/api/thing?token=secret", ip: "203.0.113.7", headers: {}, ...overrides };
  }
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const session = { id: 3, role: "RIDER", username: "r", email: "" };
  const lastLine = () => String(logger.warn.mock.calls.at(-1)?.[0] ?? "");

  async function authenticate(req: any) {
    const res = fakeRes();
    const next = vi.fn();
    await authenticateToken(req, res, next);
    return { res, next };
  }

  it("logs a role refusal with the roles the route allows", () => {
    const res = fakeRes();
    requireRole(["CUSTOMER"])(request({ user: session }), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(403);
    expect(lastLine()).toContain("403 on GET /api/thing for RIDER #3 from 203.0.113.7: role RIDER is not one of CUSTOMER");
  });

  it("logs a request with no token", async () => {
    await authenticate(request());
    expect(lastLine()).toContain("401 on GET /api/thing for a signed-out caller from 203.0.113.7: no access token");
  });

  it("logs a forged token", async () => {
    const { res } = await authenticate(request({ headers: bearer(jwt.sign(session, "not-the-secret")) }));
    expect(res.status).toHaveBeenCalledWith(401);
    expect(lastLine()).toContain("invalid access token (invalid signature)");
  });

  it("stays quiet for an expired token, which every client has every 15 minutes", async () => {
    const expired = jwt.sign({ ...session, exp: Math.floor(Date.now() / 1000) - 60 }, JWT_SECRET);
    const { res } = await authenticate(request({ headers: bearer(expired) }));
    expect(res.status).toHaveBeenCalledWith(401);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("lets a valid session token through without a line", async () => {
    const { next } = await authenticate(request({ headers: bearer(jwt.sign(session, JWT_SECRET)) }));
    expect(next).toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("logs a wrong step-up password", async () => {
    prisma.sysAdmin.findUnique.mockResolvedValue({ status: "Active", passwordHash: await bcrypt.hash("right", 4) });
    const res = fakeRes();
    await verifyStepUpPassword(
      request({ method: "POST", user: { id: 1, role: "SYSADMIN" }, body: { stepUpPassword: "wrong" } }),
      res,
      vi.fn()
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(lastLine()).toContain("403 on POST /api/thing for SYSADMIN #1 from 203.0.113.7: wrong step-up password");
  });

  it("logs a CSRF refusal", () => {
    verifySysAdminCsrf(request({ method: "POST" }), fakeRes(), vi.fn());
    expect(lastLine()).toContain("CSRF check: missing or wrong X-SysAdmin-Client header");
  });
});
