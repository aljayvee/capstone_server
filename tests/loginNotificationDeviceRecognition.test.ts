import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  userKnownDeviceFindUnique,
  userKnownDeviceCreate,
  userKnownDeviceUpdate,
  userSessionFindFirst,
  accountLoginLogFindFirst,
  sendEmailMock,
} = vi.hoisted(() => ({
  userKnownDeviceFindUnique: vi.fn(),
  userKnownDeviceCreate: vi.fn(),
  userKnownDeviceUpdate: vi.fn(),
  userSessionFindFirst: vi.fn(),
  accountLoginLogFindFirst: vi.fn(),
  sendEmailMock: vi.fn(),
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    userKnownDevice: {
      findUnique: userKnownDeviceFindUnique,
      create: userKnownDeviceCreate,
      update: userKnownDeviceUpdate,
    },
    userSession: {
      findFirst: userSessionFindFirst,
    },
    accountLoginLog: {
      findFirst: accountLoginLogFindFirst,
    },
  },
}));

vi.mock("../src/lib/mailer.js", () => ({
  sendEmail: sendEmailMock,
}));

import {
  resolveEffectiveDeviceId,
  checkAndRegisterDevice,
  sendLoginAlert,
  type LoginContext,
  type LoginAlertUser,
} from "../src/services/loginNotificationService.js";

describe("Device Recognition & Login Notification Suppression", () => {
  const dummyUser: LoginAlertUser = {
    id: 42,
    firstName: "Maria",
    lastName: "Santos",
    username: "dispatcher_maria",
    email: "maria.santos@sugo-express.org",
    role: "DISPATCHER",
  };

  const chromeWindowsUA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  const edgeWindowsUA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0";

  beforeEach(() => {
    vi.clearAllMocks();
    userKnownDeviceFindUnique.mockResolvedValue(null);
    userKnownDeviceCreate.mockResolvedValue({ id: 1 });
    userKnownDeviceUpdate.mockResolvedValue({ id: 1 });
    userSessionFindFirst.mockResolvedValue(null);
    accountLoginLogFindFirst.mockResolvedValue(null);
    sendEmailMock.mockResolvedValue(true);
  });

  describe("resolveEffectiveDeviceId", () => {
    it("returns explicit deviceId when provided", () => {
      const ctx: LoginContext = {
        deviceId: "web-client-uuid-12345",
        userAgent: chromeWindowsUA,
        ipAddress: "124.106.12.34",
        deviceHint: null,
        channel: "WEB_PORTAL",
      };
      expect(resolveEffectiveDeviceId(ctx)).toBe("web-client-uuid-12345");
    });

    it("falls back to deterministic ua-hash when deviceId is missing", () => {
      const ctx: LoginContext = {
        deviceId: null,
        userAgent: chromeWindowsUA,
        ipAddress: "124.106.12.34",
        deviceHint: null,
        channel: "WEB_PORTAL",
      };
      const resolved = resolveEffectiveDeviceId(ctx);
      expect(resolved).toMatch(/^ua-[a-f0-9]{32}$/);

      // Consistent hash for the same userAgent
      const resolvedAgain = resolveEffectiveDeviceId(ctx);
      expect(resolvedAgain).toBe(resolved);

      // Different userAgent yields different hash
      const edgeCtx: LoginContext = { ...ctx, userAgent: edgeWindowsUA };
      expect(resolveEffectiveDeviceId(edgeCtx)).not.toBe(resolved);
    });

    it("safely falls back to deterministic hash when deviceId is 'undefined' or 'null' string", () => {
      const ctxUndefined: LoginContext = {
        deviceId: "undefined",
        userAgent: chromeWindowsUA,
        ipAddress: "124.106.12.34",
        deviceHint: null,
        channel: "WEB_PORTAL",
      };
      const ctxNull: LoginContext = {
        deviceId: "null",
        userAgent: chromeWindowsUA,
        ipAddress: "124.106.12.34",
        deviceHint: null,
        channel: "WEB_PORTAL",
      };
      expect(resolveEffectiveDeviceId(ctxUndefined)).toMatch(/^ua-[a-f0-9]{32}$/);
      expect(resolveEffectiveDeviceId(ctxNull)).toMatch(/^ua-[a-f0-9]{32}$/);
    });

    it("uses deviceHint in hash for mobile app when deviceId is missing", () => {
      const riderCtx: LoginContext = {
        deviceId: null,
        userAgent: null,
        ipAddress: "124.106.12.34",
        deviceHint: "Samsung Galaxy A54",
        channel: "RIDER_APP",
      };
      const resolved = resolveEffectiveDeviceId(riderCtx);
      expect(resolved).toMatch(/^ua-[a-f0-9]{32}$/);
    });

    it("returns null when neither deviceId, deviceHint nor userAgent are present", () => {
      const ctx: LoginContext = {
        deviceId: null,
        userAgent: null,
        ipAddress: "124.106.12.34",
        deviceHint: null,
        channel: "WEB_PORTAL",
      };
      expect(resolveEffectiveDeviceId(ctx)).toBeNull();
    });
  });

  describe("checkAndRegisterDevice", () => {
    it("recognizes first-time device as new, registers it, and returns isNew: true", async () => {
      userKnownDeviceFindUnique.mockResolvedValue(null);
      userSessionFindFirst.mockResolvedValue(null);

      const ctx: LoginContext = {
        deviceId: "laptop-chrome-dev-1",
        userAgent: chromeWindowsUA,
        ipAddress: "124.106.12.34",
        deviceHint: null,
        channel: "WEB_PORTAL",
      };

      const result = await checkAndRegisterDevice(dummyUser.id, ctx);

      expect(result.isNew).toBe(true);
      expect(userKnownDeviceFindUnique).toHaveBeenCalledWith({
        where: {
          userId_deviceId: {
            userId: 42,
            deviceId: "laptop-chrome-dev-1",
          },
        },
      });
      expect(userKnownDeviceCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: 42,
            deviceId: "laptop-chrome-dev-1",
            userAgent: chromeWindowsUA,
            ipAddress: "124.106.12.34",
          }),
        })
      );
      expect(userKnownDeviceUpdate).not.toHaveBeenCalled();
    });

    it("recognizes existing device, updates lastSeenAt, and returns isNew: false", async () => {
      userKnownDeviceFindUnique.mockResolvedValue({
        id: 99,
        userId: 42,
        deviceId: "laptop-chrome-dev-1",
        firstSeenAt: new Date(Date.now() - 86400000),
        lastSeenAt: new Date(Date.now() - 3600000),
      });

      const ctx: LoginContext = {
        deviceId: "laptop-chrome-dev-1",
        userAgent: chromeWindowsUA,
        ipAddress: "124.106.12.99",
        deviceHint: null,
        channel: "WEB_PORTAL",
      };

      const result = await checkAndRegisterDevice(dummyUser.id, ctx);

      expect(result.isNew).toBe(false);
      expect(userKnownDeviceCreate).not.toHaveBeenCalled();
      expect(userKnownDeviceUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 99 },
          data: expect.objectContaining({
            ipAddress: "124.106.12.99",
          }),
        })
      );
    });

    it("returns isNew: false even if updating lastSeenAt throws (resilient against update errors)", async () => {
      userKnownDeviceFindUnique.mockResolvedValue({
        id: 99,
        userId: 42,
        deviceId: "laptop-chrome-dev-1",
        firstSeenAt: new Date(Date.now() - 86400000),
        lastSeenAt: new Date(Date.now() - 3600000),
      });
      userKnownDeviceUpdate.mockRejectedValue(new Error("DB update connection failed"));

      const ctx: LoginContext = {
        deviceId: "laptop-chrome-dev-1",
        userAgent: chromeWindowsUA,
        ipAddress: "124.106.12.99",
        deviceHint: null,
        channel: "WEB_PORTAL",
      };

      const result = await checkAndRegisterDevice(dummyUser.id, ctx);

      // Must NOT fail open into sending a security alert email!
      expect(result.isNew).toBe(false);
    });

    it("gracefully backfills from user_sessions regardless of revokedAt timestamp", async () => {
      userKnownDeviceFindUnique.mockResolvedValue(null);
      const sessionCreatedAt = new Date(Date.now() - 259200000); // 3 days ago
      userSessionFindFirst.mockResolvedValue({
        id: "session-abc-123",
        createdAt: sessionCreatedAt,
      });

      const ctx: LoginContext = {
        deviceId: "pre-existing-device-id",
        userAgent: chromeWindowsUA,
        ipAddress: "124.106.12.34",
        deviceHint: null,
        channel: "WEB_PORTAL",
      };

      const result = await checkAndRegisterDevice(dummyUser.id, ctx);

      expect(result.isNew).toBe(false);
      // Verify query did NOT restrict by revokedAt: null (which would miss sessions revoked by revokeSameDeviceSessions)
      expect(userSessionFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            subjectId: 42,
            subjectType: "USER",
            deviceId: "pre-existing-device-id",
          },
        })
      );
      expect(userKnownDeviceCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: 42,
            deviceId: "pre-existing-device-id",
            firstSeenAt: sessionCreatedAt,
          }),
        })
      );
    });

    it("gracefully backfills ua-hash device from account_login_logs", async () => {
      userKnownDeviceFindUnique.mockResolvedValue(null);
      userSessionFindFirst.mockResolvedValue(null);
      const loginLogCreatedAt = new Date(Date.now() - 86400000);
      accountLoginLogFindFirst.mockResolvedValue({
        id: 501,
        createdAt: loginLogCreatedAt,
      });

      const ctxWithoutDeviceId: LoginContext = {
        deviceId: null,
        userAgent: chromeWindowsUA,
        ipAddress: "124.106.12.34",
        deviceHint: null,
        channel: "WEB_PORTAL",
      };

      const result = await checkAndRegisterDevice(dummyUser.id, ctxWithoutDeviceId);

      expect(result.isNew).toBe(false);
      expect(accountLoginLogFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: 42,
            status: "SUCCESS",
            userAgent: chromeWindowsUA,
          }),
        })
      );
    });

    it("does NOT suppress alert for a new laptop with new deviceId just because account_login_logs has same UA", async () => {
      userKnownDeviceFindUnique.mockResolvedValue(null);
      userSessionFindFirst.mockResolvedValue(null);
      accountLoginLogFindFirst.mockResolvedValue({
        id: 501,
        createdAt: new Date(Date.now() - 86400000),
      });

      const newLaptopCtx: LoginContext = {
        deviceId: "brand-new-laptop-uuid",
        userAgent: chromeWindowsUA,
        ipAddress: "124.106.12.34",
        deviceHint: null,
        channel: "WEB_PORTAL",
      };

      const result = await checkAndRegisterDevice(dummyUser.id, newLaptopCtx);

      // Must be recognized as NEW and NOT falsely backfilled from prior laptop's UA log!
      expect(result.isNew).toBe(true);
      expect(accountLoginLogFindFirst).not.toHaveBeenCalled();
    });

    it("handles concurrent registration race condition (P2002) without throwing", async () => {
      userKnownDeviceFindUnique.mockResolvedValue(null);
      userSessionFindFirst.mockResolvedValue(null);
      userKnownDeviceCreate.mockRejectedValue({ code: "P2002", message: "Unique constraint failed" });

      const ctx: LoginContext = {
        deviceId: "race-condition-device",
        userAgent: chromeWindowsUA,
        ipAddress: "124.106.12.34",
        deviceHint: null,
        channel: "WEB_PORTAL",
      };

      const result = await checkAndRegisterDevice(dummyUser.id, ctx);

      expect(result.isNew).toBe(false);
    });
  });

  describe("sendLoginAlert", () => {
    it("dispatches email alert for a newly seen device", async () => {
      userKnownDeviceFindUnique.mockResolvedValue(null);
      userSessionFindFirst.mockResolvedValue(null);

      const ctx: LoginContext = {
        deviceId: "new-unseen-phone",
        userAgent: null,
        deviceHint: "Samsung Galaxy A54",
        channel: "RIDER_APP",
        ipAddress: "112.198.67.89",
      };

      await sendLoginAlert(dummyUser, ctx);

      expect(sendEmailMock).toHaveBeenCalledTimes(1);
      const [to, subject, text, html] = sendEmailMock.mock.calls[0];
      expect(to).toBe("maria.santos@sugo-express.org");
      expect(subject).toContain("New sign-in to your Sugo Express account");
      expect(text).toContain("Sugo Rider App (Samsung Galaxy A54)");
      expect(html).toContain("New Sign-In Detected");
    });

    it("suppresses email alert for an already recognized device", async () => {
      userKnownDeviceFindUnique.mockResolvedValue({
        id: 77,
        userId: 42,
        deviceId: "known-laptop-chrome",
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
      });

      const ctx: LoginContext = {
        deviceId: "known-laptop-chrome",
        userAgent: chromeWindowsUA,
        ipAddress: "124.106.12.34",
        deviceHint: null,
        channel: "WEB_PORTAL",
      };

      await sendLoginAlert(dummyUser, ctx);

      // CRITICAL ASSERTION: Email MUST NOT be sent for known devices
      expect(sendEmailMock).not.toHaveBeenCalled();
    });

    it("suppresses email alert for known device even if updating lastSeenAt rejects", async () => {
      userKnownDeviceFindUnique.mockResolvedValue({
        id: 77,
        userId: 42,
        deviceId: "known-laptop-chrome",
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
      });
      userKnownDeviceUpdate.mockRejectedValue(new Error("Database write failed"));

      const ctx: LoginContext = {
        deviceId: "known-laptop-chrome",
        userAgent: chromeWindowsUA,
        ipAddress: "124.106.12.34",
        deviceHint: null,
        channel: "WEB_PORTAL",
      };

      await sendLoginAlert(dummyUser, ctx);

      // Must NOT send an email just because timestamp update failed
      expect(sendEmailMock).not.toHaveBeenCalled();
    });

    it("distinguishes between different browsers on the same laptop", async () => {
      // Chrome is known
      userKnownDeviceFindUnique.mockImplementation(async ({ where }: any) => {
        if (where?.userId_deviceId?.deviceId === "chrome-browser-id") {
          return { id: 1, userId: 42, deviceId: "chrome-browser-id" };
        }
        return null;
      });

      const chromeCtx: LoginContext = {
        deviceId: "chrome-browser-id",
        userAgent: chromeWindowsUA,
        ipAddress: "124.106.12.34",
        deviceHint: null,
        channel: "WEB_PORTAL",
      };

      // Sign in on Chrome -> Suppressed
      await sendLoginAlert(dummyUser, chromeCtx);
      expect(sendEmailMock).not.toHaveBeenCalled();

      // Sign in on Edge on the same machine -> Different deviceId -> Dispatches email!
      const edgeCtx: LoginContext = {
        deviceId: "edge-browser-id",
        userAgent: edgeWindowsUA,
        ipAddress: "124.106.12.34",
        deviceHint: null,
        channel: "WEB_PORTAL",
      };

      await sendLoginAlert(dummyUser, edgeCtx);
      expect(sendEmailMock).toHaveBeenCalledTimes(1);
      expect(sendEmailMock.mock.calls[0][3]).toContain("Microsoft Edge on Windows 10/11");
    });

    it("safely exits without sending email if user has no email address", async () => {
      const userWithoutEmail: LoginAlertUser = {
        ...dummyUser,
        email: "",
      };

      const ctx: LoginContext = {
        deviceId: "any-device",
        userAgent: chromeWindowsUA,
        ipAddress: "124.106.12.34",
        deviceHint: null,
        channel: "WEB_PORTAL",
      };

      await sendLoginAlert(userWithoutEmail, ctx);

      expect(sendEmailMock).not.toHaveBeenCalled();
      expect(userKnownDeviceFindUnique).not.toHaveBeenCalled();
    });
  });
});
