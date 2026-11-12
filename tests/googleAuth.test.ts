import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  findByGoogleId,
  findByEmail,
  findByUsername,
  createCustomer,
  updateCustomer,
  verifyFirebaseIdTokenMock,
  findAllByPhone,
  claimToken,
} = vi.hoisted(() => ({
  claimToken: vi.fn(),
  findAllByPhone: vi.fn(),
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
    findAllByPhone,
    create: createCustomer,
    update: updateCustomer,
  },
}));

vi.mock("../src/lib/firebaseAdmin.js", () => ({
  verifyFirebaseIdToken: verifyFirebaseIdTokenMock,
}));

vi.mock("../src/repositories/tokenBlocklistRepository.js", () => ({
  tokenBlocklistRepository: { claim: claimToken },
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
    findAllByPhone.mockResolvedValue([]);
    claimToken.mockResolvedValue(true);
  });

  describe("loginCustomerWithGoogle", () => {
    it("logs in an existing Google customer who already has a verified phone", async () => {
      verifyFirebaseIdTokenMock.mockResolvedValue({
        uid: "google-uid-123",
        email: "existing@gmail.com",
        emailVerified: true,
        signInProvider: "google.com",
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
        emailVerified: true,
        signInProvider: "google.com",
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
        emailVerified: true,
        signInProvider: "google.com",
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

    // Codex security scan, 2026-11-02: linking by email trusted an address no
    // provider had proven, and a suspended customer could sign in through Google.
    it("refuses an email the provider has not verified, and links nothing", async () => {
      verifyFirebaseIdTokenMock.mockResolvedValue({
        uid: "google-uid-unverified",
        email: "legacy@gmail.com",
        emailVerified: false,
        signInProvider: "google.com",
      });

      await expect(loginCustomerWithGoogle("valid-token")).rejects.toMatchObject({ status: 403 });
      expect(findByEmail).not.toHaveBeenCalled();
      expect(updateCustomer).not.toHaveBeenCalled();
    });

    it("refuses a suspended customer found by Google id", async () => {
      verifyFirebaseIdTokenMock.mockResolvedValue({
        uid: "google-uid-123",
        email: "existing@gmail.com",
        emailVerified: true,
        signInProvider: "google.com",
      });
      findByGoogleId.mockResolvedValue({
        id: 10,
        email: "existing@gmail.com",
        status: "Suspended",
        information: { phone: "09123456789" },
      });

      await expect(loginCustomerWithGoogle("valid-token")).rejects.toMatchObject({ status: 403 });
    });

    it("refuses a suspended customer found by email before linking Google to it", async () => {
      verifyFirebaseIdTokenMock.mockResolvedValue({
        uid: "google-uid-456",
        email: "legacy@gmail.com",
        emailVerified: true,
        signInProvider: "google.com",
      });
      findByGoogleId.mockResolvedValue(null);
      findByEmail.mockResolvedValue({ id: 20, email: "legacy@gmail.com", status: "Locked", information: {} });

      await expect(loginCustomerWithGoogle("valid-token")).rejects.toMatchObject({ status: 403 });
      expect(updateCustomer).not.toHaveBeenCalled();
    });
  });

  describe("registerCustomerWithGoogle", () => {
    it("completes registration with verified phone number and Google token", async () => {
      verifyFirebaseIdTokenMock.mockImplementation(async (token: string) => {
        if (token === "google-token") {
          return {
            uid: "google-uid-999",
            email: "fresh@gmail.com",
            emailVerified: true,
            signInProvider: "google.com",
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
      expect(claimToken).toHaveBeenCalledTimes(1);
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
            emailVerified: true,
            signInProvider: "google.com",
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

    it("refuses an unverified email instead of writing it as verified", async () => {
      verifyFirebaseIdTokenMock.mockResolvedValue({
        uid: "uid-x",
        email: "someone@example.com",
        emailVerified: false,
        signInProvider: "google.com",
      });

      await expect(
        registerCustomerWithGoogle({ idToken: "google-token", phone: "09123456789", phoneToken: "phone-token" })
      ).rejects.toMatchObject({ status: 403 });
      expect(createCustomer).not.toHaveBeenCalled();
      expect(updateCustomer).not.toHaveBeenCalled();
    });
  });

  // 2026-11-09: the token verified for its whole hour, from any Firebase
  // provider, as many times as it was sent. There is no nonce to check (the
  // native Google SDK takes none), so the server pins down the rest.
  describe("the Google sign-in token", () => {
    const googleToken = (overrides: Record<string, unknown> = {}) => ({
      uid: "google-uid-123",
      email: "existing@gmail.com",
      emailVerified: true,
      signInProvider: "google.com",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      ...overrides,
    });
    const customerWithPhone = (overrides: Record<string, unknown> = {}) => ({
      id: 10,
      username: "existing_user",
      email: "existing@gmail.com",
      passwordHash: null,
      googleId: "google-uid-123",
      status: "Active",
      emailVerified: true,
      phoneVerified: true,
      information: { firstName: "Existing", lastName: "User", phone: "09123456789", phoneVerified: true },
      ...overrides,
    });
    const phoneOr = (google: Record<string, unknown>) => async (token: string) =>
      token === "phone-token" ? { uid: "phone-uid", phoneNumber: "+639123456789" } : google;

    it("asks Firebase whether the user was disabled or signed out everywhere", async () => {
      verifyFirebaseIdTokenMock.mockResolvedValue(googleToken());
      findByGoogleId.mockResolvedValue(customerWithPhone());
      await loginCustomerWithGoogle("valid-token");
      expect(verifyFirebaseIdTokenMock).toHaveBeenCalledWith("valid-token", { checkRevoked: true });
    });

    it("refuses a token from another Firebase provider, even with a verified email", async () => {
      verifyFirebaseIdTokenMock.mockResolvedValue(googleToken({ signInProvider: "password" }));
      await expect(loginCustomerWithGoogle("valid-token")).rejects.toMatchObject({ status: 400 });
      expect(findByGoogleId).not.toHaveBeenCalled();
      expect(findByEmail).not.toHaveBeenCalled();
      expect(updateCustomer).not.toHaveBeenCalled();
      expect(claimToken).not.toHaveBeenCalled();
    });

    it("refuses a phone sign-in token at google-register", async () => {
      verifyFirebaseIdTokenMock.mockResolvedValue({ uid: "phone-uid", phoneNumber: "+639123456789", signInProvider: "phone" });
      await expect(
        registerCustomerWithGoogle({ idToken: "phone-token", phone: "09123456789", phoneToken: "phone-token" })
      ).rejects.toMatchObject({ status: 400 });
      expect(createCustomer).not.toHaveBeenCalled();
    });

    it("spends the token when it signs in, keyed by its hash until it expires", async () => {
      const token = googleToken();
      verifyFirebaseIdTokenMock.mockResolvedValue(token);
      findByGoogleId.mockResolvedValue(customerWithPhone());
      expect((await loginCustomerWithGoogle("valid-token")).status).toBe("AUTHENTICATED");
      expect(claimToken).toHaveBeenCalledTimes(1);
      const [key, expiresAt] = claimToken.mock.calls[0];
      expect(key).toMatch(/^firebase-id:[0-9a-f]{64}$/);
      expect(expiresAt).toEqual(new Date(token.expiresAt * 1000));
    });

    it("refuses a token that was already spent", async () => {
      verifyFirebaseIdTokenMock.mockResolvedValue(googleToken());
      findByGoogleId.mockResolvedValue(customerWithPhone());
      claimToken.mockResolvedValue(false);
      await expect(loginCustomerWithGoogle("valid-token")).rejects.toMatchObject({ status: 409 });
    });

    it("leaves the token unspent when the account still needs a phone, for google-register", async () => {
      verifyFirebaseIdTokenMock.mockResolvedValue(googleToken({ uid: "google-uid-789", email: "newuser@gmail.com" }));
      findByGoogleId.mockResolvedValue(null);
      findByEmail.mockResolvedValue(null);
      expect((await loginCustomerWithGoogle("valid-token")).status).toBe("PHONE_SETUP_REQUIRED");
      expect(claimToken).not.toHaveBeenCalled();
    });

    it("refuses google-register with a spent token and writes nothing", async () => {
      verifyFirebaseIdTokenMock.mockImplementation(phoneOr(googleToken({ uid: "google-uid-999", email: "fresh@gmail.com" })));
      findByGoogleId.mockResolvedValue(null);
      findByEmail.mockResolvedValue(null);
      claimToken.mockResolvedValue(false);
      await expect(
        registerCustomerWithGoogle({ idToken: "google-token", phone: "09123456789", phoneToken: "phone-token" })
      ).rejects.toMatchObject({ status: 409 });
      expect(createCustomer).not.toHaveBeenCalled();
      expect(updateCustomer).not.toHaveBeenCalled();
    });

    // google-register replaced the number and issued a session with no second
    // factor, so a replayed token skipped MFA for an account that had one.
    it("refuses google-register over an account that already has a mobile number", async () => {
      verifyFirebaseIdTokenMock.mockImplementation(phoneOr(googleToken()));
      findByGoogleId.mockResolvedValue(customerWithPhone({ information: { phone: "09987654321", phoneVerified: true } }));
      await expect(
        registerCustomerWithGoogle({ idToken: "google-token", phone: "09123456789", phoneToken: "phone-token" })
      ).rejects.toMatchObject({ status: 409 });
      expect(updateCustomer).not.toHaveBeenCalled();
      expect(claimToken).not.toHaveBeenCalled();
    });
  });
});
