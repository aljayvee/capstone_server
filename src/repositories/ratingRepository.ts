import { prisma } from "../lib/prisma.js";

export const ratingRepository = {
  findByErrandId(errandId: string) {
    return prisma.rating.findUnique({ where: { errandId } });
  },

  create(errandId: string, riderId: number, stars: number, comment?: string) {
    return prisma.rating.create({ data: { errandId, riderId, stars, comment } });
  },

  // All-time average, not period-scoped — ratings are sparse enough that a
  // date-windowed average would be noisy; reportService.ts's Rider Performance
  // report reads this regardless of the report's own period/date filter.
  averageForRider(riderId: number) {
    return prisma.rating.aggregate({
      where: { riderId },
      _avg: { stars: true },
      _count: { _all: true },
    });
  },

  // Every rider's average in ONE query, replacing a per-rider fan-out in the
  // Rider Performance report. All-time for the same reason averageForRider is.
  //
  // The count travels with the average deliberately: a single 5-star rating and
  // forty averaging 4.6 are not comparable figures, and a table that shows only
  // the mean invites exactly that comparison.
  averagesForAllRiders() {
    return prisma.rating.groupBy({
      by: ["riderId"],
      _avg: { stars: true },
      _count: { _all: true },
    });
  },
};
