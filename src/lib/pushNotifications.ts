import { Expo, type ExpoPushMessage } from "expo-server-sdk";
import { logger } from "./logger.js";

const expo = new Expo();

export interface PushNotificationPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
  /**
   * Whether this needs to wake a sleeping phone.
   *
   * Android defers NORMAL priority messages while the device is in Doze — a
   * locked handset in a rider's pocket can hold one for minutes. That is fatal
   * for anything the rider has to act on inside a countdown, and invisible in
   * testing because a plugged-in phone with the screen on is never in Doze.
   *
   * "high" wakes the device immediately. Reserved for messages a rider must see
   * NOW: an errand offered to them, and its reminder. Everything else stays
   * normal, because a high-priority message the user did not need is how an app
   * loses the privilege of sending them at all.
   */
  urgent?: boolean;
  /** Android channel. Must match a channel the app created, or importance is lost. */
  channelId?: string;
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
    priority: payload.urgent ? "high" : "default",
    // The app creates "default" at IMPORTANCE_HIGH (useRegisterPushToken). Without
    // naming it, Android files the message under its own default channel and the
    // importance the app configured is simply not applied.
    channelId: payload.channelId ?? "default",
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
