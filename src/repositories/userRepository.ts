import { prisma } from "../lib/prisma.js";
import type { Prisma } from "@prisma/client";

export const userRepository = {
  findByUsername(username: string) {
    return prisma.user.findUnique({ where: { username } });
  },

  findById(id: number) {
    return prisma.user.findUnique({ where: { id } });
  },

  findByUsernameOrEmail(username: string, email: string) {
    return prisma.user.findFirst({ where: { OR: [{ username }, { email }] } });
  },

  findMany() {
    return prisma.user.findMany();
  },

  // Full roster regardless of status — backs the dispatcher/owner fleet-monitoring
  // views, filtered further in userService for the online-only "Assign Rider" picker.
  findAllRiders() {
    return prisma.user.findMany({
      where: { role: "RIDER" },
      select: {
        id: true,
        username: true,
        firstName: true,
        lastName: true,
        phone: true,
        avatar: true,
        status: true,
      },
    });
  },

  create(data: Prisma.UserCreateInput) {
    return prisma.user.create({ data });
  },

  update(id: number, data: Prisma.UserUpdateInput) {
    return prisma.user.update({ where: { id }, data });
  },

  // Conditional write: only applies if `version` still matches what the client
  // last read. A resulting count of 0 means someone else changed this user first.
  updateWithVersion(id: number, expectedVersion: number, data: Prisma.UserUpdateManyMutationInput) {
    return prisma.user.updateMany({
      where: { id, version: expectedVersion },
      data: { ...data, version: { increment: 1 } },
    });
  },

  updatePushToken(id: number, expoPushToken: string) {
    return prisma.user.update({ where: { id }, data: { expoPushToken } });
  },
};
