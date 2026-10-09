import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SMS password reset resolves the account FROM the phone number, and
 * customer_information.phone is not unique. findByPhone's findFirst used to
 * reset whichever holder MariaDB returned first (2026-10-09). The reset now
 * honours only verified holders, and only when there is exactly one.
 */

const { findAllByPhone, verifyFirebaseIdToken } = vi.hoisted(() => ({
  findAllByPhone: vi.fn(),
  verifyFirebaseIdToken: vi.fn(),
}));

vi.mock("../src/repositories/customerRepository.js", () => ({
  customerRepository: { findAllByPhone },
}));
vi.mock("../src/repositories/passwordResetRepository.js", () => ({
  passwordResetRepository: { create: vi.fn(async () => undefined) },
}));
vi.mock("../src/lib/firebaseAdmin.js", () => ({ verifyFirebaseIdToken }));
vi.mock("../src/services/emailVerificationService.js", () => ({ sendPasswordResetCode: vi.fn() }));
vi.mock("../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { verifyResetPhone } = await import("../src/services/passwordResetService.js");

const ctx = { ipAddress: "127.0.0.1", userAgent: "vitest" };
const holder = (id: number) => ({ id, status: "Active", passwordHash: "$2a$10$abcdefghijklmnopqrstuv" });

beforeEach(() => {
  vi.clearAllMocks();
  verifyFirebaseIdToken.mockResolvedValue({ uid: "fb", phoneNumber: "+639171234567" });
});

describe("verifyResetPhone", () => {
  it("asks only for accounts that verified the number", async () => {
    findAllByPhone.mockResolvedValue([holder(5)]);
    const result = await verifyResetPhone("token", ctx);
    expect(findAllByPhone).toHaveBeenCalledWith("9171234567", { verifiedOnly: true });
    expect(result.resetToken).toEqual(expect.any(String));
  });

  it("refuses to choose between two accounts on the same number", async () => {
    findAllByPhone.mockResolvedValue([holder(5), holder(9)]);
    await expect(verifyResetPhone("token", ctx)).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("by email"),
    });
  });

  it("finds nothing when the only holder never verified it", async () => {
    findAllByPhone.mockResolvedValue([]);
    await expect(verifyResetPhone("token", ctx)).rejects.toMatchObject({ status: 404 });
  });
});
