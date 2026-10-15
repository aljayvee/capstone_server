import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { RequestHandler } from "express";
import { getClientIp } from "../lib/requestContext.js";

const isDev = process.env.NODE_ENV === "development" || !process.env.NODE_ENV;

/**
 * The caller's IP as a rate-limit key: resolved through the proxies that
 * lib/trustedProxies.ts trusts (so no header can choose it), with IPv6 masked
 * to a /56 by express-rate-limit's helper (so nobody can step through their
 * own block of addresses for fresh buckets). The library's default key does
 * the same, which keeps every IP-keyed limiter on one definition of "an IP".
 */
export const clientIpKey = (req: any): string => `ip_${ipKeyGenerator(getClientIp(req) || "127.0.0.1")}`;

/**
 * The signed-in account when there is one, otherwise the IP.
 *
 * It used to fall back to the client-sent `x-device-id` before the IP. On a
 * route nobody has signed in for yet (registration, a public photo, the
 * traffic report), sending a fresh random id with every request then bought a
 * fresh bucket every time (2026-10-16). Signed-in routes are unaffected: they
 * always had an account id to key on.
 */
export const smartKeyGenerator = (req: any): string => {
  if (req.user?.id) {
    return `user_${req.user.id}`;
  }
  return clientIpKey(req);
};

/**
 * Sign-in only: per device, so riders and customers who share a mobile
 * carrier's IP each get their own allowance of typos. On its own this was the
 * hole (rotate the id, get a new bucket), which is why sign-in also passes
 * loginIpCeiling below. Falls back to the IP when the client sends no id.
 */
export const deviceKeyGenerator = (req: any): string => {
  const deviceId = req.headers?.["x-device-id"];
  if (deviceId && typeof deviceId === "string") {
    return `device_${deviceId.slice(0, 64)}`;
  }
  return clientIpKey(req);
};

/**
 * 1. Auth & Login Limiter (Anti-Brute-Force)
 * Protects login endpoints against credential stuffing and dictionary attacks.
 * Only failed attempts count against the limit (skipSuccessfulRequests).
 *
 * Two limits, both of which must pass (chosen by the user, 2026-10-16):
 *   - 10 failures per device (deviceKeyGenerator), so people sharing a carrier
 *     IP do not spend each other's allowance;
 *   - 30 failures per IP (loginIpCeiling), so a caller who rotates x-device-id
 *     to get fresh device buckets still stops at 30.
 * Mounted as an array; Express runs both in order.
 */
const loginIpCeiling = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDev ? 300 : 30,
  keyGenerator: clientIpKey,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    error: "Too many failed sign-in attempts from this network. Please try again after 15 minutes.",
  },
});

const loginDeviceLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15-minute sliding window
  max: isDev ? 100 : 10, // 10 failed login attempts in prod
  keyGenerator: deviceKeyGenerator,
  skipSuccessfulRequests: true, // Successful logins never count against the user!
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    error: "Too many failed login attempts. Please try again after 15 minutes.",
  },
});

export const loginLimiter: RequestHandler[] = [loginIpCeiling, loginDeviceLimiter];

/**
 * 2. General Operational Read Limiter (GET endpoints)
 * High-ceiling 1-minute window for errands, transactions, notifications, and locations.
 * Prevents rapid scraping without locking out normal users who switch tabs or poll.
 */
export const readLimiter = rateLimit({
  windowMs: 60 * 1000, // 1-minute sliding window (not 15 minutes!)
  max: isDev ? 1200 : 240, // 240 requests/min in prod (4 req/sec average)
  keyGenerator: smartKeyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    error: "Traffic limit reached. Please slow down and try again shortly.",
  },
});

/**
 * 3. General Operational Mutation Limiter (POST / PUT / PATCH / DELETE)
 * Protects database write resources against spam and request flooding.
 */
export const userApiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1-minute sliding window (not 15 minutes!)
  max: isDev ? 300 : 60, // 60 write requests/min in prod (1 write/sec)
  keyGenerator: smartKeyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    error: "Action rate limit reached. Please wait a few seconds before trying again.",
  },
});

/**
 * 4. Verification & OTP Limiter (SMS / Email OTP Verification)
 * Prevents OTP brute-forcing while allowing users reasonable resend attempts.
 */
export const verificationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15-minute sliding window
  max: isDev ? 50 : 15, // 15 attempts in prod
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    error: "Too many verification attempts. Please wait a few minutes before trying again.",
  },
});

/**
 * 5. Password Reset Limiter (Anti-Enumeration)
 *
 * Two deliberate differences from the limiters above.
 *
 * It does NOT skip successful requests. /forgot-password answers 200 whether or
 * not the account exists — that is what closes the enumeration oracle — so a
 * 200 says nothing about whether the caller is legitimate. Skipping them would
 * leave the endpoint effectively unlimited for precisely the traffic it needs
 * to cap.
 *
 * It keys on IP (express-rate-limit's default key), the only key here the
 * caller cannot choose for themselves: password reset is unauthenticated, and
 * an `x-device-id` header is whatever the caller sends. smartKeyGenerator no
 * longer falls back to that header either (2026-10-16).
 */
export const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDev ? 60 : 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    error: "Too many password reset requests. Please try again after 15 minutes.",
  },
});

/**
 * 6. Rider Breadcrumb Ingest Limiter (POST /errands/:id/track)
 * Batched telemetry, not per-fix: a rider device flushes roughly once a minute
 * while moving, plus a burst of backlog batches immediately after reconnecting
 * from a signal blackout. Sized to absorb that reconnect burst comfortably
 * while still capping a runaway client.
 */
export const trackingLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: isDev ? 600 : 120,
  keyGenerator: smartKeyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    error: "Location upload rate limit reached.",
  },
});

/**
 * 7. Item Tidy Limiter (POST /errands/normalize-items)
 * Every call can reach Google through the category sidecar, whose Gemini quota
 * (25 a minute, 5,000 a day) is shared with dispatcher categorisation. One
 * Review screen asks once, and again only after the list changes, so 15 per
 * 10 minutes covers a customer reworking a list several times while keeping
 * one account from spending the dispatchers' budget.
 */
export const itemTidyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: isDev ? 200 : 15,
  keyGenerator: smartKeyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    error: "Too many tidy-ups in a short time. Your list will be sent as you typed it.",
  },
});

/**
 * 8. Item Store Check Limiter (POST /errands/item-stores)
 * The customer's store editor asks once per pause in typing. The local model
 * answers most names for free, but an unsure one is passed to the shared
 * Gemini quota in the background, so a single account is capped well below
 * what would crowd out the dispatchers.
 */
// The customer's store picker (GET /api/places/establishments). Every call is a
// billed Google Places request, so it is held well below what typing needs: the
// app waits for a pause in typing before it asks.
export const establishmentSearchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isDev ? 300 : 30,
  keyGenerator: smartKeyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    error: "Too many store searches in a short time. Wait a moment, then search again.",
  },
});

export const itemStoreCheckLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: isDev ? 400 : 60,
  keyGenerator: smartKeyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    error: "Too many store checks in a short time. Your items are still on your list.",
  },
});
