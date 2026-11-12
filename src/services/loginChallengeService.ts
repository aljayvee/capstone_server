import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { userRepository } from "../repositories/userRepository.js";
import { customerRepository } from "../repositories/customerRepository.js";
import { tokenBlocklistRepository } from "../repositories/tokenBlocklistRepository.js";
import { isRevoked, markRevoked } from "../lib/blocklistCache.js";
import * as staffVerificationService from "./staffVerificationService.js";
import * as mfaTrustService from "./mfaTrustService.js";
import type { StampSource, TrustSubject } from "./mfaTrustService.js";
import { ServiceError } from "./ServiceError.js";
import { JWT_CHALLENGE_SECRET, LOGIN_CHALLENGE_EXPIRES_IN_SECONDS } from "../config/env.js";

// The pre-authentication half of sign-in, for staff and customers.
//
// A "challenge" is the state between "your password was correct" and "you have
// a session". It is represented by a short-lived token that is deliberately NOT
// an access token — see JWT_CHALLENGE_SECRET in config/env.ts for why that
// distinction is the thing holding this whole gate up.
//
// Step OTP is the second sign-in factor: an SMS code (Firebase Phone Auth) or an
// email code. Staff meet it on their first sign-in (FIRST_LOGIN), and every
// account meets it on a device that has not passed it within MFA_TRUST_DAYS
// once its audience is in MFA_ENFORCED_AUDIENCES (NEW_DEVICE).

export type ChallengeStep = "PROFILE_SETUP" | "OTP";
export type ChallengeAudience = "WEB_PORTAL" | "RIDER_APP" | "CUSTOMER_APP";
export type ChallengeReason = "FIRST_LOGIN" | "NEW_DEVICE";
export type MfaFactor = "SMS" | "EMAIL";

type StaffRow = NonNullable<Awaited<ReturnType<typeof userRepository.findById>>>;
type CustomerRow = NonNullable<Awaited<ReturnType<typeof customerRepository.findById>>>;

// Staff and customer ids collide, so a challenge always says which table its id
// belongs to.
export type ChallengeSubject = { kind: "STAFF"; row: StaffRow } | { kind: "CUSTOMER"; row: CustomerRow };

export interface LoginChallenge {
  step: ChallengeStep;
  challengeToken: string;
  maskedEmail: string | null;
  maskedPhone: string | null;
  // The last four digits only. The full number is never sent: a password alone
  // must not reveal the second factor, so the SMS step asks for the number.
  phoneHint: string | null;
  factors: MfaFactor[];
  reason: ChallengeReason;
  role: string;
  expiresInSeconds: number;
}

// What the request says about the client, read by the controller.
export interface MfaRequestContext {
  // Sent `x-sugo-mfa: 1`: it can answer a challenge without an email code
  // having been sent for it. Older clients (no header) get today's behaviour.
  capable: boolean;
  // Every trust token the client holds: the portal's cookie carries one per
  // account that signed in on that browser, the apps send their one.
  trustTokens: string[];
  deviceId: string | null;
}

export const LEGACY_CLIENT: MfaRequestContext = { capable: false, trustTokens: [], deviceId: null };

interface ChallengeClaims {
  id: number;
  username: string;
  purpose: "LOGIN_CHALLENGE";
  step: ChallengeStep;
  aud: ChallengeAudience;
  cs: string;
  // Subject kind. Absent on tokens minted before customers could be challenged,
  // which were all staff.
  sk?: "STAFF" | "CUSTOMER";
  jti?: string;
  iat?: number;
  exp?: number;
}

const PURPOSE = "LOGIN_CHALLENGE";
const CUSTOMER_DEACTIVATED = "This account has been deactivated. Please contact SUGO support.";

// The single source of truth for "is this staff sign-in gated?". Every caller
// that mints a staff session consults this and nothing else.
export function evaluateGate(
  user: Pick<StaffRow, "profileCompleted" | "emailVerified" | "phoneVerified" | "email" | "phone">,
  mfa: { enforced: boolean; trusted: boolean } = { enforced: false, trusted: false }
): ChallengeStep | null {
  const email = (user.email || "").trim();
  const phone = (user.phone || "").trim();
  // An account must have a profile and at least one contact channel (email or phone)
  if (!user.profileCompleted || (!email && !phone)) return "PROFILE_SETUP";
  // Neither channel verified yet: the first-sign-in check, enforced or not
  if (!user.emailVerified && !user.phoneVerified) return "OTP";
  // MFA: a device that has not passed the second factor recently
  if (mfa.enforced && !mfa.trusted) return "OTP";
  return null;
}

// Binds the challenge to the exact credential state that produced it. If the
// password, role, status or email changes while a challenge is outstanding, the
// stamp stops matching and the challenge dies.
function credentialStamp(subject: ChallengeSubject): string {
  const material =
    subject.kind === "STAFF"
      ? `${subject.row.passwordHash}|${subject.row.role}|${subject.row.status}|${(subject.row.email || "").toLowerCase()}`
      : `${subject.row.passwordHash || ""}|${subject.row.status}|${(subject.row.email || "").toLowerCase()}|${subject.row.googleId || ""}`;
  return crypto.createHash("sha256").update(material).digest("hex").slice(0, 32);
}

export function contactOf(subject: ChallengeSubject): { email: string; phone: string; name: string } {
  if (subject.kind === "STAFF") {
    const { row } = subject;
    return {
      email: (row.email || "").trim(),
      phone: (row.phone || "").trim(),
      name: `${row.firstName} ${row.lastName}`.trim(),
    };
  }
  const info = subject.row.information;
  return {
    email: (subject.row.email || "").trim(),
    phone: (info?.phone || "").trim(),
    name: `${info?.firstName || ""} ${info?.lastName || ""}`.trim(),
  };
}

export function trustSubjectOf(subject: ChallengeSubject): TrustSubject {
  return { type: subject.kind === "STAFF" ? "USER" : "CUSTOMER", id: subject.row.id };
}

export function trustSourceOf(subject: ChallengeSubject): StampSource {
  const contact = contactOf(subject);
  return {
    passwordHash: subject.row.passwordHash,
    status: subject.row.status,
    email: contact.email,
    phone: contact.phone,
  };
}

export function factorsFor(subject: ChallengeSubject): MfaFactor[] {
  const contact = contactOf(subject);
  const factors: MfaFactor[] = [];
  if (contact.phone.replace(/\D/g, "").length >= 10) factors.push("SMS");
  if (contact.email.includes("@")) factors.push("EMAIL");
  return factors;
}

function reasonFor(subject: ChallengeSubject): ChallengeReason {
  if (subject.kind === "STAFF" && !subject.row.emailVerified && !subject.row.phoneVerified) return "FIRST_LOGIN";
  return "NEW_DEVICE";
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

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length <= 4) return phone;
  const prefix = digits.startsWith("63") ? "+63 " : digits.startsWith("0") ? "0" : "";
  const last4 = digits.slice(-4);
  return `${prefix}*** *** ${last4}`;
}

function mintToken(subject: ChallengeSubject, step: ChallengeStep, audience: ChallengeAudience): string {
  const claims: ChallengeClaims = {
    id: subject.row.id,
    username: subject.row.username,
    purpose: PURPOSE,
    step,
    aud: audience,
    cs: credentialStamp(subject),
    sk: subject.kind,
    // A per-token nonce. Without it two challenges minted for one account in
    // the same second (`iat` has one-second resolution) are byte-identical, so
    // resend's re-mint could hand back the very token it had just burned.
    jti: crypto.randomUUID(),
  };
  // No `role` and no `email` claim on purpose: middleware/auth.ts and
  // requireRole both read `role` off the decoded payload, so a token without
  // one cannot satisfy any role check even if the secrets were ever confused.
  return jwt.sign(claims, JWT_CHALLENGE_SECRET, { expiresIn: LOGIN_CHALLENGE_EXPIRES_IN_SECONDS });
}

function toChallenge(subject: ChallengeSubject, step: ChallengeStep, audience: ChallengeAudience): LoginChallenge {
  const contact = contactOf(subject);
  const isOtp = step === "OTP";
  const phoneDigits = contact.phone.replace(/\D/g, "");
  return {
    step,
    challengeToken: mintToken(subject, step, audience),
    maskedEmail: isOtp && contact.email ? maskEmail(contact.email) : null,
    maskedPhone: isOtp && contact.phone ? maskPhone(contact.phone) : null,
    phoneHint: isOtp && phoneDigits.length >= 4 ? phoneDigits.slice(-4) : null,
    factors: isOtp ? factorsFor(subject) : [],
    reason: reasonFor(subject),
    role: subject.kind === "STAFF" ? subject.row.role : "CUSTOMER",
    expiresInSeconds: LOGIN_CHALLENGE_EXPIRES_IN_SECONDS,
  };
}

function assertHasFactor(subject: ChallengeSubject): void {
  if (factorsFor(subject).length === 0) {
    throw new ServiceError(
      403,
      subject.kind === "STAFF"
        ? "This account has no mobile number or email to confirm the sign-in. Ask your administrator to add one."
        : "This account has no mobile number or email to confirm the sign-in. Please contact SUGO support."
    );
  }
}

// Returns null when the sign-in may proceed straight to a session. For step OTP
// an older client (no x-sugo-mfa header) is sent the email code at once, as it
// always was, and the mail send is awaited so a delivery failure surfaces here
// rather than stranding the user. A capable client asks for it when the person
// picks email (resend-login-otp), so choosing SMS sends no mail at all.
export async function startChallenge(
  user: StaffRow,
  audience: ChallengeAudience,
  mfa: MfaRequestContext = LEGACY_CLIENT
): Promise<LoginChallenge | null> {
  const subject: ChallengeSubject = { kind: "STAFF", row: user };
  const enforced = mfaTrustService.isMfaEnforced(audience);
  // Only looked up when it can matter, so an unenforced sign-in costs no query.
  const trusted =
    enforced &&
    (await mfaTrustService.isTrusted(trustSubjectOf(subject), mfa.trustTokens, mfa.deviceId, trustSourceOf(subject)));
  const step = evaluateGate(user, { enforced, trusted });
  if (!step) return null;

  if (step === "OTP") {
    assertHasFactor(subject);
    if (!mfa.capable && factorsFor(subject).includes("EMAIL")) {
      const contact = contactOf(subject);
      await staffVerificationService.issueLoginOtp(user.id, contact.email, contact.name);
    }
  }

  return toChallenge(subject, step, audience);
}

// The customer half. Customers never had a first-sign-in check, so only MFA
// can gate them, and only once CUSTOMER_APP is enforced.
export async function startCustomerChallenge(
  customer: CustomerRow,
  mfa: MfaRequestContext = LEGACY_CLIENT
): Promise<LoginChallenge | null> {
  if (!mfaTrustService.isMfaEnforced("CUSTOMER_APP")) return null;

  const subject: ChallengeSubject = { kind: "CUSTOMER", row: customer };
  if (await mfaTrustService.isTrusted(trustSubjectOf(subject), mfa.trustTokens, mfa.deviceId, trustSourceOf(subject))) {
    return null;
  }

  // An app build from before MFA cannot show a challenge: given one, it read the
  // reply as a session and reported "another account is signed in". Refuse with
  // a sentence it does show, and never fall back to a session.
  if (!mfa.capable) {
    throw new ServiceError(403, "Update Sugo Express to the latest version to sign in.", {
      code: "APP_UPDATE_REQUIRED",
    });
  }

  assertHasFactor(subject);
  return toChallenge(subject, "OTP", "CUSTOMER_APP");
}

// Issues a fresh challenge for an already-identified user without re-checking
// credentials — used after profile setup, where the email just changed and the
// old token's credential stamp is therefore stale by design.
export async function restartChallenge(
  userId: number,
  audience: ChallengeAudience,
  mfa: MfaRequestContext = LEGACY_CLIENT
): Promise<LoginChallenge> {
  const user = await userRepository.findById(userId);
  if (!user) {
    throw new ServiceError(401, "Account no longer exists. Please sign in again.");
  }
  const challenge = await startChallenge(user, audience, mfa);
  if (!challenge) {
    // Only reachable if the account became fully verified mid-flow, which means
    // the caller should simply sign in again and sail through.
    throw new ServiceError(401, "This sign-in has already been completed. Please sign in again.");
  }
  return challenge;
}

// A new token for the same OTP step, without asking the gate again: used by
// resend, which must not be talked out of a challenge already under way.
export function remintChallenge(subject: ChallengeSubject, audience: ChallengeAudience): LoginChallenge {
  return toChallenge(subject, "OTP", audience);
}

export interface ConsumedChallenge {
  subject: ChallengeSubject;
  audience: ChallengeAudience;
  // When the challenge was minted (seconds). An SMS proof must postdate it.
  issuedAt: number;
}

async function loadSubject(claims: ChallengeClaims): Promise<ChallengeSubject> {
  if (claims.sk === "CUSTOMER") {
    const customer = await customerRepository.findById(claims.id);
    if (!customer) {
      throw new ServiceError(401, "Account no longer exists. Please sign in again.");
    }
    if (customer.status !== "Active") {
      throw new ServiceError(403, CUSTOMER_DEACTIVATED);
    }
    return { kind: "CUSTOMER", row: customer };
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
  return { kind: "STAFF", row: user };
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
    claims = jwt.verify(challengeToken, JWT_CHALLENGE_SECRET, { algorithms: ["HS256"] }) as ChallengeClaims;
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
  // A customer challenge only ever belongs to the customer app, and a staff one
  // never does.
  if ((claims.sk === "CUSTOMER") !== (claims.aud === "CUSTOMER_APP")) {
    throw new ServiceError(401, "Your sign-in session expired. Please sign in again.");
  }

  const subject = await loadSubject(claims);
  if (credentialStamp(subject) !== claims.cs) {
    throw new ServiceError(401, "Your account was updated. Please sign in again.");
  }

  return { subject, audience: claims.aud, issuedAt: claims.iat ?? 0 };
}

function blocklistExpiry(challengeToken: string): Date {
  const decoded = jwt.decode(challengeToken) as { exp?: number } | null;
  return decoded?.exp
    ? new Date(decoded.exp * 1000)
    : new Date(Date.now() + LOGIN_CHALLENGE_EXPIRES_IN_SECONDS * 1000);
}

// One-shot: a consumed challenge can never be presented again.
export async function burnChallenge(challengeToken: string): Promise<void> {
  await tokenBlocklistRepository.revoke(challengeToken, blocklistExpiry(challengeToken));
  markRevoked(challengeToken);
}

// burnChallenge for the step that mints a session: false when another request
// already completed this challenge. Called after the factor checks out and
// before the session exists, so two concurrent verifications of one challenge
// (an email code and an SMS proof, say) can never both end in a session.
export async function claimChallenge(challengeToken: string): Promise<boolean> {
  const won = await tokenBlocklistRepository.claim(challengeToken, blocklistExpiry(challengeToken));
  markRevoked(challengeToken);
  return won;
}
