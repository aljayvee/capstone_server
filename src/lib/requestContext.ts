import type { Request } from "express";

// Where a request actually came from.
//
// The user agent and device hints below are DISPLAY data: a spoofed one makes a
// misleading email, not an escalation. The IP is not: rate limiters, the
// password-reset throttle and the threat interceptor's whitelist and bans all
// key on it, so it must never come from a header the client controls.

const MAX_USER_AGENT_LENGTH = 300;

// req.ip alone. index.ts trusts only nginx and Cloudflare's ranges
// (lib/trustedProxies.ts), so Express has already walked past them to the real
// client. CF-Connecting-IP used to win here, on the belief that a Cloudflare
// Tunnel was the only way in. There is no tunnel: the origin answers on 443
// directly, so anyone skipping Cloudflare could set that header to any address
// (2026-10-16). Through Cloudflare, req.ip and CF-Connecting-IP agree anyway.
export function getClientIp(req: Request): string | null {
  const raw = req.ip || req.socket?.remoteAddress || null;
  if (!raw) return null;

  // Node reports IPv4 connections over a dual-stack socket as ::ffff:127.0.0.1.
  // Left as-is, every locally-originated alert email reads as gibberish.
  const normalized = raw.startsWith("::ffff:") ? raw.slice(7) : raw;
  return normalized === "::1" ? "127.0.0.1" : normalized;
}

export function getUserAgent(req: Request): string | null {
  const ua = req.headers["user-agent"];
  if (!ua || typeof ua !== "string") return null;
  return ua.slice(0, MAX_USER_AGENT_LENGTH);
}

// The mobile apps already send these (RiderMobileApp/src/utils/deviceInfo.ts),
// so on mobile we get the real OS instead of guessing from a user-agent string.
export function getDeviceHint(req: Request): string | null {
  const os = req.headers["x-device-os"];
  const platform = req.headers["x-device-platform"];
  const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || null;
  return pick(os) || pick(platform);
}

// The stable per-install id both mobile apps generate and send as x-device-id
// (CustomerApp/src/utils/deviceInfo.ts). Unlike everything above this one IS
// used in a security decision — sessionService binds a session to it and
// revokes on mismatch — so treat it as a hint that can only ever cause a
// *stricter* outcome: a spoofed value gets the spoofer signed out, never in.
// The web dashboard sends none, and a null is simply not compared.
export function getDeviceId(req: Request): string | null {
  const raw = req.headers["x-device-id"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || typeof value !== "string") return null;
  return value.slice(0, 80);
}

export function parseDeviceInfo(userAgent: string | null, deviceHint?: string | null): string {
  if (deviceHint) return deviceHint;
  if (!userAgent) return "Unknown Device";

  let browser = "Browser";
  if (/edg/i.test(userAgent)) browser = "Edge";
  else if (/opr|opera/i.test(userAgent)) browser = "Opera";
  else if (/chrome|crios/i.test(userAgent)) browser = "Chrome";
  else if (/firefox|fxios/i.test(userAgent)) browser = "Firefox";
  else if (/safari/i.test(userAgent)) browser = "Safari";

  let os = "Unknown OS";
  if (/windows nt 10\.0/i.test(userAgent)) os = "Windows 10/11";
  else if (/windows nt 6\.3/i.test(userAgent)) os = "Windows 8.1";
  else if (/windows nt 6\.1/i.test(userAgent)) os = "Windows 7";
  else if (/windows/i.test(userAgent)) os = "Windows";
  else if (/macintosh|mac os x/i.test(userAgent)) os = "macOS";
  else if (/android/i.test(userAgent)) os = "Android";
  else if (/iphone|ipad|ipod/i.test(userAgent)) os = "iOS";
  else if (/linux/i.test(userAgent)) os = "Linux";

  return `${browser} on ${os}`;
}
