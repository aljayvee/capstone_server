import { errandRepository } from "../repositories/errandRepository.js";
import { customerTransactionRepository } from "../repositories/customerTransactionRepository.js";
import { settlementRepository } from "../repositories/settlementRepository.js";
import { userRepository } from "../repositories/userRepository.js";
import { ratingRepository } from "../repositories/ratingRepository.js";
import { type ReportPeriod } from "./patterns/reportPeriodStrategy.js";
import { resolveRange as resolveDateRange, type RangeRequest } from "./patterns/dateRangeResolver.js";
import {
  breakdown,
  describeCoverage,
  periodBuckets,
  type BucketUnit,
} from "./patterns/periodBuckets.js";
import { RIDER_SHARE_RATE, splitCommission } from "./patterns/commissionSplit.js";
import { ADJUSTMENT_LABEL, settlementBalance, type AdjustmentKind } from "./patterns/settlementBalance.js";
import { activeCategoryNameSet } from "./patterns/categoryFeeModes.js";
import {
  UNCATEGORISED,
  allocate,
  buildWeights,
  primaryCategory,
  toCategoryEvidence,
  type ErrandCategoryRow,
} from "./patterns/categoryRevenueAllocation.js";
import * as exceptionService from "./exceptionService.js";
import type { ExceptionKind } from "./patterns/exceptionRules.js";
import * as riderPerformanceService from "./riderPerformanceService.js";
import { ServiceError } from "./ServiceError.js";

interface ReportMeta {
  /** "CUSTOM" when the caller supplied an explicit start and end. */
  period: ReportPeriod | "CUSTOM";
  rangeLabel: string;
  /** The window in one plain sentence, naming the days: see describeCoverage. */
  coverageLabel: string;
  /** What each timelineBreakdown row is: a day, week, month or year. */
  breakdownUnit: BucketUnit;
  start: string;
  end: string;
}

/**
 * Every report takes the same window request: either a named period with a
 * reference date, or the explicit start/end the calendar picker sends.
 */
export type ReportRequest = RangeRequest & {
  /** Rider Performance only: one rider's report. Ignored by the other five. */
  riderId?: number;
};

function resolveRange(request: ReportRequest) {
  const resolved = resolveDateRange(request);
  // The rows every report's breakdown table is split into, from the one
  // definition the PDF uses too.
  const plan = periodBuckets(resolved.period, resolved.start, resolved.end);
  const meta: ReportMeta = {
    period: resolved.period,
    rangeLabel: resolved.label,
    coverageLabel: describeCoverage(resolved),
    breakdownUnit: plan.unit,
    start: resolved.start.toISOString(),
    end: resolved.end.toISOString(),
  };
  return { start: resolved.start, end: resolved.end, meta, plan };
}

/**
 * One errand's money, divided between the merchant categories it touched.
 *
 * Shared by the Sales and Commission reports so both read the same fetch and the
 * same rules — two passes over the same rows would eventually disagree about
 * what a category earned, and the owner would have no way to tell which was
 * right.
 */
interface CategoryBucket {
  category: string;
  revenue: number;
  itemCost: number;
  deliveryFee: number;
  tip: number;
  businessShare: number;
  riderShare: number;
  orderCount: number;
  touchedOrderCount: number;
}

type AllocationRow = ErrandCategoryRow & {
  createdAt: Date;
  totalCost: number;
  deliveryFee: number;
  tip: number;
  estimatedCost: number;
  commission: { riderShare: number; businessShare: number } | null;
};

/**
 * What an errand counts as in sales: the items bought plus the delivery fee.
 *
 * `totalCost` is items + delivery fee + tip. The business takes no tips, yet
 * 100 delivered errands on prod (2026-08-18 to 10-15) carry tip 20, so summing
 * totalCost overstated Total sales by PHP 2,000 and, with the Tips column gone,
 * left rows that did not add up. Taken off totalCost rather than rebuilt from
 * the parts, so any other charge folded into totalCost still counts.
 */
function salesValue(r: { totalCost: number; tip: number }): number {
  return round2(r.totalCost - (r.tip ?? 0));
}

function emptyBucket(category: string): CategoryBucket {
  return {
    category,
    revenue: 0,
    itemCost: 0,
    deliveryFee: 0,
    tip: 0,
    businessShare: 0,
    riderShare: 0,
    orderCount: 0,
    touchedOrderCount: 0,
  };
}

/**
 * Folds a period's errands into per-category totals.
 *
 * Every money scalar is allocated with the SAME weight vector and reconciled
 * independently, so each column sums to its own headline exactly. The
 * business/rider shares are allocated as already-computed figures rather than
 * re-split from allocated fees: re-splitting would round once per category and
 * drift away from the report's own commission total.
 *
 * A recorded RiderCommission is preferred over recomputation wherever one
 * exists, matching getSettlementReport below — a payout already settled must not
 * be restated by a later report run.
 */
function allocateByCategory(rows: AllocationRow[], activeNames: ReadonlySet<string>) {
  const buckets = new Map<string, CategoryBucket>();
  let errandsWithoutReceipts = 0;
  let businessShareTotal = 0;
  let riderShareTotal = 0;

  const bucketFor = (name: string) => {
    let bucket = buckets.get(name);
    if (!bucket) {
      bucket = emptyBucket(name);
      buckets.set(name, bucket);
    }
    return bucket;
  };

  for (const row of rows) {
    const evidence = toCategoryEvidence(row);
    if (!evidence.receipts.some((r) => r.amount > 0)) errandsWithoutReceipts += 1;

    const { weights } = buildWeights(evidence, activeNames);

    const split =
      row.commission ??
      splitCommission({ deliveryFee: row.deliveryFee, tip: row.tip, itemCost: row.estimatedCost });

    // Accumulated from the SAME per-errand figures the categories are built
    // from, so the total under the column is the total the column adds up to.
    businessShareTotal = round2(businessShareTotal + split.businessShare);
    riderShareTotal = round2(riderShareTotal + split.riderShare);

    const revenue = allocate(salesValue(row), weights);
    const itemCost = allocate(row.estimatedCost, weights);
    const deliveryFee = allocate(row.deliveryFee, weights);
    const tip = allocate(row.tip, weights);
    const businessShare = allocate(split.businessShare, weights);
    const riderShare = allocate(split.riderShare, weights);

    for (const [name, amount] of revenue) {
      const bucket = bucketFor(name);
      bucket.revenue = round2(bucket.revenue + amount);
      bucket.itemCost = round2(bucket.itemCost + (itemCost.get(name) ?? 0));
      bucket.deliveryFee = round2(bucket.deliveryFee + (deliveryFee.get(name) ?? 0));
      bucket.tip = round2(bucket.tip + (tip.get(name) ?? 0));
      bucket.businessShare = round2(bucket.businessShare + (businessShare.get(name) ?? 0));
      bucket.riderShare = round2(bucket.riderShare + (riderShare.get(name) ?? 0));
      bucket.touchedOrderCount += 1;
    }

    // The errand counts as ONE order, in whichever category holds most of its
    // money. Counting it in every category it touched would push this column
    // past the report's own totalOrders.
    bucketFor(primaryCategory(weights)).orderCount += 1;
  }

  // Revenue descending, but the residual bucket is pinned last however large it
  // grows: it is an absence of information, not a merchant type, and sorting it
  // into second place would read as one.
  const byCategory = [...buckets.values()].sort((a, b) => {
    if (a.category === UNCATEGORISED) return 1;
    if (b.category === UNCATEGORISED) return -1;
    return b.revenue - a.revenue;
  });

  return { byCategory, errandsWithoutReceipts, businessShareTotal, riderShareTotal };
}

/** Notes that must travel with any category breakdown, on screen and in print. */
function categoryNotes(rowCount: number, errandsWithoutReceipts: number, uncategorised: number) {
  const notes: string[] = [];

  if (errandsWithoutReceipts > 0) {
    notes.push(
      `${errandsWithoutReceipts} of ${rowCount} orders had no receipt, so their item cost is ` +
        `counted under the store types the customer picked.`
    );
  }
  if (uncategorised > 0) {
    notes.push(
      `${formatAmount(uncategorised)} could not be matched to a store type, so it is listed ` +
        `under "${UNCATEGORISED}" instead of being left out.`
    );
  }
  notes.push(
    "Item cost is counted under the store where the money was spent. Delivery fees follow the " +
      "store types the customer picked, so the two can differ when an order changed stores."
  );

  return notes;
}

function formatAmount(value: number): string {
  return `PHP ${value.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export interface TimelineBreakdownPoint {
  /** "Sunday", "Week 2", "January", "2026". */
  label: string;
  /** The dates the row covers: "Oct 18", "Oct 8 to 14". */
  dateLabel: string;
  orderCount: number;
  revenue: number;
  itemCost: number;
  deliveryFee: number;
  tip: number;
}

/**
 * Sales per day / week / month / year, on the same rows the category table
 * adds up, so the breakdown's total is the report's total.
 */
function buildSalesTimeline(
  rows: AllocationRow[],
  plan: ReturnType<typeof periodBuckets>
): TimelineBreakdownPoint[] {
  return breakdown(
    plan,
    rows,
    (r) => r.createdAt,
    () => ({ orderCount: 0, revenue: 0, itemCost: 0, deliveryFee: 0, tip: 0 }),
    (f, r) => {
      f.orderCount += 1;
      f.revenue = round2(f.revenue + salesValue(r));
      f.itemCost = round2(f.itemCost + r.estimatedCost);
      f.deliveryFee = round2(f.deliveryFee + r.deliveryFee);
      f.tip = round2(f.tip + r.tip);
    }
  );
}

export async function getSalesReport(request: ReportRequest) {
  const { start, end, meta, plan } = resolveRange(request);
  const [totals, rows, activeNames] = await Promise.all([
    errandRepository.aggregateBetween(start, end),
    errandRepository.findForCategoryAllocationBetween(start, end),
    activeCategoryNameSet(),
  ]);

  const { byCategory, errandsWithoutReceipts } = allocateByCategory(rows, activeNames);

  // Tip excluded, the same as every row below (salesValue), so they still reconcile.
  const totalRevenue = round2((totals._sum.totalCost ?? 0) - (totals._sum.tip ?? 0));
  const allocatedRevenue = round2(byCategory.reduce((sum, c) => sum + c.revenue, 0));
  const uncategorised = byCategory.find((c) => c.category === UNCATEGORISED)?.revenue ?? 0;

  return {
    ...meta,
    totalRevenue,
    totalOrders: totals._count._all,
    timelineBreakdown: buildSalesTimeline(rows, plan),
    byCategory: byCategory.map((c) => ({
      category: c.category,
      revenue: c.revenue,
      itemCost: c.itemCost,
      deliveryFee: c.deliveryFee,
      tip: c.tip,
      // Kept as `count` as well as `orderCount` so the field the CSV export and
      // any older client reads does not vanish under them.
      count: c.orderCount,
      orderCount: c.orderCount,
      touchedOrderCount: c.touchedOrderCount,
    })),
    // Shipped rather than asserted internally: if allocation ever stops
    // reconciling, an owner sees it on the page instead of an auditor finding it
    // months later. `difference` must be 0.
    reconciliation: {
      totalRevenue,
      allocatedRevenue,
      difference: round2(totalRevenue - allocatedRevenue),
    },
    uncategorisedRevenue: uncategorised,
    notes: categoryNotes(rows.length, errandsWithoutReceipts, uncategorised),
  };
}

export async function getRiderPerformanceReport(request: ReportRequest) {
  // Delegated so the JSON endpoint and the PDF export cannot drift apart: two
  // paths to the same table is how a printed figure comes to disagree with the
  // screen it was printed from. See riderPerformanceService for the metrics and
  // for what is deliberately absent from them.
  return riderPerformanceService.getRiderPerformanceReport(request);
}

// Commission is an ESTIMATE for the period: a fixed rider/business split (see
// patterns/commissionSplit.ts) applied to the service fees earned in it.
//
// It is an estimate because it aggregates over errands rather than reading each
// one's recorded payout — getSettlementReport below does prefer the stored
// RiderCommission where one exists, and is the ledger-accurate view.
export async function getCommissionReport(request: ReportRequest) {
  const { start, end, meta, plan } = resolveRange(request);
  const riderId = request.riderId;
  const [totals, rows, activeNames, riders] = await Promise.all([
    errandRepository.aggregateBetween(start, end, riderId),
    errandRepository.findForCategoryAllocationBetween(start, end, riderId),
    activeCategoryNameSet(),
    userRepository.findAllRiders(),
  ]);

  // Every rider, for the report's rider picker, whichever one is being shown.
  const riderOptions = riders
    .map((r) => ({ riderId: r.id, name: `${r.firstName} ${r.lastName}`.trim() || r.username }))
    .sort((a, b) => a.name.localeCompare(b.name));
  // An unknown id is refused rather than answered with an empty report that
  // would print as a rider who earned nothing.
  const rider = riderId ? (riderOptions.find((o) => o.riderId === riderId) ?? null) : null;
  if (riderId && !rider) throw new ServiceError(404, "That rider was not found.");

  // The split each order was paid at: the stored payout first, as everywhere.
  const splitOf = (r: (typeof rows)[number]) =>
    r.commission ?? splitCommission({ deliveryFee: r.deliveryFee, tip: r.tip, itemCost: r.estimatedCost });

  const { byCategory, errandsWithoutReceipts, businessShareTotal, riderShareTotal } =
    allocateByCategory(rows, activeNames);
  const uncategorised = byCategory.find((c) => c.category === UNCATEGORISED)?.revenue ?? 0;

  // Summed per errand, NOT split from the period's summed fees.
  //
  // Splitting the aggregate was off by a centavo against the category column
  // beneath it (₱442.20 against ₱442.19 on real August data) because rounding
  // happens once per errand, not once per period. It was also quietly wrong in a
  // second way: it re-derived every payout from raw fees, restating commissions
  // already recorded in RiderCommission — the exact thing getSettlementReport
  // takes care not to do. allocateByCategory prefers the stored row, so the
  // headline now inherits that too.
  //
  // The split is on SERVICE FEES, never order value: totalCost bundles the money
  // the company fronted for the goods, and splitting that credited the rider 70%
  // of the purchase float — ₱2,100 of unearned commission on a ₱3,000 grocery
  // run. See commissionSplit.ts.
  const estimatedCommission = businessShareTotal;

  // Per day / week / month / year, from the same per-errand split the headline
  // is summed from (stored payout first), so each column adds up to its total.
  const timelineBreakdown = breakdown(
    plan,
    rows,
    (r) => r.createdAt,
    () => ({ orderCount: 0, deliveryFee: 0, businessShare: 0, riderShare: 0 }),
    (f, r) => {
      const split = splitOf(r);
      f.orderCount += 1;
      f.deliveryFee = round2(f.deliveryFee + r.deliveryFee);
      f.businessShare = round2(f.businessShare + split.businessShare);
      f.riderShare = round2(f.riderShare + split.riderShare);
    }
  );

  return {
    ...meta,
    estimatedCommission,
    riderCommission: riderShareTotal,
    totalDeliveryFees: round2(totals._sum.deliveryFee ?? 0),
    orderCount: totals._count._all,
    timelineBreakdown,
    // The rate the split was taken at, so the UI stops hardcoding "30%"/"70%"
    // captions that go stale the moment this business rule changes.
    commissionRate: RIDER_SHARE_RATE,
    byCategory: byCategory.map((c) => ({
      category: c.category,
      orderCount: c.orderCount,
      touchedOrderCount: c.touchedOrderCount,
      revenue: c.revenue,
      deliveryFee: c.deliveryFee,
      // What the business actually kept from this category, rather than the
      // gross it passed through — the figure the tile above the table reports.
      businessShare: c.businessShare,
      riderShare: c.riderShare,
    })),
    riderOptions,
    /** The rider this report is narrowed to, or null for every rider. */
    rider,
    /** One rider's report only: every order in the window and how its fee was split, newest first. */
    orders: rider
      ? [...rows]
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .map((r) => {
            const split = splitOf(r);
            return {
              errandId: r.id,
              referenceNo: r.referenceNo ?? null,
              placedAt: r.createdAt.toISOString(),
              deliveryFee: round2(r.deliveryFee),
              tip: round2(r.tip ?? 0),
              businessShare: round2(split.businessShare),
              riderShare: round2(split.riderShare),
            };
          })
      : [],
    notes: categoryNotes(rows.length, errandsWithoutReceipts, uncategorised),
  };
}

export async function getSettlementReport(request: ReportRequest) {
  const { start, end, meta, plan } = resolveRange(request);
  const riderId = request.riderId;
  const [rows, riders] = await Promise.all([
    errandRepository.findWithSettlementBetween(start, end, riderId),
    userRepository.findAllRiders(),
  ]);

  // Every rider, for the report's rider picker, whichever one is being shown.
  const riderOptions = riders
    .map((r) => ({ riderId: r.id, name: `${r.firstName} ${r.lastName}`.trim() || r.username }))
    .sort((a, b) => a.name.localeCompare(b.name));
  // An unknown id is refused rather than answered with an empty report that
  // would print as a rider who handed over nothing.
  const rider = riderId ? (riderOptions.find((o) => o.riderId === riderId) ?? null) : null;
  if (riderId && !rider) throw new ServiceError(404, "That rider was not found.");

  const totalDeliveryFees = round2(rows.reduce((sum, r) => sum + r.deliveryFee, 0));

  // Money confirmed in hand, and money merely priced — reported apart.
  //
  // These used to be one figure: `settlement?.collectedAmount ?? totalCost`.
  // The total is right, but it silently mixed cash somebody counted with cash
  // nobody has seen, and there was no way to tell which was which. Every row
  // here is already DELIVERED or COMPLETED, so an unreconciled one is finished
  // work whose money is unaccounted for — worth its own line, not an invisible
  // contribution to a revenue headline.
  //
  // It matters most for non-COD. settlementService.submitSettlement rejects
  // anything that is not Cash on Delivery with a 400, so a non-COD errand can
  // NEVER acquire a settlement — it would sit in the headline at full totalCost
  // for ever, indistinguishable from collected cash. That has been harmless only
  // because no customer can currently reach a non-COD payment mode; it stops
  // being harmless the moment one can.
  //
  // Once the downpayment ledger exists, confirmed ledger rows join
  // collectedRevenue and the rest stays here.
  let collectedRevenue = 0;
  let awaitingCollection = 0;
  for (const r of rows) {
    if (r.settlement) {
      collectedRevenue = round2(collectedRevenue + r.settlement.collectedAmount);
    } else {
      awaitingCollection = round2(awaitingCollection + r.totalCost);
    }
  }

  // Deliberately the same total as before, so the five report views and the CSV
  // exports that read this name keep meaning what they meant. The split above is
  // additive: it explains the figure rather than restating it.
  const grossRevenue = round2(collectedRevenue + awaitingCollection);

  // grossRevenue above is cash through the business and stays reported as such.
  // The SPLIT, though, is taken only on fees: item money passes through the
  // rider's hands without ever being earned by anyone.
  //
  // Prefers a recorded RiderCommission where one exists — same shape as the
  // collectedAmount preference above, and for the same reason: a figure already
  // settled should not be restated by a later run.
  let riderShare = 0;
  let businessShare = 0;
  for (const row of rows) {
    if (row.commission) {
      riderShare = round2(riderShare + row.commission.riderShare);
      businessShare = round2(businessShare + row.commission.businessShare);
      continue;
    }
    const split = splitCommission({
      deliveryFee: row.deliveryFee,
      tip: row.tip,
      itemCost: row.estimatedCost,
    });
    riderShare = round2(riderShare + split.riderShare);
    businessShare = round2(businessShare + split.businessShare);
  }

  // ── the cash half, on a different clock ──────────────────────────────────
  //
  // Everything above windows on Errand.createdAt. A settlement is stamped
  // SettlementRecord.settledAt, and an errand created on the 31st and settled on
  // the 1st belongs to one month's revenue and the next month's cash. Both are
  // correct. Reporting them as one figure would make the per-rider lines fail to
  // add up to the header, which an owner reads as money going missing — so the
  // two travel as separate blocks, each naming the column it was windowed on.
  const [settlements, repaymentsRaw] = await Promise.all([
    settlementRepository.findBetweenWithRider(start, end, riderId),
    settlementRepository.findRepaymentsBetweenWithSettlement?.(start, end, riderId) ?? [],
  ]);
  const repayments = repaymentsRaw ?? [];
  const settlementIdsInWindow = new Set(settlements.map((s) => s.id));

  const byRider = new Map<
    number,
    {
      riderId: number;
      riderName: string | null;
      settlementCount: number;
      expected: number;
      collected: number;
      variance: number;
      /** Short and over apart (owner, 2026-10-27): netted, one hides the other. */
      short: number;
      over: number;
      shortageCount: number;
      /** Paid back afterwards, by the rider or the customer. */
      paidBackLater: number;
      writtenOff: number;
      stillOwed: number;
    }
  >();

  // Each handover's short and what has happened to it since. "Since" means up
  // to now, not up to the window's end: still owed is today's figure.
  const balanceOf = new Map(settlements.map((s) => [s.id, settlementBalance(s.variance, s.adjustments)]));
  const balance = (s: (typeof settlements)[number]) => balanceOf.get(s.id)!;

  for (const s of settlements) {
    let entry = byRider.get(s.riderId);
    if (!entry) {
      entry = {
        riderId: s.riderId,
        riderName: `${s.rider.firstName} ${s.rider.lastName}`.trim() || null,
        settlementCount: 0,
        expected: 0,
        collected: 0,
        variance: 0,
        short: 0,
        over: 0,
        shortageCount: 0,
        paidBackLater: 0,
        writtenOff: 0,
        stillOwed: 0,
      };
      byRider.set(s.riderId, entry);
    }
    const b = balance(s);
    entry.settlementCount += 1;
    entry.expected = round2(entry.expected + s.expectedAmount);
    entry.collected = round2(entry.collected + s.collectedAmount);
    entry.variance = round2(entry.variance + s.variance);
    entry.short = round2(entry.short + b.short);
    entry.over = round2(entry.over + Math.max(0, s.variance));
    if (s.variance < 0) entry.shortageCount += 1;
    entry.paidBackLater = round2(entry.paidBackLater + b.riderPaidBack + b.customerPaid);
    entry.writtenOff = round2(entry.writtenOff + b.writtenOff);
    entry.stillOwed = round2(entry.stillOwed + b.stillOwed);
  }

  for (const a of repayments) {
    if (settlementIdsInWindow.has(a.settlementId)) continue;
    let entry = byRider.get(a.settlement.riderId);
    if (!entry) {
      entry = {
        riderId: a.settlement.riderId,
        riderName: `${a.settlement.rider.firstName} ${a.settlement.rider.lastName}`.trim() || null,
        settlementCount: 0,
        expected: 0,
        collected: 0,
        variance: 0,
        short: 0,
        over: 0,
        shortageCount: 0,
        paidBackLater: 0,
        writtenOff: 0,
        stillOwed: 0,
      };
      byRider.set(a.settlement.riderId, entry);
    }
    entry.paidBackLater = round2(entry.paidBackLater + a.amount);
  }

  // On the cash clock (settledAt), like the rider table it sits beside: its
  // totals are the cash totals, not the revenue ones.
  const timelineBreakdown = breakdown(
    plan,
    settlements,
    (s) => s.settledAt,
    () => ({ settlementCount: 0, expected: 0, collected: 0, variance: 0, short: 0, over: 0, shortageCount: 0, stillOwed: 0 }),
    (f, s) => {
      f.settlementCount += 1;
      f.expected = round2(f.expected + s.expectedAmount);
      f.collected = round2(f.collected + s.collectedAmount);
      f.variance = round2(f.variance + s.variance);
      f.short = round2(f.short + balance(s).short);
      f.over = round2(f.over + Math.max(0, s.variance));
      if (s.variance < 0) f.shortageCount += 1;
      f.stillOwed = round2(f.stillOwed + balance(s).stillOwed);
    }
  );

  const sumOf = (pick: (b: ReturnType<typeof settlementBalance>) => number) =>
    round2(settlements.reduce((sum, s) => sum + pick(balance(s)), 0));
  const shortTotal = sumOf((b) => b.short);
  const paidBackLaterTotal = sumOf((b) => b.riderPaidBack + b.customerPaid);
  const writtenOffTotal = sumOf((b) => b.writtenOff);
  const stillOwedTotal = sumOf((b) => b.stillOwed);

  return {
    ...meta,
    // Read from commissionSplit rather than restated in the UI, so a change to
    // the business rule cannot leave a caption claiming the old ratio.
    commissionRate: RIDER_SHARE_RATE,
    timelineBreakdown,

    revenue: {
      basis: "errand.createdAt" as const,
      grossRevenue,
      /** The part of grossRevenue somebody has actually counted. */
      collectedRevenue,
      /** Finished errands whose money was never reconciled. */
      awaitingCollection,
      /** Finished errands with no settlement behind them. */
      awaitingCount: rows.filter((r) => !r.settlement).length,
      totalDeliveryFees,
      businessShare,
      riderShare,
      orderCount: rows.length,
    },

    cash: {
      basis: "settlement.settledAt" as const,
      expectedTotal: round2(settlements.reduce((sum, s) => sum + s.expectedAmount, 0)),
      collectedTotal: round2(settlements.reduce((sum, s) => sum + s.collectedAmount, 0)),
      varianceTotal: round2(settlements.reduce((sum, s) => sum + s.variance, 0)),
      settlementCount: settlements.length,
      shortageCount: settlements.filter((s) => s.variance < 0).length,
      // Over, apart from short: netted into varianceTotal, a ₱60 short and a
      // ₱60 over read as nothing wrong. overTotal - shortTotal = varianceTotal.
      overTotal: round2(settlements.reduce((sum, s) => sum + Math.max(0, s.variance), 0)),
      overCount: settlements.filter((s) => s.variance > 0).length,
      // What happened to the shorts afterwards. Always
      // shortTotal = paidBackLaterTotal + writtenOffTotal + stillOwedTotal.
      shortTotal,
      paidBackLaterTotal,
      writtenOffTotal,
      stillOwedTotal,
      byRider: [...byRider.values()].sort((a, b) => a.variance - b.variance),
      lines: [
        ...settlements.map((s) => {
          const b = balance(s);
          return {
            lineKey: `settlement-${s.id}`,
            lineKind: "HANDOVER" as const,
            errandId: s.errandId,
            referenceNo: s.errand?.referenceNo ?? null,
            riderName: `${s.rider.firstName} ${s.rider.lastName}`.trim() || null,
            expected: round2(s.expectedAmount),
            collected: round2(s.collectedAmount),
            variance: round2(s.variance),
            status: s.status,
            shortReason: s.shortReason,
            settledAt: s.settledAt.toISOString(),
            short: b.short,
            over: round2(Math.max(0, s.variance)),
            paidBackLater: round2(b.riderPaidBack + b.customerPaid),
            writtenOff: b.writtenOff,
            stillOwed: b.stillOwed,
            /** Every amount recorded since the handover and not undone, oldest first. */
            followUps: s.adjustments
              .filter((a) => !a.voidedAt)
              .map((a) => ({
                kind: a.kind,
                label: ADJUSTMENT_LABEL[a.kind as AdjustmentKind] ?? a.kind,
                amount: a.amount,
                reference: a.reference,
                recordedAt: a.recordedAt.toISOString(),
                recordedBy:
                  `${a.recordedBy.firstName ?? ""} ${a.recordedBy.lastName ?? ""}`.trim() ||
                  a.recordedBy.username,
              })),
          };
        }),
        ...repayments.map((a) => {
          const label = ADJUSTMENT_LABEL[a.kind as AdjustmentKind] ?? a.kind;
          const recordedBy =
            `${a.recordedBy.firstName ?? ""} ${a.recordedBy.lastName ?? ""}`.trim() ||
            a.recordedBy.username;
          return {
            lineKey: `repayment-${a.id}`,
            lineKind: "REPAYMENT" as const,
            errandId: a.settlement.errandId,
            referenceNo: a.settlement.errand?.referenceNo ?? null,
            riderName:
              `${a.settlement.rider.firstName} ${a.settlement.rider.lastName}`.trim() || null,
            expected: round2(a.amount),
            collected: round2(a.amount),
            variance: 0,
            status: label,
            shortReason: a.note ?? (a.reference ? `Ref ${a.reference}` : null),
            settledAt: a.recordedAt.toISOString(),
            short: 0,
            over: 0,
            paidBackLater: 0,
            writtenOff: 0,
            stillOwed: 0,
            followUps: [
              {
                kind: a.kind,
                label,
                amount: round2(a.amount),
                reference: a.reference,
                recordedAt: a.recordedAt.toISOString(),
                recordedBy,
              },
            ],
          };
        }),
      ],
    },

    riderOptions,
    /** The rider this report is narrowed to, or null for every rider. */
    rider,

    // Flat mirrors of the revenue block. The five report views and the CSV
    // exports read these names today; keeping them means the settlement change
    // is additive rather than a breaking rename for anything not yet updated.
    grossRevenue,
    collectedRevenue,
    awaitingCollection,
    totalDeliveryFees,
    businessShare,
    riderShare,
    orderCount: rows.length,

    notes: [
      "Sales are counted on the day the order was placed. Cash is counted on the day the " +
        "rider handed it over. An order placed late in a period can hand over its cash in the " +
        "next one, so the two sections do not have to match.",
      ...(awaitingCollection > 0
        ? [
            `₱${awaitingCollection.toFixed(2)} of these sales comes from finished orders whose ` +
              "cash has not been handed over and counted yet. Orders not paid in cash cannot " +
              "be handed over here, so they always stay in this amount.",
          ]
        : []),
      ...(shortTotal > 0
        ? [
            "A short stays on the handover as it was counted. Money paid back later, by the " +
              "rider or the customer, and amounts written off are shown beside it, and Still " +
              "owed is what is left as of today, even if it was paid after these dates.",
          ]
        : []),
    ],
  };
}

/**
 * One name per payment method.
 *
 * `CustomerTransaction.paymentMethod` carries the legacy literal "COD" on every
 * row, while `PaymentMode.name` — the catalogue a dispatcher actually picks
 * from — spells the same thing "Cash on Delivery". Only some errands have a
 * PaymentSelection, so the two spellings both appear and the subtotal table
 * listed one payment method as two, splitting its takings across both rows.
 *
 * Maps the legacy short forms onto the catalogue name. Anything unrecognised
 * passes through untouched rather than being coerced into a bucket it may not
 * belong in.
 */
const LEGACY_PAYMENT_NAMES: Record<string, string> = {
  COD: "Cash on Delivery",
  CASH: "Cash on Delivery",
};

function canonicalPaymentMethod(raw?: string | null): string {
  if (!raw) return "Cash on Delivery";
  const value = String(raw).trim();
  if (!value) return "Cash on Delivery";
  return LEGACY_PAYMENT_NAMES[value.toUpperCase()] ?? value;
}

export async function getTransactionSummary(request: ReportRequest) {
  const { start, end, meta, plan } = resolveRange(request);
  const riderId = request.riderId;
  const [transactions, activeNames, riders] = await Promise.all([
    customerTransactionRepository.findBetween(start, end, riderId),
    activeCategoryNameSet(),
    userRepository.findAllRiders(),
  ]);

  // Every rider, for the report's rider picker, whichever one is being shown
  // (owner, 2026-10-27). Same rules as the Settlement report: an unknown id is
  // refused rather than answered with an empty report that would print as a
  // rider with no transactions.
  const riderOptions = riders
    .map((r) => ({ riderId: r.id, name: `${r.firstName} ${r.lastName}`.trim() || r.username }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const rider = riderId ? (riderOptions.find((o) => o.riderId === riderId) ?? null) : null;
  if (riderId && !rider) throw new ServiceError(404, "That rider was not found.");

  const rows = transactions.map((t) => {
    const errand = t.errand;
    if (!errand) {
      return {
        transactionId: t.id,
        errandId: t.errandId,
        referenceNo: null,
        category: UNCATEGORISED,
        categories: [UNCATEGORISED],
        riderName: null,
        customerName: t.customer?.information
          ? `${t.customer.information.firstName ?? ""} ${t.customer.information.lastName ?? ""}`.trim() || null
          : null,
        deliveryAddress: "Unknown",
        amount: Number(t.amount) || 0,
        deliveryFee: 0,
        paymentMethod: canonicalPaymentMethod(t.paymentMethod),
        paymentReferenceNo: null,
        paymentTransactionId: null,
        paymentConfirmedBy: null,
        paymentEvidenceSource: null,
        paymentProofImageId: null,
        status: "CANCELLED" as const,
        errandStatus: "CANCELLED" as const,
        paymentStatus: t.status ?? "PENDING",
        createdAt: t.createdAt ? t.createdAt.toISOString() : new Date().toISOString(),
      };
    }

    // Same evidence and same rules as the Sales report, so an errand does not
    // appear under one category there and another here. Resolved from relations
    // already loaded with the transaction — no extra query per row.
    const { weights } = buildWeights(toCategoryEvidence(errand), activeNames);
    const categories = [...weights.keys()].sort();

    // The ledger entry that IS the payment — UPFRONT on a half-payment plan,
    // FINAL once the balance lands, whichever exists. TOP_UP/REFUND are
    // adjustments to that payment, not the payment itself, so they're
    // excluded here (they still count in the ledger a dispatcher sees).
    const paymentEntry =
      errand.payments?.find((p) => p.kind === "UPFRONT" || p.kind === "FINAL") ?? null;
    const proof = paymentEntry?.proofImage ?? null;

    const riderName = errand.rider
      ? `${errand.rider.firstName ?? ""} ${errand.rider.lastName ?? ""}`.trim() || null
      : null;

    const customerInfo = t.customer?.information;
    const customerName = customerInfo
      ? `${customerInfo.firstName ?? ""} ${customerInfo.lastName ?? ""}`.trim() || null
      : null;

    return {
      transactionId: t.id,
      errandId: t.errandId,
      referenceNo: errand.referenceNo ?? null,
      // The single category this transaction counts under, plus every category
      // it touched — a two-stop errand is one row but two shops.
      category: primaryCategory(weights),
      categories,
      riderName,
      customerName,
      deliveryAddress: errand.deliveryAddress ?? "",
      amount: Number(t.amount) || 0,
      deliveryFee: Number(errand.deliveryFee) || 0,
      // CustomerTransaction.paymentMethod is written once at creation and
      // defaults to COD. What a dispatcher actually confirmed with the customer
      // is the PaymentSelection, so that wins where one exists.
      paymentMethod: canonicalPaymentMethod(
        errand.paymentSelection?.paymentMode?.name ?? errand.paymentMode?.name ?? t.paymentMethod
      ),
      // The GCash/Maya reference and transaction id read off whichever photo
      // backed the payment — null on COD (no ledger entry to point at) or
      // where the confirmation predates this pairing existing.
      paymentReferenceNo: proof?.extraction?.referenceNo ?? null,
      paymentTransactionId: proof?.extraction?.transactionId ?? null,
      paymentConfirmedBy: paymentEntry?.confirmedBy
        ? `${paymentEntry.confirmedBy.firstName ?? ""} ${paymentEntry.confirmedBy.lastName ?? ""}`.trim() || null
        : paymentEntry
          ? // No person: the customer's receipt passed every check on its own.
            "Automatic (receipt check)"
          : null,
      // Whose photo it was — the customer's own upload, or a rider's
      // door-side photo of the customer's receipt. Exactly one of
      // customerId/riderId is ever set on a proof image.
      paymentEvidenceSource: proof ? (proof.customerId ? "customer" : "rider") : null,
      // The photo itself, for the report's viewer: opened through
      // GET /errands/:id/proof-images/:imageId, which owners may read.
      paymentProofImageId: proof?.id ?? null,
      // The errand's own lifecycle state. This is the status column that carries
      // information — see paymentStatus below for the one that does not.
      status: errand.status,
      errandStatus: errand.status,
      paymentStatus: t.status,
      createdAt: t.createdAt.toISOString(),
    };
  });

  const tally = (key: (row: (typeof rows)[number]) => string) => {
    const totals = new Map<string, { count: number; amount: number }>();
    for (const row of rows) {
      const bucket = totals.get(key(row)) ?? { count: 0, amount: 0 };
      bucket.count += 1;
      bucket.amount = round2(bucket.amount + row.amount);
      totals.set(key(row), bucket);
    }
    return [...totals.entries()]
      .map(([name, v]) => ({ ...v, name }))
      .sort((a, b) => b.amount - a.amount);
  };

  let unremitted = 0;
  let unremittedCount = 0;
  let uncollected = 0;
  let uncollectedCount = 0;
  for (const t of transactions) {
    const errand = t.errand;
    if (!errand || errand.status === "CANCELLED") continue;
    const txAmount = Number(t.amount) || 0;
    const settlement = (
      errand as {
        settlement?: {
          variance: number;
          adjustments?: Array<{ kind: string; amount: number; voidedAt?: Date | null }>;
        } | null;
      }
    ).settlement;
    if (settlement) {
      const b = settlementBalance(
        settlement.variance,
        (settlement.adjustments ?? []).map((a) => ({ ...a, voidedAt: a.voidedAt ?? null }))
      );
      if (b.stillOwed > 0) {
        unremitted = round2(unremitted + b.stillOwed);
        unremittedCount += 1;
      }
    } else {
      const ledgerPaid = (errand.payments ?? []).reduce((sum, p) => {
        const amt = Number(p.amount) || 0;
        return p.kind === "REFUND" ? sum - amt : sum + amt;
      }, 0);
      const unpaid = round2(Math.max(0, txAmount - ledgerPaid));
      if (unpaid > 0) {
        uncollected = round2(uncollected + unpaid);
        uncollectedCount += 1;
      }
    }
  }

  // Over the same rows as `totals` below, so the breakdown's total row is that total.
  const timelineBreakdown = breakdown(
    plan,
    rows,
    (r) => new Date(r.createdAt),
    () => ({ count: 0, amount: 0, deliveryFee: 0 }),
    (f, r) => {
      f.count += 1;
      f.amount = round2(f.amount + r.amount);
      f.deliveryFee = round2(f.deliveryFee + r.deliveryFee);
    }
  );

  return {
    ...meta,
    timelineBreakdown,
    transactions: rows,
    byPaymentMethod: tally((r) => r.paymentMethod).map(({ name, ...rest }) => ({
      paymentMethod: name,
      ...rest,
    })),
    byErrandStatus: tally((r) => r.errandStatus).map(({ name, ...rest }) => ({
      status: name,
      ...rest,
    })),
    byPaymentStatus: tally((r) => r.paymentStatus).map(({ name, ...rest }) => ({
      status: name,
      ...rest,
    })),
    totals: {
      count: rows.length,
      amount: round2(rows.reduce((sum, r) => sum + r.amount, 0)),
      deliveryFee: round2(rows.reduce((sum, r) => sum + r.deliveryFee, 0)),
      unremitted,
      unremittedCount,
      uncollected,
      uncollectedCount,
    },
    riderOptions,
    /** The rider this report is narrowed to, or null for every rider. */
    rider,
    notes: [
      "Payment status is saved once, when the order is placed, and is not updated after " +
        "that, so it shows Pending on every row. Order status is the one that shows what " +
        "really happened.",
    ],
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}


/**
 * Errands that did not reconcile, across a period.
 *
 * The owner's view of the same derivation the dispatcher's queue runs — but
 * keeping the resolved ones, because "who cleared this and what did they say"
 * is the part with teeth. An unresolved exception from three weeks ago is the
 * thing this report exists to make impossible to miss.
 */
export async function getExceptionReport(request: ReportRequest) {
  const { start, end, meta, plan } = resolveRange(request);
  const found = await exceptionService.findExceptions(start, end);

  // Counted on the day the order was placed: that is what the window selects
  // on, so every problem in the list lands in exactly one row. Bucketing on
  // when it happened would drop a short handover settled the morning after.
  const timelineBreakdown = breakdown(
    plan,
    found.exceptions,
    (e) => e.orderPlacedAt ?? e.occurredAt,
    () => ({ count: 0, openCount: 0, resolvedCount: 0, atRisk: 0 }),
    (f, e) => {
      f.count += 1;
      if (e.resolvedAt) f.resolvedCount += 1;
      else f.openCount += 1;
      f.atRisk = round2(f.atRisk + e.amountAtRisk);
    }
  );

  // Cash short and cash over as two problems on this report (owner,
  // 2026-10-27): one "Cash short or over" bar hid which way the money went.
  // Only the report splits them; the dispatcher's queue keeps CASH_VARIANCE.
  // Each line carries `problem`, the kind it is counted and labelled under.
  const problemOf = (e: (typeof found.exceptions)[number]): ReportProblem =>
    e.kind !== "CASH_VARIANCE" || !e.cash
      ? e.kind
      : e.cash.collected < e.cash.expected
        ? "CASH_SHORT"
        : "CASH_OVER";
  const exceptions = found.exceptions.map((e) => ({ ...e, problem: problemOf(e) }));

  // Same order as before: the split pair takes CASH_VARIANCE's place, short first.
  const byProblem = new Map<ReportProblem, { count: number; atRisk: number }>();
  for (const { kind } of found.summary.byKind) {
    for (const problem of kind === "CASH_VARIANCE" ? (["CASH_SHORT", "CASH_OVER", "CASH_VARIANCE"] as const) : [kind]) {
      for (const e of exceptions) {
        if (e.kind !== kind || e.problem !== problem) continue;
        const entry = byProblem.get(problem) ?? { count: 0, atRisk: 0 };
        entry.count += 1;
        entry.atRisk = round2(entry.atRisk + e.amountAtRisk);
        byProblem.set(problem, entry);
      }
    }
  }

  return {
    meta,
    ...found,
    exceptions,
    summary: { ...found.summary, byKind: [...byProblem.entries()].map(([kind, v]) => ({ kind, ...v })) },
    timelineBreakdown,
  };
}

/** What a Help Desk Report line is counted under: its kind, with cash split. */
export type ReportProblem = ExceptionKind | "CASH_SHORT" | "CASH_OVER";
