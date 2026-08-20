import { Expo, type ExpoPushMessage } from "expo-server-sdk";
import { logger } from "./logger.js";

const expo = new Expo();

export interface PushNotificationPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

// Fire-and-forget: a push failure must never fail the caller's request (e.g. an
// errand assignment), so every failure path here logs and returns rather than throws.
export async function sendPushNotification(
  expoPushToken: string | null | undefined,
  payload: PushNotificationPayload
): Promise<void> {
  if (!expoPushToken || !Expo.isExpoPushToken(expoPushToken)) {
    return;
  }

  const message: ExpoPushMessage = {
    to: expoPushToken,
    sound: "default",
    title: payload.title,
    body: payload.body,
    data: payload.data,
  };

  try {
    const [ticket] = await expo.sendPushNotificationsAsync([message]);
    if (ticket.status === "error") {
      logger.error("Push notification ticket error:", ticket.message, ticket.details);
    }
  } catch (err) {
    logger.error("Failed to send push notification:", err);
  }
}
