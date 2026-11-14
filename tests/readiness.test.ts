import { describe, it, expect, vi, beforeEach } from "vitest";

// The real client is never used: every case passes its own ping.
vi.mock("../src/lib/prisma.js", () => ({ prisma: {} }));

import { checkReadiness } from "../src/lib/readiness.js";

describe("checkReadiness", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("is ready when the database answers", async () => {
    const result = await checkReadiness(async () => [{ 1: 1 }], 500);

    expect(result.status).toBe("ready");
    expect(result.checks.database.ok).toBe(true);
    expect(result.checks.database.error).toBeUndefined();
    expect(result.checks.database.latencyMs).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Date.parse(result.timestamp))).toBe(false);
  });

  it("is not ready when the database refuses, and leaks no driver text", async () => {
    const result = await checkReadiness(async () => {
      throw new Error("Can't reach database server at `127.0.0.1:3306` user=root");
    }, 500);

    expect(result.status).toBe("not_ready");
    expect(result.checks.database).toMatchObject({ ok: false, error: "unreachable" });
    expect(JSON.stringify(result)).not.toContain("3306");
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it("gives up on a hung database within the timeout", async () => {
    const started = Date.now();
    const result = await checkReadiness(() => new Promise(() => {}), 50);

    expect(result.status).toBe("not_ready");
    expect(result.checks.database.error).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("does not count a late answer after the timeout as ready", async () => {
    const late = new Promise((resolve) => setTimeout(() => resolve([{ 1: 1 }]), 120));
    const result = await checkReadiness(() => late, 30);

    expect(result.status).toBe("not_ready");
    expect(result.checks.database.error).toBe("timeout");
    await late;
  });
});
