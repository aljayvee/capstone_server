import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What a change to a staff account does to the access it already holds
 * (Codex security scan, 2026-11-02):
 * - a self-service email or phone change is unproven, so it cannot be where a
 *   password reset code goes (a stolen access token used to make it so);
 * - a demotion or deactivation ends the account's sessions and live sockets;
 * - a sysadmin suspension closes live sockets as well as sessions.
 */

const { findById, update, updateWithVersion, revokeAllSubjectSessions, prisma } = vi.hoisted(() => ({
  findById: vi.fn(),
  update: vi.fn(async (_id: number, data: object) => ({ id: 9, firstName: "Jo", lastName: "Cruz", ...data })),
  updateWithVersion: vi.fn(async () => ({ count: 1 })),
  revokeAllSubjectSessions: vi.fn(async () => 1),
  prisma: {
    // findFirst answers the Main Owner lookup (lib/mainOwner.ts): id 1, the
    // acting owner in these tests.
    user: { findUnique: vi.fn(), findFirst: vi.fn(async () => ({ id: 1 })), update: vi.fn(async () => ({})) },
    customerAccount: { findUnique: vi.fn(), update: vi.fn(async () => ({})) },
    accountModificationLog: { create: vi.fn(async () => ({})) },
    userPermissionOverride: { deleteMany: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
  },
}));

vi.mock("../src/lib/prisma.js", () => ({ prisma }));
vi.mock("../src/repositories/userRepository.js", () => ({ userRepository: { findById, update, updateWithVersion } }));
vi.mock("../src/services/sessionService.js", async (orig) => ({
  ...(await orig<typeof import("../src/services/sessionService.js")>()),
  revokeAllSubjectSessions,
}));
vi.mock("../src/lib/socket.js", async (orig) => ({
  ...(await orig<typeof import("../src/lib/socket.js")>()),
  notifySessionRevoked: vi.fn(),
  disconnectAccount: vi.fn(),
}));

import { updateProfile, updateUser } from "../src/services/userService.js";
import { updateAccountStatus } from "../src/services/sysAdminUserService.js";
import { disconnectAccount, notifySessionRevoked } from "../src/lib/socket.js";

const dispatcher = {
  id: 9,
  username: "jo",
  firstName: "Jo",
  lastName: "Cruz",
  email: "jo@sugo.example",
  phone: "09171234567",
  role: "DISPATCHER",
  status: "Active",
  emailVerified: true,
  phoneVerified: true,
  passwordHash: "x",
};

beforeEach(() => {
  vi.clearAllMocks();
  findById.mockResolvedValue({ ...dispatcher });
});

describe("self-service profile edit", () => {
  it("un-proves a changed email so password reset cannot be sent to it", async () => {
    await updateProfile(9, { email: "Attacker@Example.com" });
    expect(update).toHaveBeenCalledWith(
      9,
      expect.objectContaining({ email: "attacker@example.com", emailVerified: false, emailVerifiedAt: null })
    );
    expect(update.mock.calls[0][1]).not.toHaveProperty("phoneVerified");
  });

  it("un-proves a changed phone number for the same reason", async () => {
    await updateProfile(9, { phone: "09998887777" });
    expect(update).toHaveBeenCalledWith(9, expect.objectContaining({ phoneVerified: false, phoneVerifiedAt: null }));
  });

  it("keeps the proof when the address is the same one, whatever its case", async () => {
    await updateProfile(9, { firstName: "Joanna", email: "JO@sugo.example" });
    expect(update.mock.calls[0][1]).not.toHaveProperty("emailVerified");
  });
});

describe("owner edit of a staff account", () => {
  it("ends the sessions and live sockets of a demoted account", async () => {
    await updateUser(9, { role: "RIDER", version: 1 } as never, 1);
    expect(revokeAllSubjectSessions).toHaveBeenCalledWith(9, "USER", "ROLE_CHANGED_BY_OWNER");
    expect(notifySessionRevoked).toHaveBeenCalledWith(9, expect.objectContaining({ reason: expect.any(String) }));
    expect(disconnectAccount).toHaveBeenCalledWith(9);
  });

  it("ends them for a deactivated account", async () => {
    await updateUser(9, { status: "Inactive", version: 1 } as never, 1);
    expect(revokeAllSubjectSessions).toHaveBeenCalledWith(9, "USER", "ACCOUNT_DEACTIVATED_BY_OWNER");
    expect(disconnectAccount).toHaveBeenCalledWith(9);
  });

  it("leaves them alone for a name change, or the same role sent back", async () => {
    await updateUser(9, { firstName: "Joanna", role: "dispatcher", status: "Active", version: 1 } as never, 1);
    expect(revokeAllSubjectSessions).not.toHaveBeenCalled();
    expect(disconnectAccount).not.toHaveBeenCalled();
  });

  it("drops the account's access group and overrides when its role changes", async () => {
    await updateUser(9, { role: "RIDER", version: 1 } as never, 1);
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 9 }, data: { accessGroupId: null } });
    expect(prisma.userPermissionOverride.deleteMany).toHaveBeenCalledWith({ where: { userId: 9 } });
  });

  it("refuses an Admin who is not the Main Owner promoting someone to Admin", async () => {
    await expect(updateUser(9, { role: "OWNER", version: 1 } as never, 4)).rejects.toMatchObject({ status: 403 });
    expect(updateWithVersion).not.toHaveBeenCalled();
  });
});

describe("sysadmin status change", () => {
  it("closes a suspended dispatcher's live sockets as well as their sessions", async () => {
    prisma.user.findUnique.mockResolvedValue({ ...dispatcher });
    await updateAccountStatus("DISPATCHER", 9, "Suspended", "it_admin");
    expect(revokeAllSubjectSessions).toHaveBeenCalledWith(9, "USER", "ACCOUNT_SUSPENDED_BY_SYSADMIN");
    expect(disconnectAccount).toHaveBeenCalledWith(9);
  });

  it("closes a locked customer's sockets in the customer room, not the staff one", async () => {
    prisma.customerAccount.findUnique.mockResolvedValue({ id: 9, status: "Active" });
    await updateAccountStatus("CUSTOMER", 9, "Locked", "it_admin");
    expect(disconnectAccount).toHaveBeenCalledWith(9, "CUSTOMER");
  });

  it("does not disconnect anyone when an account is restored", async () => {
    prisma.user.findUnique.mockResolvedValue({ ...dispatcher, status: "Suspended" });
    await updateAccountStatus("DISPATCHER", 9, "Active", "it_admin");
    expect(disconnectAccount).not.toHaveBeenCalled();
  });
});
