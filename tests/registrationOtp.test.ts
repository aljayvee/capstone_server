import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  findByUsernameOrEmail,
  createCode,
  countRecentForEmail,
  findLatestForEmail,
  consumeAllForEmail,
  sendEmail,
} = vi.hoisted(() => ({
  findByUsernameOrEmail: vi.fn(),
  createCode: vi.fn(),
  countRecentForEmail: vi.fn(),
  findLatestForEmail: vi.fn(),
  consumeAllForEmail: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock("../src/repositories/customerRepository.js", () => ({
  customerRepository: { findByUsernameOrEmail },
}));
vi.mock("../src/repositories/emailVerificationRepository.js", () => ({
  emailVerificationRepository: {
    create: createCode,
    countRecentForEmail,
    findLatestForEmail,
    consumeAllForEmail,
  },
}));
vi.mock("../src/lib/mailer.js", () => ({ sendEmail }));

import { sendRegistrationOtp } from "../src/services/emailVerificationService.js";

const EMAIL = "juan@gmail.com";

const sentCode = (ageMs: number) => ({
  id: 7,
  createdAt: new Date(Date.now() - ageMs),
  expiresAt: new Date(Date.now() - ageMs + 15 * 60 * 1000),
});

// n codes already sent, the newest `ageMs` ago.
const streak = (n: number, ageMs: number) => {
  countRecentForEmail.mockResolvedValue(n);
  findLatestForEmail.mockResolvedValue(sentCode(ageMs));
};

beforeEach(() => {
  vi.clearAllMocks();
  findByUsernameOrEmail.mockResolvedValue(null);
  countRecentForEmail.mockResolvedValue(0);
  findLatestForEmail.mockResolvedValue(null);
  consumeAllForEmail.mockResolvedValue({});
  createCode.mockResolvedValue({});
});

describe("sendRegistrationOtp — resend cooldown", () => {
  // Regression: stepping back from the code screen and pressing Send again
  // issued a second code. verifyRegistrationOtp reads only the NEWEST code for
  // an address, so the one already in the inbox stopped being accepted.
  it("leaves a fresh code alone instead of issuing another", async () => {
    streak(1, 5_000);

    await sendRegistrationOtp(EMAIL);

    expect(createCode).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("reports the seconds left rather than throwing, so the caller can still advance", async () => {
    streak(1, 20_000);

    await expect(sendRegistrationOtp(EMAIL)).resolves.toBe(40);
  });

  it("issues a new code once the first minute has passed", async () => {
    streak(1, 61_000);

    await expect(sendRegistrationOtp(EMAIL)).resolves.toBe(120);
    expect(createCode).toHaveBeenCalledTimes(1);
  });

  it("doubles the wait for each further code to the same address", async () => {
    streak(2, 121_000);
    await expect(sendRegistrationOtp(EMAIL)).resolves.toBe(240);

    vi.clearAllMocks();
    findByUsernameOrEmail.mockResolvedValue(null);
    consumeAllForEmail.mockResolvedValue({});
    createCode.mockResolvedValue({});
    streak(3, 241_000);
    await expect(sendRegistrationOtp(EMAIL)).resolves.toBe(480);
  });

  it("holds a second code for the doubled gap, not the original minute", async () => {
    // 90s since the second code: past the first 60s step, short of 120s.
    streak(2, 90_000);

    await expect(sendRegistrationOtp(EMAIL)).resolves.toBe(30);
    expect(createCode).not.toHaveBeenCalled();
  });

  it("starts over when the last code predates the streak window", async () => {
    countRecentForEmail.mockResolvedValue(0);
    findLatestForEmail.mockResolvedValue(sentCode(2 * 60 * 60 * 1000));

    await expect(sendRegistrationOtp(EMAIL)).resolves.toBe(60);
    expect(createCode).toHaveBeenCalledTimes(1);
  });

  it("retires older codes so only the newest can ever be live", async () => {
    await sendRegistrationOtp(EMAIL);

    expect(consumeAllForEmail).toHaveBeenCalledWith(EMAIL);
    expect(createCode).toHaveBeenCalledTimes(1);
  });

  it("normalises the address, so casing cannot dodge the cooldown", async () => {
    streak(1, 5_000);

    await sendRegistrationOtp("  Juan@GMAIL.com  ");

    expect(countRecentForEmail).toHaveBeenCalledWith(EMAIL, expect.any(Date));
    expect(createCode).not.toHaveBeenCalled();
  });

  it("still refuses an address that already has an account", async () => {
    findByUsernameOrEmail.mockResolvedValue({ id: 1 });

    await expect(sendRegistrationOtp(EMAIL)).rejects.toMatchObject({ status: 400 });
    expect(createCode).not.toHaveBeenCalled();
  });
});
