import { errandRepository } from "../repositories/errandRepository.js";
import { userRepository } from "../repositories/userRepository.js";
import { ratingRepository } from "../repositories/ratingRepository.js";
import { commissionRepository } from "../repositories/commissionRepository.js";
import { settlementRepository } from "../repositories/settlementRepository.js";
import { riderLoginSessionRepository } from "../repositories/riderLoginSessionRepository.js";
import { connectivityIncidentRepository } from "../repositories/connectivityIncidentRepository.js";
import { resolveRange, type RangeRequest } from "./patterns/dateRangeResolver.js";
import * as exceptionService from "./exceptionService.js";

/**
 * How each rider actually performed over a period.
 *
 * Lives apart from reportService because twelve metrics is more arithmetic than
 * the other five reports carry between them, and because the PDF export and the
 * JSON endpoint must both come through one entry point — two paths to the same
 * table is how a printed figure comes to disagree with the screen it was printed
 * from.
 *
 * ## What is deliberately NOT here
 *
 * Metrics with no backing data are absent rather than approximated:
 *
 *  - **Acceptance rate.** `errandService.declineErrand` sets `riderId: null`, so
 *    a rider declining a job erases their own connection to it. The offers a
 *    rider turned down cannot be counted because they are no longer recorded.
 *  - **Offers per rider.** `DispatchLog` records the dispatcher's action, not a
 *    per-rider offer.
 *  - **First-attempt delivery success** and **complaint counts.** No table.
 *
 * A performance table that invents these would be worse than one that omits
 * them, because a fabricated denominator is indistinguishable from a real one.
 */

/** Metrics whose absence is meaningful and must not be rendered as a zero. */
export interface RiderThroughput {
  completedCount: number;
  /** Mean acceptedAt -> deliveredAt, in minutes. */
  avgDeliveryMinutes: number | null;
  /** How many errands carried both stamps, so the mean can be read in context. */
  deliveryTimedCount: number;
  /** Mean assignedAt -> acceptedAt, in minutes. */
  avgAcceptMinutes: number | null;
  acceptTimedCount: number;
  activeHours: number;
  errandsPerActiveHour: number | null;
}

export interface RiderReliability {
  /** Fraction delivered by the high end of the quoted ETA window. */
  onTimeRate: number | null;
  /** Errands that carried an ETA at all — the only fair denominator. */
  onTimeDenominator: number;
  /** Of those, how many ETAs were fallback estimates rather than routed ones. */
  degradedEtaCount: number;
  cancellationRate: number | null;
  reachedCount: number;
  cancelledCount: number;
  connectivityDrops: number;
  unresolvedDrops: number;
}

export interface RiderEarnings {
  riderShareEarned: number;
  commissionCount: number;
  settlementVarianceTotal: number;
  shortageCount: number;
  settlementCount: number;
}

export interface RiderQuality {
  /** All-time, not period-scoped. See the note this report ships with. */
  averageRatingAllTime: number | null;
  ratingCountAllTime: number;
  exceptionCount: number;
  exceptionErrandCount: number;
  exceptionRate: number | null;
  exceptionsAtRisk: number;
}

export interface RiderPerformanceRow {
  riderId: number;
  name: string;
  throughput: RiderThroughput;
  reliability: RiderReliability;
  earnings: RiderEarnings;
  quality: RiderQuality;
  // Flat mirrors of the three figures the previous version of this report
  // returned, so an unmigrated client keeps rendering rather than blanking.
  completedCount: number;
  avgDeliveryMinutes: number | null;
  averageRating: number | null;
}

interface TimedErrand {
  riderId: number | null;
  assignedAt: Date | null;
  acceptedAt: Date | null;
  deliveredAt: Date | null;
  completedAt: Date | null;
  etaHighAt: Date | null;
  etaIsDegraded: boolean;
}

interface LoginSession {
  riderId: number;
  loginAt: Date;
  logoutAt: Date | null;
  durationSeconds: number | null;
}

/**
 * Mean minutes between two lifecycle stamps, over the errands that carry both.
 *
 * Returns null rather than 0 when nothing qualifies. The two are different
 * facts — "this rider delivered instantly" and "no errand recorded when this
 * rider accepted" — and a table that shows 0 for the second gets someone
 * congratulated or disciplined for a missing column.
 *
 * This replaces `updatedAt - createdAt`, which measured from when the CUSTOMER
 * placed the order (before any rider saw it) to whenever the row was last
 * touched (which a rating or settlement written after delivery silently
 * extends). Neither endpoint was under the rider's control.
 */
export function meanMinutesBetween(
  errands: TimedErrand[],
  from: (e: TimedErrand) => Date | null,
  to: (e: TimedErrand) => Date | null
): { mean: number | null; count: number } {
  let total = 0;
  let count = 0;

  for (const errand of errands) {
    const startAt = from(errand);
    const endAt = to(errand);
    if (!startAt || !endAt) continue;
    const minutes = (endAt.getTime() - startAt.getTime()) / 60000;
    // A negative interval is a clock artefact, not a delivery that finished
    // before it began. Excluded rather than allowed to drag the mean down.
    if (minutes < 0) continue;
    total += minutes;
    count += 1;
  }

  return { mean: count > 0 ? round2(total / count) : null, count };
}

/**
 * On-time performance against the high end of the quoted ETA range.
 *
 * The denominator is errands that carried an ETA, NOT every completed errand.
 * Dividing by the latter would score a rider down for every job the routing
 * layer never quoted — punishing them for the system's silence. The denominator
 * travels with the rate so the reader can see how much it rests on.
 *
 * `degradedEtaCount` is reported beside it because `etaIsDegraded` marks an ETA
 * the router fell back to rather than measured. Being judged late against a
 * guess is worth being able to see.
 */
export function onTimePerformance(errands: TimedErrand[]) {
  let denominator = 0;
  let onTime = 0;
  let degraded = 0;

  for (const errand of errands) {
    if (!errand.etaHighAt || !errand.deliveredAt) continue;
    denominator += 1;
    if (errand.deliveredAt.getTime() <= errand.etaHighAt.getTime()) onTime += 1;
    if (errand.etaIsDegraded) degraded += 1;
  }

  return {
    onTimeRate: denominator > 0 ? round2(onTime / denominator) : null,
    onTimeDenominator: denominator,
    degradedEtaCount: degraded,
  };
}

/**
 * Hours a rider was signed in during the window.
 *
 * An open session is clamped to the window rather than counted whole or dropped:
 * a rider still mid-shift has real hours on the clock, and excluding them would
 * divide their errands by a smaller number and flatter exactly the people whose
 * day is not yet over. `durationSeconds` is trusted where the session is closed
 * because that is what the logout path recorded.
 */
export function activeHoursFor(sessions: LoginSession[], start: Date, end: Date, now: Date): number {
  let seconds = 0;

  for (const session of sessions) {
    if (session.logoutAt) {
      seconds += session.durationSeconds ?? (session.logoutAt.getTime() - session.loginAt.getTime()) / 1000;
      continue;
    }
    const from = Math.max(session.loginAt.getTime(), start.getTime());
    const to = Math.min(now.getTime(), end.getTime());
    if (to > from) seconds += (to - from) / 1000;
  }

  return round2(Math.max(0, seconds) / 3600);
}

export async function getRiderPerformanceReport(request: RangeRequest) {
  const { start, end, label, period } = resolveRange(request);
  const now = new Date();

  const [finished, reached, riders, ratings, commissions, sessions, drops, unresolved, settlements, exceptions] =
    await Promise.all([
      errandRepository.findRiderPerformanceBetween(start, end),
      errandRepository.findReachedRiderBetween(start, end),
      userRepository.findAllRiders(),
      ratingRepository.averagesForAllRiders(),
      commissionRepository.sumByRiderBetween(start, end),
      riderLoginSessionRepository.findOverlappingBetween(start, end),
      connectivityIncidentRepository.countByRiderBetween(start, end),
      connectivityIncidentRepository.countUnresolvedByRiderBetween(start, end),
      settlementRepository.findBetweenWithRider(start, end),
      exceptionService.findExceptions(start, end),
    ]);

  const finishedByRider = groupBy(finished, (e) => e.riderId);
  const reachedByRider = groupBy(reached, (e) => e.riderId);
  const sessionsByRider = groupBy(sessions, (s) => s.riderId);
  const settlementsByRider = groupBy(settlements, (s) => s.riderId);
  const ratingByRider = new Map(ratings.map((r) => [r.riderId, r]));
  const commissionByRider = new Map(commissions.map((c) => [c.riderId, c]));
  const dropsByRider = new Map(drops.map((d) => [d.riderId, d._count._all]));
  const unresolvedByRider = new Map(unresolved.map((d) => [d.riderId, d._count._all]));
  const exceptionsByRider = new Map(exceptions.riders.map((r) => [r.riderId, r]));

  const rows: RiderPerformanceRow[] = riders.map((rider) => {
    const mine = finishedByRider.get(rider.id) ?? [];
    const completedCount = mine.length;

    const delivery = meanMinutesBetween(mine, (e) => e.acceptedAt, (e) => e.deliveredAt);
    const accept = meanMinutesBetween(mine, (e) => e.assignedAt, (e) => e.acceptedAt);
    const activeHours = activeHoursFor(sessionsByRider.get(rider.id) ?? [], start, end, now);

    const reachedRows = reachedByRider.get(rider.id) ?? [];
    const cancelledCount = reachedRows.filter((e) => e.status === "CANCELLED").length;

    const mySettlements = settlementsByRider.get(rider.id) ?? [];
    const rating = ratingByRider.get(rider.id);
    const commission = commissionByRider.get(rider.id);
    const exception = exceptionsByRider.get(rider.id);

    return {
      riderId: rider.id,
      name: `${rider.firstName} ${rider.lastName}`.trim(),

      throughput: {
        completedCount,
        avgDeliveryMinutes: delivery.mean,
        deliveryTimedCount: delivery.count,
        avgAcceptMinutes: accept.mean,
        acceptTimedCount: accept.count,
        activeHours,
        errandsPerActiveHour: activeHours > 0 ? round2(completedCount / activeHours) : null,
      },

      reliability: {
        ...onTimePerformance(mine),
        cancellationRate: reachedRows.length > 0 ? round2(cancelledCount / reachedRows.length) : null,
        reachedCount: reachedRows.length,
        cancelledCount,
        connectivityDrops: dropsByRider.get(rider.id) ?? 0,
        unresolvedDrops: unresolvedByRider.get(rider.id) ?? 0,
      },

      earnings: {
        riderShareEarned: round2(commission?._sum.riderShare ?? 0),
        commissionCount: commission?._count._all ?? 0,
        settlementVarianceTotal: round2(mySettlements.reduce((sum, s) => sum + s.variance, 0)),
        shortageCount: mySettlements.filter((s) => s.variance < 0).length,
        settlementCount: mySettlements.length,
      },

      quality: {
        averageRatingAllTime:
          rating && rating._count._all > 0 ? round2(rating._avg.stars ?? 0) : null,
        ratingCountAllTime: rating?._count._all ?? 0,
        exceptionCount: exception?.exceptionCount ?? 0,
        exceptionErrandCount: exception?.errandCount ?? 0,
        exceptionRate: exception?.rate ?? null,
        exceptionsAtRisk: round2(exception?.atRisk ?? 0),
      },

      completedCount,
      avgDeliveryMinutes: delivery.mean,
      averageRating: rating && rating._count._all > 0 ? round2(rating._avg.stars ?? 0) : null,
    };
  });

  rows.sort((a, b) => b.throughput.completedCount - a.throughput.completedCount);

  return {
    period,
    rangeLabel: label,
    start: start.toISOString(),
    end: end.toISOString(),
    riders: rows,
    fleet: aggregateFleet(rows),
    notes: [
      "Cancellation counts errands that reached a rider and ended cancelled. The record does " +
        "not name who cancelled, and a rider who declines a job is detached from it entirely, " +
        "so this under-counts rider-initiated abandonment rather than over-counting it.",
      "Average rating is all-time and does not change with the selected period — ratings are " +
        "too sparse for a period-windowed average to mean anything.",
      "On-time is measured only over errands that carried an ETA; the count each rate rests on " +
        "is shown beside it.",
      "A dash means the record holds nothing to compute the metric from. It does not mean zero.",
    ],
  };
}

function aggregateFleet(rows: RiderPerformanceRow[]) {
  const completedCount = rows.reduce((sum, r) => sum + r.throughput.completedCount, 0);
  const onTimeDenominator = rows.reduce((sum, r) => sum + r.reliability.onTimeDenominator, 0);
  // Reconstructed from each rider's rate and denominator rather than re-derived,
  // so the fleet figure is exactly the sum of the rows beneath it.
  const onTimeCount = rows.reduce(
    (sum, r) => sum + Math.round((r.reliability.onTimeRate ?? 0) * r.reliability.onTimeDenominator),
    0
  );
  const timedTotal = rows.reduce(
    (sum, r) => sum + (r.throughput.avgDeliveryMinutes ?? 0) * r.throughput.deliveryTimedCount,
    0
  );
  const timedCount = rows.reduce((sum, r) => sum + r.throughput.deliveryTimedCount, 0);

  return {
    riderCount: rows.length,
    completedCount,
    avgDeliveryMinutes: timedCount > 0 ? round2(timedTotal / timedCount) : null,
    deliveryTimedCount: timedCount,
    onTimeRate: onTimeDenominator > 0 ? round2(onTimeCount / onTimeDenominator) : null,
    onTimeDenominator,
    degradedEtaCount: rows.reduce((sum, r) => sum + r.reliability.degradedEtaCount, 0),
    riderShareEarned: round2(rows.reduce((sum, r) => sum + r.earnings.riderShareEarned, 0)),
    settlementVarianceTotal: round2(
      rows.reduce((sum, r) => sum + r.earnings.settlementVarianceTotal, 0)
    ),
    shortageCount: rows.reduce((sum, r) => sum + r.earnings.shortageCount, 0),
    exceptionCount: rows.reduce((sum, r) => sum + r.quality.exceptionCount, 0),
    connectivityDrops: rows.reduce((sum, r) => sum + r.reliability.connectivityDrops, 0),
  };
}

function groupBy<T, K>(items: T[], key: (item: T) => K | null): Map<K, T[]> {
  const grouped = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    if (k === null) continue;
    const existing = grouped.get(k);
    if (existing) existing.push(item);
    else grouped.set(k, [item]);
  }
  return grouped;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
