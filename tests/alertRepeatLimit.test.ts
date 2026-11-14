import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../src/lib/prisma.js", () => ({ prisma: { sysAdminAlert: { create } } }));

import {
  sysAdminAlertService,
  resetAlertRepeatLimit,
  REPEAT_WINDOW_MS,
} from "../src/services/sysAdminAlertService.js";

const fetchMock = vi.fn();

function sentTexts(): string[] {
  return fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).text as string);
}
function recordedStatuses(): string[] {
  return create.mock.calls.map((c) => c[0].data.status);
}

const ban = (ip: string) => ({
  alertType: "CRITICAL_INTRUSION" as const,
  title: `IP Blacklisted: ${ip}`,
  message: `IP ${ip} has been banned.`,
  repeatKey: "CRITICAL_INTRUSION",
});

describe("sendTelegramAlert repeat limit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-15T00:00:00Z"));
    resetAlertRepeatLimit();
    create.mockReset().mockResolvedValue({});
    fetchMock.mockReset().mockResolvedValue({ ok: true, text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_ALERT_CHAT_ID = "12345";
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_ALERT_CHAT_ID;
  });

  it("sends one alert per key per window, records the rest as held back", async () => {
    expect(await sysAdminAlertService.sendTelegramAlert(ban("1.1.1.1"))).toBe(true);
    expect(await sysAdminAlertService.sendTelegramAlert(ban("2.2.2.2"))).toBe(false);
    expect(await sysAdminAlertService.sendTelegramAlert(ban("3.3.3.3"))).toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recordedStatuses()).toEqual(["SENT", "SUPPRESSED", "SUPPRESSED"]);
    expect(create.mock.calls[1][0].data.metadata).toMatchObject({ suppressedReason: "repeat_limit" });
  });

  it("reports how many were held back in the next alert after the window", async () => {
    await sysAdminAlertService.sendTelegramAlert(ban("1.1.1.1"));
    await sysAdminAlertService.sendTelegramAlert(ban("2.2.2.2"));
    await sysAdminAlertService.sendTelegramAlert(ban("3.3.3.3"));

    vi.advanceTimersByTime(REPEAT_WINDOW_MS);
    expect(await sysAdminAlertService.sendTelegramAlert(ban("4.4.4.4"))).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentTexts()[1]).toContain("2 similar alerts were held back");
    // The count resets once reported.
    vi.advanceTimersByTime(REPEAT_WINDOW_MS);
    await sysAdminAlertService.sendTelegramAlert(ban("5.5.5.5"));
    expect(sentTexts()[2]).not.toContain("held back");
  });

  it("defaults the key to type plus title, so different alerts are not merged", async () => {
    const base = { alertType: "SERVICE_RESTART" as const, message: "m" };
    await sysAdminAlertService.sendTelegramAlert({ ...base, title: "Maintenance ACTIVATED" });
    await sysAdminAlertService.sendTelegramAlert({ ...base, title: "Maintenance DEACTIVATED" });
    await sysAdminAlertService.sendTelegramAlert({ ...base, title: "Maintenance DEACTIVATED" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(recordedStatuses()).toEqual(["SENT", "SENT", "SUPPRESSED"]);
  });

  it("never holds back an alert that bypasses the limit", async () => {
    const down = { alertType: "DB_DISCONNECT" as const, title: "Database not answering", message: "m", bypassRepeatLimit: true };
    await sysAdminAlertService.sendTelegramAlert(down);
    await sysAdminAlertService.sendTelegramAlert(down);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("lets the next alert try again after a failed send", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 502, text: async () => "bad gateway" });
    expect(await sysAdminAlertService.sendTelegramAlert(ban("1.1.1.1"))).toBe(false);
    expect(await sysAdminAlertService.sendTelegramAlert(ban("2.2.2.2"))).toBe(true);
    expect(recordedStatuses()).toEqual(["FAILED", "SENT"]);
  });

  it("still sends when the database cannot record the alert", async () => {
    create.mockRejectedValue(new Error("Can't reach database server"));
    await expect(
      sysAdminAlertService.sendTelegramAlert({ alertType: "DB_DISCONNECT", title: "Database not answering", message: "m" })
    ).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("marks unconfigured alerts as not_configured and applies no limit", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    await sysAdminAlertService.sendTelegramAlert(ban("1.1.1.1"));
    await sysAdminAlertService.sendTelegramAlert(ban("2.2.2.2"));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(create.mock.calls.map((c) => c[0].data.metadata.suppressedReason)).toEqual([
      "not_configured",
      "not_configured",
    ]);

    // Turning Telegram on later sends straight away: no window was opened while it was off.
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    expect(await sysAdminAlertService.sendTelegramAlert(ban("3.3.3.3"))).toBe(true);
  });
});
