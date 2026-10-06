import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  findByGoogleId,
  findByEmail,
  findByUsername,
  createCustomer,
  updateCustomer,
  verifyFirebaseIdTokenMock,
} = vi.hoisted(() => ({
  findByGoogleId: vi.fn(),
  findByEmail: vi.fn(),
  findByUsername: vi.fn(),
  createCustomer: vi.fn(),
  updateCustomer: vi.fn(),
  verifyFirebaseIdTokenMock: vi.fn(),
}));

vi.mock("../src/repositories/customerRepository.js", () => ({
  customerRepository: {
    findByGoogleId,
    findByEmail,
    findByUsername,
    create: createCustomer,
    update: updateCustomer,
  },
}));

vi.mock("../src/lib/firebaseAdmin.js", () => ({
  verifyFirebaseIdToken: verifyFirebaseIdTokenMock,
}));

vi.mock("../src/services/sessionService.js", () => ({
  createSession: vi.fn().mockResolvedValue({ id: "session-1" }),
}));

import {
  loginCustomerWithGoogle,
  registerCustomerWithGoogle,
} from "../src/services/authService.js";

describe("Google Authentication Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("loginCustomerWithGoogle", () => {
    it("logs in an existing Google customer who already has a verified phone", async () => {
      verifyFirebaseIdTokenMock.mockResolvedValue({
        uid: "google-uid-123",
        email: "existing@gmail.com",
        name: "Existing User",
        picture: "https://photo.jpg",
      });

      findByGoogleId.mockResolvedValue({
        id: 10,
        username: "existing_user",
        email: "existing@gmail.com",
        passwordHash: null,
        googleId: "google-uid-123",
        status: "Active",
        emailVerified: true,
        phoneVerified: true,
        information: {
          firstName: "Existing",
          lastName: "User",
          phone: "09123456789",
          phoneVerified: true,
        },
      });

      const result = await loginCustomerWithGoogle("valid-token");
      expect(result.status).toBe("AUTHENTICATED");
      if (result.status === "AUTHENTICATED") {
        expect(result.auth.user.id).toBe(10);
        expect(result.auth.user.email).toBe("existing@gmail.com");
        expect(result.auth.accessToken).toBeDefined();
        expect(result.auth.refreshToken).toBeDefined();
      }
    });

    it("links Google account to an existing email/password customer and logs them in", async () => {
      verifyFirebaseIdTokenMock.mockResolvedValue({
        uid: "google-uid-456",
        email: "legacy@gmail.com",
        name: "Legacy User",
        picture: "https://photo.jpg",
      });

      findByGoogleId.mockResolvedValue(null);
      findByEmail.mockResolvedValue({
        id: 20,
        username: "legacy_user",
        email: "legacy@gmail.com",
        passwordHash: "hashed-pass",
        googleId: null,
        status: "Active",
        emailVerified: false,
        phoneVerified: true,
        information: {
          firstName: "Legacy",
          lastName: "User",
          phone: "09987654321",
        },
      });

      updateCustomer.mockResolvedValue({
        id: 20,
        username: "legacy_user",
        email: "legacy@gmail.com",
        passwordHash: "hashed-pass",
        googleId: "google-uid-456",
        status: "Active",
        emailVerified: true,
        phoneVerified: true,
        information: {
          firstName: "Legacy",
          lastName: "User",
          phone: "09987654321",
        },
      });

      const result = await loginCustomerWithGoogle("valid-token");
      expect(result.status).toBe("AUTHENTICATED");
      expect(updateCustomer).toHaveBeenCalledWith(20, {
        googleId: "google-uid-456",
        emailVerified: true,
      });
    });

    it("returns PHONE_SETUP_REQUIRED when a customer has no phone number on file", async () => {
      verifyFirebaseIdTokenMock.mockResolvedValue({
        uid: "google-uid-789",
        email: "newuser@gmail.com",
        name: "Brand New",
        picture: "https://photo.jpg",
      });

      findByGoogleId.mockResolvedValue(null);
      findByEmail.mockResolvedValue(null);

      const result = await loginCustomerWithGoogle("valid-token");
      expect(result.status).toBe("PHONE_SETUP_REQUIRED");
      if (result.status === "PHONE_SETUP_REQUIRED") {
        expect(result.email).toBe("newuser@gmail.com");
        expect(result.firstName).toBe("Brand");
        expect(result.lastName).toBe("New");
        expect(result.googleUid).toBe("google-uid-789");
      }
    });
  });

  describe("registerCustomerWithGoogle", () => {
    it("completes registration with verified phone number and Google token", async () => {
      verifyFirebaseIdTokenMock.mockImplementation(async (token: string) => {
        if (token === "google-token") {
          return {
            uid: "google-uid-999",
            email: "fresh@gmail.com",
            name: "Fresh User",
            picture: "https://avatar.png",
          };
        }
        if (token === "phone-token") {
          return {
            uid: "phone-uid-999",
            phoneNumber: "+639123456789",
          };
        }
        throw new Error("Invalid token");
      });

      findByGoogleId.mockResolvedValue(null);
      findByEmail.mockResolvedValue(null);
      findByUsername.mockResolvedValue(null);

      createCustomer.mockResolvedValue({
        id: 30,
        username: "fresh",
        email: "fresh@gmail.com",
        passwordHash: null,
        googleId: "google-uid-999",
        status: "Active",
        emailVerified: true,
        phoneVerified: true,
        information: {
          firstName: "Fresh",
          lastName: "User",
          phone: "09123456789",
          phoneVerified: true,
        },
      });

      const result = await registerCustomerWithGoogle({
        idToken: "google-token",
        phone: "09123456789",
        phoneToken: "phone-token",
        firstName: "Fresh",
        lastName: "User",
      });

      expect(result.user.id).toBe(30);
      expect(result.user.email).toBe("fresh@gmail.com");
      expect(createCustomer).toHaveBeenCalledWith(
        expect.objectContaining({
          email: "fresh@gmail.com",
          googleId: "google-uid-999",
          passwordHash: null,
          phoneVerified: true,
          emailVerified: true,
        })
      );
    });

    it("rejects registration if phone verification token does not match phone number", async () => {
      verifyFirebaseIdTokenMock.mockImplementation(async (token: string) => {
        if (token === "google-token") {
          return {
            uid: "google-uid-999",
            email: "fresh@gmail.com",
            name: "Fresh User",
          };
        }
        if (token === "phone-token") {
          return {
            uid: "phone-uid-999",
            phoneNumber: "+639999999999", // Different phone number
          };
        }
        throw new Error("Invalid token");
      });

      await expect(
        registerCustomerWithGoogle({
          idToken: "google-token",
          phone: "09123456789",
          phoneToken: "phone-token",
        })
      ).rejects.toThrow(/Verified phone number does not match/);
    });
  });
});
