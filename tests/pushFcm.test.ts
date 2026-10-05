import { beforeEach, describe, expect, it, vi } from "vitest";

const { fcmSend, expoSend } = vi.hoisted(() => ({ fcmSend: vi.fn(), expoSend: vi.fn() }));

vi.mock("../src/lib/firebaseAdmin.js", () => ({ getFirebaseAdminApp: () => ({ name: "app" }) }));
vi.mock("firebase-admin/messaging", () => ({ getMessaging: () => ({ send: fcmSend }) }));
vi.mock("expo-server-sdk", () => {
  class Expo {
    static isExpoPushToken(token: unknown) {
      return typeof token === "string" && /^Expo(nent)?PushToken\[.+\]$/.test(token);
    }
    sendPushNotificationsAsync = expoSend;
  }
  return { Expo };
});

import { isFcmToken, sendPushNotification } from "../src/lib/pushNotifications.js";

// Shaped like a real FCM registration token: ~160 characters with a colon.
const FCM = "dQw4w9WgXcQ:APA91b" + "x".repeat(140);

beforeEach(() => {
  fcmSend.mockReset().mockResolvedValue("projects/p/messages/1");
  expoSend.mockReset().mockResolvedValue([{ status: "ok" }]);
});

describe("which service a stored token goes to", () => {
  it("tells an FCM device token from an Expo push token", () => {
    expect(isFcmToken(FCM)).toBe(true);
    expect(isFcmToken("ExponentPushToken[abc]")).toBe(false);
    expect(isFcmToken("short")).toBe(false);
  });

  it("sends an FCM token straight to Firebase, as a notification Android shows with the app closed", async () => {
    await sendPushNotification(FCM, {
      title: "Your order is on the way",
      body: "About 14 min away.",
      channelId: "delivery-alerts",
      tag: "delivery-e-1",
      urgent: true,
      data: { errandId: "e-1", attempt: 2 },
    });
    expect(expoSend).not.toHaveBeenCalled();
    const message = fcmSend.mock.calls[0][0];
    expect(message.token).toBe(FCM);
    expect(message.notification).toEqual({ title: "Your order is on the way", body: "About 14 min away." });
    expect(message.android).toMatchObject({
      priority: "high",
      notification: { channelId: "delivery-alerts", tag: "delivery-e-1" },
    });
    // FCM data values must be strings.
    expect(message.data).toEqual({ errandId: "e-1", attempt: "2" });
  });

  it("still sends an Expo token through Expo", async () => {
    await sendPushNotification("ExponentPushToken[abc]", { title: "t", body: "b" });
    expect(expoSend).toHaveBeenCalledTimes(1);
    expect(fcmSend).not.toHaveBeenCalled();
  });

  it("never throws when Firebase refuses", async () => {
    fcmSend.mockRejectedValue({ errorInfo: { code: "messaging/registration-token-not-registered" } });
    await expect(sendPushNotification(FCM, { title: "t", body: "b" })).resolves.toBeUndefined();
  });
});
