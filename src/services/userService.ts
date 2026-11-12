import bcrypt from "bcryptjs";
import { userRepository } from "../repositories/userRepository.js";
import { errandRepository } from "../repositories/errandRepository.js";
import * as riderPresenceService from "./riderPresenceService.js";
import * as riderBeaconService from "./riderBeaconService.js";
import { describeReason } from "../lib/riderAvailability.js";
import { ServiceError } from "./ServiceError.js";
import { withFullName } from "./authService.js";
import { buildUserCreateData } from "./patterns/userFactory.js";
import { normalizeUsername, normalizeEmail } from "../lib/identity.js";
import type { CreateUserInput, UpdateUserInput, ProfileUpdateInput, ChangePasswordInput } from "../validators/userValidators.js";
import type { PushTokenInput } from "../validators/pushTokenValidators.js";
import { assignPushToken } from "./pushTokenOwnership.js";
import { riderPhotoRepository } from "../repositories/riderPhotoRepository.js";
import type { RiderPhotoUploadInput } from "../validators/riderPhotoValidators.js";
import * as userPresenceStore from "../lib/userPresenceStore.js";
import { sendPushNotification } from "../lib/pushNotifications.js";
import * as notificationService from "./notificationService.js";
import * as sessionService from "./sessionService.js";
import { disconnectAccount, notifySessionRevoked } from "../lib/socket.js";
import { dispatcherRef } from "./notificationCatalog.js";
import { logger } from "../lib/logger.js";
import * as accessService from "./accessService.js";

function sanitize<T extends { passwordHash: string }>(user: T) {
  const { passwordHash: _, ...rest } = user;
  return rest;
}

export async function listUsers() {
  const [users, access] = await Promise.all([userRepository.findMany(), accessService.directoryAccess()]);
  return users.map((u) => ({
    ...withFullName(sanitize(u)),
    isOnline: userPresenceStore.isOnline(u.id),
    // For the Users screen: the Main Owner badge and the Group column.
    isMainOwner: u.id === access.mainOwnerId,
    accessGroup: u.accessGroupId ? { id: u.accessGroupId, name: access.groupNames.get(u.accessGroupId) ?? null } : null,
  }));
}

export function getUserPresence() {
  return {
    onlineUserIds: userPresenceStore.getOnlineUserIds(),
  };
}

export async function createUser(input: CreateUserInput, actingUserId?: number) {
  // Admin accounts are the Main Owner's to create (accessService).
  await accessService.assertCanManageAccount(actingUserId, null, input.role);
  try {
    const createData = await buildUserCreateData(input);
    const newUser = await userRepository.create(createData);
    return withFullName(sanitize(newUser));
  } catch (err: unknown) {
    const errorObj = err as { code?: string; message?: string };
    if (errorObj?.code === "P2002") {
      throw new ServiceError(400, "User already exists with provided username or email");
    }
    throw new ServiceError(400, "Failed to create user: " + (errorObj?.message || "Unknown error"));
  }
}

// Role changes need no password re-entry: PUT /users/:id is already limited to
// OWNER by requireRole in userRoutes.ts, and self role changes are refused below.
export async function updateUser(userId: number, input: UpdateUserInput, actingUserId?: number) {
  const existingUser = await userRepository.findById(userId);
  if (!existingUser) {
    throw new ServiceError(404, "User not found");
  }
  // Admin accounts, the Main Owner's own and every move into or out of the
  // Admin role are the Main Owner's (accessService.assertCanManageAccount).
  const nextRole =
    input.role !== undefined && input.role.toUpperCase() !== existingUser.role ? input.role.toUpperCase() : undefined;
  await accessService.assertCanManageAccount(actingUserId, existingUser, nextRole);

  const updateData: Record<string, unknown> = {};
  // Canonicalised on update as well as on create — otherwise renaming a user to
  // "Jayvee" would store a form that sign-in could only find by way of the
  // column collation, which is the implicit dependency this change removes.
  if (input.username !== undefined) updateData.username = normalizeUsername(input.username);
  if (input.firstName !== undefined) updateData.firstName = input.firstName.trim();
  if (input.middleName !== undefined) updateData.middleName = input.middleName.trim();
  if (input.lastName !== undefined) updateData.lastName = input.lastName.trim();
  if (input.email !== undefined) {
    // Canonicalise to lower case so the stored form matches what sign-in looks
    // up, regardless of the database collation.
    const nextEmail = normalizeEmail(input.email);
    updateData.email = nextEmail;
    // Pointing an account at a different mailbox un-proves it. Without this, an
    // admin correcting a typo would leave the account flagged as verified
    // against an address nobody controls; now the next sign-in re-verifies.
    if (nextEmail !== (existingUser.email || "").toLowerCase()) {
      updateData.emailVerified = false;
      updateData.emailVerifiedAt = null;
    }
  }
  if (input.phone !== undefined) updateData.phone = input.phone.trim();
  if (input.role !== undefined) {
    if (actingUserId === userId && input.role.toUpperCase() !== existingUser.role) {
      throw new ServiceError(400, "You cannot change your own operational role while logged in.");
    }
    updateData.role = input.role.toUpperCase();
  }
  if (input.status !== undefined) {
    if (actingUserId === userId && input.status === "Inactive") {
      throw new ServiceError(400, "You cannot deactivate your own account while logged in.");
    }
    updateData.status = input.status;
  }
  if (actingUserId !== undefined) updateData.updatedBy = actingUserId;

  if (input.password && input.password.trim() !== "") {
    updateData.passwordHash = await bcrypt.hash(input.password, 10);
  }

  try {
    const { count } = await userRepository.updateWithVersion(userId, input.version, updateData);
    if (count === 0) {
      const latest = await userRepository.findById(userId);
      throw new ServiceError(409, "This user was modified by someone else. Reload to see the latest changes.", {
        code: "VERSION_CONFLICT",
        latest: latest ? withFullName(sanitize(latest)) : null,
      });
    }
    // A demotion or a deactivation takes effect now, not when the account's
    // 30-day session runs out. Refresh refuses the old role anyway; ending the
    // sessions also closes the live socket and tells the app why (Codex
    // security scan, 2026-11-02). The update itself has landed, so a failure
    // here is logged rather than reported as a failed edit.
    const roleChanged = input.role !== undefined && input.role.toUpperCase() !== existingUser.role;
    const deactivated = input.status !== undefined && input.status !== "Active";
    // An access group belongs to one role, so it does not follow the account.
    if (roleChanged) {
      await accessService
        .onRoleChanged(userId)
        .catch((err) => logger.error(`Failed to clear the access group of user ${userId} after a role change:`, err));
    }
    if (roleChanged || deactivated) {
      await sessionService
        .revokeAllSubjectSessions(userId, "USER", roleChanged ? "ROLE_CHANGED_BY_OWNER" : "ACCOUNT_DEACTIVATED_BY_OWNER")
        .catch((err) => logger.error(`Failed to revoke sessions of user ${userId} after an owner edit:`, err));
      notifySessionRevoked(userId, {
        reason: roleChanged
          ? "Your role was changed by the owner. Please sign in again."
          : "Your account was deactivated by the owner.",
      });
      disconnectAccount(userId);
    }
    const updatedUser = await userRepository.findById(userId);
    return withFullName(sanitize(updatedUser!));
  } catch (err: unknown) {
    if (err instanceof ServiceError) {
      throw err;
    }
    const errorObj = err as { code?: string; message?: string };
    if (errorObj?.code === "P2002") {
      throw new ServiceError(400, "Username or email is already taken by another account");
    }
    throw new ServiceError(400, "Failed to update user: " + (errorObj?.message || "Unknown error"));
  }
}

// For an Admin editing another account through the profile route.
export async function assertCanEditAccount(actingUserId: number | undefined, targetUserId: number) {
  const target = await userRepository.findById(targetUserId);
  if (!target) throw new ServiceError(404, "User not found");
  await accessService.assertCanManageAccount(actingUserId, target);
}

export async function updateProfile(targetUserId: number, input: ProfileUpdateInput) {
  const existingUser = await userRepository.findById(targetUserId);
  if (!existingUser) {
    throw new ServiceError(404, "User not found");
  }

  const newFirstName = input.firstName && input.firstName !== "" ? input.firstName : existingUser.firstName;
  const newLastName = input.lastName && input.lastName !== "" ? input.lastName : existingUser.lastName;
  const newEmail = input.email && input.email !== "" ? normalizeEmail(input.email) : existingUser.email;
  const newPhone = input.phone && input.phone !== "" ? input.phone : existingUser.phone;

  // A changed address or number is unproven, exactly as in updateUser. Here it
  // matters more: this route needs only a bearer token, and password reset
  // sends its code to a VERIFIED email or phone, so keeping the old proof let
  // anyone holding a stolen access token point reset at their own mailbox and
  // take the account for good (Codex security scan, 2026-11-02). The next
  // sign-in proves the new channel through the OTP gate.
  const contactProof: {
    emailVerified?: false;
    emailVerifiedAt?: null;
    phoneVerified?: false;
    phoneVerifiedAt?: null;
  } = {};
  if (newEmail.toLowerCase() !== (existingUser.email || "").toLowerCase()) {
    contactProof.emailVerified = false;
    contactProof.emailVerifiedAt = null;
  }
  if (newPhone.trim() !== (existingUser.phone || "").trim()) {
    contactProof.phoneVerified = false;
    contactProof.phoneVerifiedAt = null;
  }

  const updatedUser = await userRepository.update(targetUserId, {
    firstName: newFirstName,
    lastName: newLastName,
    email: newEmail,
    phone: newPhone,
    ...contactProof,
  });

  return withFullName(sanitize(updatedUser));
}

export async function changePassword(targetUserId: number, input: ChangePasswordInput) {
  const existingUser = await userRepository.findById(targetUserId);
  if (!existingUser) {
    throw new ServiceError(404, "User not found");
  }

  const currentMatches = await bcrypt.compare(input.currentPassword, existingUser.passwordHash);
  if (!currentMatches) {
    throw new ServiceError(401, "Current password is incorrect.");
  }

  const passwordHash = await bcrypt.hash(input.newPassword, 10);
  await userRepository.update(targetUserId, { passwordHash });

  return { message: "Password updated successfully" };
}

export async function registerPushToken(riderId: number, input: PushTokenInput) {
  const existingUser = await userRepository.findById(riderId);
  if (!existingUser) {
    throw new ServiceError(404, "User not found");
  }
  // Taken off every other account first: see pushTokenOwnership.ts.
  await assignPushToken({ kind: "user", id: riderId }, input.token);
}

export async function getRiderProfile(riderId: number) {
  const user = await userRepository.findById(riderId);
  if (!user) {
    throw new ServiceError(404, "Rider user not found in database");
  }
  const photo = await riderPhotoRepository.findMetaByUserId(riderId);
  // A timestamp, not the image. The app uses it to decide whether to fetch the
  // bytes at all and to bust its own cache when the rider changes their photo —
  // both of which a profile read would otherwise pay for on every load.
  return { ...withFullName(sanitize(user)), photoUpdatedAt: photo?.updatedAt ?? null };
}

/** True for an OWNER or DISPATCHER account: the people customers talk to. */
export async function isStaffMember(userId: number): Promise<boolean> {
  const user = await userRepository.findById(userId);
  return user?.role === "OWNER" || user?.role === "DISPATCHER";
}

export async function getRiderPhoto(riderId: number) {
  const photo = await riderPhotoRepository.findByUserId(riderId);
  if (!photo) {
    return {
      photoData: null,
      mimeType: null,
      fileSize: 0,
      fileName: null,
      updatedAt: null,
    };
  }
  return {
    photoData: photo.photoData,
    mimeType: photo.mimeType,
    fileSize: photo.fileSize,
    fileName: photo.fileName,
    updatedAt: photo.updatedAt,
  };
}

export async function uploadRiderPhoto(riderId: number, input: RiderPhotoUploadInput) {
  const user = await userRepository.findById(riderId);
  if (!user) {
    throw new ServiceError(404, "Rider user not found in database");
  }
  const photo = await riderPhotoRepository.upsert(riderId, input);
  return {
    message: "Profile photo updated",
    photo: {
      id: photo.id,
      mimeType: photo.mimeType,
      fileSize: photo.fileSize,
      fileName: photo.fileName,
      updatedAt: photo.updatedAt,
    },
  };
}

export async function deleteRiderPhoto(riderId: number) {
  const user = await userRepository.findById(riderId);
  if (!user) {
    throw new ServiceError(404, "Rider user not found in database");
  }
  await riderPhotoRepository.deleteByUserId(riderId);
  return { message: "Profile photo removed" };
}

// Full fleet roster (all statuses, real active-order counts, real online
// presence) — backs dispatcher/owner rider-monitoring views and the
// "Assign Rider" picker (via listOnlineRiders below).
export async function listAllRiders() {
  const riders = await userRepository.findAllRiders();
  const [activeCounts, availability] = await Promise.all([
    errandRepository.countActiveByRider(),
    // The same beacon-derived state dispatch uses. When the roster said "online"
    // from a socket and dispatch decided from something else, a dispatcher could
    // watch a rider sit there green and still be told nobody was available.
    riderBeaconService.availabilityForRiders(riders.map((r) => r.id)),
  ]);

  const countByRiderId = new Map<number, number>();
  for (const entry of activeCounts) {
    if (entry.riderId !== null) {
      countByRiderId.set(entry.riderId, entry._count._all);
    }
  }

  return riders.map((r) => ({
    id: r.id,
    name: `${r.firstName} ${r.lastName}`.trim(),
    phone: r.phone,
    avatar: r.avatar,
    status: r.status,
    activeOrdersCount: countByRiderId.get(r.id) ?? 0,
    online: availability.get(r.id)?.dispatchable ?? false,
    // Named separately from `online` so the board can distinguish a rider in a
    // dead zone from one who has notifications switched off — and can say
    // "presumed offline" where the server only inferred it from silence.
    availability: availability.get(r.id)?.state ?? "OFFLINE",
    presumed: availability.get(r.id)?.presumed ?? true,
    impediments: availability.get(r.id)?.impediments ?? [],
    // The three statuses the dispatcher and owner screens show (see
    // riderStatusOf), with the reason in words and when the rider was last
    // heard from, so "signal lost" can say for how long.
    riderStatus: availability.get(r.id)?.riderStatus ?? "OFFLINE",
    riderStatusReason: availability.get(r.id)?.riderStatusReason ?? "never_connected",
    riderStatusText: describeReason(availability.get(r.id)?.riderStatusReason ?? "never_connected"),
    lastBeaconAt: availability.get(r.id)?.lastBeaconAt ?? null,
  }));
}

// Filters the same real roster data down to riders who are both enabled and
// currently online — used by the "Assign Rider" picker. Was previously a
// separate hand-written implementation returning hardcoded fake data.
export async function listOnlineRiders() {
  const allRiders = await listAllRiders();
  return allRiders.filter((r) => r.online && r.status === "Active");
}

const lastRiderChatNotifyTime = new Map<number, number>();

export async function notifyRiderChatMessage(
  riderId: number,
  dispatcherId: number,
  text: string,
  senderName?: string,
  hasImage?: boolean
) {
  const rider = await userRepository.findById(riderId);
  if (!rider) {
    throw new ServiceError(404, "Rider not found");
  }

  // 2-second cooldown per rider to avoid notification spam
  const now = Date.now();
  const lastTime = lastRiderChatNotifyTime.get(riderId) || 0;
  if (now - lastTime < 2000) {
    return { skipped: true, reason: "cooldown" };
  }
  lastRiderChatNotifyTime.set(riderId, now);

  const name = (senderName || "").trim() || "Dispatcher";
  const bodyText = text
    ? (text.length > 120 ? `${text.slice(0, 117)}...` : text)
    : "Sent a photo";

  // Saved too (2026-10-22): one unread row per dispatcher conversation in the
  // rider's notification screen, bumped with the latest line.
  try {
    await notificationService.deliverToRider(
      riderId,
      "DISPATCHER_CHAT",
      { title: `Message from ${name}`, body: bodyText },
      dispatcherRef(dispatcherId)
    );
  } catch (error) {
    logger.error(`Could not save the dispatcher chat notification for rider ${riderId}:`, error);
  }

  if (rider.expoPushToken) {
    await sendPushNotification(rider.expoPushToken, {
      title: name,
      body: bodyText,
      data: {
        type: "DISPATCHER_CHAT",
        riderId,
        dispatcherId,
      },
      urgent: true,
      channelId: "chats",
      tag: `rider_chat_${riderId}`,
    });
  }

  return { success: true };
}

