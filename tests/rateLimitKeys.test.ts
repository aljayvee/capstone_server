import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

// The limiters are module-level singletons with in-memory counts, so every test
// imports a fresh copy. NODE_ENV is "test" under vitest, which selects the
// production limits (10 per device, 30 per IP).
async function freshLimiters() {
  vi.resetModules();
  return import("../src/middleware/rateLimiters.js");
}

const reqWith = (over: Record<string, unknown>) => ({ headers: {}, socket: {}, ...over }) as any;

describe("rate-limit keys", () => {
  it("never key a signed-out request on the x-device-id it sends", async () => {
    const { smartKeyGenerator } = await freshLimiters();
    const a = smartKeyGenerator(reqWith({ ip: "203.0.113.5", headers: { "x-device-id": "aaa" } }));
    const b = smartKeyGenerator(reqWith({ ip: "203.0.113.5", headers: { "x-device-id": "bbb" } }));
    expect(a).toBe("ip_203.0.113.5");
    expect(b).toBe(a);
  });

  it("key a signed-in request on its account", async () => {
    const { smartKeyGenerator } = await freshLimiters();
    expect(smartKeyGenerator(reqWith({ ip: "203.0.113.5", user: { id: 7 } }))).toBe("user_7");
  });

  it("key sign-in on the device when it sends one, else on the IP", async () => {
    const { deviceKeyGenerator } = await freshLimiters();
    expect(deviceKeyGenerator(reqWith({ ip: "203.0.113.5", headers: { "x-device-id": "web-123" } }))).toBe(
      "device_web-123"
    );
    expect(deviceKeyGenerator(reqWith({ ip: "203.0.113.5" }))).toBe("ip_203.0.113.5");
  });

  it("treat one IPv6 /56 as one caller, so stepping through addresses buys nothing", async () => {
    const { clientIpKey } = await freshLimiters();
    const one = clientIpKey(reqWith({ ip: "2001:db8:abcd:1200::1" }));
    const two = clientIpKey(reqWith({ ip: "2001:db8:abcd:12ff:ffff::9" }));
    expect(one).toBe(two);
    expect(clientIpKey(reqWith({ ip: "2001:db8:abcd:1300::1" }))).not.toBe(one);
  });
});

describe("sign-in limits, end to end", () => {
  let server: Server;
  let url: string;

  beforeEach(async () => {
    const { loginLimiter } = await freshLimiters();
    const app = express();
    app.use(express.json());
    // A sign-in that fails unless the password is "right".
    app.post("/login", loginLimiter, (req, res) => {
      if (req.body?.password === "right") res.status(200).json({ ok: true });
      else res.status(401).json({ error: "Invalid username or password" });
    });
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/login`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const attempt = (deviceId: string | null, password = "wrong") =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(deviceId ? { "x-device-id": deviceId } : {}) },
      body: JSON.stringify({ username: "rider_juan", password }),
    });

  it("stops one device after 10 failures, without touching another device on the same IP", async () => {
    for (let i = 0; i < 10; i++) expect((await attempt("phone-a")).status).toBe(401);
    expect((await attempt("phone-a")).status).toBe(429);
    expect((await attempt("phone-b")).status).toBe(401);
  });

  it("stops a caller rotating device ids at 30 failures from the IP", async () => {
    for (let i = 0; i < 30; i++) expect((await attempt(`fresh-${i}`)).status).toBe(401);
    const blocked = await attempt("fresh-30");
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).error).toContain("from this network");
  });

  it("does not count successful sign-ins against anyone", async () => {
    for (let i = 0; i < 40; i++) expect((await attempt(`ok-${i % 3}`, "right")).status).toBe(200);
    expect((await attempt("ok-0")).status).toBe(401);
  });
});

describe("what a sign-in client is told about its allowance", () => {
  let server: Server;
  let url: string;

  beforeEach(async () => {
    const { loginLimiter } = await freshLimiters();
    const app = express();
    app.use(express.json());
    app.post("/login", loginLimiter, (_req, res) => {
      res.status(401).json({ error: "Invalid username or password" });
    });
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/login`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const attempt = (deviceId: string) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-device-id": deviceId },
      body: JSON.stringify({ username: "qa_dispatcher", password: "wrong" }),
    });

  const allowance = (res: Response) => ({
    remaining: Number(res.headers.get("x-login-attempts-remaining")),
    reset: Number(res.headers.get("x-login-attempts-reset")),
    scope: res.headers.get("x-login-attempts-scope"),
  });

  it("counts down the device's failures left, with the seconds until they reset", async () => {
    const first = allowance(await attempt("laptop"));
    expect(first.remaining).toBe(9);
    expect(first.scope).toBe("device");
    expect(first.reset).toBeGreaterThan(0);
    expect(first.reset).toBeLessThanOrEqual(900);

    for (let i = 0; i < 8; i++) await attempt("laptop");
    // The tenth failure: nothing left, so the screen can lock now, not one try later.
    expect(allowance(await attempt("laptop")).remaining).toBe(0);
  });

  it("reports the network's count once it is the tighter of the two", async () => {
    let last: Response | undefined;
    for (let i = 0; i < 25; i++) last = await attempt(`rotating-${i}`);
    // 25 failures from the IP leave it 5; each fresh device would still have 9.
    expect(allowance(last!)).toMatchObject({ remaining: 5, scope: "network" });
  });

  it("puts the real wait and the limit's name in the 429 body, not just a flat 15 minutes", async () => {
    for (let i = 0; i < 10; i++) await attempt("laptop");
    const blocked = await attempt("laptop");
    expect(blocked.status).toBe(429);
    const body = await blocked.json();
    expect(body.code).toBe("LOGIN_DEVICE_LIMIT");
    expect(body.details.retryAfterSeconds).toBeGreaterThan(0);
    expect(body.details.retryAfterSeconds).toBeLessThanOrEqual(900);
    expect(Math.abs(body.details.retryAfterSeconds - Number(blocked.headers.get("retry-after")))).toBeLessThanOrEqual(1);
    expect(body.error).toMatch(/^Too many failed login attempts\. Please try again in \d+ minutes?\.$/);
  });

  it("names the network limit when that is the one that stopped the request", async () => {
    for (let i = 0; i < 30; i++) await attempt(`rotating-${i}`);
    const body = await (await attempt("rotating-30")).json();
    expect(body.code).toBe("LOGIN_NETWORK_LIMIT");
    expect(body.error).toContain("from this network");
  });
});
