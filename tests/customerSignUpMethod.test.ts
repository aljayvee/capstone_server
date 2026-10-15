import { describe, expect, it } from "vitest";
import { flattenCustomerAccount } from "../src/services/patterns/customerFactory.js";

/**
 * How a customer account was created (2026-10-09): the customer app's Home
 * asks a manual sign-up to verify its mobile number, and a Google sign-up for
 * its birthdate. A Google sign-up has no password; a manual one keeps its
 * password even after Google is linked to it.
 */

const account = (over: Record<string, unknown>) =>
  ({
    id: 4,
    username: "maria",
    email: "maria@example.com",
    googleId: null,
    passwordHash: "$2b$10$hash",
    phoneVerified: false,
    information: { firstName: "Maria", lastName: "Santos", phone: "+639171234567", avatar: null },
    ...over,
  }) as any;

describe("a customer's sign-up method", () => {
  it("is password for a manual sign-up, even with Google linked later", () => {
    expect(flattenCustomerAccount(account({})).signUpMethod).toBe("password");
    expect(flattenCustomerAccount(account({ googleId: "g-123" })).signUpMethod).toBe("password");
  });

  it("is google for an account Google created, which has no password", () => {
    expect(flattenCustomerAccount(account({ passwordHash: null, googleId: "g-123" })).signUpMethod).toBe("google");
  });

  it("never carries the password hash itself", () => {
    expect(flattenCustomerAccount(account({}))).not.toHaveProperty("passwordHash");
  });
});
