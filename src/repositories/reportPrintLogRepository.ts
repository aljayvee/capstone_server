import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

export interface ReportPrintLogCreateInput {
  userId: number | null;
  printedByName: string;
  role: string;
  reportType: string;
  period: string;
  rangeStart: Date;
  rangeEnd: Date;
  coverageLabel: string;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface ReportPrintLogListFilters {
  search?: string;
  reportType?: string;
  skip: number;
  take: number;
}

/** One row per Owner report sent to the print screen. See ReportPrintLog in schema.prisma. */
export const reportPrintLogRepository = {
  create(data: ReportPrintLogCreateInput) {
    return prisma.reportPrintLog.create({ data });
  },

  async list(filters: ReportPrintLogListFilters) {
    const where: Prisma.ReportPrintLogWhereInput = {};
    if (filters.reportType) where.reportType = filters.reportType;

    const term = filters.search?.trim();
    if (term) {
      where.OR = [
        { printedByName: { contains: term } },
        { coverageLabel: { contains: term } },
        { ipAddress: { contains: term } },
      ];
    }

    const [rows, total] = await Promise.all([
      prisma.reportPrintLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: filters.skip,
        take: filters.take,
      }),
      prisma.reportPrintLog.count({ where }),
    ]);
    return { rows, total };
  },
};
