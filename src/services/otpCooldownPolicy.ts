import {
  OTP_RESEND_COOLDOWN_SECONDS,
  OTP_RESEND_COOLDOWN_MAX_SECONDS,
  OTP_RESEND_STREAK_MINUTES,
} from "../config/env.js";

// The resend schedule, shared by customer registration and password reset so the
// two cannot drift apart.
//
// Each code a recipient is sent inside the streak window doubles the wait before
// the next one: 60s, 120s, 240s, 480s, then flat at the cap. The doubling is the
// point — a person who genuinely did not get the first email retries once or
// twice and barely notices, while a script hammering the endpoint is priced out
// within a handful of requests without ever being hard-blocked.
//
// This is separate from the IP throttle in passwordResetService. That one asks
// "is this caller enumerating accounts?"; this one asks "how hard is this one
// recipient's mailbox being worked?". A shared NAT can trip the first without
// either question being wrong.

/**
 * Seconds to wait after the `issueCount`-th code has gone out.
 *
 * issueCount is how many codes the recipient has ALREADY been sent in the
 * current streak, so 1 means "one code is out, this is the wait before a
 * second". Zero or less means nothing has been sent and there is no wait.
 */
export function cooldownSecondsFor(issueCount: number): number {
  if (issueCount <= 0) return 0;

  // 2^(n-1) doublings, clamped before the shift so a large count cannot
  // overflow into nonsense.
  const doublings = Math.min(issueCount - 1, 16);
  const seconds = OTP_RESEND_COOLDOWN_SECONDS * 2 ** doublings;
  return Math.min(seconds, OTP_RESEND_COOLDOWN_MAX_SECONDS);
}

/** The cutoff before which past requests stop counting toward the streak. */
export function streakSince(now: Date = new Date()): Date {
  return new Date(now.getTime() - OTP_RESEND_STREAK_MINUTES * 60 * 1000);
}

/**
 * Whether a new code may go out yet.
 *
 * `lastIssuedAt` is when the most recent code was sent, `issueCount` how many
 * have been sent in the streak. Returns the verdict plus the seconds a caller
 * should be told to wait — which is the NEXT wait when the code may be sent, and
 * the REMAINING wait when it may not.
 */
export function evaluateResend(
  lastIssuedAt: Date | null,
  issueCount: number,
  now: Date = new Date()
): { allowed: boolean; retryAfterSeconds: number } {
  // Nothing outstanding — send, and quote the wait that will then apply.
  if (!lastIssuedAt || issueCount <= 0) {
    return { allowed: true, retryAfterSeconds: cooldownSecondsFor(1) };
  }

  const requiredGapMs = cooldownSecondsFor(issueCount) * 1000;

  // Clamped at zero because `lastIssuedAt` is not necessarily trustworthy: clock
  // skew between a database and an app server, or a row written with a local
  // timestamp against UTC-stored data, puts it in the FUTURE. Unclamped, that
  // subtraction quotes a wait of hours and locks a real person out of their own
  // account until the clocks agree.
  const elapsedMs = Math.max(0, now.getTime() - lastIssuedAt.getTime());

  if (elapsedMs >= requiredGapMs) {
    // Sending now makes this the (issueCount + 1)-th code, so the next wait is
    // one doubling further along.
    return { allowed: true, retryAfterSeconds: cooldownSecondsFor(issueCount + 1) };
  }

  const remainingSeconds = Math.ceil((requiredGapMs - elapsedMs) / 1000);
  return {
    allowed: false,
    // Never longer than the gap itself, and never a zero that would render as a
    // "0s" countdown on a button that is still refused.
    retryAfterSeconds: Math.min(Math.max(1, remainingSeconds), cooldownSecondsFor(issueCount)),
  };
}
