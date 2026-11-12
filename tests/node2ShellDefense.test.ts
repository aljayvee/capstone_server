import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

// Mock sysAdminThreatService so it doesn't try to query MariaDB
vi.mock("../src/services/sysAdminThreatService.js", () => ({
  sysAdminThreatService: {
    isIpWhitelisted: vi.fn(() => false),
    checkIpBlocked: vi.fn(() => ({ isBlocked: false })),
    blockIp: vi.fn().mockResolvedValue(true),
  },
}));

const { threatInterceptor } = await import("../src/middleware/threatInterceptor.js");

function createMockReqRes(headers: Record<string, string> = {}, path = "/api/test", method = "POST") {
  const req = {
    path,
    method,
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
    ip: "192.168.1.100",
  } as unknown as Request;

  let statusCode = 200;
  let responseData: any = null;

  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(data: any) {
      responseData = data;
      return this;
    },
  } as unknown as Response;

  const next = vi.fn();

  return { req, res, next, getStatus: () => statusCode, getBody: () => responseData };
}

describe("Node2Shell / CVE-2026-111497 Defense Invariant", () => {
  it("rejects incoming request with Content-Encoding: br with HTTP 415", () => {
    const { req, res, next, getStatus, getBody } = createMockReqRes({
      "content-encoding": "br",
    });

    threatInterceptor(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(getStatus()).toBe(415);
    expect(getBody()).toMatchObject({
      error: "Unsupported Media Type",
      message: expect.stringContaining("CVE-2026-111497"),
    });
  });

  it("rejects incoming request with Content-Encoding: brotli (case-insensitive) with HTTP 415", () => {
    const { req, res, next, getStatus, getBody } = createMockReqRes({
      "Content-Encoding": "BROTLI",
    });

    threatInterceptor(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(getStatus()).toBe(415);
    expect(getBody()).toMatchObject({
      error: "Unsupported Media Type",
    });
  });

  it("rejects incoming request with mixed encodings containing br (e.g., gzip, br)", () => {
    const { req, res, next, getStatus, getBody } = createMockReqRes({
      "content-encoding": "gzip, br",
    });

    threatInterceptor(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(getStatus()).toBe(415);
    expect(getBody()).toMatchObject({
      error: "Unsupported Media Type",
    });
  });

  it("allows standard uncompressed requests through to next()", () => {
    const { req, res, next, getStatus } = createMockReqRes({
      "content-type": "application/json",
    });

    threatInterceptor(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(getStatus()).toBe(200);
  });
});
