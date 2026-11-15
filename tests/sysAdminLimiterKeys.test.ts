import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

// The SysAdmin write limiters key on the admin when one is signed in and fall
// back to the caller's IP otherwise. That fallback used to be the raw req.ip,
// so a signed-out caller with an IPv6 block got a fresh bucket per address
// (express-rate-limit warned ERR_ERL_KEY_GEN_IPV6 on every boot). It now uses
// clientIpKey, which masks IPv6 to a /56 like every other IP-keyed limiter.
// NODE_ENV is "test" under vitest, which selects the production limits.

let server: Server;
let url: string;

beforeEach(async () => {
  vi.resetModules();
  const { sysAdminBackupLimiter } = await import("../src/middleware/sysAdminSecurity.js");
  const app = express();
  // Stand-in for the proxy resolution in production: the test names the caller.
  app.use((req, _res, next) => {
    Object.defineProperty(req, "ip", { value: String(req.headers["x-test-ip"]), configurable: true });
    const user = req.headers["x-test-user"];
    if (user) (req as any).user = { id: Number(user) };
    next();
  });
  app.post("/backup", sysAdminBackupLimiter, (_req, res) => res.status(200).json({ ok: true }));
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const hit = (ip: string, user?: number) =>
  fetch(`${url}/backup`, { method: "POST", headers: { "x-test-ip": ip, ...(user ? { "x-test-user": String(user) } : {}) } }).then((r) => r.status);

describe("SysAdmin write limiters", () => {
  it("count a whole IPv6 /56 as one signed-out caller", async () => {
    // The backup limiter allows 3 per hour; four different addresses in one /56 share that budget.
    expect(await hit("2001:db8:abcd:1200::1")).toBe(200);
    expect(await hit("2001:db8:abcd:1200::2")).toBe(200);
    expect(await hit("2001:db8:abcd:12ff:ffff::9")).toBe(200);
    expect(await hit("2001:db8:abcd:1201::77")).toBe(429);
    // A different /56 is a different caller.
    expect(await hit("2001:db8:abcd:1300::1")).toBe(200);
  });

  it("still key a signed-in admin on the account, whatever address it uses", async () => {
    for (const ip of ["2001:db8:1::1", "2001:db8:2::1", "203.0.113.9"]) expect(await hit(ip, 7)).toBe(200);
    expect(await hit("198.51.100.1", 7)).toBe(429);
    expect(await hit("198.51.100.1", 8)).toBe(200);
  });
});
