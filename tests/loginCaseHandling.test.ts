import { describe, expect, it, vi, beforeEach } from "vitest";
import bcrypt from "bcryptjs";

/**
 * Pins how casing is treated at sign-in.
 *
 * Three different rules apply to the three fields, and the differences are
 * deliberate rather than accidental — which is exactly why they are easy to
 * mistake for a bug when seen from the outside:
 *
 *   password  case-SENSITIVE   — it is the secret; anything else destroys entropy
 *   email     case-INSENSITIVE — mail providers are, and phone keyboards
 *                                autocapitalise the first letter
 *   username  case-INSENSITIVE — same reasoning as email
 *
 * The username rule used to hold only because `users.username` and
 * `customer_accounts.username` are declared `utf8mb4_unicode_ci`, where `_ci`
 * means the column itself ignores case. Nothing in the source said so — the
 * query read as an exact match — so the real rule lived in a column definition,
 * and would have changed silently under a collation edit or a move to Postgres.
 * It is now enforced by src/lib/identity.ts on every read and write, and these
 * tests fail if anyone puts a raw string back into a query.
 */

const { findUnique, findFirst } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findFirst: vi.fn(),
}));
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    customerAccount: { findUnique, findFirst },
    user: { findUnique, findFirst },
  },
}));

import { customerRepository } from "../src/repositories/customerRepository.js";
import { userRepository } from "../src/repositories/userRepository.js";
import { normalizeUsername, normalizeEmail, looksLikeEmail } from "../src/lib/identity.js";
import { loginSchema, customerRegisterSchema } from "../src/validators/authValidators.js";

beforeEach(() => {
  findUnique.mockReset().mockResolvedValue(null);
  findFirst.mockReset().mockResolvedValue(null);
});

describe("password casing is preserved end to end", () => {
  it("the login schema does not alter the case of a password", () => {
    // The single most important assertion in this file. A `.toLowerCase()`
    // anywhere on this path would collapse the alphabet of every password from
    // 62 characters to 36 and silently weaken every account in the system.
    const parsed = loginSchema.parse({ username: "jayvee", password: "Astrowarden12" });
    expect(parsed.password).toBe("Astrowarden12");
  });

  it("the registration schema does not alter the case of a password", () => {
    const parsed = customerRegisterSchema.parse({
      username: "jayvee",
      password: "Astrowarden12",
      email: "juandelacruz@gmail.com",
      firstName: "Juan",
      lastName: "Dela Cruz",
    });
    expect(parsed.password).toBe("Astrowarden12");
  });

  it("bcrypt rejects the same password in the wrong case", async () => {
    const hash = await bcrypt.hash("Astrowarden12", 10);

    await expect(bcrypt.compare("Astrowarden12", hash)).resolves.toBe(true);
    await expect(bcrypt.compare("astrowarden12", hash)).resolves.toBe(false);
    await expect(bcrypt.compare("ASTROWARDEN12", hash)).resolves.toBe(false);
    await expect(bcrypt.compare("aSTROWARDEN12", hash)).resolves.toBe(false);
  });

  it("preserves spaces inside a password while trimming the edges", () => {
    // Edge whitespace is trimmed at registration too, so a password with
    // leading or trailing spaces can never be stored — trimming at login
    // therefore matches something that could not have been the secret anyway,
    // and costs no entropy. Interior spaces are a passphrase and must survive.
    expect(loginSchema.parse({ username: "u", password: "  Astrowarden12  " }).password).toBe(
      "Astrowarden12"
    );
    expect(loginSchema.parse({ username: "u", password: "open sesame please" }).password).toBe(
      "open sesame please"
    );
  });
});

describe("email identifiers are matched case-insensitively", () => {
  it.each([
    "juandelacruz@gmail.com",
    "juANdelAcRuz@gmail.com",
    "JuanDelaCruz@gmail.com",
    "JUANDELACRUZ@GMAIL.COM",
  ])("looks up %s as the same lowercased address (customer)", async (identifier) => {
    await customerRepository.findByIdentifier(identifier);

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: "juandelacruz@gmail.com" } })
    );
  });

  it("applies the same rule to staff accounts", async () => {
    await userRepository.findByIdentifier("JuanDelaCruz@Gmail.com");

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: "juandelacruz@gmail.com" } })
    );
  });

  it("routes an identifier without @ to the username column", async () => {
    await customerRepository.findByIdentifier("Jayvee");

    expect(findFirst).not.toHaveBeenCalled();
    expect(findUnique).toHaveBeenCalled();
  });
});

describe("username identifiers are normalised in application code", () => {
  // The behaviour users see is unchanged; what changed is that it no longer
  // depends on `utf8mb4_unicode_ci` being in force. These assertions fail if
  // anyone reverts to passing the raw string through to the query.
  it.each(["jayvee", "Jayvee", "JAYVEE", "  JaYvEe  "])(
    "looks up %s as the same canonical username (customer)",
    async (identifier) => {
      await customerRepository.findByIdentifier(identifier);

      expect(findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { username: "jayvee" } })
      );
    }
  );

  it("applies the same rule to staff accounts", async () => {
    await userRepository.findByIdentifier("JAYVEE");

    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { username: "jayvee" } })
    );
  });

  it("asks the duplicate check in canonical form", async () => {
    // Otherwise "Jayvee" registers alongside "jayvee" and the two accounts are
    // indistinguishable at sign-in.
    await customerRepository.findByUsernameOrEmail("Jayvee", "JuanDelaCruz@Gmail.com");

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [{ username: "jayvee" }, { email: "juandelacruz@gmail.com" }],
        },
      })
    );
  });
});

describe("identity helpers", () => {
  it.each([
    ["Jayvee", "jayvee"],
    ["  JAYVEE  ", "jayvee"],
    ["jayvee", "jayvee"],
  ])("normalizeUsername(%s) is %s", (input, expected) => {
    expect(normalizeUsername(input)).toBe(expected);
  });

  it.each([
    ["juANdelAcRuz@gmail.com", "juandelacruz@gmail.com"],
    ["  JuanDelaCruz@Gmail.com ", "juandelacruz@gmail.com"],
  ])("normalizeEmail(%s) is %s", (input, expected) => {
    expect(normalizeEmail(input)).toBe(expected);
  });

  it("classifies identifiers by the presence of @", () => {
    expect(looksLikeEmail("juandelacruz@gmail.com")).toBe(true);
    expect(looksLikeEmail("jayvee")).toBe(false);
  });
});
