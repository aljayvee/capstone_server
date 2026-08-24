import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  findByIdentifier,
  findById,
  updateCustomer,
  createAttempt,
  countRecentMisses,
  countDistinctIdentifiers,
  countRecentRequestsForIdentifier,
  findLatestRequestForIdentifier,
  sendPasswordResetCode,
  findLatestActiveForCustomer,
  incrementAttempts,
  markConsumed,
} = vi.hoisted(() => ({
  findByIdentifier: vi.fn(),
  findById: vi.fn(),
  updateCustomer: vi.fn(),
  createAttempt: vi.fn(),
  countRecentMisses: vi.fn(),
  countDistinctIdentifiers: vi.fn(),
  countRecentRequestsForIdentifier: vi.fn(),
  findLatestRequestForIdentifier: vi.fn(),
  sendPasswordResetCode: vi.fn(),
  findLatestActiveForCustomer: vi.fn(),
  incrementAttempts: vi.fn(),
  markConsumed: vi.fn(),
}));

vi.mock("../src/repositories/customerRepository.js", () => ({
  customerRepository: { findByIdentifier, findById, update: updateCustomer },
}));
vi.mock("../src/repositories/passwordResetRepository.js", () => ({
  passwordResetRepository: {
    create: createAttempt,
    countRecentMisses,
    countDistinctIdentifiers,
    countRecentRequestsForIdentifier,
    findLatestRequestForIdentifier,
  },
}));
vi.mock("../src/repositories/emailVerificationRepository.js", () => ({
  emailVerificationRepository: { findLatestActiveForCustomer, incrementAttempts, markConsumed },
}));
vi.mock("../src/services/emailVerificationService.js", () => ({ sendPasswordResetCode }));

import bcrypt from "bcryptjs";
import * as passwordResetService from "../src/services/passwordResetService.js";

const CTX = { ipAddress: "203.0.113.9", userAgent: "jest" };

const CUSTOMER = {
  id: 42,
  username: "juandelacruz",
  email: "juan.delacruz@gmail.com",
  passwordHash: "$2a$10$originalhashvalueoriginalhashvalue",
  status: "Active",
};

// Every outcome the service logged, in order.
const loggedOutcomes = () => createAttempt.mock.calls.map((call) => call[0].outcome);
const lastLogged = () => createAttempt.mock.calls.at(-1)?.[0];

beforeEach(() => {
  vi.clearAllMocks();
  createAttempt.mockResolvedValue({});
  countRecentMisses.mockResolvedValue(0);
  countDistinctIdentifiers.mockResolvedValue(0);
  // No prior requests unless a test says otherwise.
  countRecentRequestsForIdentifier.mockResolvedValue(0);
  findLatestRequestForIdentifier.mockResolvedValue(null);
  sendPasswordResetCode.mockResolvedValue(undefined);
  updateCustomer.mockResolvedValue({});
  // No code outstanding unless a test says otherwise.
  findLatestActiveForCustomer.mockResolvedValue(null);
});

describe("requestReset — enumeration resistance", () => {
  it("answers a real account and an imaginary one with the same message", async () => {
    findByIdentifier.mockResolvedValueOnce(CUSTOMER);
    const hit = await passwordResetService.requestReset("juandelacruz", undefined, CTX);

    findByIdentifier.mockResolvedValueOnce(null);
    const miss = await passwordResetService.requestReset("not-a-real-user", undefined, CTX);

    expect(miss.message).toBe(hit.message);
    // The masked address is the only permitted difference, and it reveals
    // nothing the caller did not already type.
    expect(hit.maskedEmail).toBe("ju******@gmail.com");
    expect(miss.maskedEmail).toBeNull();
  });

  it("does not mail anything when nothing matched", async () => {
    findByIdentifier.mockResolvedValue(null);

    await passwordResetService.requestReset("not-a-real-user", undefined, CTX);

    expect(sendPasswordResetCode).not.toHaveBeenCalled();
  });

  it("makes a deactivated account indistinguishable from a missing one", async () => {
    findByIdentifier.mockResolvedValue({ ...CUSTOMER, status: "Inactive" });

    const result = await passwordResetService.requestReset("juandelacruz", undefined, CTX);

    expect(result.maskedEmail).toBeNull();
    expect(sendPasswordResetCode).not.toHaveBeenCalled();
    expect(loggedOutcomes()).toEqual(["UNKNOWN_ACCOUNT"]);
  });

  it("mails the code when the account is real and active", async () => {
    findByIdentifier.mockResolvedValue(CUSTOMER);
    findLatestActiveForCustomer.mockResolvedValue(null);

    await passwordResetService.requestReset("juandelacruz", undefined, CTX);

    expect(sendPasswordResetCode).toHaveBeenCalledWith(42, "juan.delacruz@gmail.com");
    expect(loggedOutcomes()).toEqual(["REQUESTED"]);
  });
});

describe("requestReset — resend backoff", () => {
  // n prior requests for this identifier, the newest `ageMs` ago.
  const streak = (n: number, ageMs: number) => {
    countRecentRequestsForIdentifier.mockResolvedValue(n);
    findLatestRequestForIdentifier.mockResolvedValue({
      id: 3,
      createdAt: new Date(Date.now() - ageMs),
    });
  };

  // Regression: a second request re-issued a code, and issuing retires the
  // previous one — so the code already in the customer's inbox stopped working.
  it("leaves a fresh code alone instead of replacing it", async () => {
    findByIdentifier.mockResolvedValue(CUSTOMER);
    streak(1, 5_000);

    await passwordResetService.requestReset("juandelacruz", undefined, CTX);

    expect(sendPasswordResetCode).not.toHaveBeenCalled();
    expect(loggedOutcomes()).toEqual(["COOLDOWN"]);
  });

  it("doubles the wait with each further request", async () => {
    findByIdentifier.mockResolvedValue(CUSTOMER);

    streak(1, 61_000);
    const second = await passwordResetService.requestReset("juandelacruz", undefined, CTX);
    expect(second.retryAfterSeconds).toBe(120);

    streak(2, 121_000);
    const third = await passwordResetService.requestReset("juandelacruz", undefined, CTX);
    expect(third.retryAfterSeconds).toBe(240);

    streak(3, 241_000);
    const fourth = await passwordResetService.requestReset("juandelacruz", undefined, CTX);
    expect(fourth.retryAfterSeconds).toBe(480);
  });

  it("quotes the same wait for a real and an imaginary account", async () => {
    // The countdown must not become the oracle the generic message refuses to
    // be, so it is derived from the audit trail, which records misses too.
    streak(2, 30_000);

    findByIdentifier.mockResolvedValueOnce(CUSTOMER);
    const hit = await passwordResetService.requestReset("juandelacruz", undefined, CTX);

    findByIdentifier.mockResolvedValueOnce(null);
    const miss = await passwordResetService.requestReset("not-a-real-user", undefined, CTX);

    expect(miss.retryAfterSeconds).toBe(hit.retryAfterSeconds);
  });

  it("issues a new code once the doubled wait has passed", async () => {
    findByIdentifier.mockResolvedValue(CUSTOMER);
    streak(2, 121_000);

    await passwordResetService.requestReset("juandelacruz", undefined, CTX);

    expect(sendPasswordResetCode).toHaveBeenCalledTimes(1);
    expect(loggedOutcomes()).toEqual(["REQUESTED"]);
  });

  it("starts over when the last request predates the streak window", async () => {
    findByIdentifier.mockResolvedValue(CUSTOMER);
    countRecentRequestsForIdentifier.mockResolvedValue(0);
    findLatestRequestForIdentifier.mockResolvedValue({
      id: 3,
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });

    const result = await passwordResetService.requestReset("juandelacruz", undefined, CTX);

    expect(sendPasswordResetCode).toHaveBeenCalledTimes(1);
    expect(result.retryAfterSeconds).toBe(60);
  });
});

describe("requestReset — IP audit trail", () => {
  it("records a miss against the IP, which is the row worth having", async () => {
    findByIdentifier.mockResolvedValue(null);

    await passwordResetService.requestReset("victim-username", undefined, CTX);

    expect(lastLogged()).toMatchObject({
      identifier: "victim-username",
      customerId: null,
      outcome: "UNKNOWN_ACCOUNT",
      ipAddress: "203.0.113.9",
      userAgent: "jest",
    });
  });

  it("stores the identifier lowercased so one account cannot be probed under many spellings", async () => {
    findByIdentifier.mockResolvedValue(null);

    await passwordResetService.requestReset("JuanDelaCruz", undefined, CTX);

    expect(lastLogged()?.identifier).toBe("juandelacruz");
  });

  it("still resolves for the customer when the audit write fails", async () => {
    findByIdentifier.mockResolvedValue(CUSTOMER);
    createAttempt.mockRejectedValue(new Error("database on fire"));

    await expect(
      passwordResetService.requestReset("juandelacruz", undefined, CTX)
    ).resolves.toMatchObject({ maskedEmail: "ju******@gmail.com" });
  });
});

describe("requestReset — honeypot", () => {
  it("logs a filled honeypot and mails nothing", async () => {
    findByIdentifier.mockResolvedValue(CUSTOMER);

    await passwordResetService.requestReset("juandelacruz", "http://spam.example", CTX);

    expect(loggedOutcomes()).toEqual(["HONEYPOT"]);
    expect(sendPasswordResetCode).not.toHaveBeenCalled();
    // Not even a lookup — a bot must not be able to time the account query.
    expect(findByIdentifier).not.toHaveBeenCalled();
  });

  it("tells the bot exactly what it tells a human", async () => {
    findByIdentifier.mockResolvedValueOnce(null);
    const human = await passwordResetService.requestReset("ghost", undefined, CTX);
    const bot = await passwordResetService.requestReset("ghost", "filled-in", CTX);

    expect(bot.message).toBe(human.message);
    expect(bot.maskedEmail).toBeNull();
  });

  it("ignores a whitespace-only honeypot rather than blaming a stray keystroke", async () => {
    findByIdentifier.mockResolvedValue(CUSTOMER);

    await passwordResetService.requestReset("juandelacruz", "   ", CTX);

    expect(loggedOutcomes()).toEqual(["REQUESTED"]);
  });
});

describe("isIpThrottled", () => {
  it("blocks an IP that has piled up fruitless attempts", async () => {
    countRecentMisses.mockResolvedValue(5);

    await expect(passwordResetService.isIpThrottled("203.0.113.9")).resolves.toBe(true);
  });

  it("blocks an IP that has probed many different identifiers", async () => {
    // Zero misses — every identifier resolved. Still enumeration: one person
    // does not reset six different accounts in an hour.
    countRecentMisses.mockResolvedValue(0);
    countDistinctIdentifiers.mockResolvedValue(6);

    await expect(passwordResetService.isIpThrottled("203.0.113.9")).resolves.toBe(true);
  });

  it("leaves a customer retrying their own account alone", async () => {
    countRecentMisses.mockResolvedValue(0);
    countDistinctIdentifiers.mockResolvedValue(1);

    await expect(passwordResetService.isIpThrottled("203.0.113.9")).resolves.toBe(false);
  });

  it("does not block when there is no IP to count against", async () => {
    await expect(passwordResetService.isIpThrottled(null)).resolves.toBe(false);
    expect(countRecentMisses).not.toHaveBeenCalled();
  });

  it("refuses the request once the IP is over the line", async () => {
    countRecentMisses.mockResolvedValue(9);

    await expect(
      passwordResetService.requestReset("juandelacruz", undefined, CTX)
    ).rejects.toMatchObject({ status: 429 });
    expect(loggedOutcomes()).toEqual(["THROTTLED"]);
  });
});

describe("verifyResetCode → completeReset", () => {
  const activeCode = async () => ({
    id: 7,
    codeHash: await bcrypt.hash("123456", 10),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    attempts: 0,
  });

  it("hands back a reset token for the right code", async () => {
    findByIdentifier.mockResolvedValue(CUSTOMER);
    findLatestActiveForCustomer.mockResolvedValue(await activeCode());

    const { resetToken } = await passwordResetService.verifyResetCode("juandelacruz", "123456", CTX);

    expect(typeof resetToken).toBe("string");
    expect(markConsumed).toHaveBeenCalledWith(7);
    expect(loggedOutcomes()).toEqual(["CODE_VERIFIED"]);
  });

  it("counts a wrong code against the attempt limit and logs the rejection", async () => {
    findByIdentifier.mockResolvedValue(CUSTOMER);
    findLatestActiveForCustomer.mockResolvedValue(await activeCode());

    await expect(
      passwordResetService.verifyResetCode("juandelacruz", "000000", CTX)
    ).rejects.toMatchObject({ status: 400 });

    expect(incrementAttempts).toHaveBeenCalledWith(7);
    expect(loggedOutcomes()).toEqual(["CODE_REJECTED"]);
  });

  it("rejects an expired code", async () => {
    findByIdentifier.mockResolvedValue(CUSTOMER);
    findLatestActiveForCustomer.mockResolvedValue({
      ...(await activeCode()),
      expiresAt: new Date(Date.now() - 1000),
    });

    await expect(
      passwordResetService.verifyResetCode("juandelacruz", "123456", CTX)
    ).rejects.toThrow(/expired/i);
  });

  it("sets the new password when the token is good", async () => {
    findByIdentifier.mockResolvedValue(CUSTOMER);
    findLatestActiveForCustomer.mockResolvedValue(await activeCode());
    const { resetToken } = await passwordResetService.verifyResetCode("juandelacruz", "123456", CTX);

    findById.mockResolvedValue(CUSTOMER);
    await passwordResetService.completeReset(resetToken, "brand new pass", CTX);

    expect(updateCustomer).toHaveBeenCalledTimes(1);
    const [id, data] = updateCustomer.mock.calls[0];
    expect(id).toBe(42);
    await expect(bcrypt.compare("brand new pass", data.passwordHash)).resolves.toBe(true);
    expect(loggedOutcomes()).toContain("COMPLETED");
  });

  it("refuses to spend the same token twice", async () => {
    findByIdentifier.mockResolvedValue(CUSTOMER);
    findLatestActiveForCustomer.mockResolvedValue(await activeCode());
    const { resetToken } = await passwordResetService.verifyResetCode("juandelacruz", "123456", CTX);

    findById.mockResolvedValue(CUSTOMER);
    await passwordResetService.completeReset(resetToken, "brand new pass", CTX);

    // The password changed, so the credential stamp baked into the token no
    // longer matches the account — replaying it is dead on arrival.
    findById.mockResolvedValue({ ...CUSTOMER, passwordHash: "$2a$10$adifferenthashentirelyxxxxxxx" });
    await expect(
      passwordResetService.completeReset(resetToken, "attacker choice", CTX)
    ).rejects.toThrow(/already been used/i);
  });

  it("rejects a token this service never minted", async () => {
    await expect(
      passwordResetService.completeReset("not.a.jwt", "brand new pass", CTX)
    ).rejects.toThrow(/expired|not valid/i);
    expect(updateCustomer).not.toHaveBeenCalled();
  });
});
