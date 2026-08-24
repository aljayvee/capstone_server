import rateLimit, { ipKeyGenerator } from "express-rate-limit";

const isDev = process.env.NODE_ENV === "development" || !process.env.NODE_ENV;

/**
 * Smart key generator that scopes limits by authenticated user ID when available,
 * falling back to client IP for unauthenticated requests. This prevents multiple
 * users sharing a Wi-Fi/NAT network or local test environment from blocking each other.
 */
const smartKeyGenerator = (req: any): string => {
  if (req.user?.id) {
    return `user_${req.user.id}`;
  }
  const deviceId = req.headers?.["x-device-id"];
  if (deviceId && typeof deviceId === "string") {
    return `device_${deviceId.slice(0, 64)}`;
  }
  // Use express-rate-limit's helper for IPv4/IPv6 normalization if available
  if (typeof ipKeyGenerator === "function") {
    return ipKeyGenerator(req);
  }
  return req.ip || req.socket?.remoteAddress || "127.0.0.1";
};

/**
 * 1. Auth & Login Limiter (Anti-Brute-Force)
 * Protects login endpoints against credential stuffing and dictionary attacks.
 * Only failed attempts count against the limit (skipSuccessfulRequests).
 */
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15-minute sliding window
  max: isDev ? 100 : 10, // 10 failed login attempts in prod
  skipSuccessfulRequests: true, // Successful logins never count against the user!
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    error: "Too many failed login attempts. Please try again after 15 minutes.",
  },
});

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
 * It does NOT use smartKeyGenerator. That helper falls back to the client-sent
 * `x-device-id` header, which an attacker simply rotates. Password reset is
 * unauthenticated, so IP (express-rate-limit's default key) is the only key
 * here the caller cannot choose for themselves.
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
