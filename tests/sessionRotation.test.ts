import { describe, expect, it, vi, beforeEach } from "vitest";

// Stub Prisma so the rotation rules can be exercised without a database. The
// session row is held in a local variable that `findUnique` returns and
// `update`/`updateMany` mutate, which is enough to model the one thing that
// matters here: what the server remembers between two refresh calls.
const { findUnique, update, updateMany, create, deleteMany } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  create: vi.fn(),
  deleteMany: vi.fn(),
}));
vi.mock("../src/lib/prisma.js", () => ({
  prisma: { userSession: { findUnique, update, updateMany, create, deleteMany } },
}));

import * as sessionService from "../src/services/sessionService.js";
import { ServiceError } from "../src/services/ServiceError.js";

const SESSION_ID = "11111111-2222-3333-4444-555555555555";
const CURRENT_TOKEN = "refresh-token-current";
const NEXT_TOKEN = "refresh-token-next";

type Row = {
  id: string;
  subjectId: number;
  subjectType: string;
  role: string;
  tokenHash: string;
  previousHash: string | null;
  rotatedAt: Date | null;
  deviceId: string | null;
  userAgent: string | null;
  ipAddress: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
};

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: SESSION_ID,
    subjectId: 42,
    subjectType: "CUSTOMER",
    role: "CUSTOMER",
    tokenHash: sessionService.hashToken(CURRENT_TOKEN),
    previousHash: null,
    rotatedAt: null,
    deviceId: null,
    userAgent: null,
    ipAddress: null,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    revokedAt: null,
    revokedReason: null,
    ...overrides,
  };
}

/** Every rotation mints this, standing in for a freshly signed JWT. */
const mint = () => NEXT_TOKEN;

beforeEach(() => {
  findUnique.mockReset();
  update.mockReset().mockResolvedValue(undefined);
  updateMany.mockReset().mockResolvedValue({ count: 1 });
  create.mockReset().mockResolvedValue(undefined);
  deleteMany.mockReset().mockResolvedValue({ count: 0 });
});

describe("hashToken", () => {
  it("never returns the token it was given", () => {
    // The whole point of the column: a database read must not yield a usable
    // credential.
    const hash = sessionService.hashToken(CURRENT_TOKEN);
    expect(hash).not.toContain(CURRENT_TOKEN);
    expect(hash).toHaveLength(64);
  });

  it("is stable and collision-distinct", () => {
    expect(sessionService.hashToken(CURRENT_TOKEN)).toBe(sessionService.hashToken(CURRENT_TOKEN));
    expect(sessionService.hashToken(CURRENT_TOKEN)).not.toBe(sessionService.hashToken(NEXT_TOKEN));
  });
});

describe("subjectTypeForRole", () => {
  it.each([
    ["CUSTOMER", "CUSTOMER"],
    ["customer", "CUSTOMER"],
    ["RIDER", "USER"],
    ["OWNER", "USER"],
    ["DISPATCHER", "USER"],
  ])("maps %s to %s", (role, expected) => {
    // A customer id and a staff id can be the same integer; the pair is what
    // identifies the account.
    expect(sessionService.subjectTypeForRole(role)).toBe(expected);
  });
});

describe("rotateSession — happy path", () => {
  it("rotates the stored hash and slides the expiry", async () => {
    findUnique.mockResolvedValue(row());

    const result = await sessionService.rotateSession(SESSION_ID, CURRENT_TOKEN, mint);

    expect(result.refreshToken).toBe(NEXT_TOKEN);
    expect(result.outcome.rotated).toBe(true);

    const written = update.mock.calls[0][0].data;
    expect(written.tokenHash).toBe(sessionService.hashToken(NEXT_TOKEN));
    // The retired token is remembered, which is what makes a later replay
    // recognisable rather than merely unknown.
    expect(written.previousHash).toBe(sessionService.hashToken(CURRENT_TOKEN));
    // Sliding window: a phone in daily use never reaches its expiry.
    expect(written.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000);
  });
});

describe("rotateSession — replay detection", () => {
  it("revokes the session when a rotated-away token comes back", async () => {
    // Rotated long enough ago that the concurrency grace window has closed.
    findUnique.mockResolvedValue(
      row({
        tokenHash: sessionService.hashToken(NEXT_TOKEN),
        previousHash: sessionService.hashToken(CURRENT_TOKEN),
        rotatedAt: new Date(Date.now() - 5 * 60 * 1000),
      })
    );

    await expect(
      sessionService.rotateSession(SESSION_ID, CURRENT_TOKEN, mint)
    ).rejects.toBeInstanceOf(ServiceError);

    // Rejecting the one call is not enough: the legitimate client still holds a
    // working token, so a thief could simply keep trying. The family dies.
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ revokedReason: "REFRESH_TOKEN_REUSE" }),
      })
    );
  });

  it("revokes when the presented token matches nothing at all", async () => {
    findUnique.mockResolvedValue(row());

    await expect(
      sessionService.rotateSession(SESSION_ID, "a-token-from-nowhere", mint)
    ).rejects.toBeInstanceOf(ServiceError);

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ revokedReason: "REFRESH_TOKEN_REUSE" }),
      })
    );
  });

  it("does not mint a replacement for a replayed token", async () => {
    findUnique.mockResolvedValue(row());
    const spy = vi.fn(mint);

    await expect(sessionService.rotateSession(SESSION_ID, "wrong", spy)).rejects.toThrow();

    expect(spy).not.toHaveBeenCalled();
  });
});

describe("rotateSession — concurrency grace window", () => {
  it("serves a just-rotated token without rotating again", async () => {
    // A phone waking from background fires several requests at once; they 401
    // together and the losers arrive holding the token the winner just retired.
    findUnique.mockResolvedValue(
      row({
        tokenHash: sessionService.hashToken(NEXT_TOKEN),
        previousHash: sessionService.hashToken(CURRENT_TOKEN),
        rotatedAt: new Date(),
      })
    );

    const result = await sessionService.rotateSession(SESSION_ID, CURRENT_TOKEN, mint);

    // No replacement is handed back, so the client keeps the token it stored —
    // returning a second new token here would desynchronise the two callers.
    expect(result.refreshToken).toBeNull();
    expect(result.outcome.rotated).toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("treats the same token as a replay once the window closes", async () => {
    findUnique.mockResolvedValue(
      row({
        tokenHash: sessionService.hashToken(NEXT_TOKEN),
        previousHash: sessionService.hashToken(CURRENT_TOKEN),
        rotatedAt: new Date(Date.now() - 60 * 1000),
      })
    );

    await expect(sessionService.rotateSession(SESSION_ID, CURRENT_TOKEN, mint)).rejects.toThrow();
  });
});

describe("rotateSession — device binding", () => {
  it("revokes when the refresh arrives from a different device", async () => {
    findUnique.mockResolvedValue(row({ deviceId: "DEV-ANDROID-original" }));

    await expect(
      sessionService.rotateSession(SESSION_ID, CURRENT_TOKEN, mint, {
        deviceId: "DEV-IOS-somewhere-else",
      })
    ).rejects.toBeInstanceOf(ServiceError);

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ revokedReason: "DEVICE_MISMATCH" }),
      })
    );
  });

  it("allows a refresh when the caller sends no device id", async () => {
    // The web dashboard sends none. Comparing against null would lock it out.
    findUnique.mockResolvedValue(row({ deviceId: "DEV-ANDROID-original" }));

    const result = await sessionService.rotateSession(SESSION_ID, CURRENT_TOKEN, mint, {});

    expect(result.refreshToken).toBe(NEXT_TOKEN);
  });

  it("allows a refresh when the session recorded no device id", async () => {
    findUnique.mockResolvedValue(row({ deviceId: null }));

    const result = await sessionService.rotateSession(SESSION_ID, CURRENT_TOKEN, mint, {
      deviceId: "DEV-ANDROID-new",
    });

    expect(result.refreshToken).toBe(NEXT_TOKEN);
  });
});

describe("rotateSession — dead sessions", () => {
  it("rejects an unknown session id", async () => {
    findUnique.mockResolvedValue(null);
    await expect(sessionService.rotateSession(SESSION_ID, CURRENT_TOKEN, mint)).rejects.toThrow();
  });

  it("rejects a revoked session", async () => {
    findUnique.mockResolvedValue(row({ revokedAt: new Date(), revokedReason: "USER_LOGOUT" }));
    await expect(sessionService.rotateSession(SESSION_ID, CURRENT_TOKEN, mint)).rejects.toThrow();
  });

  it("rejects an expired session", async () => {
    findUnique.mockResolvedValue(row({ expiresAt: new Date(Date.now() - 1000) }));
    await expect(sessionService.rotateSession(SESSION_ID, CURRENT_TOKEN, mint)).rejects.toThrow();
  });

  it("does not revoke an already-expired session a second time", async () => {
    // Expiry is not a security event — it must not be recorded as one.
    findUnique.mockResolvedValue(row({ expiresAt: new Date(Date.now() - 1000) }));
    await expect(sessionService.rotateSession(SESSION_ID, CURRENT_TOKEN, mint)).rejects.toThrow();
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe("createSession", () => {
  it("stores the hash and never the token", async () => {
    await sessionService.createSession(
      SESSION_ID,
      { id: 42, role: "CUSTOMER", subjectType: "CUSTOMER" },
      CURRENT_TOKEN,
      { deviceId: "DEV-ANDROID-1", userAgent: "okhttp", ipAddress: "203.0.113.9" }
    );

    const data = create.mock.calls[0][0].data;
    expect(data.tokenHash).toBe(sessionService.hashToken(CURRENT_TOKEN));
    expect(JSON.stringify(data)).not.toContain(CURRENT_TOKEN);
    expect(data.deviceId).toBe("DEV-ANDROID-1");
  });
});

describe("revokeAllForSubject", () => {
  it("signs out every live session for one account", async () => {
    updateMany.mockResolvedValue({ count: 3 });

    const count = await sessionService.revokeAllForSubject("CUSTOMER", 42, "PASSWORD_RESET");

    expect(count).toBe(3);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { subjectType: "CUSTOMER", subjectId: 42, revokedAt: null },
        data: expect.objectContaining({ revokedReason: "PASSWORD_RESET" }),
      })
    );
  });
});
