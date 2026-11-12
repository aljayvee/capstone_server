import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma.js";
import { ServiceError } from "./ServiceError.js";
import { JWT_SECRET, JWT_EXPIRES_IN, JWT_REFRESH_SECRET } from "../config/env.js";
import * as sessionService from "./sessionService.js";
import { normalizeUsername, normalizeEmail } from "../lib/identity.js";
import { sendEmail } from "../lib/mailer.js";
import {
  buildSysAdminVerificationLinkEmail,
  buildSysAdminUnlockLinkEmail,
  buildSysAdmin2FaOtpEmail,
  buildSysAdminSecurityAlertEmail,
} from "../lib/emailTemplates.js";
import { generateAccessToken, generateRefreshToken } from "./authService.js";
import { parseDeviceInfo } from "../lib/requestContext.js";
import type { TokenPayload } from "../middleware/auth.js";
import type { SessionContext } from "./sessionService.js";

const MAGIC_LINK_EXPIRY_MINUTES = 5;
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_DURATION_MS = 30 * 60 * 1000; // 30 minutes
const TWO_FACTOR_EXPIRY_MINUTES = 10;
const UNLOCK_TOKEN_EXPIRY_MINUTES = 30;

export interface SysAdminSessionContext extends SessionContext {
  deviceToken?: string | null;
  deviceFingerprint?: string | null;
  appOrigin?: string | null;
}

export interface SysAdminProfileInput {
  firstName: string;
  lastName: string;
  middleName?: string;
  nickname: string;
  email: string;
}

export function maskEmail(email: string): string {
  if (!email || !email.includes("@")) return "registered email";
  const [local, domain] = email.split("@");
  if (local.length <= 2) return `${local[0]}***@${domain}`;
  return `${local[0]}***${local[local.length - 1]}@${domain}`;
}

function sanitizeAdmin(admin: {
  id: number;
  username: string;
  firstName?: string | null;
  middleName?: string | null;
  lastName?: string | null;
  nickname?: string | null;
  email?: string | null;
  phone?: string | null;
  role: string;
  status: string;
  profileCompleted: boolean;
  emailVerified: boolean;
  enforceTwoFactor?: boolean;
  failedLoginAttempts?: number;
  lockedUntil?: Date | null;
  lastLoginAt?: Date | null;
  createdAt: Date;
}) {
  return {
    id: admin.id,
    username: admin.username,
    firstName: admin.firstName ?? "",
    middleName: admin.middleName ?? null,
    lastName: admin.lastName ?? "",
    name: [admin.firstName, admin.lastName].filter(Boolean).join(" ") || admin.username,
    nickname: admin.nickname ?? admin.username,
    email: admin.email ?? "",
    phone: admin.phone ?? null,
    role: "SYSADMIN",
    status: admin.status,
    profileCompleted: admin.profileCompleted,
    emailVerified: admin.emailVerified,
    enforceTwoFactor: admin.enforceTwoFactor ?? false,
    lastLoginAt: admin.lastLoginAt,
    createdAt: admin.createdAt,
  };
}

export function generateSetupToken(adminId: number): string {
  return jwt.sign({ adminId, purpose: "SYSADMIN_SETUP" }, JWT_SECRET, { expiresIn: "1h" });
}

export function verifySetupToken(token: string): number {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] }) as { adminId: number; purpose: string };
    if (!decoded || decoded.purpose !== "SYSADMIN_SETUP" || !decoded.adminId) {
      throw new ServiceError(401, "Invalid or expired setup token.");
    }
    return decoded.adminId;
  } catch {
    throw new ServiceError(401, "Invalid or expired setup token.");
  }
}

export async function loginSysAdmin(
  usernameInput: string,
  passwordInput: string,
  context: SysAdminSessionContext = {}
) {
  const normUsername = normalizeUsername(usernameInput);
  if (!normUsername || !passwordInput) {
    throw new ServiceError(400, "Username and password are required.");
  }

  const admin = await prisma.sysAdmin.findUnique({
    where: { username: normUsername },
  });

  if (!admin) {
    throw new ServiceError(401, "Invalid administrative credentials.");
  }

  // 1. Check account lockout status
  if (admin.lockedUntil && admin.lockedUntil.getTime() > Date.now()) {
    const remainingMinutes = Math.ceil((admin.lockedUntil.getTime() - Date.now()) / (60 * 1000));
    throw new ServiceError(
      423,
      `Administrative account is locked due to consecutive failed attempts. Try again in ${remainingMinutes} minute(s) or use the emergency unlock link sent to your registered email.`
    );
  }

  // 2. Validate password
  const isPasswordValid = await bcrypt.compare(passwordInput, admin.passwordHash);
  if (!isPasswordValid) {
    const newAttempts = (admin.failedLoginAttempts || 0) + 1;

    if (context.ipAddress) {
      await sessionService.recordLoginLog({
        userId: admin.id,
        role: "SYSADMIN",
        ipAddress: context.ipAddress,
        userAgent: context.userAgent ?? "Unknown",
        deviceInfo: null,
        status: "FAILED_CREDENTIALS",
        sessionId: null,
        revokedReason: `Failed password attempt ${newAttempts}/${LOCKOUT_THRESHOLD}`,
      });
    }

    if (newAttempts >= LOCKOUT_THRESHOLD) {
      const lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MS);
      const rawUnlockToken = crypto.randomBytes(32).toString("hex");
      const unlockTokenHash = crypto.createHash("sha256").update(rawUnlockToken).digest("hex");
      const unlockTokenExpiresAt = new Date(Date.now() + UNLOCK_TOKEN_EXPIRY_MINUTES * 60 * 1000);

      await prisma.sysAdmin.update({
        where: { id: admin.id },
        data: {
          failedLoginAttempts: newAttempts,
          lockedUntil,
          unlockTokenHash,
          unlockTokenExpiresAt,
        },
      });

      if (admin.email) {
        const origin = context.appOrigin?.replace(/\/$/, "") || "https://portal.sugo-express.org";
        const unlockLink = `${origin}/sysadmin/unlock?token=${rawUnlockToken}`;
        const emailTemplate = buildSysAdminUnlockLinkEmail(
          unlockLink,
          admin.firstName || admin.username,
          UNLOCK_TOKEN_EXPIRY_MINUTES
        );
        sendEmail(admin.email, emailTemplate.subject, emailTemplate.text, emailTemplate.html).catch((err) => {
          console.error("Failed to send SysAdmin emergency unlock email:", err);
        });
      }

      throw new ServiceError(
        423,
        "Account locked: 5 consecutive failed login attempts reached. Your administrator account is locked for 30 minutes. An emergency unlock link has been sent to your registered email."
      );
    }

    await prisma.sysAdmin.update({
      where: { id: admin.id },
      data: { failedLoginAttempts: newAttempts },
    });

    throw new ServiceError(
      401,
      `Invalid administrative credentials. Attempt ${newAttempts} of ${LOCKOUT_THRESHOLD} before temporary account lockout.`
    );
  }

  // 3. Status check
  if (admin.status !== "Active") {
    throw new ServiceError(403, "System Administrator account has been suspended or deactivated.");
  }

  // 4. Setup Wizard check
  if (!admin.profileCompleted || !admin.emailVerified) {
    const challengeToken = generateSetupToken(admin.id);
    return {
      profileSetupRequired: true,
      twoFactorRequired: false,
      challengeToken,
      admin: sanitizeAdmin(admin),
    };
  }

  // 5. Adaptive 2FA check (Q4 & Q5)
  let isDeviceTrusted = false;
  if (context.deviceToken && !admin.enforceTwoFactor) {
    const tokenHash = crypto.createHash("sha256").update(context.deviceToken).digest("hex");
    const trustedDevice = await prisma.sysAdminTrustedDevice.findFirst({
      where: {
        adminId: admin.id,
        deviceTokenHash: tokenHash,
        expiresAt: { gt: new Date() },
      },
    });
    if (trustedDevice) {
      isDeviceTrusted = true;
      prisma.sysAdminTrustedDevice.update({
        where: { id: trustedDevice.id },
        data: { lastUsedAt: new Date() },
      }).catch(() => {});
    }
  }

  if (admin.enforceTwoFactor || !isDeviceTrusted) {
    const otp = crypto.randomInt(100000, 999999).toString();
    const twoFactorCodeHash = crypto.createHash("sha256").update(otp).digest("hex");
    const twoFactorExpiresAt = new Date(Date.now() + TWO_FACTOR_EXPIRY_MINUTES * 60 * 1000);

    await prisma.sysAdmin.update({
      where: { id: admin.id },
      data: {
        failedLoginAttempts: 0,
        twoFactorCodeHash,
        twoFactorExpiresAt,
      },
    });

    const challengeJwt = jwt.sign(
      { adminId: admin.id, purpose: "SYSADMIN_2FA" },
      JWT_SECRET,
      { expiresIn: `${TWO_FACTOR_EXPIRY_MINUTES}m` }
    );

    if (admin.email) {
      const emailTemplate = buildSysAdmin2FaOtpEmail(
        otp,
        admin.firstName || admin.username,
        TWO_FACTOR_EXPIRY_MINUTES,
        context.ipAddress,
        parseDeviceInfo(context.userAgent ?? null)
      );
      sendEmail(admin.email, emailTemplate.subject, emailTemplate.text, emailTemplate.html).catch((err) => {
        console.error("Failed to send SysAdmin 2FA email:", err);
      });
    }

    return {
      profileSetupRequired: false,
      twoFactorRequired: true,
      challengeToken: challengeJwt,
      emailMasked: maskEmail(admin.email || ""),
      admin: sanitizeAdmin(admin),
    };
  }

  // 6. Direct Authenticated Login (Device is Trusted & Profile is Complete)
  await prisma.sysAdmin.update({
    where: { id: admin.id },
    data: {
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
    },
  });

  // Strict Single-Session Invariant (Q8): Revoke all prior active sessions for this SysAdmin
  await sessionService.revokeAllSubjectSessions(admin.id, "SYSADMIN", "SYSADMIN_CONCURRENT_LOGIN_TERMINATED");

  const sessionId = crypto.randomUUID();
  const tokenPayload: TokenPayload = {
    id: admin.id,
    username: admin.username,
    email: admin.email ?? "",
    role: "SYSADMIN",
  };

  const accessToken = generateAccessToken(tokenPayload);
  const refreshToken = generateRefreshToken(tokenPayload, sessionId);

  await sessionService.createSession(
    sessionId,
    { id: admin.id, role: "SYSADMIN", subjectType: "SYSADMIN" },
    refreshToken,
    context
  );

  if (context.ipAddress) {
    await sessionService.recordLoginLog({
      userId: admin.id,
      role: "SYSADMIN",
      ipAddress: context.ipAddress,
      userAgent: context.userAgent ?? "Unknown",
      deviceInfo: null,
      status: "SUCCESS",
      sessionId,
    });
  }

  return {
    profileSetupRequired: false,
    twoFactorRequired: false,
    user: sanitizeAdmin(admin),
    accessToken,
    refreshToken,
    sessionId,
  };
}

export async function completeSysAdminProfile(
  challengeToken: string,
  input: SysAdminProfileInput,
  appOrigin?: string
) {
  const adminId = verifySetupToken(challengeToken);

  const firstName = input.firstName?.trim();
  const lastName = input.lastName?.trim();
  const middleName = input.middleName?.trim() || null;
  const nickname = input.nickname?.trim();
  const email = normalizeEmail(input.email);

  if (!firstName || !lastName || !nickname || !email) {
    throw new ServiceError(400, "First Name, Last Name, Nickname, and Email are required.");
  }

  // Check email uniqueness across tbl_sys_admin
  const existingWithEmail = await prisma.sysAdmin.findFirst({
    where: { email, id: { not: adminId } },
  });
  if (existingWithEmail) {
    throw new ServiceError(400, "This email address is already assigned to another administrator.");
  }

  // Generate 32-byte cryptographically random magic link token
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const expiresAt = new Date(Date.now() + MAGIC_LINK_EXPIRY_MINUTES * 60 * 1000);

  await prisma.sysAdmin.update({
    where: { id: adminId },
    data: {
      firstName,
      middleName,
      lastName,
      nickname,
      email,
      verificationTokenHash: tokenHash,
      verificationTokenExpiresAt: expiresAt,
    },
  });

  // Construct magic link
  const origin = appOrigin?.replace(/\/$/, "") || "https://portal.sugo-express.org";
  const verificationLink = `${origin}/sysadmin/verify-email?token=${rawToken}`;

  const displayName = nickname || firstName;
  const { subject, text, html } = buildSysAdminVerificationLinkEmail(
    verificationLink,
    displayName,
    MAGIC_LINK_EXPIRY_MINUTES
  );

  // Send verification email via SMTP
  void sendEmail(email, subject, text, html);

  return {
    message: `Verification link dispatched to ${email}.`,
    email,
    expiresAt,
    expiryMinutes: MAGIC_LINK_EXPIRY_MINUTES,
  };
}

export async function verifySysAdminMagicLink(
  rawToken: string,
  context: SessionContext = {}
) {
  if (!rawToken || typeof rawToken !== "string") {
    throw new ServiceError(400, "Verification link token is missing.");
  }

  const tokenHash = crypto.createHash("sha256").update(rawToken.trim()).digest("hex");

  const admin = await prisma.sysAdmin.findFirst({
    where: { verificationTokenHash: tokenHash },
  });

  if (!admin) {
    throw new ServiceError(400, "This verification link is invalid or has already been used.");
  }

  if (!admin.verificationTokenExpiresAt || admin.verificationTokenExpiresAt < new Date()) {
    throw new ServiceError(
      400,
      "This verification link has expired (5-minute window). Please log in to request a new link."
    );
  }

  // Activate account
  const updatedAdmin = await prisma.sysAdmin.update({
    where: { id: admin.id },
    data: {
      emailVerified: true,
      emailVerifiedAt: new Date(),
      profileCompleted: true,
      verificationTokenHash: null,
      verificationTokenExpiresAt: null,
      lastLoginAt: new Date(),
    },
  });

  // Mint session and tokens so the admin is immediately logged in
  const sessionId = crypto.randomUUID();
  const tokenPayload: TokenPayload = {
    id: updatedAdmin.id,
    username: updatedAdmin.username,
    email: updatedAdmin.email ?? "",
    role: "SYSADMIN",
  };

  const accessToken = generateAccessToken(tokenPayload);
  const refreshToken = generateRefreshToken(tokenPayload, sessionId);

  await sessionService.createSession(
    sessionId,
    { id: updatedAdmin.id, role: "SYSADMIN", subjectType: "SYSADMIN" },
    refreshToken,
    context
  );

  if (context.ipAddress) {
    await sessionService.recordLoginLog({
      userId: updatedAdmin.id,
      role: "SYSADMIN",
      ipAddress: context.ipAddress,
      userAgent: context.userAgent ?? "Unknown",
      deviceInfo: null,
      status: "SUCCESS",
      sessionId,
    });
  }

  return {
    message: "System Administrator account successfully verified!",
    user: sanitizeAdmin(updatedAdmin),
    accessToken,
    refreshToken,
    sessionId,
  };
}

export async function resendSysAdminMagicLink(challengeToken: string, appOrigin?: string) {
  const adminId = verifySetupToken(challengeToken);

  const admin = await prisma.sysAdmin.findUnique({
    where: { id: adminId },
  });

  if (!admin || !admin.email) {
    throw new ServiceError(400, "Profile information must be submitted before requesting a link.");
  }

  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const expiresAt = new Date(Date.now() + MAGIC_LINK_EXPIRY_MINUTES * 60 * 1000);

  await prisma.sysAdmin.update({
    where: { id: admin.id },
    data: {
      verificationTokenHash: tokenHash,
      verificationTokenExpiresAt: expiresAt,
    },
  });

  const origin = appOrigin?.replace(/\/$/, "") || "https://portal.sugo-express.org";
  const verificationLink = `${origin}/sysadmin/verify-email?token=${rawToken}`;
  const displayName = admin.nickname || admin.firstName || admin.username;

  const { subject, text, html } = buildSysAdminVerificationLinkEmail(
    verificationLink,
    displayName,
    MAGIC_LINK_EXPIRY_MINUTES
  );

  void sendEmail(admin.email, subject, text, html);

  return {
    message: `A fresh verification link has been sent to ${admin.email}.`,
    email: admin.email,
    expiresAt,
    expiryMinutes: MAGIC_LINK_EXPIRY_MINUTES,
  };
}

export async function getSysAdminProfile(adminId: number) {
  const admin = await prisma.sysAdmin.findUnique({
    where: { id: adminId },
  });
  if (!admin) {
    throw new ServiceError(404, "System Administrator not found.");
  }
  return sanitizeAdmin(admin);
}

// ─────────────────────────────────────────────────────────────────────────────
// Profile Change Security Gate (3-layer: password + CONFIRM text + OTP)
// ─────────────────────────────────────────────────────────────────────────────

const PROFILE_OTP_EXPIRY_MINUTES = 10;

export async function requestProfileChangeOtp(adminId: number) {
  const admin = await prisma.sysAdmin.findUnique({ where: { id: adminId } });
  if (!admin || !admin.email) {
    throw new ServiceError(400, "No email address associated with this administrator account.");
  }

  // Generate 6-digit numeric OTP
  const otp = String(Math.floor(100000 + Math.random() * 900000));
  const otpHash = crypto.createHash("sha256").update(otp).digest("hex");
  const expiresAt = new Date(Date.now() + PROFILE_OTP_EXPIRY_MINUTES * 60 * 1000);

  await prisma.sysAdmin.update({
    where: { id: adminId },
    data: {
      profileOtpHash: otpHash,
      profileOtpExpiresAt: expiresAt,
    },
  });

  const nickname = admin.nickname || admin.firstName || admin.username;
  const subject = "SUGO SysAdmin — Profile Change Verification Code";
  const text = `Hello ${nickname},\n\nYour verification code for changing your SysAdmin profile is:\n\n${otp}\n\nThis code expires in ${PROFILE_OTP_EXPIRY_MINUTES} minutes. If you did not request this, ignore this email immediately.\n\n— SUGO Express IT Security`;
  const html = `
    <div style="font-family:monospace;max-width:480px;margin:0 auto;background:#0B132B;color:#e2e8f0;padding:32px;border-radius:12px;">
      <h2 style="color:#f62459;margin:0 0 16px">Profile Change Verification</h2>
      <p>Hello <strong>${nickname}</strong>,</p>
      <p>Your one-time verification code for updating your SysAdmin profile is:</p>
      <div style="background:#0F1A30;border:2px solid #f62459;border-radius:8px;padding:20px;text-align:center;margin:24px 0;">
        <span style="font-size:36px;font-weight:bold;letter-spacing:12px;color:#ffffff;">${otp}</span>
      </div>
      <p style="color:#94a3b8;font-size:13px;">This code expires in <strong>${PROFILE_OTP_EXPIRY_MINUTES} minutes</strong>. Do not share this code with anyone.</p>
      <p style="color:#94a3b8;font-size:12px;margin-top:24px;">— SUGO Express IT Security</p>
    </div>`;

  void sendEmail(admin.email, subject, text, html);

  return {
    message: `Verification code sent to ${admin.email}.`,
    email: admin.email,
    expiresAt,
    expiryMinutes: PROFILE_OTP_EXPIRY_MINUTES,
  };
}

export async function verifyProfileChangeOtp(adminId: number, otp: string) {
  if (!otp || typeof otp !== "string") {
    throw new ServiceError(400, "Verification code is required.");
  }

  const admin = await prisma.sysAdmin.findUnique({ where: { id: adminId } });
  if (!admin) {
    throw new ServiceError(404, "System Administrator not found.");
  }

  if (!admin.profileOtpHash || !admin.profileOtpExpiresAt) {
    throw new ServiceError(400, "No active verification code. Request a new one.");
  }

  if (admin.profileOtpExpiresAt < new Date()) {
    throw new ServiceError(400, "Verification code has expired. Request a new one.");
  }

  const otpHash = crypto.createHash("sha256").update(otp.trim()).digest("hex");
  if (otpHash !== admin.profileOtpHash) {
    throw new ServiceError(400, "Invalid verification code.");
  }

  // Consume the OTP — it can only be used once
  await prisma.sysAdmin.update({
    where: { id: adminId },
    data: { profileOtpHash: null, profileOtpExpiresAt: null },
  });

  // Return a short-lived change token (5 min) that authorizes the profile update
  const changeToken = jwt.sign(
    { adminId, purpose: "SYSADMIN_PROFILE_CHANGE" },
    JWT_SECRET,
    { expiresIn: "5m" }
  );

  return { changeToken };
}

export async function updateAdminProfile(
  adminId: number,
  changeToken: string,
  currentPassword: string,
  newData: {
    username?: string;
    firstName?: string;
    lastName?: string;
    middleName?: string;
    nickname?: string;
    email?: string;
    password?: string;
  }
) {
  // 1. Verify the short-lived change token from OTP verification
  let decoded: { adminId: number; purpose: string };
  try {
    decoded = jwt.verify(changeToken, JWT_SECRET, { algorithms: ["HS256"] }) as { adminId: number; purpose: string };
  } catch {
    throw new ServiceError(401, "Profile change token is invalid or expired. Start the process again.");
  }
  if (decoded.purpose !== "SYSADMIN_PROFILE_CHANGE" || decoded.adminId !== adminId) {
    throw new ServiceError(401, "Invalid profile change authorization.");
  }

  // 2. Verify current password
  const admin = await prisma.sysAdmin.findUnique({ where: { id: adminId } });
  if (!admin) throw new ServiceError(404, "System Administrator not found.");

  const passwordValid = await bcrypt.compare(currentPassword, admin.passwordHash);
  if (!passwordValid) {
    throw new ServiceError(401, "Current password is incorrect.");
  }

  // 3. Build the update data
  const updateData: Record<string, unknown> = {};

  if (newData.username) {
    const normUsername = normalizeUsername(newData.username);
    if (normUsername.length < 3) throw new ServiceError(400, "Username must be at least 3 characters.");
    const conflict = await prisma.sysAdmin.findFirst({ where: { username: normUsername, id: { not: adminId } } });
    if (conflict) throw new ServiceError(409, "That username is already taken.");
    updateData.username = normUsername;
  }

  if (newData.firstName) updateData.firstName = newData.firstName.trim();
  if (newData.lastName) updateData.lastName = newData.lastName.trim();
  if (newData.middleName !== undefined) updateData.middleName = newData.middleName?.trim() || null;
  if (newData.nickname) updateData.nickname = newData.nickname.trim();

  if (newData.email) {
    const normEmail = normalizeEmail(newData.email);
    const conflict = await prisma.sysAdmin.findFirst({ where: { email: normEmail, id: { not: adminId } } });
    if (conflict) throw new ServiceError(409, "That email address is already used by another administrator.");
    updateData.email = normEmail;
  }

  if (newData.password) {
    if (newData.password.length < 12) {
      throw new ServiceError(400, "New administrator password must be at least 12 characters long.");
    }
    if (!/[A-Z]/.test(newData.password) || !/[a-z]/.test(newData.password) || !/[0-9]/.test(newData.password) || !/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?~`]/.test(newData.password)) {
      throw new ServiceError(400, "Password must include at least one uppercase letter, one lowercase letter, one number, and one special symbol.");
    }

    // Compare with current password
    const matchesCurrent = await bcrypt.compare(newData.password, admin.passwordHash);
    if (matchesCurrent) {
      throw new ServiceError(400, "New password must be different from your current password.");
    }

    // Check last 3 passwords in history
    const history = await prisma.sysAdminPasswordHistory.findMany({
      where: { adminId },
      orderBy: { createdAt: "desc" },
      take: 3,
    });
    for (const h of history) {
      const reused = await bcrypt.compare(newData.password, h.passwordHash);
      if (reused) {
        throw new ServiceError(400, "For security, you cannot reuse any of your last 3 passwords.");
      }
    }

    const newHash = await bcrypt.hash(newData.password, 10);
    updateData.passwordHash = newHash;

    // Record in password history
    await prisma.sysAdminPasswordHistory.create({
      data: {
        adminId,
        passwordHash: newHash,
      },
    });

    // Revoke other sessions on password change
    await sessionService.revokeAllSubjectSessions(adminId, "SYSADMIN", "SYSADMIN_PASSWORD_CHANGED");
  }

  if (Object.keys(updateData).length === 0) {
    throw new ServiceError(400, "No fields provided to update.");
  }

  const updated = await prisma.sysAdmin.update({ where: { id: adminId }, data: updateData });
  return sanitizeAdmin(updated);
}

// ─────────────────────────────────────────────────────────────────────────────
// Two-Factor Authentication & Account Lockout Security Endpoints
// ─────────────────────────────────────────────────────────────────────────────

export async function verifySysAdmin2Fa(
  challengeToken: string,
  code: string,
  trustDevice: boolean = false,
  deviceFingerprint: string = "unknown_device",
  context: SysAdminSessionContext = {}
) {
  let decoded: { adminId: number; purpose: string };
  try {
    decoded = jwt.verify(challengeToken, JWT_SECRET, { algorithms: ["HS256"] }) as { adminId: number; purpose: string };
  } catch {
    throw new ServiceError(401, "Two-factor verification session expired. Please sign in again.");
  }

  if (decoded.purpose !== "SYSADMIN_2FA" || !decoded.adminId) {
    throw new ServiceError(401, "Invalid two-factor session.");
  }

  const admin = await prisma.sysAdmin.findUnique({ where: { id: decoded.adminId } });
  if (!admin || admin.status !== "Active") {
    throw new ServiceError(403, "System Administrator account invalid or suspended.");
  }

  if (!admin.twoFactorCodeHash || !admin.twoFactorExpiresAt) {
    throw new ServiceError(400, "No pending two-factor security code. Please sign in again.");
  }

  if (admin.twoFactorExpiresAt.getTime() < Date.now()) {
    throw new ServiceError(400, "Security code has expired. Please request a new code.");
  }

  const inputHash = crypto.createHash("sha256").update(code.trim()).digest("hex");
  if (inputHash !== admin.twoFactorCodeHash) {
    throw new ServiceError(400, "Invalid 2FA security code.");
  }

  // Consume OTP and reset attempts
  await prisma.sysAdmin.update({
    where: { id: admin.id },
    data: {
      twoFactorCodeHash: null,
      twoFactorExpiresAt: null,
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
    },
  });

  // Optional: Trust this device for 30 days
  let newDeviceToken: string | null = null;
  if (trustDevice) {
    newDeviceToken = crypto.randomBytes(32).toString("hex");
    const deviceTokenHash = crypto.createHash("sha256").update(newDeviceToken).digest("hex");
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    await prisma.sysAdminTrustedDevice.create({
      data: {
        adminId: admin.id,
        deviceFingerprint: deviceFingerprint.slice(0, 128),
        deviceTokenHash,
        ipAddress: context.ipAddress?.slice(0, 45) || "127.0.0.1",
        userAgent: context.userAgent || "Unknown Browser",
        expiresAt,
      },
    });
  }

  // Strict Single-Session Invariant (Q8): Revoke all prior active sessions
  await sessionService.revokeAllSubjectSessions(admin.id, "SYSADMIN", "SYSADMIN_CONCURRENT_LOGIN_TERMINATED");

  const sessionId = crypto.randomUUID();
  const tokenPayload: TokenPayload = {
    id: admin.id,
    username: admin.username,
    email: admin.email ?? "",
    role: "SYSADMIN",
  };

  const accessToken = generateAccessToken(tokenPayload);
  const refreshToken = generateRefreshToken(tokenPayload, sessionId);

  await sessionService.createSession(
    sessionId,
    { id: admin.id, role: "SYSADMIN", subjectType: "SYSADMIN" },
    refreshToken,
    context
  );

  if (context.ipAddress) {
    await sessionService.recordLoginLog({
      userId: admin.id,
      role: "SYSADMIN",
      ipAddress: context.ipAddress,
      userAgent: context.userAgent ?? "Unknown",
      deviceInfo: null,
      status: "SUCCESS",
      sessionId,
    });
  }

  return {
    user: sanitizeAdmin(admin),
    accessToken,
    refreshToken,
    sessionId,
    deviceToken: newDeviceToken,
  };
}

export async function resendSysAdmin2Fa(
  challengeToken: string,
  context: SysAdminSessionContext = {}
) {
  let decoded: { adminId: number; purpose: string };
  try {
    decoded = jwt.verify(challengeToken, JWT_SECRET, { algorithms: ["HS256"] }) as { adminId: number; purpose: string };
  } catch {
    throw new ServiceError(401, "Two-factor session expired. Please sign in again.");
  }

  if (decoded.purpose !== "SYSADMIN_2FA" || !decoded.adminId) {
    throw new ServiceError(401, "Invalid two-factor session.");
  }

  const admin = await prisma.sysAdmin.findUnique({ where: { id: decoded.adminId } });
  if (!admin || admin.status !== "Active" || !admin.email) {
    throw new ServiceError(404, "Administrator account or email not found.");
  }

  const otp = crypto.randomInt(100000, 999999).toString();
  const twoFactorCodeHash = crypto.createHash("sha256").update(otp).digest("hex");
  const twoFactorExpiresAt = new Date(Date.now() + TWO_FACTOR_EXPIRY_MINUTES * 60 * 1000);

  await prisma.sysAdmin.update({
    where: { id: admin.id },
    data: { twoFactorCodeHash, twoFactorExpiresAt },
  });

  const emailTemplate = buildSysAdmin2FaOtpEmail(
    otp,
    admin.firstName || admin.username,
    TWO_FACTOR_EXPIRY_MINUTES,
    context.ipAddress,
    parseDeviceInfo(context.userAgent ?? null)
  );
  sendEmail(admin.email, emailTemplate.subject, emailTemplate.text, emailTemplate.html).catch((err) => {
    console.error("Failed to send SysAdmin 2FA email:", err);
  });

  return {
    message: "A new security verification code has been dispatched to your email.",
    emailMasked: maskEmail(admin.email),
  };
}

export async function unlockSysAdminAccount(rawToken: string) {
  if (!rawToken || typeof rawToken !== "string") {
    throw new ServiceError(400, "Emergency unlock token is required.");
  }

  const unlockTokenHash = crypto.createHash("sha256").update(rawToken.trim()).digest("hex");

  const admin = await prisma.sysAdmin.findFirst({
    where: {
      unlockTokenHash,
      unlockTokenExpiresAt: { gt: new Date() },
    },
  });

  if (!admin) {
    throw new ServiceError(400, "This emergency unlock link is invalid or has expired.");
  }

  await prisma.sysAdmin.update({
    where: { id: admin.id },
    data: {
      failedLoginAttempts: 0,
      lockedUntil: null,
      unlockTokenHash: null,
      unlockTokenExpiresAt: null,
    },
  });

  return {
    message: "Administrator account unlocked successfully. You may now sign in.",
    username: admin.username,
  };
}

export async function refreshSysAdminSession(
  refreshToken: string,
  context: SessionContext = {}
) {
  if (!refreshToken || typeof refreshToken !== "string") {
    throw new ServiceError(401, "Missing administrative refresh token.");
  }

  let decoded: { id: number; username: string; email: string; role: string; sid?: string };
  try {
    decoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET, { algorithms: ["HS256"] }) as any;
  } catch {
    throw new ServiceError(401, "Invalid or expired refresh token. Please sign in again.");
  }

  if (decoded.role !== "SYSADMIN" || !decoded.sid) {
    throw new ServiceError(401, "Invalid administrative session token.");
  }

  const tokenPayload: TokenPayload = {
    id: decoded.id,
    username: decoded.username,
    email: decoded.email,
    role: "SYSADMIN",
  };

  const { outcome, refreshToken: newRefreshToken } = await sessionService.rotateSession(
    decoded.sid,
    refreshToken,
    () => generateRefreshToken(tokenPayload, decoded.sid!),
    context
  );

  const newAccessToken = generateAccessToken(tokenPayload);
  const profile = await prisma.sysAdmin.findUnique({ where: { id: decoded.id } });

  return {
    accessToken: newAccessToken,
    refreshToken: newRefreshToken,
    user: profile ? sanitizeAdmin(profile) : null,
  };
}

export async function toggleSysAdminTwoFactor(
  adminId: number,
  enforceTwoFactor: boolean,
  stepUpPassword: string
) {
  const admin = await prisma.sysAdmin.findUnique({ where: { id: adminId } });
  if (!admin) throw new ServiceError(404, "System Administrator not found.");

  const valid = await bcrypt.compare(stepUpPassword, admin.passwordHash);
  if (!valid) throw new ServiceError(403, "Step-up re-authentication failed: incorrect password.");

  const updated = await prisma.sysAdmin.update({
    where: { id: adminId },
    data: { enforceTwoFactor },
  });

  return {
    message: enforceTwoFactor
      ? "Two-Factor Authentication is now enforced on every sign-in."
      : "Adaptive Two-Factor Authentication is active (OTP required only on unrecognized devices).",
    enforceTwoFactor: updated.enforceTwoFactor,
  };
}

export async function listSysAdminTrustedDevices(adminId: number) {
  const devices = await prisma.sysAdminTrustedDevice.findMany({
    where: {
      adminId,
      expiresAt: { gt: new Date() },
    },
    orderBy: { lastUsedAt: "desc" },
  });

  return devices.map((d) => ({
    id: d.id,
    deviceFingerprint: d.deviceFingerprint,
    ipAddress: d.ipAddress,
    deviceInfo: parseDeviceInfo(d.userAgent),
    lastUsedAt: d.lastUsedAt,
    expiresAt: d.expiresAt,
    createdAt: d.createdAt,
  }));
}

export async function revokeSysAdminTrustedDevice(adminId: number, deviceId: string) {
  const deleted = await prisma.sysAdminTrustedDevice.deleteMany({
    where: { id: deviceId, adminId },
  });
  if (deleted.count === 0) {
    throw new ServiceError(404, "Trusted device not found.");
  }
  return { message: "Trusted device revoked successfully." };
}

export async function verifySysAdminStepUpPassword(adminId: number, stepUpPassword: string): Promise<boolean> {
  const admin = await prisma.sysAdmin.findUnique({
    where: { id: adminId },
    select: { passwordHash: true, status: true },
  });
  if (!admin || admin.status !== "Active") return false;
  return bcrypt.compare(stepUpPassword, admin.passwordHash);
}

