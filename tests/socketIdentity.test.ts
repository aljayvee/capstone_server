import { beforeEach, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";

/**
 * Which token a socket handshake accepts as an identity. It used to check the
 * signature only, so a signed-out token still joined that account's private
 * rooms; it now applies authenticateToken's tests (Codex security scan,
 * 2026-11-02). Anything refused connects anonymous, as before.
 */

const { isRevoked } = vi.hoisted(() => ({ isRevoked: vi.fn(async () => false) }));

vi.mock("../src/lib/prisma.js", () => ({ prisma: {} }));
vi.mock("../src/lib/blocklistCache.js", () => ({ isRevoked, markRevoked: vi.fn() }));

import { identifySocketToken } from "../src/lib/socket.js";
import { JWT_SECRET } from "../src/config/env.js";

const sign = (claims: object) => jwt.sign(claims, JWT_SECRET as string, { expiresIn: "15m" });

beforeEach(() => {
  isRevoked.mockReset();
  isRevoked.mockResolvedValue(false);
});

describe("identifySocketToken", () => {
  it("accepts a live session token", async () => {
    await expect(identifySocketToken(sign({ id: 9, role: "dispatcher" }))).resolves.toEqual({ userId: 9, role: "DISPATCHER" });
  });

  it("refuses a token that has been signed out", async () => {
    isRevoked.mockResolvedValue(true);
    await expect(identifySocketToken(sign({ id: 9, role: "DISPATCHER" }))).resolves.toBeNull();
  });

  it("refuses when the sign-out list cannot be read", async () => {
    isRevoked.mockRejectedValue(new Error("database down"));
    await expect(identifySocketToken(sign({ id: 9, role: "DISPATCHER" }))).resolves.toBeNull();
  });

  it("refuses a signed token that is not a session token", async () => {
    await expect(identifySocketToken(sign({ id: 9, role: "OWNER", purpose: "SOMETHING_ELSE" }))).resolves.toBeNull();
    await expect(identifySocketToken(sign({ adminId: 1, purpose: "SYSADMIN_2FA" }))).resolves.toBeNull();
    await expect(identifySocketToken(sign({ id: 9 }))).resolves.toBeNull();
  });

  it("refuses an expired, forged or missing token", async () => {
    const expired = jwt.sign({ id: 9, role: "DISPATCHER" }, JWT_SECRET as string, { expiresIn: -10 });
    const forged = jwt.sign({ id: 9, role: "OWNER" }, "not-the-secret");
    await expect(identifySocketToken(expired)).resolves.toBeNull();
    await expect(identifySocketToken(forged)).resolves.toBeNull();
    await expect(identifySocketToken(undefined)).resolves.toBeNull();
    await expect(identifySocketToken("")).resolves.toBeNull();
  });
});
