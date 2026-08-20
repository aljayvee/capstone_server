import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { userRepository } from "../repositories/userRepository.js";
import { customerRepository } from "../repositories/customerRepository.js";
import * as riderPresenceService from "./riderPresenceService.js";
import { tokenBlocklistRepository } from "../repositories/tokenBlocklistRepository.js";
import { markRevoked } from "../lib/blocklistCache.js";
import { buildCustomerAccountCreateData, flattenCustomerAccount } from "./patterns/customerFactory.js";
import { sendVerificationCode } from "./emailVerificationService.js";
import { ServiceError } from "./ServiceError.js";
import { JWT_SECRET, JWT_REFRESH_SECRET, JWT_EXPIRES_IN, JWT_REFRESH_EXPIRES_IN } from "../config/env.js";
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

export function generateRefreshToken(payload: TokenPayload): string {
  return jwt.sign(
    { id: payload.id, username: payload.username, email: payload.email, role: payload.role },
    JWT_REFRESH_SECRET,
    { expiresIn: JWT_REFRESH_EXPIRES_IN as jwt.SignOptions["expiresIn"] }
  );
}

export interface AuthResult {
  user: ReturnType<typeof withFullName>;
  accessToken: string;
  refreshToken: string;
}

interface RoleRequirement {
  role: string;
  deniedMessage: string;
}

// NOTE: loginGeneral/loginRider/loginCustomer intentionally stay as three separate
// functions sharing this one internal `authenticate` — mirrors the original three
// near-duplicated route handlers structurally. Collapsing them behind a single
// Facade (see AGENTS.md server section 6) is deferred to Phase 3, kept out of this
// purely-structural migration so each phase stays independently reviewable.
async function authenticate(username: string, password: string, requirement?: RoleRequirement): Promise<AuthResult> {
  const user = await userRepository.findByUsername(username);
  if (!user) {
    throw new ServiceError(401, "Invalid username or password");
  }

  if (user.status !== "Active") {
    throw new ServiceError(403, "This account has been deactivated.");
  }

  if (requirement) {
    const userRole = String(user.role || "").toUpperCase();
    if (userRole !== requirement.role) {
      throw new ServiceError(403, requirement.deniedMessage);
    }
  }

  const isMatch = await bcrypt.compare(password, user.passwordHash);
  if (!isMatch) {
    throw new ServiceError(401, "Invalid username or password");
  }

  const sanitizedUser = sanitize(user);
  const tokenPayload: TokenPayload = {
    id: sanitizedUser.id,
    username: sanitizedUser.username,
    email: sanitizedUser.email,
    role: sanitizedUser.role,
  };

  return {
    user: withFullName(sanitizedUser),
    accessToken: generateAccessToken(tokenPayload),
    refreshToken: generateRefreshToken(tokenPayload),
  };
}

export function loginGeneral(username: string, password: string) {
  return authenticate(username, password);
}

export async function loginRider(username: string, password: string) {
  const result = await authenticate(username, password, {
    role: "RIDER",
    deniedMessage: "Access denied: Only Rider accounts are permitted to access the Rider Mobile App.",
  });
  void riderPresenceService.openLoginSession(result.user.id);
  return result;
}

export async function loginCustomer(username: string, password: string): Promise<AuthResult> {
  const customer = await customerRepository.findByUsername(username);
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

  return {
    user: withFullName(flatCustomer),
    accessToken: generateAccessToken(tokenPayload),
    refreshToken: generateRefreshToken(tokenPayload),
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
  const cleanUsername = input.username.trim();
  const cleanEmail = input.email.trim().toLowerCase();

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

  return {
    user: withFullName(flatCustomer),
    accessToken: generateAccessToken(tokenPayload),
    refreshToken: generateRefreshToken(tokenPayload),
  };
}

export interface RefreshResult {
  accessToken: string;
  user: ReturnType<typeof withFullName>;
}

export async function refreshAccessToken(refreshToken: string): Promise<RefreshResult> {
  const revoked = await tokenBlocklistRepository.findByToken(refreshToken);
  if (revoked) {
    throw new ServiceError(401, "Refresh token has been revoked. Please log in again.");
  }

  const payload = await new Promise<TokenPayload>((resolve, reject) => {
    jwt.verify(refreshToken, JWT_REFRESH_SECRET, (err: jwt.VerifyErrors | null, decoded: unknown) => {
      if (err) {
        reject(new ServiceError(403, "Invalid or expired refresh token. Please log in again."));
        return;
      }
      resolve(decoded as TokenPayload);
    });
  });

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

  return { accessToken, user };
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
