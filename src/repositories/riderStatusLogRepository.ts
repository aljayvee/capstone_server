import { prisma } from "../lib/prisma.js";
import type { RiderPresenceStatus } from "@prisma/client";

export const riderStatusLogRepository = {
  // Fixed-cadence archive insert — one row per rider per tick, unconditionally.
  createMany(entries: { riderId: number; status: RiderPresenceStatus }[]) {
    if (entries.length === 0) return Promise.resolve({ count: 0 });
    return prisma.riderStatusLog.createMany({ data: entries });
  },
};
