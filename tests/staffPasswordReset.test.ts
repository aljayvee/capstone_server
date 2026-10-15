import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  userFindFirst,
  userFindMany,
  userFindUnique,
  userUpdate,
  createAttempt,
  isIpThrottled,
  findLatestActiveForUser,
  consumeAllForUser,
  createCode,
  incrementAttempts,
  markConsumed,
  sendEmail,
  verifyFirebaseIdToken,
  revokeAllForSubject,
  createAudit,
} = vi.hoisted(() => ({
  userFindFirst: vi.fn(),
  userFindMany: vi.fn(),
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
  createAttempt: vi.fn(),
  isIpThrottled: vi.fn(),
  findLatestActiveForUser: vi.fn(),
  consumeAllForUser: vi.fn(),
  createCode: vi.fn(),
  incrementAttempts: vi.fn(),
  markConsumed: vi.fn(),
  sendEmail: vi.fn(),
  verifyFirebaseIdToken: vi.fn(),
  revokeAllForSubject: vi.fn(),
  createAudit: vi.fn(),
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    user: { findFirst: userFindFirst, findMany: userFindMany, findUnique: userFindUnique, update: userUpdate },
  },
}));
vi.mock("../src/repositories/passwordResetRepository.js", () => ({
  passwordResetRepository: { create: createAttempt },
}));
vi.mock("../src/services/passwordResetService.js", () => ({ isIpThrottled }));
vi.mock("../src/repositories/emailVerificationRepository.js", () => ({
  emailVerificationRepository: {
    findLatestActiveForUser,
    consumeAllForUser,
    create: createCode,
    incrementAttempts,
    markConsumed,
  },
}));
vi.mock("../src/repositories/accountAuditRepository.js", () => ({
  accountAuditRepository: { create: createAudit },
}));
vi.mock("../src/lib/mailer.js", () => ({ sendEmail }));
vi.mock("../src/lib/firebaseAdmin.js", () => ({ verifyFirebaseIdToken }));
// complete() signs every device out. Unmocked, that is a real updateMany on
// user_sessions against whichever database is configured.
vi.mock("../src/services/sessionService.js", () => ({ revokeAllForSubject }));

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import * as staffReset from "../src/services/staffPasswordResetService.js";
import { JWT_PASSWORD_RESET_SECRET } from "../src/config/env.js";

const CTX = { ipAddress: "203.0.113.9", userAgent: "vitest" };

const MARIA = {
  id: 7,
  username: "dispatcher_maria",
  firstName: "Maria",
  middleName: null,
  lastName: "Santos",
  email: "maria.santos@sugo-express.org",
  phone: "09171234567",
  role: "DISPATCHER",
  status: "Active",
  emailVerified: true,
  phoneVerified: true,
  passwordHash: "$2a$10$originalhashvalueoriginalhashvalue",
};

const RIDER = { ...MARIA, id: 8, username: "rider_juan", role: "RIDER", phone: "09998887777" };

const lastOutcome = () => createAttempt.mock.calls.at(-1)?.[0].outcome;
const lastIdentifier = () => createAttempt.mock.calls.at(-1)?.[0].identifier;

async function sessionFor(user = MARIA) {
  userFindFirst.mockResolvedValueOnce(user);
  const found = await staffReset.findAccount(user.email, undefined, CTX);
  userFindUnique.mockResolvedValue(user);
  return found.resetSessionToken;
}

beforeEach(() => {
  vi.clearAllMocks();
  createAttempt.mockResolvedValue({});
  isIpThrottled.mockResolvedValue(false);
  // Only Maria holds her number unless a test says otherwise.
  userFindMany.mockImplementation(async ({ where }: any) =>
    where?.id ? [{ phone: RIDER.phone }] : [MARIA]
  );
  findLatestActiveForUser.mockResolvedValue(null);
  consumeAllForUser.mockResolvedValue({});
  createCode.mockResolvedValue({ id: 501 });
  sendEmail.mockResolvedValue(true);
  revokeAllForSubject.mockResolvedValue(2);
  createAudit.mockResolvedValue({});
  userUpdate.mockResolvedValue({});
});

describe("findAccount", () => {
  it("finds a portal account by email and shows its full name and verified channels", async () => {
    userFindFirst.mockResolvedValueOnce(MARIA);

    const found = await staffReset.findAccount("Maria.Santos@sugo-express.org", undefined, CTX);

    expect(found.fullName).toBe("Maria Santos");
    expect(found.maskedEmail).toBe("ma******@sugo-express.org");
    expect(found.maskedPhone).toBe("0*** *** 4567");
    expect(found.resetSessionToken).toEqual(expect.any(String));
    expect(lastOutcome()).toBe("ACCOUNT_FOUND");
    expect(lastIdentifier()).toBe("staff:#7");
  });

  it("finds a portal account by mobile number in any common format", async () => {
    const found = await staffReset.findAccount("+63 917 123 4567", undefined, CTX);
    expect(found.fullName).toBe("Maria Santos");
  });

  it("never returns the phone number itself", async () => {
    userFindFirst.mockResolvedValueOnce(MARIA);
    const found = await staffReset.findAccount(MARIA.email, undefined, CTX);
    expect(JSON.stringify(found)).not.toContain("1234567");
  });

  it("does not find riders, and logs the miss with what was typed", async () => {
    userFindFirst.mockResolvedValueOnce(RIDER);
    await expect(staffReset.findAccount(RIDER.email, undefined, CTX)).rejects.toMatchObject({ status: 404 });
    expect(lastOutcome()).toBe("UNKNOWN_ACCOUNT");
    expect(lastIdentifier()).toBe(`staff:${RIDER.email}`);
  });

  it("does not find a deactivated account", async () => {
    userFindFirst.mockResolvedValueOnce({ ...MARIA, status: "Inactive" });
    await expect(staffReset.findAccount(MARIA.email, undefined, CTX)).rejects.toMatchObject({ status: 404 });
  });

  it("refuses a number two portal accounts share", async () => {
    userFindMany.mockResolvedValueOnce([MARIA, { ...MARIA, id: 9 }]);
    await expect(staffReset.findAccount("09171234567", undefined, CTX)).rejects.toMatchObject({ status: 409 });
  });

  it("asks for an email or a full mobile number when given neither", async () => {
    await expect(staffReset.findAccount("maria", undefined, CTX)).rejects.toMatchObject({ status: 400 });
  });

  it("answers a filled honeypot like a miss", async () => {
    await expect(staffReset.findAccount(MARIA.email, "http://spam", CTX)).rejects.toMatchObject({ status: 404 });
    expect(lastOutcome()).toBe("HONEYPOT");
    expect(userFindFirst).not.toHaveBeenCalled();
  });

  it("stops a throttled IP before looking anything up", async () => {
    isIpThrottled.mockResolvedValueOnce(true);
    await expect(staffReset.findAccount(MARIA.email, undefined, CTX)).rejects.toMatchObject({ status: 429 });
    expect(userFindFirst).not.toHaveBeenCalled();
  });

  it("offers only channels that are verified", async () => {
    userFindFirst.mockResolvedValueOnce({ ...MARIA, emailVerified: false, phoneVerified: false });
    const found = await staffReset.findAccount(MARIA.email, undefined, CTX);
    expect(found.maskedEmail).toBeNull();
    expect(found.maskedPhone).toBeNull();
  });

  it("does not offer SMS when another account uses the same number", async () => {
    userFindFirst.mockResolvedValueOnce(MARIA);
    userFindMany.mockResolvedValueOnce([{ phone: "+639171234567" }]);
    const found = await staffReset.findAccount(MARIA.email, undefined, CTX);
    expect(found.maskedPhone).toBeNull();
  });
});

describe("sendCode", () => {
  it("emails a 6-digit code to the verified address", async () => {
    const token = await sessionFor();

    const result = await staffReset.sendCode(token, "EMAIL", CTX);

    expect(result).toMatchObject({ channel: "EMAIL", maskedEmail: "ma******@sugo-express.org" });
    expect(createCode).toHaveBeenCalledWith(expect.objectContaining({ userId: 7 }));
    const [to, subject, text] = sendEmail.mock.calls[0];
    expect(to).toBe(MARIA.email);
    expect(subject).toBe("Your Sugo Express password reset code");
    expect(text).toMatch(/password reset code is: \d{6}/);
    expect(text).toContain("203.0.113.9");
  });

  it("holds a resend inside the cooldown and leaves the live code alone", async () => {
    const token = await sessionFor();
    findLatestActiveForUser.mockResolvedValueOnce({ createdAt: new Date(Date.now() - 20_000) });

    await expect(staffReset.sendCode(token, "EMAIL", CTX)).rejects.toMatchObject({
      status: 429,
      details: { code: "RESEND_COOLDOWN" },
    });
    expect(consumeAllForUser).not.toHaveBeenCalled();
  });

  it("retires the code and reports 503 when the email cannot be sent", async () => {
    const token = await sessionFor();
    sendEmail.mockResolvedValueOnce(false);
    await expect(staffReset.sendCode(token, "EMAIL", CTX)).rejects.toMatchObject({ status: 503 });
    expect(markConsumed).toHaveBeenCalledWith(501);
  });

  it("for SMS, sends no code but warns the mailbox that a reset started", async () => {
    const token = await sessionFor();

    const result = await staffReset.sendCode(token, "SMS", CTX);

    expect(result).toEqual({ channel: "SMS", maskedPhone: "0*** *** 4567" });
    expect(createCode).not.toHaveBeenCalled();
    const [to, subject, text] = sendEmail.mock.calls[0];
    expect(to).toBe(MARIA.email);
    expect(subject).toBe("A password reset was started on your Sugo Express account");
    expect(text).toContain("SMS to 0*** *** 4567");
  });

  it("refuses a channel the account has not verified", async () => {
    const token = await sessionFor({ ...MARIA, phoneVerified: false });
    await expect(staffReset.sendCode(token, "SMS", CTX)).rejects.toMatchObject({ status: 400 });
  });

  it("refuses a session token whose account changed since it was issued", async () => {
    const token = await sessionFor();
    userFindUnique.mockResolvedValue({ ...MARIA, email: "new@sugo-express.org" });
    await expect(staffReset.sendCode(token, "EMAIL", CTX)).rejects.toMatchObject({ status: 400 });
  });
});

describe("verify", () => {
  it("trades a correct email code for a reset token", async () => {
    const token = await sessionFor();
    findLatestActiveForUser.mockResolvedValueOnce({
      id: 501,
      codeHash: await bcrypt.hash("123456", 4),
      expiresAt: new Date(Date.now() + 60_000),
      attempts: 0,
    });

    const { resetToken } = await staffReset.verify(token, { code: "123456" }, CTX);

    expect(markConsumed).toHaveBeenCalledWith(501);
    expect(jwt.verify(resetToken, JWT_PASSWORD_RESET_SECRET)).toMatchObject({
      id: 7,
      purpose: "STAFF_PASSWORD_RESET",
      via: "EMAIL",
    });
  });

  it("counts a wrong code against the attempt limit", async () => {
    const token = await sessionFor();
    findLatestActiveForUser.mockResolvedValueOnce({
      id: 501,
      codeHash: await bcrypt.hash("123456", 4),
      expiresAt: new Date(Date.now() + 60_000),
      attempts: 0,
    });
    await expect(staffReset.verify(token, { code: "654321" }, CTX)).rejects.toMatchObject({ status: 400 });
    expect(incrementAttempts).toHaveBeenCalledWith(501);
  });

  it("accepts an SMS proof only for the number on the account", async () => {
    const token = await sessionFor();
    verifyFirebaseIdToken.mockResolvedValueOnce({ uid: "x", phoneNumber: "+639171234567" });
    const { resetToken } = await staffReset.verify(token, { firebaseIdToken: "fb" }, CTX);
    expect(jwt.decode(resetToken)).toMatchObject({ via: "SMS" });

    verifyFirebaseIdToken.mockResolvedValueOnce({ uid: "y", phoneNumber: "+639998887777" });
    await expect(staffReset.verify(token, { firebaseIdToken: "fb2" }, CTX)).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe("complete", () => {
  async function verifiedResetToken(user = MARIA) {
    const token = await sessionFor(user);
    findLatestActiveForUser.mockResolvedValueOnce({
      id: 501,
      codeHash: await bcrypt.hash("123456", 4),
      expiresAt: new Date(Date.now() + 60_000),
      attempts: 0,
    });
    return (await staffReset.verify(token, { code: "123456" }, CTX)).resetToken;
  }

  it("sets the new password, signs every device out and records the reset", async () => {
    const resetToken = await verifiedResetToken();

    const result = await staffReset.complete(resetToken, "N3w!Passw0rd", CTX);

    expect(result).toEqual({ userId: 7, revokedSessions: 2 });
    const { data } = userUpdate.mock.calls[0][0];
    expect(await bcrypt.compare("N3w!Passw0rd", data.passwordHash)).toBe(true);
    expect(revokeAllForSubject).toHaveBeenCalledWith("USER", 7, "PASSWORD_RESET");
    expect(createAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 7,
        fieldModified: "password",
        newValue: "RESET",
        verifiedVia: "EMAIL_OTP",
        ipAddress: "203.0.113.9",
      })
    );
  });

  it("cannot be replayed once the password has changed", async () => {
    const resetToken = await verifiedResetToken();
    userFindUnique.mockResolvedValue({ ...MARIA, passwordHash: "$2a$10$somethingelseentirely" });
    await expect(staffReset.complete(resetToken, "N3w!Passw0rd", CTX)).rejects.toMatchObject({ status: 400 });
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("refuses the current password", async () => {
    const current = { ...MARIA, passwordHash: await bcrypt.hash("Same!Passw0rd", 4) };
    const resetToken = await verifiedResetToken(current);
    await expect(staffReset.complete(resetToken, "Same!Passw0rd", CTX)).rejects.toMatchObject({ status: 400 });
  });

  it("does not accept the step-1 session token in place of a reset token", async () => {
    const sessionToken = await sessionFor();
    await expect(staffReset.complete(sessionToken, "N3w!Passw0rd", CTX)).rejects.toMatchObject({ status: 400 });
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("does not accept a correctly signed token that carries no credential stamp", async () => {
    userFindUnique.mockResolvedValue(MARIA);
    const forged = jwt.sign({ id: 7, purpose: "STAFF_PASSWORD_RESET", via: "EMAIL" }, JWT_PASSWORD_RESET_SECRET);
    await expect(staffReset.complete(forged, "N3w!Passw0rd", CTX)).rejects.toMatchObject({ status: 400 });
    expect(userUpdate).not.toHaveBeenCalled();
  });
});
