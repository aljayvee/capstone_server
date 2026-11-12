import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("../src/services/sysAdminAlertService.js", () => ({
  sysAdminAlertService: {
    sendTelegramAlert: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock("../src/lib/pushNotifications.js", () => ({
  broadcastPushNotification: vi.fn().mockResolvedValue(true),
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    $queryRaw: vi.fn().mockResolvedValue([{ 1: 1 }]),
    user: { count: vi.fn().mockResolvedValue(10) },
    customerAccount: {
      count: vi.fn().mockResolvedValue(50),
      findMany: vi.fn().mockResolvedValue([{ expoPushToken: "ExponentPushToken[mock-cust]" }]),
    },
    errand: { count: vi.fn().mockResolvedValue(100) },
    userSession: { count: vi.fn().mockResolvedValue(5) },
    accountLoginLog: { count: vi.fn().mockResolvedValue(200) },
    sysAdmin: { count: vi.fn().mockResolvedValue(2) },
  },
}));

import {
  toggleMaintenanceMode,
  getPortalMaintenanceStatus,
  getSystemTelemetry,
  ensureMaintenanceLoaded,
  DEFAULT_MAINTENANCE_HEADERS,
  DEFAULT_MAINTENANCE_MESSAGES,
  DEFAULT_MAINTENANCE_FOOTNOTES,
} from "../src/services/sysAdminDevOpsService.js";
import { broadcastPushNotification } from "../src/lib/pushNotifications.js";

describe("SysAdmin DevOps Maintenance Advisory & Live Notice (Option B)", () => {
  afterEach(async () => {
    // Reset owner, customer, and rider maintenance modes
    await toggleMaintenanceMode("owner", false);
    await toggleMaintenanceMode("customer", false);
    await toggleMaintenanceMode("rider", false);
    vi.clearAllMocks();
  });

  it("should support ADVISORY maintenance type with default playful live polish copy", async () => {
    const config = await toggleMaintenanceMode("owner", true, {
      maintenanceType: "ADVISORY",
    });

    expect(config.portal).toBe("owner");
    expect(config.isActive).toBe(true);
    expect(config.maintenanceType).toBe("ADVISORY");
    expect(config.header).toBe(DEFAULT_MAINTENANCE_HEADERS.ADVISORY);
    expect(config.header).toBe("Heads up: we edit in production");
    expect(config.message).toBe(DEFAULT_MAINTENANCE_MESSAGES.ADVISORY);
    expect(config.message).toContain("If a button moves, a colour changes");
    expect(config.footnote).toBe(DEFAULT_MAINTENANCE_FOOTNOTES.ADVISORY);
    expect(config.footnote).toBe("Please enjoy the construction cones.");

    // Query status directly
    const status = getPortalMaintenanceStatus("owner");
    expect(status.isActive).toBe(true);
    expect(status.maintenanceType).toBe("ADVISORY");
  });

  it("should support LIVE_NOTICE alias and allow custom header, message, and footnote", async () => {
    const customHeader = "Live Polish in Progress";
    const customMessage = "We are updating the UI right now. Your orders are 100% safe.";
    const customFootnote = "Thank you for pairing with us.";

    const config = await toggleMaintenanceMode("customer", true, {
      maintenanceType: "LIVE_NOTICE",
      header: customHeader,
      message: customMessage,
      footnote: customFootnote,
    });

    expect(config.portal).toBe("customer");
    expect(config.isActive).toBe(true);
    expect(config.maintenanceType).toBe("LIVE_NOTICE");
    expect(config.header).toBe(customHeader);
    expect(config.message).toBe(customMessage);
    expect(config.footnote).toBe(customFootnote);

    const status = getPortalMaintenanceStatus("customer");
    expect(status.header).toBe(customHeader);
    expect(status.message).toBe(customMessage);
    expect(status.footnote).toBe(customFootnote);

    expect(broadcastPushNotification).toHaveBeenCalledWith(
      ["ExponentPushToken[mock-cust]"],
      expect.objectContaining({
        title: customHeader,
        body: customMessage,
        urgent: false,
        data: expect.objectContaining({
          type: "LIVE_ADVISORY_NOTICE",
          portal: "customer",
          maintenanceType: "LIVE_NOTICE",
          footnote: customFootnote,
        }),
      })
    );
  });

  it("should deactivate advisory mode cleanly when requested", async () => {
    await toggleMaintenanceMode("owner", true, {
      maintenanceType: "ADVISORY",
    });
    expect(getPortalMaintenanceStatus("owner").isActive).toBe(true);

    const deactivated = await toggleMaintenanceMode("owner", false);
    expect(deactivated.isActive).toBe(false);
    expect(getPortalMaintenanceStatus("owner").isActive).toBe(false);
  });

  it("should resolve ensureMaintenanceLoaded and reflect in getSystemTelemetry", async () => {
    await ensureMaintenanceLoaded();
    await toggleMaintenanceMode("dispatcher", true, {
      maintenanceType: "ADVISORY",
    });

    const telemetry = await getSystemTelemetry();
    expect(telemetry.maintenance.dispatcher.isActive).toBe(true);
    expect(telemetry.maintenance.dispatcher.maintenanceType).toBe("ADVISORY");
    expect(telemetry.maintenance.dispatcher.footnote).toBe(DEFAULT_MAINTENANCE_FOOTNOTES.ADVISORY);

    await toggleMaintenanceMode("dispatcher", false);
  });

  it("should switch between SCHEDULED and ADVISORY properly with default copy transitions", async () => {
    // 1. Start with SCHEDULED
    const scheduled = await toggleMaintenanceMode("owner", true, {
      maintenanceType: "SCHEDULED",
    });
    expect(scheduled.header).toBe(DEFAULT_MAINTENANCE_HEADERS.SCHEDULED);

    // 2. Switch to ADVISORY without explicit header - should auto-promote to ADVISORY header and footnote
    const advisory = await toggleMaintenanceMode("owner", true, {
      maintenanceType: "ADVISORY",
    });
    expect(advisory.header).toBe(DEFAULT_MAINTENANCE_HEADERS.ADVISORY);
    expect(advisory.footnote).toBe(DEFAULT_MAINTENANCE_FOOTNOTES.ADVISORY);

    // 3. Switch back to SCHEDULED - should revert to SCHEDULED header
    const reverted = await toggleMaintenanceMode("owner", true, {
      maintenanceType: "SCHEDULED",
    });
    expect(reverted.header).toBe(DEFAULT_MAINTENANCE_HEADERS.SCHEDULED);
  });
});
