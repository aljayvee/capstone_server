import { customerRepository } from "../repositories/customerRepository.js";
import { customerTransactionRepository } from "../repositories/customerTransactionRepository.js";
import { customerPhotoRepository } from "../repositories/customerPhotoRepository.js";
import { recordCustomerModifications, getCustomerModificationLogs } from "./accountAuditService.js";
import { ServiceError } from "./ServiceError.js";
import { assignPushToken } from "./pushTokenOwnership.js";
import { withFullName, verifyFirebasePhoneToken, normalizePhoneDigits, assertPhoneAvailable } from "./authService.js";
import { flattenCustomerAccount } from "./patterns/customerFactory.js";
import { formatItemLabel } from "./patterns/itemLabel.js";
import { paymentMethodChangeOf } from "./patterns/paymentModes.js";
import { holdingSiblingFor, type HoldCandidate } from "./patterns/deliveryHold.js";
import type { CustomerProfileUpdateInput } from "../validators/customerValidators.js";

export async function getProfile(customerId: number) {
  const customer = await customerRepository.findById(customerId);
  if (!customer) {
    throw new ServiceError(404, "Customer not found");
  }
  return withFullName(flattenCustomerAccount(customer));
}

export async function updateProfile(
  customerId: number,
  input: CustomerProfileUpdateInput,
  meta: { ipAddress?: string; userAgent?: string; deviceId?: string } = {}
) {
  const existing = await customerRepository.findById(customerId);
  if (!existing) {
    throw new ServiceError(404, "Customer not found");
  }

  const newEmail = input.email && input.email !== "" ? input.email.trim().toLowerCase() : existing.email;
  const newFirstName = input.firstName !== undefined && input.firstName !== "" ? input.firstName.trim() : existing.information?.firstName;
  const newMiddleName = input.middleName !== undefined ? (input.middleName ? input.middleName.trim() : null) : existing.information?.middleName;
  const newLastName = input.lastName !== undefined && input.lastName !== "" ? input.lastName.trim() : existing.information?.lastName;
  const newPhone = input.phone !== undefined && input.phone !== "" ? input.phone.trim() : existing.information?.phone;
  
  const phoneChanged =
    input.phone !== undefined &&
    input.phone.trim() !== "" &&
    normalizePhoneDigits(input.phone) !== normalizePhoneDigits(existing.information?.phone || "");

  let phoneVerified = existing.phoneVerified;
  let phoneVerifiedAt = existing.information?.phoneVerifiedAt;

  if (phoneChanged) {
    if (!input.firebaseIdToken) {
      throw new ServiceError(400, "Verification code required when updating mobile number");
    }
    const tokenPhone = await verifyFirebasePhoneToken(input.firebaseIdToken, newPhone!);
    if (!tokenPhone) {
      throw new ServiceError(400, "Invalid or expired phone verification code");
    }
    // Verified ownership of the SIM does not make the number free: another
    // account may have verified it first (see assertPhoneAvailable).
    await assertPhoneAvailable(newPhone, customerId);
    phoneVerified = true;
    phoneVerifiedAt = new Date();
  }

  let newBirthdate: Date | null | undefined = undefined;
  if (input.birthdate !== undefined) {
    newBirthdate = input.birthdate ? new Date(input.birthdate) : null;
  } else {
    newBirthdate = existing.information?.birthdate;
  }

  const oldState = {
    firstName: existing.information?.firstName,
    middleName: existing.information?.middleName,
    lastName: existing.information?.lastName,
    birthdate: existing.information?.birthdate ? existing.information.birthdate.toISOString().split("T")[0] : null,
    email: existing.email,
    phone: existing.information?.phone,
  };

  const newState = {
    firstName: newFirstName,
    middleName: newMiddleName,
    lastName: newLastName,
    birthdate: newBirthdate ? newBirthdate.toISOString().split("T")[0] : null,
    email: newEmail,
    phone: newPhone,
  };

  try {
    const updated = await customerRepository.update(customerId, {
      email: newEmail,
      phoneVerified,
      information: {
        firstName: newFirstName,
        middleName: newMiddleName,
        lastName: newLastName,
        birthdate: newBirthdate,
        phone: newPhone,
        phoneVerified,
        phoneVerifiedAt,
      },
    });

    // Record audit modification diffs
    await recordCustomerModifications(customerId, oldState, newState, {
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      verifiedVia: meta.deviceId ? "DEVICE_AUTH" : "JWT_SECURE",
    });

    return withFullName(flattenCustomerAccount(updated));
  } catch (err: unknown) {
    const errorObj = err as { code?: string; message?: string };
    if (errorObj?.code === "P2002") {
      throw new ServiceError(400, "Email is already taken by another account");
    }
    throw new ServiceError(400, "Failed to update profile: " + (errorObj?.message || "Unknown error"));
  }
}

export function listModificationLogs(customerId: number) {
  return getCustomerModificationLogs(customerId);
}

function deliveryHoldFromList(errand: HoldCandidate & { status: unknown }, candidates: HoldCandidate[]) {
  const sibling = holdingSiblingFor({ ...errand, status: String(errand.status) }, candidates);
  return sibling ? { errandId: sibling.id } : null;
}

export async function listTransactions(customerId: number) {
  const transactions = await customerTransactionRepository.findByCustomerId(customerId);
  // Every one of this customer's errands is in hand, so a delivery hold (one
  // order waiting for their other, patterns/deliveryHold.ts) is read from the
  // list itself rather than queried per row.
  const holdCandidates = transactions.map((tx) => ({ ...tx.errand, status: String(tx.errand.status) }));

  const orders = transactions.map((tx) => {
    const confirmedMode =
      tx.errand.paymentSelection?.paymentMode?.name ??
      tx.errand.paymentMode?.name ??
      null;

    let effectivePaymentMethod = confirmedMode ?? tx.paymentMethod;
    if (!confirmedMode && (effectivePaymentMethod === "COD" || effectivePaymentMethod === "PENDING" || !effectivePaymentMethod)) {
      const isPastDelivered = tx.errand.status === "DELIVERED" || tx.errand.status === "COMPLETED";
      if (!isPastDelivered) {
        effectivePaymentMethod = "PENDING";
      }
    }

    return {
      id: tx.errandId,
      orderId: tx.errandId,
      status: tx.errand.status,
      categories: tx.errand.pabiliDetails.map((d) => formatItemLabel(d.itemName, d.size)).join(", ") || tx.errand.category,
      grandTotal: Number(tx.errand.totalCost) || Number(tx.amount) || 0,
      deliveryFee: Number(tx.errand.deliveryFee) || 0,
      totalCost: Number(tx.errand.totalCost) || 0,
      estimatedCost: Number(tx.errand.estimatedCost) || 0,
      tip: Number(tx.errand.tip) || 0,
      // What it was actually paid with: a transfer customer who paid cash at
      // the door reads as cash in the list, installed apps included.
      paymentMethod: paymentMethodChangeOf(tx.errand)?.to ?? effectivePaymentMethod,
      // Chosen as a transfer, paid in cash at the door. Same shape as the
      // errand response's, so the list and the details screen agree.
      paymentMethodChange: paymentMethodChangeOf(tx.errand),
      deliveryAddress: tx.errand.deliveryAddress,
      createdAt: tx.errand.createdAt,
      latitude: tx.errand.deliveryLatitude,
      longitude: tx.errand.deliveryLongitude,
      riderId: tx.errand.riderId,
      riderName: tx.errand.rider ? `${tx.errand.rider.firstName} ${tx.errand.rider.lastName}`.trim() : null,
      pinpoints: tx.errand.pinpoints,
      itemsPurchasedAt: tx.errand.itemsPurchasedAt,
      deliveryHold: deliveryHoldFromList(tx.errand, holdCandidates),
    };
  });

  return { orders };
}

export async function uploadCustomerPhoto(
  customerId: number,
  input: { photoData: string; mimeType: "image/jpeg" | "image/jpg" | "image/png"; fileSize: number; fileName?: string },
  meta: { ipAddress?: string; userAgent?: string; deviceId?: string } = {}
) {
  const existing = await customerRepository.findById(customerId);
  if (!existing) {
    throw new ServiceError(404, "Customer not found");
  }

  // 1. Save / Upsert in customer_profile_photos table
  const photoRecord = await customerPhotoRepository.upsert(customerId, input);

  // 2. Also update customer_information.avatar for backwards compatibility
  await customerRepository.update(customerId, {
    information: {
      avatar: input.photoData,
    },
  });

  // 3. Record audit log
  await recordCustomerModifications(
    customerId,
    { avatar: existing.profilePhoto ? "Existing Photo" : null },
    { avatar: `Updated Photo (${input.mimeType}, ${(input.fileSize / 1024).toFixed(1)} KB)` },
    meta
  );

  const updatedProfile = await getProfile(customerId);
  return {
    message: "Profile photo updated successfully",
    photo: {
      id: photoRecord.id,
      mimeType: photoRecord.mimeType,
      fileSize: photoRecord.fileSize,
      fileName: photoRecord.fileName,
      updatedAt: photoRecord.updatedAt,
    },
    user: updatedProfile,
  };
}

export async function deleteCustomerPhoto(
  customerId: number,
  meta: { ipAddress?: string; userAgent?: string; deviceId?: string } = {}
) {
  const existing = await customerRepository.findById(customerId);
  if (!existing) {
    throw new ServiceError(404, "Customer not found");
  }

  await customerPhotoRepository.deleteByCustomerId(customerId);
  await customerRepository.update(customerId, {
    information: {
      avatar: null,
    },
  });

  await recordCustomerModifications(
    customerId,
    { avatar: existing.profilePhoto ? "Existing Photo" : null },
    { avatar: null },
    meta
  );

  const updatedProfile = await getProfile(customerId);
  return {
    message: "Profile photo removed successfully",
    user: updatedProfile,
  };
}

/**
 * Store (or refresh) this customer's Expo push token.
 *
 * Called on every app launch rather than once at signup: Expo tokens are not
 * stable — they change on reinstall, on some OS updates, and when a user
 * revokes and re-grants notification permission. A token written once at
 * registration silently rots, and the failure is invisible because a push to a
 * dead token succeeds at the API level and simply never arrives.
 */
export async function registerPushToken(customerId: number, input: { token: string }) {
  // Taken off every other account first: see pushTokenOwnership.ts.
  await assignPushToken({ kind: "customer", id: customerId }, input.token);
  return { success: true };
}
