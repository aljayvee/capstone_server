import { describe, expect, it, vi, beforeEach } from "vitest";

// registerCustomer used to copy `emailVerified` straight from the request
// body, so any sign-up could claim an address it never proved. It now has to
// find the registration code that /customers/verify-registration-otp consumed.

const { findByUsernameOrEmail, createCustomer, findAllByPhone, findLatestForEmail, sendVerificationCode } =
  vi.hoisted(() => ({
    findByUsernameOrEmail: vi.fn(),
    createCustomer: vi.fn(),
    findAllByPhone: vi.fn(),
    findLatestForEmail: vi.fn(),
    sendVerificationCode: vi.fn(),
  }));

vi.mock("../src/repositories/customerRepository.js", () => ({
  customerRepository: { findByUsernameOrEmail, findAllByPhone, create: createCustomer },
}));

vi.mock("../src/repositories/emailVerificationRepository.js", () => ({
  emailVerificationRepository: { findLatestForEmail, findLatestConsumedForPhone: vi.fn() },
}));

vi.mock("../src/services/emailVerificationService.js", () => ({ sendVerificationCode }));

vi.mock("../src/lib/firebaseAdmin.js", () => ({ verifyFirebaseIdToken: vi.fn() }));

vi.mock("../src/repositories/userRepository.js", () => ({
  userRepository: { findByIdentifier: vi.fn(), findById: vi.fn() },
}));

import { registerCustomer } from "../src/services/authService.js";

const MINUTE = 60 * 1000;

function codeRow(overrides: Record<string, unknown>) {
  return {
    id: 1,
    customerId: null,
    userId: null,
    email: "maria@example.com",
    phone: null,
    codeHash: "x",
    expiresAt: new Date(Date.now() + 10 * MINUTE),
    consumedAt: null,
    attempts: 0,
    createdAt: new Date(Date.now() - 5 * MINUTE),
    ...overrides,
  };
}

async function registerClaimingVerified() {
  await registerCustomer({
    username: "maria",
    password: "password123",
    email: "Maria@Example.com",
    firstName: "Maria",
    lastName: "Santos",
    emailVerified: true,
  });
  return createCustomer.mock.calls[0][0].emailVerified as boolean;
}

describe("registration email proof", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findByUsernameOrEmail.mockResolvedValue(null);
    findAllByPhone.mockResolvedValue([]);
    createCustomer.mockImplementation((data) =>
      Promise.resolve({
        id: 201,
        username: data.username,
        email: data.email,
        status: "Active",
        emailVerified: data.emailVerified,
        phoneVerified: data.phoneVerified,
        passwordHash: data.passwordHash,
        createdAt: new Date(),
        updatedAt: new Date(),
        information: data.information,
      })
    );
  });

  it("trusts the claim when the newest registration code was consumed moments ago", async () => {
    findLatestForEmail.mockResolvedValue(codeRow({ consumedAt: new Date(Date.now() - MINUTE) }));

    expect(await registerClaimingVerified()).toBe(true);
    expect(findLatestForEmail).toHaveBeenCalledWith("maria@example.com");
    expect(sendVerificationCode).not.toHaveBeenCalled();
  });

  it("refuses the claim when no code was ever sent to the address", async () => {
    findLatestForEmail.mockResolvedValue(null);

    expect(await registerClaimingVerified()).toBe(false);
    expect(sendVerificationCode).toHaveBeenCalledWith(201, "maria@example.com");
  });

  it("refuses the claim while the newest code is still unused", async () => {
    findLatestForEmail.mockResolvedValue(codeRow({ consumedAt: null }));

    expect(await registerClaimingVerified()).toBe(false);
  });

  it("refuses a proof older than thirty minutes", async () => {
    findLatestForEmail.mockResolvedValue(codeRow({ consumedAt: new Date(Date.now() - 31 * MINUTE) }));

    expect(await registerClaimingVerified()).toBe(false);
  });

  it("refuses a code that belonged to an existing account", async () => {
    findLatestForEmail.mockResolvedValue(codeRow({ customerId: 9, consumedAt: new Date(Date.now() - MINUTE) }));

    expect(await registerClaimingVerified()).toBe(false);
  });

  it("does not look anything up when the caller makes no claim", async () => {
    await registerCustomer({
      username: "pedro",
      password: "password123",
      email: "pedro@example.com",
      firstName: "Pedro",
      lastName: "Penduko",
    });

    expect(findLatestForEmail).not.toHaveBeenCalled();
    expect(createCustomer.mock.calls[0][0].emailVerified).toBe(false);
  });
});
