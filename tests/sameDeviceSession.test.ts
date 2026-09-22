import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "I log in, then reload, and I'm logged out."
 *
 * Reproduced in a real browser on 2026-09-23: the single-device guard treated a
 * dispatcher's own earlier session from the same browser as "another device",
 * superseding it signed out whatever tab still held it, and the next refresh
 * answered "This session has been signed out. Please log in again."
 *
 * The fix retires same-device sessions quietly before the guard runs. These
 * tests pin the part that matters most: it must only ever match a POSITIVE
 * device id, so it can never quietly retire a session it cannot prove belongs
 * to this browser - including every session recorded before the portal sent
 * a device id at all.
 */

const mockUpdateMany = vi.fn();

vi.mock("../src/lib/prisma.js", () => ({
  prisma: { userSession: { updateMany: (...a: unknown[]) => mockUpdateMany(...a) } },
}));

const { revokeSameDeviceSessions } = await import("../src/services/sessionService.js");

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateMany.mockResolvedValue({ count: 1 });
});

describe("retiring a session from the same browser", () => {
  it("matches only live sessions carrying this exact device id", async () => {
    await revokeSameDeviceSessions(2, "USER", "web-abc", "SUPERSEDED_SAME_DEVICE");

    const { where, data } = mockUpdateMany.mock.calls[0][0];
    expect(where).toEqual({
      subjectId: 2,
      subjectType: "USER",
      deviceId: "web-abc",
      revokedAt: null,
    });
    expect(data.revokedReason).toBe("SUPERSEDED_SAME_DEVICE");
  });

  it("never touches a session recorded without a device id", async () => {
    // Every portal session before this fix carries NULL. An equality match on
    // a string cannot select NULL, which is the point: those sessions may be
    // on another machine, and only the takeover prompt should decide that.
    await revokeSameDeviceSessions(2, "USER", "web-abc", "SUPERSEDED_SAME_DEVICE");

    const { where } = mockUpdateMany.mock.calls[0][0];
    expect(where.deviceId).not.toBeNull();
    expect(where).not.toHaveProperty("OR");
  });

  it("does nothing at all for an empty device id", async () => {
    // An empty string would otherwise match every session stored with one.
    const n = await revokeSameDeviceSessions(2, "USER", "", "SUPERSEDED_SAME_DEVICE");

    expect(n).toBe(0);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it("stays within the subject and subject type it was given", async () => {
    // A customer and a staff user can share a numeric id across tables.
    await revokeSameDeviceSessions(7, "USER", "web-xyz", "SUPERSEDED_SAME_DEVICE");

    const { where } = mockUpdateMany.mock.calls[0][0];
    expect(where.subjectId).toBe(7);
    expect(where.subjectType).toBe("USER");
  });

  it("truncates the id to the column width rather than failing the login", async () => {
    await revokeSameDeviceSessions(2, "USER", "x".repeat(200), "SUPERSEDED_SAME_DEVICE");

    const { where } = mockUpdateMany.mock.calls[0][0];
    expect(where.deviceId).toHaveLength(80);
  });
});
