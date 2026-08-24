import crypto from "node:crypto";
import dotenv from "dotenv";

dotenv.config();

// Ensure required environment variables exist (Fail fast per security standards)
if (!process.env.JWT_SECRET || !process.env.JWT_REFRESH_SECRET) {
  throw new Error("FATAL: JWT_SECRET or JWT_REFRESH_SECRET missing from environment variables.");
}

export const PORT = process.env.PORT || 5000;
export const JWT_SECRET = process.env.JWT_SECRET;
export const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;
// Access-token life. Short on purpose: an access token is a pure bearer
// credential that middleware/auth.ts verifies by signature alone, so a stolen
// one keeps working until it expires no matter what the server later learns.
// Fifteen minutes bounds that window. It used to be an hour, which was tolerable
// only because nothing was refreshing - the Customer and Rider apps had no
// refresh path at all, so an hour was the whole session and shortening it would
// have made the forced re-logins four times more frequent. With rotation wired
// up (sessionService) the clients renew silently and the user sees nothing.
export const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "15m";

// Refresh-token life, and with it the session length. Thirty days so a phone
// that is used regularly never asks for a password again; safe at that length
// only because every use rotates the token and a replay revokes the session.
export const JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || "30d";

// The same 30 days as a duration, for the `user_sessions.expiresAt` column.
// Kept in step with JWT_REFRESH_EXPIRES_IN by parsing it rather than by a second
// literal that could drift out of sync with it.
function parseDurationMs(value: string, fallbackMs: number): number {
  const match = /^(\d+)\s*([smhd])$/.exec(value.trim());
  if (!match) return fallbackMs;
  const amount = Number(match[1]);
  const unit = match[2] as "s" | "m" | "h" | "d";
  const multiplier = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  return amount * multiplier;
}

export const REFRESH_SESSION_TTL_MS = parseDurationMs(
  JWT_REFRESH_EXPIRES_IN,
  30 * 24 * 60 * 60 * 1000
);

// How long a just-rotated refresh token stays acceptable.
//
// Rotation and concurrency fight each other: a phone coming back from
// background fires several requests at once, they all 401 together, and without
// a grace window the second one to arrive looks exactly like a replay attack and
// would revoke a perfectly good session. The clients single-flight their
// refreshes to make this rare, but a network retry can still land outside that.
// Ten seconds is long enough to absorb it and far too short to be useful to
// someone replaying a stolen token days later.
export const REFRESH_ROTATION_GRACE_MS = Number(
  process.env.REFRESH_ROTATION_GRACE_MS || 10_000
);

// Signs the pre-authentication login-challenge token (see loginChallengeService).
// It MUST NOT be JWT_SECRET: middleware/auth.ts verifies bearer tokens with
// JWT_SECRET and then trusts the decoded payload, and many routes are guarded by
// authenticateToken alone. A challenge signed with JWT_SECRET would therefore be
// a usable bearer token, making the whole OTP gate bypassable. Derived rather
// than a new required env var, so there is nothing extra to configure — but it
// can still be overridden independently if the two ever need separate rotation.
export const JWT_CHALLENGE_SECRET =
  process.env.JWT_CHALLENGE_SECRET ||
  crypto.createHash("sha256").update(`${JWT_SECRET}::login-challenge::v1`).digest("hex");

// Login-challenge tokens are short-lived on purpose, and deliberately shorter
// than the 15-minute code TTL so the challenge always expires before the code
// it is carrying.
export const LOGIN_CHALLENGE_EXPIRES_IN_SECONDS = 10 * 60;

// Signs the password-reset token handed out after a customer proves ownership
// of their mailbox with the emailed code. Separate from JWT_SECRET for exactly
// the reason spelled out above — a reset token that doubled as a bearer token
// would let anyone who completed an OTP read the account's data outright — and
// separate from JWT_CHALLENGE_SECRET so a staff login challenge can never be
// replayed as a customer password reset.
export const JWT_PASSWORD_RESET_SECRET =
  process.env.JWT_PASSWORD_RESET_SECRET ||
  crypto.createHash("sha256").update(`${JWT_SECRET}::password-reset::v1`).digest("hex");

// Shorter than the 15-minute code TTL, same reasoning as the login challenge.
export const PASSWORD_RESET_TOKEN_EXPIRES_IN_SECONDS = 10 * 60;

// Minimum gap between two OTP codes for the SAME recipient, shared by customer
// registration and password reset.
//
// An unmetered re-issue does not just send a spare email — it silently voids the
// code already open in the recipient's inbox. Password reset retires the old row
// outright (sendPasswordResetCode); registration leaves it behind, but
// verifyRegistrationOtp only ever checks the NEWEST code for an address, so the
// older one is just as dead. Both surface to the customer the same way: the code
// they are looking at stops working.
//
// The client screens run their own countdown, but that is presentation. This is
// the enforcement — a client-side cooldown is one curl away from irrelevant.
// The FIRST wait. Each further code for the same recipient inside the streak
// window doubles it: 60s, 120s, 240s, ... up to the cap.
export const OTP_RESEND_COOLDOWN_SECONDS = Number(
  process.env.OTP_RESEND_COOLDOWN_SECONDS || 60
);

// Ceiling on the doubling. Without one the backoff runs away — a seventh
// request would demand an hour, well past the code's own 15-minute life, which
// locks out a real person who simply mistyped their address twice.
export const OTP_RESEND_COOLDOWN_MAX_SECONDS = Number(
  process.env.OTP_RESEND_COOLDOWN_MAX_SECONDS || 480
);

// How far back a "streak" reaches. Requests older than this stop counting, so
// somebody who reset their password this morning starts from 60s again tonight
// rather than inheriting the afternoon's backoff.
export const OTP_RESEND_STREAK_MINUTES = Number(
  process.env.OTP_RESEND_STREAK_MINUTES || 60
);

// --- Password-reset abuse thresholds ---
// Counted per IP over a rolling window and enforced in passwordResetService.
// This sits UNDER the express-rate-limit ceiling on the route: the limiter caps
// total request volume, while this caps how many DISTINCT accounts one IP may
// probe, which is the shape enumeration actually takes (slow, well under any
// request-rate limit, but touching many identifiers).
export const PASSWORD_RESET_IP_WINDOW_MINUTES = Number(
  process.env.PASSWORD_RESET_IP_WINDOW_MINUTES || 60
);
export const PASSWORD_RESET_IP_MAX_MISSES = Number(
  process.env.PASSWORD_RESET_IP_MAX_MISSES || 5
);

export const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((origin) => origin.trim())
  : ["http://localhost:5173", "http://localhost:8081"];

// --- GIS / routing ---
// Ordered provider chain for road-network routing. Each name maps to an adapter
// in lib/routing/; the resilient service walks this list left-to-right and uses
// the first provider that answers. "haversine" is always a safe terminal entry
// since it needs no external service — see lib/routing/haversineProvider.ts.
export const OSRM_BASE_URL = process.env.OSRM_BASE_URL || "";

// Google Cloud Vision, used to read photographed store receipts (see lib/ocr/).
// Deliberately a separate key from GOOGLE_MAPS_API_KEY and scoped to the Vision
// API alone: if it leaks, the exposure is OCR calls rather than everything the
// Maps key can reach. Blank disables receipt OCR — the adapter reports itself
// unconfigured and is skipped, rather than failing every upload.
export const GOOGLE_VISION_API_KEY = process.env.GOOGLE_VISION_API_KEY || "";
export const ROUTING_PROVIDER_ORDER = (process.env.ROUTING_PROVIDER_ORDER || "osrm,google,haversine")
  .split(",")
  .map((name) => name.trim().toLowerCase())
  .filter(Boolean);

// Straight-line distance under-states real road distance. Both constants below
// were measured, not guessed: six real Tacurong POI pairs from prisma/seedPlaces.ts
// were routed against OSRM and compared to their haversine distance. Observed
// detour factors ranged 1.42-1.66 (median 1.48) and effective speeds 21-30 km/h
// (median 25). Re-run server/gis/calibrate.ts after any OSM extract refresh.
//
// Pairs closer than 1 km are deliberately excluded from that sample: the ratio
// is unstable at short range (two POIs 133 m apart measured 1.8 km by road
// around a one-way loop, a ratio of 13.6) and would badly skew the median.
//
// Getting this wrong is not cosmetic: the fallback feeds fare calculation, so an
// under-stated factor quotes a customer less than the route they can watch on
// their own screen.
export const ROAD_DETOUR_FACTOR = Number(process.env.ROAD_DETOUR_FACTOR) || 1.48;

// Average achievable speed on Tacurong city streets (tricycle/motorcycle traffic),
// used only to synthesise a duration when no routing engine is reachable.
export const FALLBACK_AVG_SPEED_KMH = Number(process.env.FALLBACK_AVG_SPEED_KMH) || 25;
