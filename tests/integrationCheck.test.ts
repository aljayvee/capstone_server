import { describe, it, expect } from "vitest";
import {
  createIntegrationChecks,
  redactSecrets,
  ago,
  INTEGRATIONS,
  __test,
  type IntegrationKey,
  type ProbeOutcome,
} from "../src/services/integrationCheckService.js";

const ALL_OK = Object.fromEntries(
  INTEGRATIONS.map((d) => [d.key, async (): Promise<ProbeOutcome> => ({ status: "ok", summary: "fine" })]),
) as Record<IntegrationKey, () => Promise<ProbeOutcome>>;

describe("integration report", () => {
  it("answers once per integration, in a fixed order, with an overall status", async () => {
    const checks = createIntegrationChecks({ probes: ALL_OK, cacheMs: 0 });
    const report = await checks.report();
    expect(report.results.map((r) => r.key)).toEqual(INTEGRATIONS.map((d) => d.key));
    expect(report.overall).toBe("ok");
  });

  it("is as bad as its worst result; off and unchecked do not count against it", async () => {
    const quiet = createIntegrationChecks({
      probes: { ...ALL_OK, gemini: async () => ({ status: "off", summary: "" }), places: async () => ({ status: "unchecked", summary: "" }) },
      cacheMs: 0,
    });
    expect((await quiet.report()).overall).toBe("ok");

    const warn = createIntegrationChecks({ probes: { ...ALL_OK, routing: async () => ({ status: "warn", summary: "" }) }, cacheMs: 0 });
    expect((await warn.report()).overall).toBe("warn");

    const down = createIntegrationChecks({
      probes: { ...ALL_OK, routing: async () => ({ status: "warn", summary: "" }), email: async () => ({ status: "down", summary: "" }) },
      cacheMs: 0,
    });
    expect((await down.report()).overall).toBe("down");
  });

  it("turns a hung probe into 'down' within the time limit, without holding the others", async () => {
    const checks = createIntegrationChecks({
      probes: { ...ALL_OK, offsite: () => new Promise(() => {}) },
      timeoutMs: 50,
      cacheMs: 0,
    });
    const started = Date.now();
    const report = await checks.report();
    expect(Date.now() - started).toBeLessThan(1000);
    const offsite = report.results.find((r) => r.key === "offsite")!;
    expect(offsite).toMatchObject({ status: "down", summary: expect.stringContaining("No answer within") });
    expect(report.results.filter((r) => r.status === "ok")).toHaveLength(INTEGRATIONS.length - 1);
  });

  it("turns a throwing probe into 'down' and never shows a secret it echoed", async () => {
    const env = { TELEGRAM_BOT_TOKEN: "123456:ABCdefSECRET" };
    const checks = createIntegrationChecks({
      env,
      probes: {
        ...ALL_OK,
        telegram: async () => {
          throw new Error("request to https://api.telegram.org/bot123456:ABCdefSECRET/getMe failed");
        },
      },
      cacheMs: 0,
    });
    const telegram = (await checks.report()).results.find((r) => r.key === "telegram")!;
    expect(telegram.status).toBe("down");
    expect(telegram.summary).not.toContain("ABCdefSECRET");
    expect(telegram.summary).toContain("bot[hidden]/getMe");
  });

  it("also hides secrets in a summary a probe returned normally", async () => {
    const env = { SMTP_PASS: "xsmtpsib-very-secret" };
    const checks = createIntegrationChecks({
      env,
      probes: { ...ALL_OK, email: async () => ({ status: "down", summary: "535 auth failed for xsmtpsib-very-secret" }) },
      cacheMs: 0,
    });
    const email = (await checks.report()).results.find((r) => r.key === "email")!;
    expect(email.summary).toBe("535 auth failed for [hidden]");
  });

  it("reuses a recent run and shares one run between concurrent callers", async () => {
    let calls = 0;
    let t = 1_000_000;
    const counted = { ...ALL_OK, database: async () => (calls++, { status: "ok" as const, summary: "" }) };
    const checks = createIntegrationChecks({ probes: counted, now: () => t, cacheMs: 20_000 });

    await Promise.all([checks.report(), checks.report(), checks.report()]);
    expect(calls).toBe(1);
    t += 10_000;
    await checks.report();
    expect(calls).toBe(1);
    t += 15_000;
    await checks.report();
    expect(calls).toBe(2);
  });
});

describe("routing summary", () => {
  const now = 10 * 60 * 60 * 1000;
  const google = { name: "google" as const, configured: true, open: false, consecutiveFailures: 0, lastSuccessAt: now - 3 * 60000, lastFailureAt: null };
  const osrm = { name: "osrm" as const, configured: true, open: false, consecutiveFailures: 0, lastSuccessAt: null, lastFailureAt: null };
  const haversine = { name: "haversine" as const, configured: true, open: false, consecutiveFailures: 0, lastSuccessAt: null, lastFailureAt: null };

  it("names an unknown provider in ROUTING_PROVIDER_ORDER (production had \"havcersine\")", () => {
    const out = __test.describeRouting(
      { ignoredNames: ["havcersine"], providers: [google, osrm, haversine] },
      { ok: true, ms: 12 },
      now,
    );
    expect(out.status).toBe("warn");
    expect(out.summary).toContain('unknown name "havcersine"');
    expect(out.summary).toContain("Google last answered 3 min ago");
    expect(out.summary).toContain("OSRM answers in 12 ms");
    expect(out.summary).toContain("Order: google > osrm > haversine.");
  });

  it("is ok when the order is clean and the providers answer", () => {
    const out = __test.describeRouting({ ignoredNames: [], providers: [google, osrm, haversine] }, { ok: true, ms: 5 }, now);
    expect(out.status).toBe("ok");
  });

  it("is down when every road provider is failing, because fares fall back to straight lines", () => {
    const out = __test.describeRouting(
      { ignoredNames: [], providers: [{ ...google, open: true, consecutiveFailures: 3 }, osrm, haversine] },
      { ok: false, ms: 3000, error: "fetch failed" },
      now,
    );
    expect(out.status).toBe("down");
    expect(out.summary).toContain("straight-line");
  });

  it("is only a warning when one road provider fails and another still answers", () => {
    const out = __test.describeRouting({ ignoredNames: [], providers: [google, osrm, haversine] }, { ok: false, ms: 3000, error: "fetch failed" }, now);
    expect(out.status).toBe("warn");
    expect(out.summary).toContain("OSRM does not answer (fetch failed)");
  });
});

describe("helpers", () => {
  it("redacts every configured secret, and leaves short or empty values alone", () => {
    expect(redactSecrets("a KEY123456 b KEY123456", { GOOGLE_MAPS_API_KEY: "KEY123456" })).toBe("a [hidden] b [hidden]");
    expect(redactSecrets("abc", { SMTP_PASS: "" })).toBe("abc");
    expect(redactSecrets("x".repeat(400)).length).toBe(300);
  });

  it("says how long ago in words", () => {
    expect(ago(0, 30_000)).toBe("just now");
    expect(ago(0, 5 * 60000)).toBe("5 min ago");
    expect(ago(0, 3 * 3600000)).toBe("3 h ago");
    expect(ago(0, 72 * 3600000)).toBe("3 days ago");
  });
});
