import { prisma } from "../lib/prisma.js";

export interface CreateIncidentData {
  riderId: number;
  errandId?: string;
  disconnectedAt?: Date;
}

export const connectivityIncidentRepository = {
  findById(id: number) {
    return prisma.connectivityIncident.findUnique({ where: { id } });
  },

  // The rider's own most recent still-open incident, if any — used so a
  // flaky connection that drops repeatedly doesn't open a new row every time
  // (see connectivityIncidentService.openIncident).
  findOpenForRider(riderId: number) {
    return prisma.connectivityIncident.findFirst({
      where: { riderId, reconnectedAt: null },
      orderBy: { disconnectedAt: "desc" },
    });
  },

  create(data: CreateIncidentData) {
    return prisma.connectivityIncident.create({ data });
  },

  resolve(id: number) {
    return prisma.connectivityIncident.update({
      where: { id },
      data: { reconnectedAt: new Date() },
    });
  },

  // Drops per rider in a range, for the Rider Performance report. Two groupBys
  // rather than fetching rows: the report needs counts, and a rider on a bad
  // route can generate a great many incidents.
  countByRiderBetween(start: Date, end: Date) {
    return prisma.connectivityIncident.groupBy({
      by: ["riderId"],
      where: { disconnectedAt: { gte: start, lt: end } },
      _count: { _all: true },
    });
  },

  // Drops that never came back. Reported beside the total because a connection
  // that recovered in nine seconds and one that never returned are the same row
  // until you look at this column.
  countUnresolvedByRiderBetween(start: Date, end: Date) {
    return prisma.connectivityIncident.groupBy({
      by: ["riderId"],
      where: { disconnectedAt: { gte: start, lt: end }, reconnectedAt: null },
      _count: { _all: true },
    });
  },
};
