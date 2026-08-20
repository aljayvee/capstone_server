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
};
