import { describe, expect, it, vi } from "vitest";
import express from "express";
import type { Request } from "express";
import { TRUSTED_PROXIES } from "../src/lib/trustedProxies.js";
import { getClientIp } from "../src/lib/requestContext.js";

// The interceptor's module pulls in the threat service (and its database) at
// import; only its IP reader is under test here.
vi.mock("../src/services/sysAdminThreatService.js", () => ({ sysAdminThreatService: {} }));
const { getClientIp: threatClientIp } = await import("../src/middleware/threatInterceptor.js");

// Drives the real thing: a throwaway Express app with the production trust
// setting, and a hand-made request whose socket peer and headers are chosen per
// path. `req.ip` is Express's own getter (proxy-addr under the hood), so this is
// exactly the value the rate limiters, the reset throttle and the threat
// interceptor see.

function ipFor(trust: unknown, peer: string, headers: Record<string, string> = {}): string | undefined {
  const app = express();
  app.set("trust proxy", trust);
  const req = Object.create(app.request) as Request & { app: typeof app };
  (req as any).app = app;
  (req as any).headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  (req as any).connection = (req as any).socket = { remoteAddress: peer };
  return req.ip;
}

const NGINX = "127.0.0.1";
const CF_EDGE_V4 = "172.68.10.20"; // inside 172.64.0.0/13
const CF_EDGE_V6 = "2606:4700:10::ac43:a14";
const CLIENT = "203.0.113.50";
const FORGED = "1.2.3.4";

describe("trust proxy: the bug this replaces", () => {
  it("with `true`, a client chose their own req.ip through Cloudflare", () => {
    // What Express received: client-typed entry, the client Cloudflare saw, the edge nginx saw.
    const xff = `${FORGED}, ${CLIENT}, ${CF_EDGE_V4}`;
    expect(ipFor(true, NGINX, { "x-forwarded-for": xff })).toBe(FORGED);
  });
});

describe("trust proxy: production setting", () => {
  it("through Cloudflare, req.ip is the client Cloudflare saw, whatever was forged to its left", () => {
    const xff = `${FORGED}, ${CLIENT}, ${CF_EDGE_V4}`;
    expect(ipFor(TRUSTED_PROXIES, NGINX, { "x-forwarded-for": xff })).toBe(CLIENT);
  });

  it("through Cloudflare over IPv6 too", () => {
    const xff = `${FORGED}, 2001:db8::7, ${CF_EDGE_V6}`;
    expect(ipFor(TRUSTED_PROXIES, NGINX, { "x-forwarded-for": xff })).toBe("2001:db8::7");
  });

  it("straight to nginx (no Cloudflare), a forged Cloudflare address in the chain does not help", () => {
    // nginx appends the real peer; the client wrote the rest, including a Cloudflare-looking hop.
    const xff = `${FORGED}, ${CF_EDGE_V4}, ${CLIENT}`;
    expect(ipFor(TRUSTED_PROXIES, NGINX, { "x-forwarded-for": xff })).toBe(CLIENT);
  });

  it("straight to Express, headers are ignored and the socket peer is the client", () => {
    const xff = `${FORGED}, ${CF_EDGE_V4}`;
    expect(ipFor(TRUSTED_PROXIES, CLIENT, { "x-forwarded-for": xff })).toBe(CLIENT);
  });

  it("a local request with no proxy headers is itself", () => {
    expect(ipFor(TRUSTED_PROXIES, NGINX)).toBe(NGINX);
  });
});

describe("getClientIp", () => {
  it("ignores a forged CF-Connecting-IP, which anyone can send by skipping Cloudflare", () => {
    const req = { ip: CLIENT, headers: { "cf-connecting-ip": FORGED }, socket: {} } as unknown as Request;
    expect(getClientIp(req)).toBe(CLIENT);
  });

  it("still tidies IPv4-mapped and loopback addresses", () => {
    expect(getClientIp({ ip: "::ffff:203.0.113.9", headers: {}, socket: {} } as unknown as Request)).toBe(
      "203.0.113.9"
    );
    expect(getClientIp({ ip: "::1", headers: {}, socket: {} } as unknown as Request)).toBe("127.0.0.1");
  });
});

describe("threat interceptor", () => {
  it("reads the resolved IP, not the left-most X-Forwarded-For entry", () => {
    // Before 2026-10-16 this returned FORGED: enough to claim a whitelisted IP,
    // dodge a ban, or get someone else's address banned with a scanner path.
    const req = {
      ip: CLIENT,
      headers: { "x-forwarded-for": `${FORGED}, ${CLIENT}, ${CF_EDGE_V4}` },
      socket: {},
    } as unknown as Request;
    expect(threatClientIp(req)).toBe(CLIENT);
  });
});
