import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "http";
import type { AddressInfo } from "net";

/**
 * Which Origin a Socket.IO WebSocket upgrade accepts. React Native's Android
 * WebSocket sends `Origin: https://<api host>`, which the allow-list refused,
 * so both mobile apps were stuck on 25 s long-polls for every session
 * (Cloudflare p99 origin response time of 25 s, 2026-11-04).
 */

vi.mock("../src/lib/prisma.js", () => ({ prisma: {} }));
vi.mock("../src/lib/blocklistCache.js", () => ({ isRevoked: vi.fn(async () => false), markRevoked: vi.fn() }));

import { io, isSameOrigin } from "../src/lib/socket.js";
import { ALLOWED_ORIGINS } from "../src/config/env.js";

let server: http.Server;
let port: number;

beforeAll(async () => {
  server = http.createServer();
  io.attach(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => io.close(() => resolve()));
});

/** The status a raw WebSocket upgrade gets: 101 when accepted. */
function upgradeStatus(headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: "/socket.io/?EIO=4&transport=websocket",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        ...headers,
      },
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("isSameOrigin", () => {
  it("matches an origin on the request's own host", () => {
    expect(isSameOrigin("https://api.sugo-express.org", "api.sugo-express.org")).toBe(true);
    expect(isSameOrigin("http://192.168.1.5:5000", "192.168.1.5:5000")).toBe(true);
    expect(isSameOrigin("https://API.sugo-express.org", "Api.Sugo-Express.org")).toBe(true);
  });

  it("refuses any other host, port or a malformed origin", () => {
    expect(isSameOrigin("https://evil.example", "api.sugo-express.org")).toBe(false);
    expect(isSameOrigin("https://api.sugo-express.org.evil.example", "api.sugo-express.org")).toBe(false);
    expect(isSameOrigin("http://192.168.1.5:8081", "192.168.1.5:5000")).toBe(false);
    expect(isSameOrigin("null", "api.sugo-express.org")).toBe(false);
    expect(isSameOrigin("https://api.sugo-express.org", undefined)).toBe(false);
  });
});

describe("Socket.IO WebSocket upgrade origin check", () => {
  it("accepts the API's own origin, as React Native's okhttp sends it", async () => {
    await expect(upgradeStatus({ Host: "api.sugo-express.org", Origin: "https://api.sugo-express.org" })).resolves.toBe(101);
    await expect(upgradeStatus({ Origin: `http://127.0.0.1:${port}` })).resolves.toBe(101);
  });

  it("still accepts no origin and an allow-listed one", async () => {
    await expect(upgradeStatus({})).resolves.toBe(101);
    await expect(upgradeStatus({ Origin: ALLOWED_ORIGINS[0] })).resolves.toBe(101);
  });

  it("still refuses a foreign origin", async () => {
    await expect(upgradeStatus({ Origin: "https://evil.example" })).resolves.toBe(400);
    await expect(upgradeStatus({ Host: "api.sugo-express.org", Origin: "https://evil.example" })).resolves.toBe(400);
  });
});
