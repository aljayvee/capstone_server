import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { userRepository } from "../repositories/userRepository.js";
import { tokenBlocklistRepository } from "../repositories/tokenBlocklistRepository.js";
import { isRevoked, markRevoked } from "../lib/blocklistCache.js";
import * as staffVerificationService from "./staffVerificationService.js";
import { ServiceError } from "./ServiceError.js";
import { JWT_CHALLENGE_SECRET, LOGIN_CHALLENGE_EXPIRES_IN_SECONDS } from "../config/env.js";

// The pre-authentication half of staff sign-in.
//
// A "challenge" is the state between "your password was correct" and "you have
// a session". It is represented by a short-lived token that is deliberately NOT
// an access token — see JWT_CHALLENGE_SECRET in config/env.ts for why that
// distinction is the thing holding this whole gate up.

export type ChallengeStep = "PROFILE_SETUP" | "OTP";
export type ChallengeAudience = "WEB_PORTAL" | "RIDER_APP";

type StaffRow = NonNullable<Awaited<ReturnType<typeof userRepository.findById>>>;

export interface LoginChallenge {
  step: ChallengeStep;
  challengeToken: string;
  maskedEmail: string | null;
  role: string;
  expiresInSeconds: number;
}

interface ChallengeClaims {
  id: number;
  username: string;
  purpose: "LOGIN_CHALLENGE";
  step: ChallengeStep;
  aud: ChallengeAudience;
  cs: string;
}

const PURPOSE = "LOGIN_CHALLENGE";

// The single source of truth for "is this sign-in gated?". Every caller that
// mints a session consults this and nothing else.
export function evaluateGate(user: Pick<StaffRow, "profileCompleted" | "emailVerified" | "email">): ChallengeStep | null {
  const email = (user.email || "").trim();
  // The `!email` clause is not redundant: legacy rows are allowed to carry a
  // blank email and were grandfathered as verified, so without it such an
  // account would be routed to an OTP that can never be delivered.
  if (!user.profileCompleted || !email) return "PROFILE_SETUP";
  if (!user.emailVerified) return "OTP";
  return null;
}

// Binds the challenge to the exact credential state that produced it. If the
// password, role, status or email changes while a challenge is outstanding, the
// stamp stops matching and the challenge dies.
function credentialStamp(user: StaffRow): string {
  return crypto
    .createHash("sha256")
    .update(`${user.passwordHash}|${user.role}|${user.status}|${(user.email || "").toLowerCase()}`)
    .digest("hex")
    .slice(0, 32);
}

export function maskEmail(email: string): string {
  const value = (email || "").trim();
  const atIndex = value.indexOf("@");
  if (atIndex < 1) return value;

  const local = value.slice(0, atIndex);
  const domain = value.slice(atIndex);
  if (local.length <= 2) return `${local[0]}***${domain}`;
  return `${local.slice(0, 2)}${"*".repeat(Math.min(local.length - 2, 6))}${domain}`;
}

function mintToken(user: StaffRow, step: ChallengeStep, audience: ChallengeAudience): string {
  const claims: ChallengeClaims = {
    id: user.id,
    username: user.username,
    purpose: PURPOSE,
    step,
    aud: audience,
    cs: credentialStamp(user),
  };
  // No `role` and no `email` claim on purpose: middleware/auth.ts and
  // requireRole both read `role` off the decoded payload, so a token without
  // one cannot satisfy any role check even if the secrets were ever confused.
  return jwt.sign(claims, JWT_CHALLENGE_SECRET, { expiresIn: LOGIN_CHALLENGE_EXPIRES_IN_SECONDS });
}

function toChallenge(user: StaffRow, step: ChallengeStep, audience: ChallengeAudience): LoginChallenge {
  return {
    step,
    challengeToken: mintToken(user, step, audience),
    maskedEmail: step === "OTP" ? maskEmail(user.email) : null,
    role: user.role,
    expiresInSeconds: LOGIN_CHALLENGE_EXPIRES_IN_SECONDS,
  };
}

// Returns null when the account is fully verified and may proceed straight to a
// session. For step OTP the code is issued and the mail send is awaited, so a
// delivery failure surfaces here rather than stranding the user.
export async function startChallenge(user: StaffRow, audience: ChallengeAudience): Promise<LoginChallenge | null> {
  const step = evaluateGate(user);
  if (!step) return null;

  if (step === "OTP") {
    await staffVerificationService.issueLoginOtp(
      user.id,
      user.email,
      `${user.firstName} ${user.lastName}`.trim()
    );
  }

  return toChallenge(user, step, audience);
}

// Issues a fresh challenge for an already-identified user without re-checking
// credentials — used after profile setup, where the email just changed and the
// old token's credential stamp is therefore stale by design.
export async function restartChallenge(userId: number, audience: ChallengeAudience): Promise<LoginChallenge> {
  const user = await userRepository.findById(userId);
  if (!user) {
    throw new ServiceError(401, "Account no longer exists. Please sign in again.");
  }
  const challenge = await startChallenge(user, audience);
  if (!challenge) {
    // Only reachable if the account became fully verified mid-flow, which means
    // the caller should simply sign in again and sail through.
    throw new ServiceError(401, "This sign-in has already been completed. Please sign in again.");
  }
  return challenge;
}

export interface ConsumedChallenge {
  user: StaffRow;
  audience: ChallengeAudience;
}

// Verifies signature, expiry, purpose, step, audience and revocation, then
// re-reads the account and re-checks status and the credential stamp. Nothing
// about the caller's identity is taken from the token alone.
export async function consumeChallenge(
  challengeToken: string,
  expected: { step: ChallengeStep; audience?: ChallengeAudience }
): Promise<ConsumedChallenge> {
  if (await isRevoked(challengeToken)) {
    throw new ServiceError(401, "This sign-in has already been completed. Please sign in again.");
  }

  let claims: ChallengeClaims;
  try {
    claims = jwt.verify(challengeToken, JWT_CHALLENGE_SECRET) as ChallengeClaims;
  } catch {
    throw new ServiceError(401, "Your sign-in session expired. Please sign in again.");
  }

  if (claims.purpose !== PURPOSE || !claims.id) {
    throw new ServiceError(401, "Your sign-in session expired. Please sign in again.");
  }
  if (claims.step !== expected.step) {
    throw new ServiceError(401, "Your sign-in session expired. Please sign in again.");
  }
  if (expected.audience && claims.aud !== expected.audience) {
    throw new ServiceError(401, "Your sign-in session expired. Please sign in again.");
  }

  const user = await userRepository.findById(claims.id);
  if (!user) {
    throw new ServiceError(401, "Account no longer exists. Please sign in again.");
  }
  // Checked independently of the stamp so a deactivation produces the same
  // message the sign-in form would have given, not a generic one.
  if (user.status !== "Active") {
    throw new ServiceError(403, "This account has been deactivated.");
  }
  if (credentialStamp(user) !== claims.cs) {
    throw new ServiceError(401, "Your account was updated. Please sign in again.");
  }

  return { user, audience: claims.aud };
}

// One-shot: a consumed challenge can never be presented again.
export async function burnChallenge(challengeToken: string): Promise<void> {
  const decoded = jwt.decode(challengeToken) as { exp?: number } | null;
  const expiresAt = decoded?.exp
    ? new Date(decoded.exp * 1000)
    : new Date(Date.now() + LOGIN_CHALLENGE_EXPIRES_IN_SECONDS * 1000);

  await tokenBlocklistRepository.revoke(challengeToken, expiresAt);
  markRevoked(challengeToken);
}
