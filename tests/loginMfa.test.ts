import { beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

/**
 * MFA on every sign-in (2026-11-03). After the password (or Google) the server
 * asks for a second factor on a device that has not passed one recently: an SMS
 * code checked by Firebase Phone Auth, or an email code. A passed factor trusts
 * the device for MFA_TRUST_DAYS.
 *
 * Prisma is replaced by an in-memory table pair, so mfaTrustService and the
 * insert-only blocklist claim run for real.
 */

const h = vi.hoisted(() => {
  type Row = Record<string, any>;
  const trusted: Row[] = [];
  const blocklist = new Map<string, Row>();
  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([key, value]) => {
      if (key === "NOT") return !matches(row, value);
      if (key === "OR") return (value as Row[]).some((clause) => matches(row, clause));
      if (value && typeof value === "object" && "in" in value) return (value.in as unknown[]).includes(row[key]);
      if (value && typeof value === "object" && "gt" in value) return row[key] > value.gt;
      if (value && typeof value === "object" && "not" in value) return row[key] !== null && row[key] !== value.not;
      return row[key] === value;
    });
  let nextId = 1;
  const prisma = {
    mfaTrustedDevice: {
      findUnique: vi.fn(async ({ where }: Row) => trusted.find((row) => row.tokenHash === where.tokenHash) ?? null),
      findMany: vi.fn(async ({ where }: Row) => trusted.filter((row) => matches(row, where))),
      create: vi.fn(async ({ data }: Row) => {
        const row = { id: nextId++, revokedAt: null, lastUsedAt: new Date(), createdAt: new Date(), ...data };
        trusted.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: Row) => Object.assign(trusted.find((row) => row.id === where.id)!, data)),
      updateMany: vi.fn(async ({ where, data }: Row) => {
        const hit = trusted.filter((row) => matches(row, where));
        hit.forEach((row) => Object.assign(row, data));
        return { count: hit.length };
      }),
    },
    tokenBlocklist: {
      findUnique: vi.fn(async ({ where }: Row) => blocklist.get(where.token) ?? null),
      create: vi.fn(async ({ data }: Row) => {
        if (blocklist.has(data.token)) throw Object.assign(new Error("Unique constraint"), { code: "P2002" });
        blocklist.set(data.token, data);
        return data;
      }),
      upsert: vi.fn(async ({ where, create }: Row) => {
        if (!blocklist.has(where.token)) blocklist.set(where.token, create);
        return blocklist.get(where.token);
      }),
    },
  };
  return {
    trusted,
    blocklist,
    prisma,
    enforced: new Set<string>(),
    findUserById: vi.fn(),
    findUserByIdentifier: vi.fn(),
    markPhoneVerified: vi.fn(async () => undefined),
    markEmailVerified: vi.fn(async () => undefined),
    findCustomerById: vi.fn(),
    findCustomerByIdentifier: vi.fn(),
    findCustomerByGoogleId: vi.fn(),
    findCustomerByEmail: vi.fn(),
    updateCustomer: vi.fn(async () => undefined),
    markCustomerEmailVerified: vi.fn(async () => undefined),
    findAllByPhone: vi.fn(async () => []),
    issueLoginOtp: vi.fn(async () => undefined),
    verifyLoginOtp: vi.fn(async () => undefined),
    verifyCustomerLoginOtp: vi.fn(async () => undefined),
    resendLoginOtp: vi.fn(async () => undefined),
    resendCustomerLoginOtp: vi.fn(async () => undefined),
    verifyFirebaseIdToken: vi.fn(),
  };
});

vi.mock("../src/lib/prisma.js", () => ({ prisma: h.prisma }));
vi.mock("../src/config/env.js", async (orig) => ({
  ...(await orig<typeof import("../src/config/env.js")>()),
  MFA_ENFORCED_AUDIENCES: h.enforced,
}));
vi.mock("../src/repositories/userRepository.js", () => ({
  userRepository: {
    findById: h.findUserById,
    findByIdentifier: h.findUserByIdentifier,
    markPhoneVerified: h.markPhoneVerified,
    markEmailVerified: h.markEmailVerified,
  },
}));
vi.mock("../src/repositories/customerRepository.js", () => ({
  customerRepository: {
    findById: h.findCustomerById,
    findByIdentifier: h.findCustomerByIdentifier,
    findByGoogleId: h.findCustomerByGoogleId,
    findByEmail: h.findCustomerByEmail,
    findAllByPhone: h.findAllByPhone,
    update: h.updateCustomer,
    markEmailVerified: h.markCustomerEmailVerified,
  },
}));
vi.mock("../src/services/staffVerificationService.js", () => ({
  issueLoginOtp: h.issueLoginOtp,
  verifyLoginOtp: h.verifyLoginOtp,
  verifyCustomerLoginOtp: h.verifyCustomerLoginOtp,
  resendLoginOtp: h.resendLoginOtp,
  resendCustomerLoginOtp: h.resendCustomerLoginOtp,
}));
vi.mock("../src/lib/firebaseAdmin.js", () => ({ verifyFirebaseIdToken: h.verifyFirebaseIdToken }));
vi.mock("../src/services/riderPresenceService.js", () => ({ openLoginSession: vi.fn(async () => undefined) }));

import {
  canonicalPhone,
  completeLoginOtp,
  loginCustomer,
  loginCustomerWithGoogle,
  loginGeneral,
  loginRider,
  resendLoginOtp,
} from "../src/services/authService.js";
import * as mfaTrustService from "../src/services/mfaTrustService.js";
import { evaluateGate } from "../src/services/loginChallengeService.js";

const PASSWORD_HASH = bcrypt.hashSync("right-password", 4);
const DEVICE = { deviceId: "device-a", userAgent: "vitest" };
const CAPABLE = { capable: true, trustTokens: [] as string[], deviceId: "device-a" };
const LEGACY = { capable: false, trustTokens: [] as string[], deviceId: "device-a" };

function staff(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    username: "qa_dispatcher",
    email: "qa@example.com",
    phone: "0917 123 4567",
    passwordHash: PASSWORD_HASH,
    role: "DISPATCHER",
    status: "Active",
    firstName: "Qa",
    lastName: "Dispatcher",
    profileCompleted: true,
    emailVerified: true,
    phoneVerified: true,
    ...overrides,
  };
}

function customer(overrides: Record<string, unknown> = {}) {
  return {
    id: 7, // same number as the staff row on purpose: ids collide across tables
    username: "ana",
    email: "ana@example.com",
    passwordHash: PASSWORD_HASH,
    googleId: null,
    status: "Active",
    emailVerified: true,
    phoneVerified: false,
    information: { firstName: "Ana", lastName: "Cruz", phone: "+639181112222", phoneVerified: false },
    ...overrides,
  };
}

function smsToken(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    uid: "phone-uid",
    phoneNumber: "+639171234567",
    signInProvider: "phone",
    authTime: now,
    issuedAt: now,
    expiresAt: now + 3600,
    ...overrides,
  };
}

async function staffChallenge(row = staff()) {
  h.findUserByIdentifier.mockResolvedValue(row);
  h.findUserById.mockResolvedValue(row);
  const outcome = await loginGeneral("qa_dispatcher", "right-password", CAPABLE);
  if (outcome.kind !== "CHALLENGE") throw new Error("expected a challenge");
  return outcome.challenge;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.trusted.length = 0;
  h.blocklist.clear();
  h.enforced.clear();
});

describe("the gate", () => {
  const verified = { profileCompleted: true, emailVerified: true, phoneVerified: false, email: "a@b.c", phone: "" };

  it("lets a verified account through while MFA is off", () => {
    expect(evaluateGate(verified)).toBeNull();
  });

  it("asks an untrusted device once MFA is on, and not a trusted one", () => {
    expect(evaluateGate(verified, { enforced: true, trusted: false })).toBe("OTP");
    expect(evaluateGate(verified, { enforced: true, trusted: true })).toBeNull();
  });

  it("keeps the first-sign-in check whatever the MFA state", () => {
    const fresh = { ...verified, emailVerified: false };
    expect(evaluateGate(fresh, { enforced: false, trusted: false })).toBe("OTP");
    expect(evaluateGate(fresh, { enforced: true, trusted: true })).toBe("OTP");
  });
});

describe("staff sign-in", () => {
  it("signs a verified dispatcher straight in while WEB_PORTAL is not enforced", async () => {
    h.findUserByIdentifier.mockResolvedValue(staff());
    const outcome = await loginGeneral("qa_dispatcher", "right-password", CAPABLE);
    expect(outcome.kind).toBe("AUTHENTICATED");
    expect(h.prisma.mfaTrustedDevice.findMany).not.toHaveBeenCalled();
  });

  it("challenges with both factors and never sends the full number", async () => {
    h.enforced.add("WEB_PORTAL");
    const challenge = await staffChallenge();
    expect(challenge).toMatchObject({
      step: "OTP",
      reason: "NEW_DEVICE",
      factors: ["SMS", "EMAIL"],
      phoneHint: "4567",
      role: "DISPATCHER",
    });
    expect(JSON.stringify(challenge)).not.toContain("1234567");
    // A capable client asks for the email when the person picks it.
    expect(h.issueLoginOtp).not.toHaveBeenCalled();
  });

  it("still emails the code at once to a client built before MFA", async () => {
    h.enforced.add("WEB_PORTAL");
    h.findUserByIdentifier.mockResolvedValue(staff());
    const outcome = await loginGeneral("qa_dispatcher", "right-password", LEGACY);
    expect(outcome.kind).toBe("CHALLENGE");
    expect(h.issueLoginOtp).toHaveBeenCalledWith(7, "qa@example.com", "Qa Dispatcher");
  });

  it("does not offer email to an account with none", async () => {
    h.enforced.add("RIDER_APP");
    const row = staff({ role: "RIDER", email: "" });
    h.findUserByIdentifier.mockResolvedValue(row);
    const outcome = await loginRider("qa_rider", "right-password", LEGACY);
    expect(outcome.kind === "CHALLENGE" && outcome.challenge.factors).toEqual(["SMS"]);
    expect(h.issueLoginOtp).not.toHaveBeenCalled();
  });

  it("trusts the device after an SMS code, and skips the challenge next time", async () => {
    h.enforced.add("WEB_PORTAL");
    const challenge = await staffChallenge();
    h.verifyFirebaseIdToken.mockResolvedValue(smsToken());

    const done = await completeLoginOtp(challenge.challengeToken, undefined, "firebase-id-token", DEVICE);
    expect(done.result.role).toBe("DISPATCHER");
    expect(done.trustToken).toMatch(/^[\w-]{40,}$/);

    const again = await loginGeneral("qa_dispatcher", "right-password", { ...CAPABLE, trustTokens: [done.trustToken] });
    expect(again.kind).toBe("AUTHENTICATED");
  });

  it("trusts the device after an email code", async () => {
    h.enforced.add("WEB_PORTAL");
    const challenge = await staffChallenge();
    const done = await completeLoginOtp(challenge.challengeToken, "123456", undefined, DEVICE);
    expect(h.verifyLoginOtp).toHaveBeenCalledWith(7, "123456");
    expect(h.trusted[0]).toMatchObject({ subjectType: "USER", subjectId: 7, method: "EMAIL", deviceId: "device-a" });
    expect(done.trustToken).toBeTruthy();
  });

  it("lets only one of two concurrent verifications of a challenge end in a session", async () => {
    h.enforced.add("WEB_PORTAL");
    const challenge = await staffChallenge();
    h.verifyFirebaseIdToken.mockResolvedValue(smsToken());

    const results = await Promise.allSettled([
      completeLoginOtp(challenge.challengeToken, "123456", undefined, DEVICE),
      completeLoginOtp(challenge.challengeToken, undefined, "firebase-id-token", DEVICE),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { status: 401 } });
  });

  it("refuses a completed challenge presented again", async () => {
    h.enforced.add("WEB_PORTAL");
    const challenge = await staffChallenge();
    await completeLoginOtp(challenge.challengeToken, "123456", undefined, DEVICE);
    await expect(completeLoginOtp(challenge.challengeToken, "123456", undefined, DEVICE)).rejects.toMatchObject({
      status: 401,
    });
  });

  it("resend sends the email and hands back a fresh challenge", async () => {
    h.enforced.add("WEB_PORTAL");
    const challenge = await staffChallenge();
    const next = await resendLoginOtp(challenge.challengeToken);
    expect(h.resendLoginOtp).toHaveBeenCalledWith(7, "qa@example.com", "Qa Dispatcher");
    expect(next.challengeToken).not.toBe(challenge.challengeToken);
    expect(next.reason).toBe("NEW_DEVICE");
    await expect(resendLoginOtp(challenge.challengeToken)).rejects.toMatchObject({ status: 401 });
  });
});

describe("the SMS proof", () => {
  beforeEach(() => h.enforced.add("WEB_PORTAL"));

  it("refuses a token from a sign-in that was not by phone", async () => {
    const challenge = await staffChallenge();
    h.verifyFirebaseIdToken.mockResolvedValue(smsToken({ signInProvider: "google.com" }));
    await expect(completeLoginOtp(challenge.challengeToken, undefined, "t", DEVICE)).rejects.toMatchObject({ status: 400 });
  });

  it("refuses a phone sign-in from before the challenge", async () => {
    const challenge = await staffChallenge();
    const longAgo = Math.floor(Date.now() / 1000) - 600;
    h.verifyFirebaseIdToken.mockResolvedValue(smsToken({ authTime: longAgo }));
    await expect(completeLoginOtp(challenge.challengeToken, undefined, "t", DEVICE)).rejects.toMatchObject({ status: 400 });
  });

  it("refuses another number, even one ending in the same ten digits", async () => {
    const challenge = await staffChallenge();
    h.verifyFirebaseIdToken.mockResolvedValue(smsToken({ phoneNumber: "+19171234567" }));
    await expect(completeLoginOtp(challenge.challengeToken, undefined, "t", DEVICE)).rejects.toMatchObject({ status: 400 });
  });

  it("refuses an SMS token that already answered a challenge", async () => {
    h.verifyFirebaseIdToken.mockResolvedValue(smsToken());
    const first = await staffChallenge();
    await completeLoginOtp(first.challengeToken, undefined, "same-token", DEVICE);

    const second = await staffChallenge();
    await expect(completeLoginOtp(second.challengeToken, undefined, "same-token", DEVICE)).rejects.toMatchObject({
      status: 401,
    });
  });

  it("canonicalises Philippine numbers before comparing", () => {
    expect(canonicalPhone("0917 123 4567")).toBe("+639171234567");
    expect(canonicalPhone("639171234567")).toBe("+639171234567");
    expect(canonicalPhone("9171234567")).toBe("+639171234567");
    expect(canonicalPhone("+63 917 123 4567")).toBe("+639171234567");
  });
});

describe("trusted devices", () => {
  const subject = { type: "USER" as const, id: 7 };
  const source = { passwordHash: "hash", status: "Active", email: "qa@example.com", phone: "09171234567" };
  const ctx = { deviceId: "device-a", userAgent: null, method: "SMS" as const };

  it("ends trust when the password changes", async () => {
    const token = await mfaTrustService.issue(subject, source, ctx);
    expect(await mfaTrustService.isTrusted(subject, token, "device-a", source)).toBe(true);
    expect(await mfaTrustService.isTrusted(subject, token, "device-a", { ...source, passwordHash: "new" })).toBe(false);
  });

  it("refuses the token on another device, another account, or after expiry", async () => {
    const token = await mfaTrustService.issue(subject, source, ctx);
    expect(await mfaTrustService.isTrusted(subject, token, "device-b", source)).toBe(false);
    expect(await mfaTrustService.isTrusted({ type: "CUSTOMER", id: 7 }, token, "device-a", source)).toBe(false);
    h.trusted[0].expiresAt = new Date(Date.now() - 1000);
    expect(await mfaTrustService.isTrusted(subject, token, "device-a", source)).toBe(false);
  });

  it("forgets the other devices but keeps the caller's, the web's included", async () => {
    const mine = await mfaTrustService.issue(subject, source, ctx);
    const phone = await mfaTrustService.issue(subject, source, { ...ctx, deviceId: "device-b" });
    const web = await mfaTrustService.issue(subject, source, { ...ctx, deviceId: null });

    expect(await mfaTrustService.revokeOthers(subject, { deviceId: "device-a" })).toBe(2);
    expect(await mfaTrustService.isTrusted(subject, mine, "device-a", source)).toBe(true);
    expect(await mfaTrustService.isTrusted(subject, phone, "device-b", source)).toBe(false);
    expect(await mfaTrustService.isTrusted(subject, web, null, source)).toBe(false);
  });

  it("replaces a device's earlier trust when it is trusted again", async () => {
    const first = await mfaTrustService.issue(subject, source, ctx);
    const second = await mfaTrustService.issue(subject, source, ctx);
    expect(await mfaTrustService.isTrusted(subject, first, "device-a", source)).toBe(false);
    expect(await mfaTrustService.isTrusted(subject, second, "device-a", source)).toBe(true);
  });
});

describe("several accounts on one browser (2026-11-04 bug)", () => {
  const owner = { type: "USER" as const, id: 1 };
  const dispatcher = { type: "USER" as const, id: 13 };
  const ownerSource = { passwordHash: "o", status: "Active", email: "owner@example.com", phone: "09170000001" };
  const dispatcherSource = { passwordHash: "d", status: "Active", email: "jay@example.com", phone: "09170000002" };
  const ctx = { deviceId: "web-1", userAgent: null, method: "EMAIL" as const };

  it("keeps both accounts trusted when the cookie carries both tokens", async () => {
    const ownerToken = await mfaTrustService.issue(owner, ownerSource, ctx);
    const dispatcherToken = await mfaTrustService.issue(dispatcher, dispatcherSource, ctx);
    const cookie = mfaTrustService.serializeTrustCookie(dispatcherToken, [ownerToken]);
    const tokens = mfaTrustService.parseTrustCookie(cookie);

    expect(tokens).toEqual([dispatcherToken, ownerToken]);
    expect(await mfaTrustService.isTrusted(owner, tokens, "web-1", ownerSource)).toBe(true);
    expect(await mfaTrustService.isTrusted(dispatcher, tokens, "web-1", dispatcherSource)).toBe(true);
  });

  it("does not let one account's token trust another account", async () => {
    const dispatcherToken = await mfaTrustService.issue(dispatcher, dispatcherSource, ctx);
    expect(await mfaTrustService.isTrusted(owner, [dispatcherToken], "web-1", ownerSource)).toBe(false);
  });

  it("drops replaced and revoked tokens when the cookie is rewritten", async () => {
    const first = await mfaTrustService.issue(owner, ownerSource, ctx);
    const replacement = await mfaTrustService.issue(owner, ownerSource, ctx); // same device: first is revoked
    const other = await mfaTrustService.issue(dispatcher, dispatcherSource, ctx);
    expect(await mfaTrustService.liveTokens([first, replacement, other])).toEqual([replacement, other]);
  });

  it("caps the cookie and ignores anything that is not a token", () => {
    const tokens = Array.from({ length: 7 }, (_, i) => `token-${i}-${"x".repeat(30)}`);
    const cookie = mfaTrustService.serializeTrustCookie("new-token-" + "y".repeat(30), tokens);
    expect(cookie.split(".")).toHaveLength(mfaTrustService.MFA_TRUST_COOKIE_MAX_TOKENS);
    expect(mfaTrustService.parseTrustCookie("short.<script>." + "z".repeat(43))).toEqual(["z".repeat(43)]);
    expect(mfaTrustService.parseTrustCookie(undefined)).toEqual([]);
  });

  it("signs the owner straight back in after the dispatcher used the same browser", async () => {
    h.enforced.add("WEB_PORTAL");
    const ownerRow = staff({ id: 1, username: "owner", role: "OWNER" });
    const dispatcherRow = staff({ id: 13, username: "jayvee", email: "jay@example.com", phone: "09170000002" });

    // Owner passes MFA, then the dispatcher does, on the same browser.
    const ownerChallenge = await staffChallenge(ownerRow);
    const ownerDone = await completeLoginOtp(ownerChallenge.challengeToken, "123456", undefined, DEVICE);
    const dispatcherChallenge = await staffChallenge(dispatcherRow);
    const dispatcherDone = await completeLoginOtp(dispatcherChallenge.challengeToken, "123456", undefined, DEVICE);
    const cookie = mfaTrustService.serializeTrustCookie(
      dispatcherDone.trustToken,
      await mfaTrustService.liveTokens([ownerDone.trustToken])
    );

    h.findUserByIdentifier.mockResolvedValue(ownerRow);
    const again = await loginGeneral("owner", "right-password", {
      ...CAPABLE,
      trustTokens: mfaTrustService.parseTrustCookie(cookie),
    });
    expect(again.kind).toBe("AUTHENTICATED");
  });
});

describe("customer sign-in", () => {
  it("is not challenged until CUSTOMER_APP is enforced", async () => {
    h.findCustomerByIdentifier.mockResolvedValue(customer());
    const outcome = await loginCustomer("ana", "right-password", LEGACY);
    expect(outcome.kind).toBe("AUTHENTICATED");
  });

  it("tells an app built before MFA to update, and never signs it in", async () => {
    h.enforced.add("CUSTOMER_APP");
    h.findCustomerByIdentifier.mockResolvedValue(customer());
    await expect(loginCustomer("ana", "right-password", LEGACY)).rejects.toMatchObject({
      status: 403,
      details: { code: "APP_UPDATE_REQUIRED" },
    });
  });

  it("challenges a password sign-in and completes it as a customer, not as staff #7", async () => {
    h.enforced.add("CUSTOMER_APP");
    const row = customer();
    h.findCustomerByIdentifier.mockResolvedValue(row);
    h.findCustomerById.mockResolvedValue(row);

    const outcome = await loginCustomer("ana", "right-password", CAPABLE);
    if (outcome.kind !== "CHALLENGE") throw new Error("expected a challenge");
    expect(outcome.challenge).toMatchObject({ role: "CUSTOMER", factors: ["SMS", "EMAIL"], phoneHint: "2222" });
    expect((jwt.decode(outcome.challenge.challengeToken) as { sk: string }).sk).toBe("CUSTOMER");

    h.verifyFirebaseIdToken.mockResolvedValue(smsToken({ phoneNumber: "+639181112222" }));
    const done = await completeLoginOtp(outcome.challenge.challengeToken, undefined, "t", DEVICE);
    expect(done.user).toBeNull();
    expect(done.result.role).toBe("CUSTOMER");
    expect(h.findUserById).not.toHaveBeenCalled();
    expect(h.trusted[0]).toMatchObject({ subjectType: "CUSTOMER", subjectId: 7 });
    // The proven number becomes the customer's verified phone.
    expect(h.updateCustomer).toHaveBeenCalledWith(7, expect.objectContaining({ phoneVerified: true }));
  });

  it("uses the customer's own email code store", async () => {
    h.enforced.add("CUSTOMER_APP");
    const row = customer();
    h.findCustomerByIdentifier.mockResolvedValue(row);
    h.findCustomerById.mockResolvedValue(row);
    const outcome = await loginCustomer("ana", "right-password", CAPABLE);
    if (outcome.kind !== "CHALLENGE") throw new Error("expected a challenge");

    await resendLoginOtp(outcome.challenge.challengeToken);
    expect(h.resendCustomerLoginOtp).toHaveBeenCalledWith(7, "ana@example.com", "Ana Cruz");
    expect(h.resendLoginOtp).not.toHaveBeenCalled();
  });

  it("challenges a Google sign-in on an untrusted device", async () => {
    h.enforced.add("CUSTOMER_APP");
    h.verifyFirebaseIdToken.mockResolvedValue({
      uid: "g-1",
      email: "ana@example.com",
      emailVerified: true,
      signInProvider: "google.com",
    });
    h.findCustomerByGoogleId.mockResolvedValue(customer({ googleId: "g-1" }));
    const result = await loginCustomerWithGoogle("google-id-token", CAPABLE);
    expect(result.status).toBe("MFA_REQUIRED");
  });

  // 2026-11-09: a captured Google token signed in again for its whole hour.
  // Through the real insert-only claim, so a replay loses even mid-challenge.
  it("refuses the same Google sign-in token a second time", async () => {
    h.enforced.add("CUSTOMER_APP");
    h.verifyFirebaseIdToken.mockResolvedValue({
      uid: "g-1",
      email: "ana@example.com",
      emailVerified: true,
      signInProvider: "google.com",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    h.findCustomerByGoogleId.mockResolvedValue(customer({ googleId: "g-1" }));
    expect((await loginCustomerWithGoogle("google-id-token-replayed", CAPABLE)).status).toBe("MFA_REQUIRED");
    await expect(loginCustomerWithGoogle("google-id-token-replayed", CAPABLE)).rejects.toMatchObject({ status: 409 });
  });
});
