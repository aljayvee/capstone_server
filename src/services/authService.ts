import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { userRepository } from "../repositories/userRepository.js";
import { customerRepository } from "../repositories/customerRepository.js";
import * as riderPresenceService from "./riderPresenceService.js";
import { tokenBlocklistRepository } from "../repositories/tokenBlocklistRepository.js";
import { markRevoked } from "../lib/blocklistCache.js";
import { buildCustomerAccountCreateData, flattenCustomerAccount } from "./patterns/customerFactory.js";
import { sendVerificationCode } from "./emailVerificationService.js";
import * as loginChallengeService from "./loginChallengeService.js";
import type { ChallengeAudience, LoginChallenge } from "./loginChallengeService.js";
import * as staffVerificationService from "./staffVerificationService.js";
import { ServiceError } from "./ServiceError.js";
import { JWT_SECRET, JWT_REFRESH_SECRET, JWT_EXPIRES_IN, JWT_REFRESH_EXPIRES_IN } from "../config/env.js";
import * as sessionService from "./sessionService.js";
import { normalizeUsername, normalizeEmail } from "../lib/identity.js";
import crypto from "node:crypto";
import type { TokenPayload } from "../middleware/auth.js";

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

export async function loginGeneral(identifier: string, password: string): Promise<LoginOutcome> {
  const user = await verifyStaffCredentials(identifier, password);
  const challenge = await loginChallengeService.startChallenge(user, "WEB_PORTAL");
  if (challenge) return { kind: "CHALLENGE", challenge };
  return { kind: "AUTHENTICATED", result: finalizeStaffLogin(user, "WEB_PORTAL"), user };
}

export async function loginRider(identifier: string, password: string): Promise<LoginOutcome> {
  const user = await verifyStaffCredentials(identifier, password, {
    role: "RIDER",
    deniedMessage: "Access denied: Only Rider accounts are permitted to access the Rider Mobile App.",
  });
  const challenge = await loginChallengeService.startChallenge(user, "RIDER_APP");
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
export async function completeLoginProfile(input: CompleteProfileInput): Promise<LoginChallenge> {
  const { user, audience } = await loginChallengeService.consumeChallenge(input.challengeToken, {
    step: "PROFILE_SETUP",
  });

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
  return loginChallengeService.restartChallenge(user.id, audience);
}

export interface VerifyLoginOtpResult {
  result: AuthResult;
  user: StaffRow;
  audience: ChallengeAudience;
}

export async function completeLoginOtp(challengeToken: string, code: string): Promise<VerifyLoginOtpResult> {
  const { user, audience } = await loginChallengeService.consumeChallenge(challengeToken, { step: "OTP" });

  // Hard replay stop, independent of the token blocklist.
  if (user.emailVerified) {
    throw new ServiceError(401, "This sign-in has already been completed. Please sign in again.");
  }

  await staffVerificationService.verifyLoginOtp(user.id, code);
  await userRepository.markEmailVerified(user.id);
  await loginChallengeService.burnChallenge(challengeToken);

  // Re-read so the returned profile and the JWT carry the post-verification
  // state rather than the row we captured before the write.
  const verifiedUser = await userRepository.findById(user.id);
  if (!verifiedUser) {
    throw new ServiceError(401, "Account no longer exists. Please sign in again.");
  }

  return { result: finalizeStaffLogin(verifiedUser, audience), user: verifiedUser, audience };
}

export async function resendLoginOtp(challengeToken: string): Promise<LoginChallenge> {
  const { user, audience } = await loginChallengeService.consumeChallenge(challengeToken, { step: "OTP" });

  await staffVerificationService.resendLoginOtp(
    user.id,
    user.email,
    `${user.firstName} ${user.lastName}`.trim()
  );

  // A fresh token so the 10-minute window restarts alongside the new code.
  await loginChallengeService.burnChallenge(challengeToken);
  return loginChallengeService.restartChallenge(user.id, audience);
}

// `identifier` is whatever the customer typed into the single sign-in box —
// their username OR their email address. The wire key stays `username` (see
// authValidators.ts) so the parameter name is the only thing that changes.
export async function loginCustomer(identifier: string, password: string): Promise<AuthResult> {
  const customer = await customerRepository.findByIdentifier(identifier);
  if (!customer) {
    throw new ServiceError(401, "Invalid username or password");
  }

  const isMatch = await bcrypt.compare(password, customer.passwordHash);
  if (!isMatch) {
    throw new ServiceError(401, "Invalid username or password");
  }

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

  const createData = await buildCustomerAccountCreateData({
    username: cleanUsername,
    password: input.password,
    email: cleanEmail,
    firstName: input.firstName,
    middleName: input.middleName,
    lastName: input.lastName,
    birthdate: input.birthdate,
    phone: input.phone,
    emailVerified: input.emailVerified ?? false,
  });
  const newCustomer = await customerRepository.create(createData);

  // If not yet verified during registration, send email verification code
  if (!input.emailVerified) {
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
    jwt.verify(refreshToken, JWT_REFRESH_SECRET, (err: jwt.VerifyErrors | null, decoded: unknown) => {
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

  // Refresh tokens only carry id/username/email/role — look up the full
  // profile (name, phone, avatar, ...) so the client can restore `user`
  // state without depending on sessionStorage as a source of truth.
  const role = String(payload.role || "").toUpperCase();
  const user =
    role === "CUSTOMER"
      ? await (async () => {
          const customer = await customerRepository.findById(payload.id);
          if (!customer) {
            throw new ServiceError(401, "Account no longer exists. Please log in again.");
          }
          return withFullName(flattenCustomerAccount(customer));
        })()
      : await (async () => {
          const dbUser = await userRepository.findById(payload.id);
          if (!dbUser) {
            throw new ServiceError(401, "Account no longer exists. Please log in again.");
          }
          return withFullName(sanitize(dbUser));
        })();

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
