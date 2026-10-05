import { Expo, type ExpoPushMessage } from "expo-server-sdk";
import { getMessaging } from "firebase-admin/messaging";
import { getFirebaseAdminApp } from "./firebaseAdmin.js";
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
  /**
   * Android notification tag. A new notification with the same tag replaces
   * the one in the tray instead of stacking under it: how a delivery's "on the
   * way", "5 minutes away" and "arriving" read as one alert that updates.
   * Direct FCM only; Expo's service has no equivalent.
   */
  tag?: string;
}

/**
 * Whether a stored token is a native FCM registration token rather than an
 * Expo push token. The column is still named expoPushToken (the schema is
 * locked); since 2026-09-24 the Android apps register their FCM device token
 * in it instead, because Expo's service could not deliver at all: the Expo
 * project had no FCM credentials, and every send came back InvalidCredentials.
 */
export function isFcmToken(token: string): boolean {
  // Cast: isExpoPushToken is a type guard, and negating it narrows a plain
  // string to never.
  const looksExpo = Expo.isExpoPushToken(token as unknown);
  return !looksExpo && token.length >= 100 && /^[\w:\-]+$/.test(token);
}

// FCM data values must be strings.
function stringData(data: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!data) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    out[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return out;
}

/**
 * Straight to the device over FCM, with the server's Firebase service account.
 *
 * A `notification` message: while the app is closed, or swiped away from
 * recents, Android itself puts it in the tray. The app does not need to be
 * running to receive it (only a user's "Force stop" in settings blocks
 * delivery, and that until the app is next opened).
 */
async function sendViaFcm(token: string, payload: PushNotificationPayload): Promise<void> {
  const app = getFirebaseAdminApp();
  if (!app) {
    logger.warn("Push not sent: no Firebase service account is configured.");
    return;
  }
  try {
    await getMessaging(app).send({
      token,
      notification: { title: payload.title, body: payload.body },
      data: stringData(payload.data),
      android: {
        priority: payload.urgent ? "high" : "normal",
        notification: {
          channelId: payload.channelId ?? "default",
          sound: "default",
          tag: payload.tag,
          defaultVibrateTimings: true,
        },
      },
    });
  } catch (err: any) {
    const code = err?.errorInfo?.code ?? err?.code;
    if (code === "messaging/registration-token-not-registered") {
      // The app was uninstalled or its token rotated; the next launch
      // registers a fresh one.
      logger.info("Push not delivered: the device token is no longer registered.");
      return;
    }
    logger.error("Failed to send FCM push notification:", code ?? err);
  }
}

// Fire-and-forget: a push failure must never fail the caller's request (e.g. an
// errand assignment), so every failure path here logs and returns rather than throws.
export async function sendPushNotification(
  expoPushToken: string | null | undefined,
  payload: PushNotificationPayload
): Promise<void> {
  if (!expoPushToken) return;

  if (isFcmToken(expoPushToken)) {
    await sendViaFcm(expoPushToken, payload);
    return;
  }

  if (!Expo.isExpoPushToken(expoPushToken)) {
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

/**
 * Broadcasts a push notification to multiple tokens in bulk.
 * Partitions tokens into direct FCM and Expo push batches.
 */
export async function broadcastPushNotification(
  tokens: (string | null | undefined)[],
  payload: PushNotificationPayload
): Promise<{ sentCount: number; failedCount: number }> {
  const validTokens = Array.from(new Set(tokens.filter((t): t is string => Boolean(t && typeof t === "string"))));
  if (validTokens.length === 0) {
    return { sentCount: 0, failedCount: 0 };
  }

  const fcmTokens: string[] = [];
  const expoTokens: string[] = [];

  for (const t of validTokens) {
    if (isFcmToken(t)) {
      fcmTokens.push(t);
    } else if (Expo.isExpoPushToken(t)) {
      expoTokens.push(t);
    }
  }

  let sentCount = 0;
  let failedCount = 0;

  // 1. Send FCM multicast
  const app = getFirebaseAdminApp();
  if (app && fcmTokens.length > 0) {
    const BATCH_SIZE = 500;
    for (let i = 0; i < fcmTokens.length; i += BATCH_SIZE) {
      const batch = fcmTokens.slice(i, i + BATCH_SIZE);
      try {
        const response = await getMessaging(app).sendEachForMulticast({
          tokens: batch,
          notification: { title: payload.title, body: payload.body },
          data: stringData(payload.data),
          android: {
            priority: payload.urgent ? "high" : "normal",
            notification: {
              channelId: payload.channelId ?? "default",
              sound: "default",
              tag: payload.tag,
              defaultVibrateTimings: true,
            },
          },
        });
        sentCount += response.successCount;
        failedCount += response.failureCount;
        if (response.failureCount > 0) {
          logger.warn(`[broadcastPushNotification] ${response.failureCount} FCM notifications failed in batch.`);
        }
      } catch (err) {
        logger.error("[broadcastPushNotification] FCM multicast failed:", err);
        failedCount += batch.length;
      }
    }
  } else if (!app && fcmTokens.length > 0) {
    logger.warn(`[broadcastPushNotification] Skipped ${fcmTokens.length} FCM tokens: Firebase Admin not configured.`);
    failedCount += fcmTokens.length;
  }

  // 2. Send Expo push notifications
  if (expoTokens.length > 0) {
    const messages: ExpoPushMessage[] = expoTokens.map((to) => ({
      to,
      sound: "default",
      title: payload.title,
      body: payload.body,
      data: payload.data,
      priority: payload.urgent ? "high" : "default",
      channelId: payload.channelId ?? "default",
    }));

    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      try {
        const tickets = await expo.sendPushNotificationsAsync(chunk);
        for (const ticket of tickets) {
          if (ticket.status === "ok") {
            sentCount++;
          } else {
            failedCount++;
          }
        }
      } catch (err) {
        logger.error("[broadcastPushNotification] Expo push batch error:", err);
        failedCount += chunk.length;
      }
    }
  }

  logger.info(`[broadcastPushNotification] Broadcast complete: ${sentCount} sent, ${failedCount} failed.`);
  return { sentCount, failedCount };
}

