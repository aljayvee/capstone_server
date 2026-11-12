import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { userRepository } from "../repositories/userRepository.js";
import { customerRepository } from "../repositories/customerRepository.js";
import * as riderPresenceService from "./riderPresenceService.js";
import { tokenBlocklistRepository } from "../repositories/tokenBlocklistRepository.js";
import { markRevoked } from "../lib/blocklistCache.js";
import { buildCustomerAccountCreateData, flattenCustomerAccount } from "./patterns/customerFactory.js";
import { sendVerificationCode } from "./emailVerificationService.js";
import { emailVerificationRepository } from "../repositories/emailVerificationRepository.js";
import { verifyFirebaseIdToken } from "../lib/firebaseAdmin.js";
import type { DecodedFirebaseToken } from "../lib/firebaseAdmin.js";
import * as loginChallengeService from "./loginChallengeService.js";
import type {
  ChallengeAudience,
  ChallengeSubject,
  LoginChallenge,
  MfaRequestContext,
} from "./loginChallengeService.js";
import * as staffVerificationService from "./staffVerificationService.js";
import * as mfaTrustService from "./mfaTrustService.js";
import type { TrustMethod } from "./mfaTrustService.js";
import { ServiceError } from "./ServiceError.js";
import { JWT_SECRET, JWT_REFRESH_SECRET, JWT_EXPIRES_IN, JWT_REFRESH_EXPIRES_IN } from "../config/env.js";
import * as sessionService from "./sessionService.js";
import { normalizeUsername, normalizeEmail } from "../lib/identity.js";
import crypto from "node:crypto";
import type { TokenPayload } from "../middleware/auth.js";
import { logger } from "../lib/logger.js";

// Computes a display-only "name" field from firstName/lastName.
// Not stored in the DB (3NF: name is derivable from firstName + lastName,
// so persisting it would be a transitive-dependency redundancy).
export function withFullName<T extends { id: number; firstName: string; lastName: string }>(
  user: T
): T & { name: string } {
  return { ...user, name: `${user.firstName} ${user.lastName}`.trim() };
}

function sanitize<T extends { passwordHash: string }>(user: T) {
  const { passwordHash: _, ...rest } = user;
  return rest;
}

export function generateAccessToken(payload: TokenPayload): string {
  return jwt.sign(
    { id: payload.id, username: payload.username, email: payload.email, role: payload.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"] }
  );
}

// `sid` binds the token to a row in `user_sessions`. Without it the token is a
// pure bearer credential that nothing can revoke or even count; with it, every
// use is checked against server state and rotated. Tokens minted before this
// change carry no sid and are rejected on first use — one re-login at deploy.
export function generateRefreshToken(payload: TokenPayload, sessionId: string): string {
  return jwt.sign(
    {
      id: payload.id,
      username: payload.username,
      email: payload.email,
      role: payload.role,
      sid: sessionId,
      // A per-token nonce, and the reason rotation works at all.
      //
      // Without it the payload is fully determined by the session, and `iat` has
      // one-second resolution — so a token minted in the same second as the one
      // it replaces is byte-identical to it. The stored hash would not change,
      // the "old" token would still validate as current, and both rotation and
      // the replay detection built on it would silently do nothing. That is not
      // hypothetical: it is exactly what the first run of the session smoke test
      // showed before this claim existed.
      jti: crypto.randomUUID(),
    },
    JWT_REFRESH_SECRET,
    { expiresIn: JWT_REFRESH_EXPIRES_IN as jwt.SignOptions["expiresIn"] }
  );
}

/** A fresh session id. Minted with the token pair, persisted by the controller. */
export function newSessionId(): string {
  return crypto.randomUUID();
}

export interface AuthResult {
  user: ReturnType<typeof withFullName>;
  accessToken: string;
  refreshToken: string;
  /** Session this pair belongs to. The controller persists it (respondWithAuth),
   *  because only the controller can see the device and IP it was born on. */
  sessionId: string;
  subjectType: sessionService.SubjectType;
  /** Carried explicitly because `user` is narrowed to display fields and no
   *  longer exposes `role` at this boundary. */
  role: string;
}

interface RoleRequirement {
  role: string;
  deniedMessage: string;
}

export type StaffRow = NonNullable<Awaited<ReturnType<typeof userRepository.findById>>>;

// A staff sign-in ends in exactly one of two places: a real session, or a
// challenge that must be completed first (see loginChallengeService).
export type LoginOutcome =
  | { kind: "AUTHENTICATED"; result: AuthResult; user: StaffRow }
  | { kind: "CHALLENGE"; challenge: LoginChallenge };

// The customer twin. No row rides along: the login alert and log that read it
// are staff-only.
export type CustomerLoginOutcome =
  | { kind: "AUTHENTICATED"; result: AuthResult }
  | { kind: "CHALLENGE"; challenge: LoginChallenge };

// Where the request came from, for the trust a passed second factor grants.
export interface DeviceContext {
  deviceId: string | null;
  userAgent: string | null;
}

// NOTE: loginGeneral/loginRider/loginCustomer intentionally stay as three separate
// functions sharing these internals — mirrors the original three near-duplicated
// route handlers structurally. Collapsing them behind a single Facade (see
// AGENTS.md server section 6) is deferred to Phase 3.

// Step 1 of 3: credentials only. Returns the raw row (still carrying
// passwordHash) because the verification gate and the challenge's credential
// stamp both need fields that sanitize() strips.
async function verifyStaffCredentials(
  identifier: string,
  password: string,
  requirement?: RoleRequirement
): Promise<StaffRow> {
  const user = await userRepository.findByIdentifier(identifier);
  if (!user) {
    throw new ServiceError(401, "Invalid username or password");
  }

  if (user.status !== "Active") {
    throw new ServiceError(403, "This account has been deactivated.");
  }

  // The password check deliberately precedes the role check. With the order
  // reversed, an unauthenticated caller could learn a username's role just by
  // POSTing any password to /riders/login and reading the 403 — a free role
  // oracle. Now only a correct credential produces the role-specific message.
  const isMatch = await bcrypt.compare(password, user.passwordHash);
  if (!isMatch) {
    throw new ServiceError(401, "Invalid username or password");
  }

  if (requirement) {
    const userRole = String(user.role || "").toUpperCase();
    if (userRole !== requirement.role) {
      throw new ServiceError(403, requirement.deniedMessage);
    }
  }

  return user;
}

// Step 2 of 3: token minting, unchanged in behaviour from the original.
function issueAuthResult(user: StaffRow): AuthResult {
  const sanitizedUser = sanitize(user);
  const tokenPayload: TokenPayload = {
    id: sanitizedUser.id,
    username: sanitizedUser.username,
    email: sanitizedUser.email,
    role: sanitizedUser.role,
  };

  const sessionId = newSessionId();
  return {
    user: withFullName(sanitizedUser),
    accessToken: generateAccessToken(tokenPayload),
    refreshToken: generateRefreshToken(tokenPayload, sessionId),
    sessionId,
    subjectType: sessionService.subjectTypeForRole(sanitizedUser.role),
    role: sanitizedUser.role,
  };
}

// Step 3 of 3: the ONLY place a staff session is born. Both the unchallenged
// path and the post-OTP path funnel through here, which is what makes "you
// cannot get a token without passing the gate" checkable by reading one
// function's callers.
function finalizeStaffLogin(user: StaffRow, audience: ChallengeAudience): AuthResult {
  // Presence tracking belongs behind the gate: it used to fire on any correct
  // password, so a rider sitting at an unfinished OTP prompt opened a login
  // session per attempt.
  if (audience === "RIDER_APP") {
    void riderPresenceService.openLoginSession(user.id);
  }
  return issueAuthResult(user);
}

export async function loginGeneral(
  identifier: string,
  password: string,
  mfa: MfaRequestContext = loginChallengeService.LEGACY_CLIENT
): Promise<LoginOutcome> {
  const user = await verifyStaffCredentials(identifier, password);
  const challenge = await loginChallengeService.startChallenge(user, "WEB_PORTAL", mfa);
  if (challenge) return { kind: "CHALLENGE", challenge };
  return { kind: "AUTHENTICATED", result: finalizeStaffLogin(user, "WEB_PORTAL"), user };
}

export async function loginRider(
  identifier: string,
  password: string,
  mfa: MfaRequestContext = loginChallengeService.LEGACY_CLIENT
): Promise<LoginOutcome> {
  const user = await verifyStaffCredentials(identifier, password, {
    role: "RIDER",
    deniedMessage: "Access denied: Only Rider accounts are permitted to access the Rider Mobile App.",
  });
  const challenge = await loginChallengeService.startChallenge(user, "RIDER_APP", mfa);
  if (challenge) return { kind: "CHALLENGE", challenge };
  return { kind: "AUTHENTICATED", result: finalizeStaffLogin(user, "RIDER_APP"), user };
}

export interface CompleteProfileInput {
  challengeToken: string;
  firstName: string;
  middleName: string;
  lastName: string;
  email: string;
}

// The bootstrap admin supplying a real identity. Ends in a NEW challenge at
// step OTP — the re-mint is required, not cosmetic: the credential stamp covers
// the email, which just changed, so the old token is now structurally invalid.
export async function completeLoginProfile(
  input: CompleteProfileInput,
  mfa: MfaRequestContext = loginChallengeService.LEGACY_CLIENT
): Promise<LoginChallenge> {
  const { subject, audience } = await loginChallengeService.consumeChallenge(input.challengeToken, {
    step: "PROFILE_SETUP",
  });
  // Only staff are ever sent to profile setup.
  if (subject.kind !== "STAFF") {
    throw new ServiceError(401, "Your sign-in session expired. Please sign in again.");
  }
  const user = subject.row;

  const email = input.email.trim().toLowerCase();
  const emailOwner = await userRepository.findByIdentifier(email);
  if (emailOwner && emailOwner.id !== user.id) {
    // Pre-empts the raw P2002 so the message names the actual problem.
    throw new ServiceError(400, "That email address is already in use by another account.");
  }

  await userRepository.completeBootstrapProfile(user.id, {
    firstName: input.firstName.trim(),
    middleName: input.middleName.trim(),
    lastName: input.lastName.trim(),
    email,
  });

  await loginChallengeService.burnChallenge(input.challengeToken);
  return loginChallengeService.restartChallenge(user.id, audience, mfa);
}

export interface VerifyLoginOtpResult {
  result: AuthResult;
  // The staff row, for the login alert and log; null for a customer.
  user: StaffRow | null;
  audience: ChallengeAudience;
  // This device's MFA trust (mfaTrustService), handed to the client once.
  trustToken: string;
}

// Philippine mobile numbers in the one form both sides can compare exactly:
// "0917 123 4567", "639171234567" and "+63 917 123 4567" all become
// "+639171234567". Anything else keeps its digits behind a "+".
export function canonicalPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("63")) return `+${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `+63${digits.slice(1)}`;
  if (digits.length === 10 && digits.startsWith("9")) return `+63${digits}`;
  return `+${digits}`;
}

// How far a phone sign-in may precede the challenge it answers, for clock skew
// between Google and this server.
const SMS_PROOF_SKEW_SECONDS = 30;

// Marks a Firebase ID token as used, for as long as it could still verify.
// Insert-only, so two concurrent requests with one token cannot both win. The
// SMS proof and Google sign-in share the key space, so a token spent as one can
// never answer the other.
async function claimFirebaseIdToken(idToken: string, decoded: DecodedFirebaseToken): Promise<boolean> {
  const spentKey = `firebase-id:${crypto.createHash("sha256").update(idToken).digest("hex")}`;
  const expiresAt = new Date((decoded.expiresAt ?? Math.floor(Date.now() / 1000) + 3600) * 1000);
  return tokenBlocklistRepository.claim(spentKey, expiresAt);
}

/**
 * The SMS factor. Firebase Phone Auth sent the code and checked it; the client
 * proves that with the ID token of that phone sign-in, and this decides whether
 * the proof answers THIS challenge for THIS account:
 * - the token comes from a phone sign-in, not Google or a custom token;
 * - that sign-in happened after the challenge was issued, so an old token
 *   lying in a browser cannot be replayed;
 * - its number is exactly the account's number, country code included;
 * - it is spent: the same token never answers a second challenge.
 */
async function verifySmsProof(firebaseIdToken: string, accountPhone: string, challengeIssuedAt: number): Promise<void> {
  const decoded = await verifyFirebaseIdToken(firebaseIdToken);
  if (decoded.signInProvider !== "phone" || !decoded.phoneNumber) {
    throw new ServiceError(400, "This step needs the code from a text message. Please try again.");
  }
  if (!decoded.authTime || decoded.authTime < challengeIssuedAt - SMS_PROOF_SKEW_SECONDS) {
    throw new ServiceError(400, "That text message code was for an earlier sign-in. Please request a new one.");
  }
  if (!accountPhone || canonicalPhone(decoded.phoneNumber) !== canonicalPhone(accountPhone)) {
    throw new ServiceError(400, "That number does not match the mobile number on this account.");
  }

  if (!(await claimFirebaseIdToken(firebaseIdToken, decoded))) {
    throw new ServiceError(401, "That text message code was already used. Please request a new one.");
  }
}

// After the second factor: records the channel as verified, so the
// first-sign-in check (staff) and password reset by SMS (customers) know it.
async function markFactorVerified(subject: ChallengeSubject, method: TrustMethod): Promise<void> {
  if (subject.kind === "STAFF") {
    if (method === "SMS" && !subject.row.phoneVerified) await userRepository.markPhoneVerified(subject.row.id);
    if (method === "EMAIL" && !subject.row.emailVerified) await userRepository.markEmailVerified(subject.row.id);
    return;
  }

  if (method === "EMAIL") {
    if (!subject.row.emailVerified) await customerRepository.markEmailVerified(subject.row.id);
    return;
  }
  if (subject.row.information?.phoneVerified) return;
  try {
    // A number another account has verified stays theirs: the sign-in still
    // passes (this person has the phone), but it is not marked as verified here.
    await assertPhoneAvailable(subject.row.information?.phone, subject.row.id);
  } catch {
    return;
  }
  await customerRepository.update(subject.row.id, {
    phoneVerified: true,
    information: { phoneVerified: true, phoneVerifiedAt: new Date() },
  });
}

export async function completeLoginOtp(
  challengeToken: string,
  code?: string,
  firebaseIdToken?: string,
  device: DeviceContext = { deviceId: null, userAgent: null }
): Promise<VerifyLoginOtpResult> {
  const { subject, audience, issuedAt } = await loginChallengeService.consumeChallenge(challengeToken, {
    step: "OTP",
  });
  const contact = loginChallengeService.contactOf(subject);

  let method: TrustMethod;
  if (firebaseIdToken) {
    // 1. SMS: Firebase Phone Auth sent and checked the code
    await verifySmsProof(firebaseIdToken, contact.phone, issuedAt);
    method = "SMS";
  } else if (code) {
    // 2. Email code
    if (subject.kind === "STAFF") {
      await staffVerificationService.verifyLoginOtp(subject.row.id, code);
    } else {
      await staffVerificationService.verifyCustomerLoginOtp(subject.row.id, code);
    }
    method = "EMAIL";
  } else {
    throw new ServiceError(400, "Please provide either an Email OTP code or Firebase SMS token.");
  }

  // The replay stop. It used to refuse any account already verified, which was
  // right while this step ran once per account and would block MFA on every
  // later sign-in. The insert-only claim keeps the one-session guarantee.
  if (!(await loginChallengeService.claimChallenge(challengeToken))) {
    throw new ServiceError(401, "This sign-in has already been completed. Please sign in again.");
  }

  await markFactorVerified(subject, method);

  // Re-read so the returned profile, the JWT and the trust stamp carry the
  // post-verification state rather than the row we captured before the write.
  if (subject.kind === "STAFF") {
    const verifiedUser = await userRepository.findById(subject.row.id);
    if (!verifiedUser) {
      throw new ServiceError(401, "Account no longer exists. Please sign in again.");
    }
    const verified: ChallengeSubject = { kind: "STAFF", row: verifiedUser };
    const trustToken = await mfaTrustService.issue(
      loginChallengeService.trustSubjectOf(verified),
      loginChallengeService.trustSourceOf(verified),
      { ...device, method }
    );
    return { result: finalizeStaffLogin(verifiedUser, audience), user: verifiedUser, audience, trustToken };
  }

  const verifiedCustomer = await customerRepository.findById(subject.row.id);
  if (!verifiedCustomer) {
    throw new ServiceError(401, "Account no longer exists. Please sign in again.");
  }
  const verified: ChallengeSubject = { kind: "CUSTOMER", row: verifiedCustomer };
  const trustToken = await mfaTrustService.issue(
    loginChallengeService.trustSubjectOf(verified),
    loginChallengeService.trustSourceOf(verified),
    { ...device, method }
  );
  return { result: customerAuthResult(verifiedCustomer), user: null, audience, trustToken };
}

// Sends (or re-sends) the email code. A capable client calls this when the
// person picks email, so it is also the FIRST send for them.
export async function resendLoginOtp(challengeToken: string): Promise<LoginChallenge> {
  const { subject, audience } = await loginChallengeService.consumeChallenge(challengeToken, { step: "OTP" });
  const contact = loginChallengeService.contactOf(subject);

  if (subject.kind === "STAFF") {
    await staffVerificationService.resendLoginOtp(subject.row.id, contact.email, contact.name);
  } else {
    await staffVerificationService.resendCustomerLoginOtp(subject.row.id, contact.email, contact.name);
  }

  // A fresh token so the 10-minute window restarts alongside the new code.
  await loginChallengeService.burnChallenge(challengeToken);
  return loginChallengeService.remintChallenge(subject, audience);
}

// `identifier` is whatever the customer typed into the single sign-in box —
// their username OR their email address. The wire key stays `username` (see
// authValidators.ts) so the parameter name is the only thing that changes.
// The one standing check every customer credential passes through: password,
// Google and Google sign-up all issue sessions, and a sysadmin suspension used
// to stop none of them (it revoked the old sessions, then the next sign-in made
// new ones). Staff have the same rule in verifyStaffCredentials. Called after
// the credential is proven, so a wrong password cannot learn an account's status.
const ACCOUNT_DEACTIVATED = "This account has been deactivated. Please contact SUGO support.";
function assertCustomerActive(customer: { status: string }): void {
  if (customer.status !== "Active") {
    throw new ServiceError(403, ACCOUNT_DEACTIVATED);
  }
}

// Linking a Google sign-in to an account BY EMAIL trusts that the caller owns
// that mailbox. Google tokens always prove it, but Firebase signs tokens for
// every provider the project enables, and an email/password provider would let
// anyone claim a customer's address and be linked straight into their account.
function assertGoogleEmailVerified(decoded: { email?: string; emailVerified?: boolean }): string {
  if (!decoded.email) {
    throw new ServiceError(400, "Google account does not have an email address.");
  }
  if (decoded.emailVerified !== true) {
    throw new ServiceError(403, "Google has not verified this email address.");
  }
  return decoded.email;
}

// The Google sign-in token. A Firebase ID token verifies for an hour, and
// nothing ties it to the request that asked for it: the native Google SDK the
// CustomerApp uses takes no nonce, and there is no redirect for an OAuth
// `state` to protect. So the server pins down what it can:
// - it is a Google sign-in, not a phone or password token from the same project;
// - Firebase has not disabled the user or revoked their sessions since;
// - spendGoogleSignInToken uses it up once it buys a session or an MFA challenge.
async function verifyGoogleSignInToken(idToken: string): Promise<DecodedFirebaseToken> {
  const decoded = await verifyFirebaseIdToken(idToken, { checkRevoked: true });
  if (decoded.signInProvider !== "google.com") {
    throw new ServiceError(400, "Please sign in with your Google account and try again.");
  }
  return decoded;
}

async function spendGoogleSignInToken(idToken: string, decoded: DecodedFirebaseToken): Promise<void> {
  if (!(await claimFirebaseIdToken(idToken, decoded))) {
    throw new ServiceError(409, "That Google sign-in was already used. Please try again.");
  }
}

type CustomerRow = NonNullable<Awaited<ReturnType<typeof customerRepository.findById>>>;

// The one place a customer token pair is minted for sign-in (registration still
// builds its own inline).
function customerAuthResult(customer: CustomerRow): AuthResult {
  const flatCustomer = flattenCustomerAccount(customer);
  const tokenPayload: TokenPayload = {
    id: flatCustomer.id,
    username: flatCustomer.username,
    email: flatCustomer.email,
    role: "CUSTOMER",
  };

  const sessionId = newSessionId();
  return {
    user: withFullName(flatCustomer),
    accessToken: generateAccessToken(tokenPayload),
    refreshToken: generateRefreshToken(tokenPayload, sessionId),
    sessionId,
    subjectType: "CUSTOMER",
    role: "CUSTOMER",
  };
}

/**
 * Trusts the device a customer just registered on: sign-up already proved the
 * phone or email it needed, so their first sign-in there is not asked again.
 */
export async function trustCustomerDevice(customerId: number, device: DeviceContext): Promise<string | null> {
  const customer = await customerRepository.findById(customerId);
  if (!customer) return null;
  const subject: ChallengeSubject = { kind: "CUSTOMER", row: customer };
  return mfaTrustService.issue(loginChallengeService.trustSubjectOf(subject), loginChallengeService.trustSourceOf(subject), {
    ...device,
    method: customer.information?.phoneVerified ? "SMS" : "EMAIL",
  });
}

export async function loginCustomer(
  identifier: string,
  password: string,
  mfa: MfaRequestContext = loginChallengeService.LEGACY_CLIENT
): Promise<CustomerLoginOutcome> {
  const customer = await customerRepository.findByIdentifier(identifier);
  if (!customer) {
    throw new ServiceError(401, "Invalid username or password");
  }

  if (!customer.passwordHash) {
    throw new ServiceError(401, "This account uses Google Sign-In. Please sign in with Google.");
  }

  const isMatch = await bcrypt.compare(password, customer.passwordHash);
  if (!isMatch) {
    throw new ServiceError(401, "Invalid username or password");
  }
  assertCustomerActive(customer);

  const challenge = await loginChallengeService.startCustomerChallenge(customer, mfa);
  if (challenge) return { kind: "CHALLENGE", challenge };
  return { kind: "AUTHENTICATED", result: customerAuthResult(customer) };
}

export function normalizePhoneDigits(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length >= 10) {
    return digits.slice(-10);
  }
  return digits;
}

/**
 * Refuses a mobile number another account has already verified.
 *
 * customer_information.phone is not unique, and SMS password reset resolves an
 * account FROM the number, so two holders made that reset pick one of them
 * arbitrarily (2026-10-09). Only a VERIFIED holder blocks: an unverified number
 * is an unproven claim, and letting it block would let anyone pre-register
 * someone else's number and lock its owner out.
 *
 * 400, not 409: the customer app reads a 409 as "that changed, refresh" and
 * shows this sentence only for a 400.
 */
export async function assertPhoneAvailable(phone: string | null | undefined, exceptCustomerId?: number) {
  if (!phone || !normalizePhoneDigits(phone)) return;
  const holders = await customerRepository.findAllByPhone(phone, { verifiedOnly: true });
  if (holders.some((holder) => holder.id !== exceptCustomerId)) {
    throw new ServiceError(400, "This mobile number is already registered to another account.");
  }
}

export async function verifyFirebasePhoneToken(
  idToken: string,
  expectedPhone?: string
): Promise<{ uid: string; phone: string; verified: boolean }> {
  const result = await verifyFirebaseIdToken(idToken);
  if (!result.phoneNumber) {
    throw new ServiceError(400, "Firebase ID token does not contain a verified phone number.");
  }
  if (expectedPhone && expectedPhone.trim()) {
    const cleanExpected = normalizePhoneDigits(expectedPhone);
    const cleanToken = normalizePhoneDigits(result.phoneNumber);
    if (cleanExpected !== cleanToken) {
      throw new ServiceError(400, "Verified phone number does not match expected phone number.");
    }
  }
  return {
    uid: result.uid,
    phone: result.phoneNumber,
    verified: true,
  };
}

export type GoogleAuthResult =
  | {
      status: "AUTHENTICATED";
      auth: AuthResult;
    }
  | {
      status: "PHONE_SETUP_REQUIRED";
      email: string;
      firstName: string;
      lastName: string;
      googleUid: string;
      avatar?: string;
    }
  | {
      status: "MFA_REQUIRED";
      challenge: LoginChallenge;
    };

export async function loginCustomerWithGoogle(
  idToken: string,
  mfa: MfaRequestContext = loginChallengeService.LEGACY_CLIENT
): Promise<GoogleAuthResult> {
  const decoded = await verifyGoogleSignInToken(idToken);
  const email = assertGoogleEmailVerified(decoded);

  // 1. Try finding by googleId
  let customer = await customerRepository.findByGoogleId(decoded.uid);

  // 2. If not found by googleId, try finding by email to link accounts
  if (!customer) {
    customer = await customerRepository.findByEmail(email);
    if (customer) {
      // Before linking, so a suspended account is not handed a new sign-in method.
      assertCustomerActive(customer);
      customer = await customerRepository.update(customer.id, {
        googleId: decoded.uid,
        emailVerified: true,
      });
    }
  }

  // 3. If customer exists, check if phone number is present
  if (customer) {
    assertCustomerActive(customer);
    const hasPhone = Boolean(customer.information?.phone && customer.information.phone.trim());
    if (!hasPhone) {
      const nameParts = (decoded.name || "").trim().split(/\s+/);
      const firstName = customer.information?.firstName || nameParts[0] || "Customer";
      const lastName = customer.information?.lastName || (nameParts.length > 1 ? nameParts.slice(1).join(" ") : "");
      return {
        status: "PHONE_SETUP_REQUIRED",
        email: customer.email,
        firstName,
        lastName,
        googleUid: decoded.uid,
        avatar: decoded.picture,
      };
    }

    // The token now buys a challenge or a session, so it is spent here. The
    // phone-setup replies leave it unspent: google-register needs it next.
    await spendGoogleSignInToken(idToken, decoded);

    // Google proved the email; MFA still asks for the phone or a code on a
    // device that has not passed it, same as a password sign-in.
    const challenge = await loginChallengeService.startCustomerChallenge(customer, mfa);
    if (challenge) return { status: "MFA_REQUIRED", challenge };

    return { status: "AUTHENTICATED", auth: customerAuthResult(customer) };
  }

  // 4. New user: needs phone number setup
  const nameParts = (decoded.name || "").trim().split(/\s+/);
  const firstName = nameParts[0] || "Customer";
  const lastName = nameParts.length > 1 ? nameParts.slice(1).join(" ") : "";

  return {
    status: "PHONE_SETUP_REQUIRED",
    email,
    firstName,
    lastName,
    googleUid: decoded.uid,
    avatar: decoded.picture,
  };
}

export interface GoogleRegisterInput {
  idToken: string;
  phone: string;
  phoneToken: string;
  firstName?: string;
  lastName?: string;
  avatar?: string;
}

export async function registerCustomerWithGoogle(input: GoogleRegisterInput): Promise<AuthResult> {
  const decoded = await verifyGoogleSignInToken(input.idToken);
  // Also the address written below as emailVerified: true.
  const email = assertGoogleEmailVerified(decoded);

  // Verify that the phone number was actually verified via SMS OTP
  await verifyFirebasePhoneToken(input.phoneToken, input.phone);

  let existing = await customerRepository.findByGoogleId(decoded.uid);
  if (!existing) {
    existing = await customerRepository.findByEmail(email);
  }
  if (existing) assertCustomerActive(existing);

  // An account that already has a mobile number signs in through google-login,
  // which asks for its second factor. Registering over it would replace that
  // number and hand out a session with no second factor at all.
  if (existing?.information?.phone?.trim()) {
    throw new ServiceError(409, "This account already has a mobile number. Please sign in with Google instead.");
  }

  // Both branches below write this number as verified, so neither may take one
  // another account already holds. The account being linked keeps its own.
  await assertPhoneAvailable(input.phone, existing?.id);

  // Last check before anything is written: this token signs up once.
  await spendGoogleSignInToken(input.idToken, decoded);

  if (existing) {
    const updated = await customerRepository.update(existing.id, {
      googleId: decoded.uid,
      emailVerified: true,
      phoneVerified: true,
      information: {
        phone: input.phone.trim(),
        phoneVerified: true,
        phoneVerifiedAt: new Date(),
        firstName: input.firstName?.trim() || existing.information?.firstName,
        lastName: input.lastName?.trim() || existing.information?.lastName,
        avatar: input.avatar || existing.information?.avatar || decoded.picture || null,
      },
    });

    const flatCustomer = flattenCustomerAccount(updated);
    const tokenPayload: TokenPayload = {
      id: flatCustomer.id,
      username: flatCustomer.username,
      email: flatCustomer.email,
      role: "CUSTOMER",
    };
    const sessionId = newSessionId();
    return {
      user: withFullName(flatCustomer),
      accessToken: generateAccessToken(tokenPayload),
      refreshToken: generateRefreshToken(tokenPayload, sessionId),
      sessionId,
      subjectType: "CUSTOMER",
      role: "CUSTOMER",
    };
  }

  // Generate unique username from email
  let baseUsername = (email.split("@")[0] || "user").replace(/[^a-zA-Z0-9_]/g, "").toLowerCase();
  if (baseUsername.length < 3) baseUsername = `user_${baseUsername}`;
  let username = baseUsername;
  let counter = 1;
  while (await customerRepository.findByUsername(username)) {
    username = `${baseUsername}_${counter++}`;
  }

  const nameParts = (decoded.name || "").trim().split(/\s+/);
  const firstName = input.firstName?.trim() || nameParts[0] || "Customer";
  const lastName = input.lastName?.trim() || (nameParts.length > 1 ? nameParts.slice(1).join(" ") : "");

  const newCustomer = await customerRepository.create({
    username,
    email,
    passwordHash: null,
    googleId: decoded.uid,
    emailVerified: true,
    phoneVerified: true,
    information: {
      firstName,
      lastName,
      phone: input.phone.trim(),
      phoneVerified: true,
      phoneVerifiedAt: new Date(),
      avatar: input.avatar || decoded.picture || undefined,
    },
  });

  const flatCustomer = flattenCustomerAccount(newCustomer);
  const tokenPayload: TokenPayload = {
    id: flatCustomer.id,
    username: flatCustomer.username,
    email: flatCustomer.email,
    role: "CUSTOMER",
  };
  const sessionId = newSessionId();
  return {
    user: withFullName(flatCustomer),
    accessToken: generateAccessToken(tokenPayload),
    refreshToken: generateRefreshToken(tokenPayload, sessionId),
    sessionId,
    subjectType: "CUSTOMER",
    role: "CUSTOMER",
  };
}

export interface RegisterInput {
  username: string;
  password: string;
  email: string;
  firstName: string;
  middleName?: string;
  lastName: string;
  birthdate?: string | Date | null;
  phone?: string;
  emailVerified?: boolean;
  phoneVerified?: boolean;
  firebaseIdToken?: string;
}

export async function registerCustomer(input: RegisterInput): Promise<AuthResult> {
  // Canonical from the first line, so the duplicate check below, the row that
  // gets written, and the sign-in lookup all speak about the same string.
  const cleanUsername = normalizeUsername(input.username);
  const cleanEmail = normalizeEmail(input.email);

  const existing = await customerRepository.findByUsernameOrEmail(cleanUsername, cleanEmail);
  if (existing) {
    throw new ServiceError(400, "Customer already exists with provided username or email");
  }

  let isPhoneVerified = false;
  let phoneVerifiedAt: Date | null = null;
  let effectivePhone = input.phone ? input.phone.trim() : "";

  if (input.firebaseIdToken) {
    const verified = await verifyFirebasePhoneToken(input.firebaseIdToken, input.phone);
    isPhoneVerified = true;
    phoneVerifiedAt = new Date();
    if (!effectivePhone && verified.phone) {
      effectivePhone = verified.phone;
    }
  } else if (effectivePhone) {
    const consumed = await emailVerificationRepository.findLatestConsumedForPhone(effectivePhone);
    if (consumed?.consumedAt && Date.now() - consumed.consumedAt.getTime() < 30 * 60 * 1000) {
      isPhoneVerified = true;
      phoneVerifiedAt = consumed.consumedAt;
    }
  }

  // The app sends emailVerified: true once /customers/verify-registration-otp
  // passes, but the body is the caller's word. Believe it only when that check
  // consumed this address's newest registration code, recently. A resend
  // retires older codes as well, but always leaves a newer live one behind, so
  // a consumed newest code means the person typed it.
  let isEmailVerified = false;
  if (input.emailVerified) {
    const latest = await emailVerificationRepository.findLatestForEmail(cleanEmail);
    isEmailVerified = Boolean(
      latest?.consumedAt &&
        latest.customerId == null &&
        latest.userId == null &&
        Date.now() - latest.consumedAt.getTime() < 30 * 60 * 1000
    );
  }

  // After the Firebase step, which may be what supplied effectivePhone.
  await assertPhoneAvailable(effectivePhone);

  const createData = await buildCustomerAccountCreateData({
    username: cleanUsername,
    password: input.password,
    email: cleanEmail,
    firstName: input.firstName,
    middleName: input.middleName,
    lastName: input.lastName,
    birthdate: input.birthdate,
    phone: effectivePhone,
    emailVerified: isEmailVerified,
    phoneVerified: isPhoneVerified,
    phoneVerifiedAt,
  });
  const newCustomer = await customerRepository.create(createData);

  // If not yet verified during registration, send email verification code
  if (!isEmailVerified) {
    void sendVerificationCode(newCustomer.id, cleanEmail);
  }

  const flatCustomer = flattenCustomerAccount(newCustomer);
  const tokenPayload: TokenPayload = {
    id: flatCustomer.id,
    username: flatCustomer.username,
    email: flatCustomer.email,
    role: "CUSTOMER",
  };

  const sessionId = newSessionId();
  return {
    user: withFullName(flatCustomer),
    accessToken: generateAccessToken(tokenPayload),
    refreshToken: generateRefreshToken(tokenPayload, sessionId),
    sessionId,
    subjectType: "CUSTOMER",
    role: "CUSTOMER",
  };
}

export interface RefreshResult {
  accessToken: string;
  /** Present only when the token actually rotated. `null` means the caller hit
   *  the concurrency grace window and should keep the token it already has. */
  refreshToken: string | null;
  user: ReturnType<typeof withFullName>;
}

/**
 * Exchange a refresh token for a new access token, rotating the refresh token
 * in the process.
 *
 * This is the call the Customer and Rider apps were never making — which is why
 * a session died the moment its access token aged out. It now also rotates, so
 * a 30-day session is not a 30-day replayable credential.
 */
export async function refreshAccessToken(
  refreshToken: string,
  context: sessionService.SessionContext = {}
): Promise<RefreshResult> {
  const revoked = await tokenBlocklistRepository.findByToken(refreshToken);
  if (revoked) {
    throw new ServiceError(401, "Refresh token has been revoked. Please log in again.");
  }

  const payload = await new Promise<TokenPayload & { sid?: string }>((resolve, reject) => {
    jwt.verify(refreshToken, JWT_REFRESH_SECRET, { algorithms: ["HS256"] }, (err: jwt.VerifyErrors | null, decoded: unknown) => {
      if (err) {
        reject(new ServiceError(401, "Invalid or expired refresh token. Please log in again."));
        return;
      }
      resolve(decoded as TokenPayload & { sid?: string });
    });
  });

  // Pre-rotation tokens have no sid and cannot be checked against any session.
  // Treated as expired rather than honoured, because honouring them would leave
  // an unrevocable 7-day credential in circulation alongside the new scheme.
  if (!payload.sid) {
    throw new ServiceError(401, "Your session is no longer valid. Please log in again.");
  }

  // Refresh tokens only carry id/username/email/role — look up the full
  // profile (name, phone, avatar, ...) so the client can restore `user`
  // state without depending on sessionStorage as a source of truth.
  //
  // The same lookup decides whether this session may continue. A refresh token
  // lives 30 days and slides, and every new access token is minted from its
  // claims, so without this a demoted owner stayed an owner and a deactivated
  // or suspended account kept working until the session went idle (Codex
  // security scan, 2026-11-02). Checked BEFORE rotating, and a refused session
  // is revoked, so it is never handed a fresh token to try again with.
  const role = String(payload.role || "").toUpperCase();
  const sessionId = payload.sid;
  const endSession = async (reason: string, message: string): Promise<ServiceError> => {
    await sessionService.revokeSession(sessionId, reason);
    return new ServiceError(401, message);
  };
  const user =
    role === "CUSTOMER"
      ? await (async () => {
          const customer = await customerRepository.findById(payload.id);
          if (!customer) {
            throw new ServiceError(401, "Account no longer exists. Please log in again.");
          }
          if (customer.status !== "Active") {
            throw await endSession("ACCOUNT_NOT_ACTIVE", ACCOUNT_DEACTIVATED);
          }
          return withFullName(flattenCustomerAccount(customer));
        })()
      : await (async () => {
          const dbUser = await userRepository.findById(payload.id);
          if (!dbUser) {
            throw new ServiceError(401, "Account no longer exists. Please log in again.");
          }
          if (dbUser.status !== "Active") {
            throw await endSession("ACCOUNT_NOT_ACTIVE", "This account has been deactivated.");
          }
          if (String(dbUser.role || "").toUpperCase() !== role) {
            throw await endSession("ROLE_CHANGED", "Your role has changed. Please log in again.");
          }
          return withFullName(sanitize(dbUser));
        })();

  // Validates, detects replay, and mints the replacement inside sessionService
  // so the new hash is written in the same step that retires the old one.
  const { refreshToken: rotated } = await sessionService.rotateSession(
    payload.sid,
    refreshToken,
    () =>
      generateRefreshToken(
        {
          id: payload.id,
          username: payload.username,
          email: payload.email,
          role: payload.role,
        },
        payload.sid as string
      ),
    context
  );

  if (role === "RIDER") {
    void riderPresenceService.openLoginSession(payload.id).catch((err) => {
      logger.error(`Failed to ensure rider login session on refresh for rider ${payload.id}:`, err);
    });
  }

  const accessToken = generateAccessToken({
    id: payload.id,
    username: payload.username,
    email: payload.email,
    role: payload.role,
  });

  return { accessToken, refreshToken: rotated, user };
}

/** Reads the session id out of a refresh token without trusting its signature.
 *  Only used on logout, where the worst case of a forged sid is revoking a
 *  session the caller could already revoke by other means. */
export function sessionIdFromRefreshToken(token: string): string | null {
  const decoded = jwt.decode(token) as { sid?: string } | null;
  return decoded?.sid ?? null;
}

export function buildRevocationEntry(token: string, fallbackMs: number): { token: string; expiresAt: Date } {
  const decoded = jwt.decode(token) as { exp?: number } | null;
  return {
    token,
    expiresAt: decoded?.exp ? new Date(decoded.exp * 1000) : new Date(Date.now() + fallbackMs),
  };
}

export async function revokeTokens(tokens: { token: string; expiresAt: Date }[]): Promise<void> {
  for (const entry of tokens) {
    await tokenBlocklistRepository.revoke(entry.token, entry.expiresAt);
    markRevoked(entry.token);
  }
}
