import { prisma } from "../lib/prisma.js";
import type { RiderPhotoUploadInput } from "../validators/riderPhotoValidators.js";

export const riderPhotoRepository = {
  findByUserId(userId: number) {
    return prisma.riderProfilePhoto.findUnique({ where: { userId } });
  },

  // Just the metadata. The profile endpoint needs to know a photo exists and when
  // it last changed; it has no use for a megabyte of base64 to answer that.
  findMetaByUserId(userId: number) {
    return prisma.riderProfilePhoto.findUnique({
      where: { userId },
      select: { id: true, mimeType: true, fileSize: true, fileName: true, updatedAt: true },
    });
  },

  upsert(userId: number, data: RiderPhotoUploadInput) {
    const fields = {
      photoData: data.photoData,
      mimeType: data.mimeType,
      fileSize: data.fileSize,
      fileName: data.fileName || null,
    };
    return prisma.riderProfilePhoto.upsert({
      where: { userId },
      create: { userId, ...fields },
      update: fields,
    });
  },

  deleteByUserId(userId: number) {
    return prisma.riderProfilePhoto.deleteMany({ where: { userId } });
  },
};
