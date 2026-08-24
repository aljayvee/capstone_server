import { describe, expect, it, vi, beforeEach } from "vitest";

// A stub Prisma client, so the repository can be exercised without a database.
// findUnique/findFirst just record how they were called — the rule under test
// is which one the identifier is routed to, and with what value.
const { findUnique, findFirst } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findFirst: vi.fn(),
}));
vi.mock("../src/lib/prisma.js", () => ({
  prisma: { customerAccount: { findUnique, findFirst } },
}));

import { customerRepository } from "../src/repositories/customerRepository.js";
import { loginSchema, customerRegisterSchema } from "../src/validators/authValidators.js";

beforeEach(() => {
  findUnique.mockReset().mockResolvedValue(null);
  findFirst.mockReset().mockResolvedValue(null);
});

describe("customerRepository.findByIdentifier", () => {
  it("looks a plain identifier up as a username", async () => {
    await customerRepository.findByIdentifier("juandelacruz");

    expect(findFirst).not.toHaveBeenCalled();
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { username: "juandelacruz" } })
    );
  });

  it("looks an identifier containing @ up as an email, lowercased", async () => {
    await customerRepository.findByIdentifier("Juan.DelaCruz@Gmail.com");

    expect(findUnique).not.toHaveBeenCalled();
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: "juan.delacruz@gmail.com" } })
    );
  });

  it("returns null for a blank identifier instead of querying", async () => {
    await expect(customerRepository.findByIdentifier("   ")).resolves.toBeNull();

    expect(findUnique).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
  });
});

describe("loginSchema password", () => {
  it("trims the edges and keeps the spaces inside", () => {
    const parsed = loginSchema.parse({ username: "juandelacruz", password: "  my pass word  " });

    expect(parsed.password).toBe("my pass word");
  });

  it("rejects a password of nothing but spaces — trimmed, that is an empty box", () => {
    expect(() => loginSchema.parse({ username: "juandelacruz", password: "      " })).toThrow();
  });

  it("trims the identifier too", () => {
    expect(loginSchema.parse({ username: "  juandelacruz  ", password: "x" }).username).toBe(
      "juandelacruz"
    );
  });

  it("rejects an empty password", () => {
    expect(() => loginSchema.parse({ username: "juandelacruz", password: "" })).toThrow();
  });
});

describe("customerRegisterSchema password", () => {
  const base = {
    username: "juandelacruz",
    email: "juan@gmail.com",
    firstName: "Juan",
    lastName: "Dela Cruz",
  };

  it("hashes the edge-trimmed password, inner spaces intact", () => {
    expect(customerRegisterSchema.parse({ ...base, password: " open sesame " }).password).toBe(
      "open sesame"
    );
  });

  it("counts inner spaces toward the 6-character minimum", () => {
    expect(customerRegisterSchema.parse({ ...base, password: "ab cde" }).password).toBe("ab cde");
  });

  it("measures the minimum after the trim, not before", () => {
    // 8 characters typed, 5 once the padding is gone — too short.
    expect(() => customerRegisterSchema.parse({ ...base, password: " abcde  " })).toThrow(
      /at least 6/
    );
  });

  it("rejects a password that is nothing but spaces", () => {
    expect(() => customerRegisterSchema.parse({ ...base, password: "        " })).toThrow();
  });
});
