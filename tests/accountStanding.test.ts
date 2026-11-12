import { beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

/**
 * An account's standing is read when a session starts AND when it is renewed
 * (Codex security scan, 2026-11-02). A sysadmin suspension revoked a customer's
 * sessions, then the next password sign-in made new ones; a refresh token kept
 * minting access tokens with the role it was issued under, so a demoted owner
 * stayed an owner for as long as the 30-day session slid.
 */

const { findCustomerById, findCustomerByIdentifier, findUserById, rotateSession, revokeSession } = vi.hoisted(() => ({
  findCustomerById: vi.fn(),
  findCustomerByIdentifier: vi.fn(),
  findUserById: vi.fn(),
  rotateSession: vi.fn(async () => ({ refreshToken: "rotated-refresh-token" })),
  revokeSession: vi.fn(async () => undefined),
}));

vi.mock("../src/lib/prisma.js", () => ({ prisma: {} }));
vi.mock("../src/repositories/customerRepository.js", () => ({
  customerRepository: { findById: findCustomerById, findByIdentifier: findCustomerByIdentifier },
}));
vi.mock("../src/repositories/userRepository.js", () => ({ userRepository: { findById: findUserById } }));
vi.mock("../src/repositories/tokenBlocklistRepository.js", () => ({
  tokenBlocklistRepository: { findByToken: vi.fn(async () => null) },
}));
vi.mock("../src/services/riderPresenceService.js", () => ({ openLoginSession: vi.fn(async () => undefined) }));
vi.mock("../src/services/sessionService.js", async (orig) => ({
  ...(await orig<typeof import("../src/services/sessionService.js")>()),
  rotateSession,
  revokeSession,
}));

import { generateRefreshToken, loginCustomer, refreshAccessToken } from "../src/services/authService.js";

const SID = "11111111-2222-3333-4444-555555555555";
const PASSWORD_HASH = bcrypt.hashSync("right-password", 4);

function customer(status: string) {
  return { id: 9, username: "ana", email: "ana@example.com", passwordHash: PASSWORD_HASH, status, information: {} };
}

function staff(role: string, status = "Active") {
  return { id: 9, username: "jo", email: "jo@example.com", passwordHash: PASSWORD_HASH, role, status, firstName: "Jo", lastName: "Cruz" };
}

function refreshTokenFor(role: string) {
  return generateRefreshToken({ id: 9, username: "jo", email: "jo@example.com", role }, SID);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("customer password sign-in", () => {
  it("refuses a suspended customer even with the right password", async () => {
    findCustomerByIdentifier.mockResolvedValue(customer("Suspended"));
    await expect(loginCustomer("ana", "right-password")).rejects.toMatchObject({ status: 403 });
  });

  it("answers a wrong password the same way whatever the account's status", async () => {
    findCustomerByIdentifier.mockResolvedValue(customer("Locked"));
    await expect(loginCustomer("ana", "wrong-password")).rejects.toMatchObject({ status: 401 });
  });

  it("still signs in an active customer", async () => {
    findCustomerByIdentifier.mockResolvedValue(customer("Active"));
    const outcome = await loginCustomer("ana", "right-password");
    // MFA is not enforced in tests (MFA_ENFORCED_AUDIENCES is empty), so no challenge.
    expect(outcome.kind).toBe("AUTHENTICATED");
    if (outcome.kind !== "AUTHENTICATED") return;
    expect(outcome.result.role).toBe("CUSTOMER");
    expect(outcome.result.accessToken).toBeTruthy();
  });
});

describe("session refresh", () => {
  it("ends the session of a demoted staff member instead of minting the old role", async () => {
    findUserById.mockResolvedValue(staff("DISPATCHER"));

    await expect(refreshAccessToken(refreshTokenFor("OWNER"))).rejects.toMatchObject({ status: 401 });
    expect(revokeSession).toHaveBeenCalledWith(SID, "ROLE_CHANGED");
    expect(rotateSession).not.toHaveBeenCalled();
  });

  it("ends the session of a deactivated staff member", async () => {
    findUserById.mockResolvedValue(staff("DISPATCHER", "Inactive"));

    await expect(refreshAccessToken(refreshTokenFor("DISPATCHER"))).rejects.toMatchObject({ status: 401 });
    expect(revokeSession).toHaveBeenCalledWith(SID, "ACCOUNT_NOT_ACTIVE");
    expect(rotateSession).not.toHaveBeenCalled();
  });

  it("ends the session of a suspended customer", async () => {
    findCustomerById.mockResolvedValue(customer("Suspended"));

    await expect(refreshAccessToken(refreshTokenFor("CUSTOMER"))).rejects.toMatchObject({ status: 401 });
    expect(revokeSession).toHaveBeenCalledWith(SID, "ACCOUNT_NOT_ACTIVE");
    expect(rotateSession).not.toHaveBeenCalled();
  });

  it("rotates as before for an active account whose role is unchanged", async () => {
    findUserById.mockResolvedValue(staff("DISPATCHER"));

    const result = await refreshAccessToken(refreshTokenFor("DISPATCHER"));
    expect(rotateSession).toHaveBeenCalledOnce();
    expect(revokeSession).not.toHaveBeenCalled();
    expect(result.refreshToken).toBe("rotated-refresh-token");
    expect(result.user.id).toBe(9);
  });
});
