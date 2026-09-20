import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma.js";
import { ServiceError } from "./ServiceError.js";
import { JWT_SECRET, JWT_EXPIRES_IN } from "../config/env.js";
import * as sessionService from "./sessionService.js";
import { normalizeUsername, normalizeEmail } from "../lib/identity.js";
import { sendEmail } from "../lib/mailer.js";
import { buildSysAdminVerificationLinkEmail } from "../lib/emailTemplates.js";
import { generateAccessToken, generateRefreshToken } from "./authService.js";
import type { TokenPayload } from "../middleware/auth.js";
import type { SessionContext } from "./sessionService.js";

const MAGIC_LINK_EXPIRY_MINUTES = 5;

export interface SysAdminProfileInput {
  firstName: string;
  lastName: string;
  middleName?: string;
  nickname: string;
  email: string;
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
    lastLoginAt: admin.lastLoginAt,
    createdAt: admin.createdAt,
  };
}

export function generateSetupToken(adminId: number): string {
  return jwt.sign({ adminId, purpose: "SYSADMIN_SETUP" }, JWT_SECRET, { expiresIn: "1h" });
}

export function verifySetupToken(token: string): number {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { adminId: number; purpose: string };
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
  context: SessionContext = {}
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

  const isPasswordValid = await bcrypt.compare(passwordInput, admin.passwordHash);
  if (!isPasswordValid) {
    throw new ServiceError(401, "Invalid administrative credentials.");
  }

  if (admin.status !== "Active") {
    throw new ServiceError(403, "System Administrator account has been suspended or deactivated.");
  }

  // If profile is not completed or email is not verified, require the Setup Wizard
  if (!admin.profileCompleted || !admin.emailVerified) {
    const challengeToken = generateSetupToken(admin.id);
    return {
      profileSetupRequired: true,
      challengeToken,
      admin: sanitizeAdmin(admin),
    };
  }

  // Full authenticated login
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

  await prisma.sysAdmin.update({
    where: { id: admin.id },
    data: { lastLoginAt: new Date() },
  });

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
  const origin = appOrigin?.replace(/\/$/, "") || "https://sugo-express.org";
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

  const origin = appOrigin?.replace(/\/$/, "") || "https://sugo-express.org";
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
    decoded = jwt.verify(changeToken, JWT_SECRET) as { adminId: number; purpose: string };
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
    if (newData.password.length < 8) throw new ServiceError(400, "New password must be at least 8 characters.");
    updateData.passwordHash = await bcrypt.hash(newData.password, 10);
  }

  if (Object.keys(updateData).length === 0) {
    throw new ServiceError(400, "No fields provided to update.");
  }

  const updated = await prisma.sysAdmin.update({ where: { id: adminId }, data: updateData });
  return sanitizeAdmin(updated);
}
