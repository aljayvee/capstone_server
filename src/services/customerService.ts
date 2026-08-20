import { customerRepository } from "../repositories/customerRepository.js";
import { customerTransactionRepository } from "../repositories/customerTransactionRepository.js";
import { customerPhotoRepository } from "../repositories/customerPhotoRepository.js";
import { recordCustomerModifications, getCustomerModificationLogs } from "./accountAuditService.js";
import { ServiceError } from "./ServiceError.js";
import { withFullName } from "./authService.js";
import { flattenCustomerAccount } from "./patterns/customerFactory.js";
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
      information: {
        firstName: newFirstName,
        middleName: newMiddleName,
        lastName: newLastName,
        birthdate: newBirthdate,
        phone: newPhone,
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

export async function listTransactions(customerId: number) {
  const transactions = await customerTransactionRepository.findByCustomerId(customerId);

  const orders = transactions.map((tx) => ({
    id: tx.errandId,
    orderId: tx.errandId,
    status: tx.errand.status,
    categories: tx.errand.pabiliDetails.map((d) => d.itemName).join(", ") || tx.errand.category,
    grandTotal: Number(tx.errand.totalCost) || Number(tx.amount) || 0,
    deliveryFee: Number(tx.errand.deliveryFee) || 0,
    totalCost: Number(tx.errand.totalCost) || 0,
    estimatedCost: Number(tx.errand.estimatedCost) || 0,
    tip: Number(tx.errand.tip) || 0,
    paymentMethod: tx.paymentMethod,
    deliveryAddress: tx.errand.deliveryAddress,
    createdAt: tx.errand.createdAt,
    latitude: tx.errand.deliveryLatitude,
    longitude: tx.errand.deliveryLongitude,
    riderId: tx.errand.riderId,
    riderName: tx.errand.rider ? `${tx.errand.rider.firstName} ${tx.errand.rider.lastName}`.trim() : null,
    pinpoints: tx.errand.pinpoints,
    itemsPurchasedAt: tx.errand.itemsPurchasedAt,
  }));

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
