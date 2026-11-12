import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  findByUsernameOrEmail,
  createCustomer,
  findByIdCustomer,
  updateCustomer,
  findLatestConsumedForPhone,
  verifyFirebaseIdTokenMock,
  findAllByPhone,
} = vi.hoisted(() => ({
  findAllByPhone: vi.fn(),
  findByUsernameOrEmail: vi.fn(),
  createCustomer: vi.fn(),
  findByIdCustomer: vi.fn(),
  updateCustomer: vi.fn(),
  findLatestConsumedForPhone: vi.fn(),
  verifyFirebaseIdTokenMock: vi.fn(),
}));

vi.mock("../src/repositories/customerRepository.js", () => ({
  customerRepository: {
    findByUsernameOrEmail,
    findAllByPhone,
    create: createCustomer,
    findById: findByIdCustomer,
    update: updateCustomer,
  },
}));

vi.mock("../src/services/accountAuditService.js", () => ({
  recordCustomerModifications: vi.fn().mockResolvedValue(undefined),
  getCustomerModificationLogs: vi.fn().mockResolvedValue([]),
}));

vi.mock("../src/repositories/emailVerificationRepository.js", () => ({
  emailVerificationRepository: {
    findLatestConsumedForPhone,
    // registerCustomer checks emailVerified claims against this; no code here.
    findLatestForEmail: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("../src/lib/firebaseAdmin.js", () => ({
  verifyFirebaseIdToken: verifyFirebaseIdTokenMock,
}));

vi.mock("../src/services/emailVerificationService.js", () => ({
  sendVerificationCode: vi.fn(),
}));

vi.mock("../src/repositories/userRepository.js", () => ({
  userRepository: {
    findByIdentifier: vi.fn(),
    findById: vi.fn(),
  },
}));

import {
  normalizePhoneDigits,
  verifyFirebasePhoneToken,
  registerCustomer,
} from "../src/services/authService.js";
import { updateProfile } from "../src/services/customerService.js";

describe("Firebase Phone Auth & Verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findByUsernameOrEmail.mockResolvedValue(null);
    findAllByPhone.mockResolvedValue([]);
  });

  describe("normalizePhoneDigits", () => {
    it("extracts the last 10 digits for standard PH phone formats", () => {
      expect(normalizePhoneDigits("+639171234567")).toBe("9171234567");
      expect(normalizePhoneDigits("09171234567")).toBe("9171234567");
      expect(normalizePhoneDigits("639171234567")).toBe("9171234567");
      expect(normalizePhoneDigits("9171234567")).toBe("9171234567");
      expect(normalizePhoneDigits("+63 917 123 4567")).toBe("9171234567");
    });
  });

  describe("verifyFirebasePhoneToken", () => {
    it("throws 400 when token contains no phone number", async () => {
      verifyFirebaseIdTokenMock.mockResolvedValue({ uid: "fb-uid-123" });

      await expect(
        verifyFirebasePhoneToken("valid-token")
      ).rejects.toThrow("Firebase ID token does not contain a verified phone number.");
    });

    it("throws 400 when verified phone does not match expected phone", async () => {
      verifyFirebaseIdTokenMock.mockResolvedValue({
        uid: "fb-uid-123",
        phoneNumber: "+639171234567",
      });

      await expect(
        verifyFirebasePhoneToken("valid-token", "09123456789")
      ).rejects.toThrow("Verified phone number does not match expected phone number.");
    });

    it("succeeds when verified phone matches expected phone across PH formats", async () => {
      verifyFirebaseIdTokenMock.mockResolvedValue({
        uid: "fb-uid-123",
        phoneNumber: "+639171234567",
      });

      const result = await verifyFirebasePhoneToken("valid-token", "09171234567");
      expect(result).toEqual({
        uid: "fb-uid-123",
        phone: "+639171234567",
        verified: true,
      });
    });
  });

  describe("registerCustomer with phone verification", () => {
    it("marks phoneVerified: true when valid firebaseIdToken is provided", async () => {
      verifyFirebaseIdTokenMock.mockResolvedValue({
        uid: "fb-uid-456",
        phoneNumber: "+639171234567",
      });

      createCustomer.mockImplementation((data) =>
        Promise.resolve({
          id: 101,
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

      const result = await registerCustomer({
        username: "testuser",
        password: "password123",
        email: "test@example.com",
        firstName: "Maria",
        lastName: "Santos",
        phone: "09171234567",
        emailVerified: true,
        firebaseIdToken: "valid-firebase-token",
      });

      expect(createCustomer).toHaveBeenCalledWith(
        expect.objectContaining({
          phoneVerified: true,
          information: expect.objectContaining({
            phoneVerified: true,
            phone: "09171234567",
          }),
        })
      );
      expect(result.user.phoneVerified).toBe(true);
    });

    it("marks phoneVerified: false when no token or consumed OTP exists", async () => {
      findLatestConsumedForPhone.mockResolvedValue(null);

      createCustomer.mockImplementation((data) =>
        Promise.resolve({
          id: 102,
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

      const result = await registerCustomer({
        username: "unverifieduser",
        password: "password123",
        email: "unverified@example.com",
        firstName: "Pedro",
        lastName: "Penduko",
        phone: "09123456789",
        emailVerified: true,
      });

      expect(createCustomer).toHaveBeenCalledWith(
        expect.objectContaining({
          phoneVerified: false,
          information: expect.objectContaining({
            phoneVerified: false,
          }),
        })
      );
      expect(result.user.phoneVerified).toBe(false);
    });
  });

  describe("updateProfile with phone verification", () => {
    const mockExistingCustomer = {
      id: 50,
      username: "juan_dc",
      email: "juan@example.com",
      status: "Active",
      phoneVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      information: {
        id: 50,
        customerId: 50,
        firstName: "Juan",
        middleName: null,
        lastName: "Dela Cruz",
        birthdate: new Date("1995-05-10"),
        phone: "09171234567",
        phoneVerified: true,
        phoneVerifiedAt: new Date(),
        avatar: null,
      },
    };

    it("allows updating profile without phone change and preserves verification", async () => {
      findByIdCustomer.mockResolvedValue(mockExistingCustomer);
      updateCustomer.mockImplementation(async (id, data) => ({
        ...mockExistingCustomer,
        ...data,
        information: {
          ...mockExistingCustomer.information,
          ...data.information,
        },
      }));

      const res = await updateProfile(50, {
        firstName: "Johnny",
      });

      expect(updateCustomer).toHaveBeenCalledWith(
        50,
        expect.objectContaining({
          phoneVerified: true,
          information: expect.objectContaining({
            firstName: "Johnny",
            phone: "09171234567",
            phoneVerified: true,
          }),
        })
      );
      expect(res.firstName).toBe("Johnny");
      expect(res.phoneVerified).toBe(true);
    });

    it("rejects phone number change without firebaseIdToken", async () => {
      findByIdCustomer.mockResolvedValue(mockExistingCustomer);

      await expect(
        updateProfile(50, {
          phone: "09129876543",
        })
      ).rejects.toThrow("Verification code required when updating mobile number");

      expect(updateCustomer).not.toHaveBeenCalled();
    });

    it("rejects phone number change with invalid firebaseIdToken", async () => {
      findByIdCustomer.mockResolvedValue(mockExistingCustomer);
      verifyFirebaseIdTokenMock.mockResolvedValue({
        uid: "wrong-uid",
        phoneNumber: "+639999999999", // Mismatched phone
      });

      await expect(
        updateProfile(50, {
          phone: "09129876543",
          firebaseIdToken: "invalid-token",
        })
      ).rejects.toThrow("Verified phone number does not match expected phone number.");

      expect(updateCustomer).not.toHaveBeenCalled();
    });

    it("succeeds when changing phone with valid matching firebaseIdToken", async () => {
      findByIdCustomer.mockResolvedValue(mockExistingCustomer);
      verifyFirebaseIdTokenMock.mockResolvedValue({
        uid: "valid-fb-uid",
        phoneNumber: "+639129876543",
      });
      updateCustomer.mockImplementation(async (id, data) => ({
        ...mockExistingCustomer,
        ...data,
        information: {
          ...mockExistingCustomer.information,
          ...data.information,
        },
      }));

      const res = await updateProfile(50, {
        phone: "09129876543",
        firebaseIdToken: "valid-token-for-new-number",
      });

      expect(updateCustomer).toHaveBeenCalledWith(
        50,
        expect.objectContaining({
          phoneVerified: true,
          information: expect.objectContaining({
            phone: "09129876543",
            phoneVerified: true,
            phoneVerifiedAt: expect.any(Date),
          }),
        })
      );
      expect(res.phone).toBe("09129876543");
      expect(res.phoneVerified).toBe(true);
    });

    it("refuses a number another account has already verified", async () => {
      findByIdCustomer.mockResolvedValue(mockExistingCustomer);
      verifyFirebaseIdTokenMock.mockResolvedValue({ uid: "valid-fb-uid", phoneNumber: "+639129876543" });
      findAllByPhone.mockResolvedValue([{ id: 77 }]);

      await expect(
        updateProfile(50, { phone: "09129876543", firebaseIdToken: "valid-token-for-new-number" })
      ).rejects.toMatchObject({ status: 400, message: expect.stringContaining("already registered") });
      expect(findAllByPhone).toHaveBeenCalledWith("09129876543", { verifiedOnly: true });
      expect(updateCustomer).not.toHaveBeenCalled();
    });
  });

  describe("one verified account per mobile number", () => {
    it("refuses registration with a number another account has verified", async () => {
      verifyFirebaseIdTokenMock.mockResolvedValue({ uid: "fb-uid-456", phoneNumber: "+639171234567" });
      findAllByPhone.mockResolvedValue([{ id: 9 }]);

      await expect(
        registerCustomer({
          username: "second",
          password: "password123",
          email: "second@example.com",
          firstName: "Maria",
          lastName: "Santos",
          phone: "09171234567",
          firebaseIdToken: "valid-firebase-token",
        })
      ).rejects.toMatchObject({ status: 400 });
      expect(createCustomer).not.toHaveBeenCalled();
    });
  });
});
