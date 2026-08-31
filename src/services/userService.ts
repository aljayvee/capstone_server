import bcrypt from "bcryptjs";
import { userRepository } from "../repositories/userRepository.js";
import { errandRepository } from "../repositories/errandRepository.js";
import * as riderPresenceService from "./riderPresenceService.js";
import * as riderBeaconService from "./riderBeaconService.js";
import { ServiceError } from "./ServiceError.js";
import { withFullName } from "./authService.js";
import { buildUserCreateData } from "./patterns/userFactory.js";
import { normalizeUsername, normalizeEmail } from "../lib/identity.js";
import { ROLE_CHANGE_REAUTH_ROLES } from "../validators/userValidators.js";
import type { CreateUserInput, UpdateUserInput, ProfileUpdateInput, ChangePasswordInput } from "../validators/userValidators.js";
import type { PushTokenInput } from "../validators/pushTokenValidators.js";
import { riderPhotoRepository } from "../repositories/riderPhotoRepository.js";
import type { RiderPhotoUploadInput } from "../validators/riderPhotoValidators.js";

function sanitize<T extends { passwordHash: string }>(user: T) {
  const { passwordHash: _, ...rest } = user;
  return rest;
}

export async function listUsers() {
  const users = await userRepository.findMany();
  return users.map((u) => withFullName(sanitize(u)));
}

export async function createUser(input: CreateUserInput) {
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

// Re-assigning a Dispatcher or Rider immediately changes what that account can
// see and do on the live dispatch board, so it costs the acting admin their own
// password. 403 rather than 401 on purpose: the caller IS authenticated, and a
// 401 would make the dashboard's axios interceptor burn a token refresh and
// retry the very request that was just refused.
async function assertRoleChangeAuthorised(
  currentRole: string,
  nextRole: string,
  adminPassword: string | undefined,
  actingUserId: number | undefined
) {
  const from = String(currentRole).toUpperCase();
  const to = String(nextRole).toUpperCase();
  if (from === to || !ROLE_CHANGE_REAUTH_ROLES.includes(from)) {
    return;
  }

  if (!actingUserId) {
    throw new ServiceError(403, "Sign in again before changing an account's role.");
  }
  if (!adminPassword) {
    throw new ServiceError(
      403,
      "Changing the role of a Dispatcher or Rider account requires your Admin password."
    );
  }

  const actingUser = await userRepository.findById(actingUserId);
  if (!actingUser || String(actingUser.role).toUpperCase() !== "OWNER") {
    throw new ServiceError(403, "Only an Admin account can change the role of a Dispatcher or Rider.");
  }

  const passwordMatches = await bcrypt.compare(adminPassword, actingUser.passwordHash);
  if (!passwordMatches) {
    throw new ServiceError(403, "Incorrect Admin password. The role change was not saved.");
  }
}

export async function updateUser(userId: number, input: UpdateUserInput, actingUserId?: number) {
  const existingUser = await userRepository.findById(userId);
  if (!existingUser) {
    throw new ServiceError(404, "User not found");
  }

  await assertRoleChangeAuthorised(
    existingUser.role,
    input.role ?? existingUser.role,
    input.adminPassword,
    actingUserId
  );

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
  if (input.role !== undefined) updateData.role = input.role.toUpperCase();
  if (input.status !== undefined) updateData.status = input.status;
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

export async function updateProfile(targetUserId: number, input: ProfileUpdateInput) {
  const existingUser = await userRepository.findById(targetUserId);
  if (!existingUser) {
    throw new ServiceError(404, "User not found");
  }

  const newFirstName = input.firstName && input.firstName !== "" ? input.firstName : existingUser.firstName;
  const newLastName = input.lastName && input.lastName !== "" ? input.lastName : existingUser.lastName;
  const newEmail = input.email && input.email !== "" ? input.email : existingUser.email;
  const newPhone = input.phone && input.phone !== "" ? input.phone : existingUser.phone;

  const updatedUser = await userRepository.update(targetUserId, {
    firstName: newFirstName,
    lastName: newLastName,
    email: newEmail,
    phone: newPhone,
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
  await userRepository.updatePushToken(riderId, input.token);
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

export async function getRiderPhoto(riderId: number) {
  const photo = await riderPhotoRepository.findByUserId(riderId);
  if (!photo) {
    throw new ServiceError(404, "No profile photo set");
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
  }));
}

// Filters the same real roster data down to riders who are both enabled and
// currently online — used by the "Assign Rider" picker. Was previously a
// separate hand-written implementation returning hardcoded fake data.
export async function listOnlineRiders() {
  const allRiders = await listAllRiders();
  return allRiders.filter((r) => r.online && r.status === "Active");
}
