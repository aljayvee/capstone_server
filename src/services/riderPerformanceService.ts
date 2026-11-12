import { errandRepository } from "../repositories/errandRepository.js";
import { userRepository } from "../repositories/userRepository.js";
import { ratingRepository } from "../repositories/ratingRepository.js";
import { commissionRepository } from "../repositories/commissionRepository.js";
import { settlementRepository } from "../repositories/settlementRepository.js";
import { riderLoginSessionRepository } from "../repositories/riderLoginSessionRepository.js";
import { connectivityIncidentRepository } from "../repositories/connectivityIncidentRepository.js";
import { riderOfferDeclineRepository } from "../repositories/riderOfferDeclineRepository.js";
import { resolveRange, type RangeRequest } from "./patterns/dateRangeResolver.js";
import { breakdown, describeCoverage, periodBuckets } from "./patterns/periodBuckets.js";
import * as exceptionService from "./exceptionService.js";
import { ServiceError } from "./ServiceError.js";

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
 *    until 2026-10-25 a rider declining a job erased their own connection to it.
 *    Declines are now kept in `rider_offer_declines` and counted below, but a
 *    rate over a window reaching back before that date would divide by offers
 *    that were never recorded, so the counts are reported and the rate is not.
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
  /** Fraction of CHECKED deliveries made by the frozen promise. See onTimePerformance. */
  onTimeRate: number | null;
  /** Deliveries that could be checked: the only fair denominator. */
  onTimeDenominator: number;
  /** Of those, how many arrived by the promise. */
  onTimeCount: number;
  /** Deliveries left out of the rate, and why: no usable promise, or an unproven moment. */
  notCheckedCount: number;
  noPromiseCount: number;
  unverifiedCount: number;
  /**
   * Always 0 since 2026-10-22: a promise is only ever frozen from a routed
   * estimate, never a fallback. Kept so older clients still read a number.
   */
  degradedEtaCount: number;
  cancellationRate: number | null;
  reachedCount: number;
  cancelledCount: number;
  connectivityDrops: number;
  unresolvedDrops: number;
  /** Offers the rider turned down with the Decline button, in the window. */
  declinedCount: number;
  /** Offers the rider let run out without answering, in the window. */
  expiredOfferCount: number;
}

export interface RiderEarnings {
  riderShareEarned: number;
  commissionCount: number;
  /** Net of shorts and overs. Kept for older clients; the report shows the two apart. */
  settlementVarianceTotal: number;
  /** Cash handed over short, as a positive amount: the sum of every negative variance. */
  cashShortTotal: number;
  /** Cash handed over above what was expected: the sum of every positive variance. */
  cashOverTotal: number;
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
  id?: string;
  riderId: number | null;
  assignedAt: Date | null;
  acceptedAt: Date | null;
  deliveredAt: Date | null;
  completedAt: Date | null;
  etaHighAt: Date | null;
  etaIsDegraded: boolean;
  itemsPurchasedAt?: Date | null;
  etaPromisedAt?: Date | null;
  etaPromisedHighAt?: Date | null;
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

/** A promise made later than this after the leg began was made from near the door. */
export const PROMISE_LATE_LIMIT_MS = 15 * 60 * 1000;
/** A promise this close to the delivery could not have been missed. */
export const MIN_PROMISE_LEAD_MS = 2 * 60 * 1000;
/** How near the address the rider's GPS must put them when they marked it delivered. */
export const DOOR_RADIUS_METERS = 150;

/**
 * On Time: delivered by the promise frozen when the rider set out for the door.
 *
 * It used to compare deliveredAt with etaHighAt, which etaService recomputes
 * about once a minute from the rider's live position right up to the door. A
 * delivery was therefore judged against an estimate made seconds earlier from
 * where the rider already stood, and every one passed: on production all six
 * real deliveries read "on time", one of them 3.5 hours after acceptance.
 *
 * A delivery is CHECKED, and counts toward the rate, only when both hold:
 *
 *  1. **There is a usable promise.** etaPromisedHighAt exists (frozen once from
 *     a live GPS fix, a routed estimate, no store left ahead), it was made
 *     within PROMISE_LATE_LIMIT_MS of the leg starting (items bought, or
 *     accepted when there were no stores), so a phone that was dark for the
 *     whole trip cannot produce a promise at the gate, and it was made at
 *     least MIN_PROMISE_LEAD_MS before the delivery.
 *  2. **The delivery moment is proven.** It comes after the acceptance and
 *     after the promise (a phone-supplied time can be set back), and the
 *     rider's own GPS put them within DOOR_RADIUS_METERS of the address in
 *     the 10 minutes before marking it delivered.
 *
 * Everything else is NOT CHECKED: left out of the denominator and counted
 * apart, never scored as on time or late. A rider is not marked down for a
 * promise the system never made, and not credited for a moment it cannot see.
 */
export function onTimePerformance(errands: TimedErrand[], nearestToDoor: Map<string, number> = new Map()) {
  let denominator = 0;
  let onTime = 0;
  let noPromise = 0;
  let unverified = 0;

  for (const errand of errands) {
    const check = classifyDelivery(errand, nearestToDoor);
    if (!check) continue;
    if (check.result === "NOT_CHECKED") {
      if (NO_PROMISE_REASONS.has(check.reason)) noPromise += 1;
      else unverified += 1;
      continue;
    }
    denominator += 1;
    if (check.result === "ON_TIME") onTime += 1;
  }

  return {
    onTimeRate: denominator > 0 ? round2(onTime / denominator) : null,
    onTimeDenominator: denominator,
    onTimeCount: onTime,
    notCheckedCount: noPromise + unverified,
    noPromiseCount: noPromise,
    unverifiedCount: unverified,
    degradedEtaCount: 0,
  };
}

/** Why a delivery was left out of On Time. */
export type NotCheckedReason =
  | "NO_PROMISE"
  | "PROMISE_TOO_LATE"
  | "PROMISE_TOO_CLOSE"
  | "TIME_DOES_NOT_ADD_UP"
  | "NO_GPS_AT_DELIVERY"
  | "FAR_FROM_ADDRESS";

const NO_PROMISE_REASONS = new Set<NotCheckedReason>(["NO_PROMISE", "PROMISE_TOO_LATE", "PROMISE_TOO_CLOSE"]);

export type DeliveryCheck =
  | { result: "ON_TIME" | "LATE"; minutesLate: number; nearestMeters: number }
  | { result: "NOT_CHECKED"; reason: NotCheckedReason; nearestMeters: number | null };

/**
 * One delivery's On Time verdict, with the reason when it could not be judged.
 * onTimePerformance counts these; a single rider's report lists them, so the
 * owner can see exactly which deliveries the rate rests on.
 *
 * Returns null for an errand that was never marked delivered.
 */
export function classifyDelivery(
  errand: TimedErrand,
  nearestToDoor: Map<string, number> = new Map()
): DeliveryCheck | null {
  const delivered = errand.deliveredAt;
  if (!delivered) return null;

  const distance = errand.id !== undefined ? nearestToDoor.get(errand.id) : undefined;
  const nearestMeters = distance ?? null;
  const promisedAt = errand.etaPromisedAt ?? null;
  const promisedHigh = errand.etaPromisedHighAt ?? null;
  const legStart = errand.itemsPurchasedAt ?? errand.acceptedAt ?? null;

  if (!promisedAt || !promisedHigh || !legStart) {
    return { result: "NOT_CHECKED", reason: "NO_PROMISE", nearestMeters };
  }
  if (promisedAt.getTime() - legStart.getTime() > PROMISE_LATE_LIMIT_MS) {
    return { result: "NOT_CHECKED", reason: "PROMISE_TOO_LATE", nearestMeters };
  }
  if (delivered.getTime() - promisedAt.getTime() < MIN_PROMISE_LEAD_MS) {
    // Covers a delivery time set BEFORE the promise too (a negative lead), but
    // that one is a time that does not add up, so it is named as such below.
    if (delivered.getTime() >= promisedAt.getTime()) {
      return { result: "NOT_CHECKED", reason: "PROMISE_TOO_CLOSE", nearestMeters };
    }
  }
  if (
    !errand.acceptedAt ||
    delivered.getTime() < errand.acceptedAt.getTime() ||
    delivered.getTime() < promisedAt.getTime()
  ) {
    return { result: "NOT_CHECKED", reason: "TIME_DOES_NOT_ADD_UP", nearestMeters };
  }
  if (distance === undefined) {
    return { result: "NOT_CHECKED", reason: "NO_GPS_AT_DELIVERY", nearestMeters };
  }
  if (distance > DOOR_RADIUS_METERS) {
    return { result: "NOT_CHECKED", reason: "FAR_FROM_ADDRESS", nearestMeters };
  }

  const lateMs = delivered.getTime() - promisedHigh.getTime();
  return lateMs <= 0
    ? { result: "ON_TIME", minutesLate: 0, nearestMeters: distance }
    : { result: "LATE", minutesLate: Math.ceil(lateMs / 60000), nearestMeters: distance };
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

export async function getRiderPerformanceReport(request: RangeRequest & { riderId?: number }) {
  const resolved = resolveRange(request);
  const { start, end, label, period } = resolved;
  const now = new Date();

  const [
    finished,
    reached,
    riders,
    ratings,
    commissions,
    sessions,
    drops,
    unresolved,
    settlements,
    exceptions,
    payouts,
    declineCounts,
    declineRows,
  ] = await Promise.all([
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
    commissionRepository.findBetween(start, end),
    riderOfferDeclineRepository.countByRiderBetween(start, end),
    request.riderId
      ? riderOfferDeclineRepository.findForRiderBetween(request.riderId, start, end)
      : Promise.resolve([]),
  ]);

  // Every rider, for the report's rider picker, whichever one is being shown.
  const riderOptions = riders
    .map((r) => ({ riderId: r.id, name: `${r.firstName} ${r.lastName}`.trim() || r.username }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // One rider's report: the same figures, the same rules, narrowed to them.
  // An unknown id is refused rather than answered with an empty report that
  // would print as a rider who did nothing.
  const shown = request.riderId ? riders.filter((r) => r.id === request.riderId) : riders;
  if (request.riderId && shown.length === 0) {
    throw new ServiceError(404, "That rider was not found.");
  }

  // One query for the whole window: how close each rider's GPS came to the
  // address when they marked the errand delivered.
  const nearestToDoor = await errandRepository.nearestFixToDoorAtDelivery(
    finished.filter((e) => e.deliveredAt).map((e) => e.id)
  );

  const finishedByRider = groupBy(finished, (e) => e.riderId);
  const reachedByRider = groupBy(reached, (e) => e.riderId);
  const sessionsByRider = groupBy(sessions, (s) => s.riderId);
  const settlementsByRider = groupBy(settlements, (s) => s.riderId);
  const ratingByRider = new Map(ratings.map((r) => [r.riderId, r]));
  const commissionByRider = new Map(commissions.map((c) => [c.riderId, c]));
  const dropsByRider = new Map(drops.map((d) => [d.riderId, d._count._all]));
  const unresolvedByRider = new Map(unresolved.map((d) => [d.riderId, d._count._all]));
  const exceptionsByRider = new Map(exceptions.riders.map((r) => [r.riderId, r]));
  const declinesByRider = new Map<number, { declined: number; expired: number }>();
  for (const d of declineCounts) {
    const counts = declinesByRider.get(d.riderId) ?? { declined: 0, expired: 0 };
    if (d.kind === "EXPIRED") counts.expired += d._count._all;
    else counts.declined += d._count._all;
    declinesByRider.set(d.riderId, counts);
  }

  const rows: RiderPerformanceRow[] = shown.map((rider) => {
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
        ...onTimePerformance(mine, nearestToDoor),
        cancellationRate: reachedRows.length > 0 ? round2(cancelledCount / reachedRows.length) : null,
        reachedCount: reachedRows.length,
        cancelledCount,
        connectivityDrops: dropsByRider.get(rider.id) ?? 0,
        unresolvedDrops: unresolvedByRider.get(rider.id) ?? 0,
        declinedCount: declinesByRider.get(rider.id)?.declined ?? 0,
        expiredOfferCount: declinesByRider.get(rider.id)?.expired ?? 0,
      },

      earnings: {
        riderShareEarned: round2(commission?._sum.riderShare ?? 0),
        commissionCount: commission?._count._all ?? 0,
        settlementVarianceTotal: round2(mySettlements.reduce((sum, s) => sum + s.variance, 0)),
        // Apart, not netted: a ₱60 short and a ₱60 over would otherwise read ₱0.
        cashShortTotal: round2(mySettlements.reduce((sum, s) => sum + Math.max(0, -s.variance), 0)),
        cashOverTotal: round2(mySettlements.reduce((sum, s) => sum + Math.max(0, s.variance), 0)),
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
    coverageLabel: describeCoverage(resolved),
    breakdownUnit: periodBuckets(period, start, end).unit,
    start: start.toISOString(),
    end: end.toISOString(),
    timelineBreakdown: fleetBreakdown(resolved, shown, { finished, reached, payouts, settlements }),
    riders: rows,
    fleet: aggregateFleet(rows),
    riderOptions,
    /** The rider this report is narrowed to, or null for the whole fleet. */
    rider: request.riderId ? (riderOptions.find((o) => o.riderId === request.riderId) ?? null) : null,
    /**
     * One rider's report only: every delivery in the window with its On Time
     * verdict, newest first, so the rate can be traced to the orders under it.
     */
    deliveries: request.riderId
      ? (finishedByRider.get(request.riderId) ?? [])
          .filter((e) => e.deliveredAt)
          .sort((a, b) => (b.deliveredAt as Date).getTime() - (a.deliveredAt as Date).getTime())
          .map((e) => ({
            errandId: e.id,
            referenceNo: e.referenceNo ?? null,
            acceptedAt: e.acceptedAt?.toISOString() ?? null,
            deliveredAt: (e.deliveredAt as Date).toISOString(),
            promisedBy: e.etaPromisedHighAt?.toISOString() ?? null,
            check: classifyDelivery(e, nearestToDoor),
          }))
      : [],
    /**
     * One rider's report only: every offer they declined or let run out in the
     * window, newest first, with the reason they gave.
     */
    declines: declineRows.map((d) => ({
      id: d.id,
      errandId: d.errandId,
      referenceNo: d.errand?.referenceNo ?? null,
      kind: d.kind,
      reason: d.reason,
      offeredAt: d.offeredAt?.toISOString() ?? null,
      declinedAt: d.declinedAt.toISOString(),
    })),
    // Empty on the owner's instruction (2026-10-27): the "About these numbers"
    // block is gone from the screen and the printout. Kept as a field so clients
    // that read it still get an array.
    notes: [] as string[],
  };
}

/**
 * The whole fleet per day / week / month / year: orders delivered, orders
 * cancelled, rider pay, and cash short or over.
 *
 * Each figure is dated on the clock its own column already uses (delivered,
 * assigned, paid out, handed over), and only riders in the table are counted,
 * so every column adds up to the fleet total above it.
 */
function fleetBreakdown(
  resolved: ReturnType<typeof resolveRange>,
  riders: Array<{ id: number }>,
  sources: {
    finished: Array<{
      riderId: number | null;
      deliveredAt: Date | null;
      completedAt: Date | null;
      updatedAt: Date;
    }>;
    reached: Array<{ riderId: number | null; status: string; assignedAt: Date | null }>;
    payouts: Array<{ riderId: number; riderShare: number; computedAt: Date }>;
    settlements: Array<{ riderId: number; variance: number; settledAt: Date }>;
  }
) {
  const known = new Set(riders.map((r) => r.id));
  const isKnown = (id: number | null) => id !== null && known.has(id);

  // Counts carry amount 0; only pay and cash read it.
  type Event = { at: Date; kind: "delivered" | "cancelled" | "pay" | "cash"; amount: number };

  const events: Event[] = [
    ...sources.finished
      .filter((e) => isKnown(e.riderId))
      .map((e) => ({
        at: e.deliveredAt ?? e.completedAt ?? e.updatedAt,
        kind: "delivered" as const,
        amount: 0,
      })),
    ...sources.reached
      .filter((e) => isKnown(e.riderId) && e.status === "CANCELLED" && e.assignedAt)
      .map((e) => ({ at: e.assignedAt as Date, kind: "cancelled" as const, amount: 0 })),
    ...sources.payouts
      .filter((p) => isKnown(p.riderId))
      .map((p) => ({ at: p.computedAt, kind: "pay" as const, amount: p.riderShare })),
    ...sources.settlements
      .filter((s) => isKnown(s.riderId))
      .map((s) => ({ at: s.settledAt, kind: "cash" as const, amount: s.variance })),
  ];

  return breakdown(
    periodBuckets(resolved.period, resolved.start, resolved.end),
    events,
    (e) => e.at,
    () => ({
      completedCount: 0,
      cancelledCount: 0,
      riderShareEarned: 0,
      settlementVarianceTotal: 0,
      cashShort: 0,
      cashOver: 0,
    }),
    (f, e) => {
      if (e.kind === "delivered") f.completedCount += 1;
      else if (e.kind === "cancelled") f.cancelledCount += 1;
      else if (e.kind === "pay") f.riderShareEarned = round2(f.riderShareEarned + e.amount);
      else {
        f.settlementVarianceTotal = round2(f.settlementVarianceTotal + e.amount);
        if (e.amount < 0) f.cashShort = round2(f.cashShort - e.amount);
        else f.cashOver = round2(f.cashOver + e.amount);
      }
    }
  );
}

function aggregateFleet(rows: RiderPerformanceRow[]) {
  const completedCount = rows.reduce((sum, r) => sum + r.throughput.completedCount, 0);
  const onTimeDenominator = rows.reduce((sum, r) => sum + r.reliability.onTimeDenominator, 0);
  // Summed from each rider's own count, so the fleet figure is exactly the sum
  // of the rows beneath it. (It used to be rebuilt from each rounded rate.)
  const onTimeCount = rows.reduce((sum, r) => sum + r.reliability.onTimeCount, 0);
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
    notCheckedCount: rows.reduce((sum, r) => sum + r.reliability.notCheckedCount, 0),
    degradedEtaCount: rows.reduce((sum, r) => sum + r.reliability.degradedEtaCount, 0),
    riderShareEarned: round2(rows.reduce((sum, r) => sum + r.earnings.riderShareEarned, 0)),
    settlementVarianceTotal: round2(
      rows.reduce((sum, r) => sum + r.earnings.settlementVarianceTotal, 0)
    ),
    cashShortTotal: round2(rows.reduce((sum, r) => sum + r.earnings.cashShortTotal, 0)),
    cashOverTotal: round2(rows.reduce((sum, r) => sum + r.earnings.cashOverTotal, 0)),
    shortageCount: rows.reduce((sum, r) => sum + r.earnings.shortageCount, 0),
    exceptionCount: rows.reduce((sum, r) => sum + r.quality.exceptionCount, 0),
    connectivityDrops: rows.reduce((sum, r) => sum + r.reliability.connectivityDrops, 0),
    declinedCount: rows.reduce((sum, r) => sum + r.reliability.declinedCount, 0),
    expiredOfferCount: rows.reduce((sum, r) => sum + r.reliability.expiredOfferCount, 0),
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
