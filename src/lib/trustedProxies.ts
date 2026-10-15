// The proxies allowed to tell Express who the client is.
//
// The path in production is client -> Cloudflare -> nginx (127.0.0.1) ->
// Express. Express walks X-Forwarded-For from the right, skipping addresses it
// trusts, and req.ip is the first one it does not: the real client, as
// Cloudflare appended it.
//
// This list used to be `true` (trust every hop), which made req.ip the
// LEFT-most entry: whatever the client typed. Through Cloudflare that let any
// caller pick their own IP for the rate limiters, the password-reset throttle
// and the threat interceptor's whitelist and auto-ban (2026-10-16). It also
// cannot be "trust 2 hops": the origin answers directly on 443 too, so a
// request can arrive with no Cloudflare hop at all, and a hop count would then
// trust one address too many.
//
// Trusting by address instead holds on every path:
//   via Cloudflare     nginx (loopback) and the Cloudflare edge are skipped,
//                      req.ip is the client Cloudflare saw
//   straight to nginx  the address nginx appends is not Cloudflare's, so it
//                      is req.ip, and anything forged to its left is ignored
//   straight to :5000  the socket peer is not trusted, so headers are ignored
//
// Cloudflare's published ranges, fetched from cloudflare.com/ips-v4 and
// /ips-v6 on 2026-10-16. They change rarely; if Cloudflare adds a range, its
// traffic through that range reads as the edge's address (every such client
// shares one rate-limit bucket) until it is added here. It fails closed: no
// client can use a missing range to choose their own IP.

export const CLOUDFLARE_IPV4 = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
] as const;

export const CLOUDFLARE_IPV6 = [
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
] as const;

/** For `app.set("trust proxy", ...)`. "loopback" is nginx on the same host. */
export const TRUSTED_PROXIES: string[] = ["loopback", ...CLOUDFLARE_IPV4, ...CLOUDFLARE_IPV6];
