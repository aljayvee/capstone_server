import { prisma } from "../lib/prisma.js";
import type { CustomerPhotoUploadInput } from "../validators/customerPhotoValidators.js";

export const customerPhotoRepository = {
  findByCustomerId(customerId: number) {
    return prisma.customerProfilePhoto.findUnique({
      where: { customerId },
    });
  },

  upsert(customerId: number, data: CustomerPhotoUploadInput) {
    return prisma.customerProfilePhoto.upsert({
      where: { customerId },
      create: {
        customerId,
        photoData: data.photoData,
        mimeType: data.mimeType,
        fileSize: data.fileSize,
        fileName: data.fileName || null,
      },
      update: {
        photoData: data.photoData,
        mimeType: data.mimeType,
        fileSize: data.fileSize,
        fileName: data.fileName || null,
      },
    });
  },

  deleteByCustomerId(customerId: number) {
    return prisma.customerProfilePhoto.deleteMany({
      where: { customerId },
    });
  },
};
