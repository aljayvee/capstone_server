import { errandRepository } from "../repositories/errandRepository.js";
import { customerTransactionRepository } from "../repositories/customerTransactionRepository.js";
import { userRepository } from "../repositories/userRepository.js";
import { ratingRepository } from "../repositories/ratingRepository.js";
import { getPeriodStrategy, type ReportPeriod } from "./patterns/reportPeriodStrategy.js";
import { splitRiderBusinessShare } from "./patterns/commissionSplit.js";

interface ReportMeta {
  period: ReportPeriod;
  rangeLabel: string;
  start: string;
  end: string;
}

function resolveRange(period: ReportPeriod, referenceDate: Date) {
  const strategy = getPeriodStrategy(period);
  const { start, end } = strategy.range(referenceDate);
  const meta: ReportMeta = {
    period,
    rangeLabel: strategy.label(referenceDate),
    start: start.toISOString(),
    end: end.toISOString(),
  };
  return { start, end, meta };
}

export async function getSalesReport(period: ReportPeriod, referenceDate: Date) {
  const { start, end, meta } = resolveRange(period, referenceDate);
  const [totals, byCategory] = await Promise.all([
    errandRepository.aggregateBetween(start, end),
    errandRepository.groupByCategoryBetween(start, end),
  ]);

  return {
    ...meta,
    totalRevenue: round2(totals._sum.totalCost ?? 0),
    totalOrders: totals._count._all,
    byCategory: byCategory.map((c) => ({
      category: c.category,
      revenue: round2(c._sum.totalCost ?? 0),
      count: c._count._all,
    })),
  };
}

export async function getRiderPerformanceReport(period: ReportPeriod, referenceDate: Date) {
  const { start, end, meta } = resolveRange(period, referenceDate);
  const [finished, riders] = await Promise.all([
    errandRepository.findFinishedBetween(start, end),
    userRepository.findAllRiders(),
  ]);

  const statsByRider = new Map<number, { completedCount: number; totalMinutes: number }>();
  for (const errand of finished) {
    if (errand.riderId === null) continue;
    const minutes = (errand.updatedAt.getTime() - errand.createdAt.getTime()) / 60000;
    const existing = statsByRider.get(errand.riderId) ?? { completedCount: 0, totalMinutes: 0 };
    existing.completedCount += 1;
    existing.totalMinutes += minutes;
    statsByRider.set(errand.riderId, existing);
  }

  // Ratings now exist (see ratingService.ts) — average is all-time, not scoped
  // to this report's period, since ratings are too sparse for a period-windowed
  // average to be meaningful. Fetched in parallel; rider counts are small enough
  // at this app's scale that one query per rider is fine (see AGENTS.md section 5
  // on not over-engineering for scale this app doesn't have yet).
  const ratingAverages = await Promise.all(riders.map((r) => ratingRepository.averageForRider(r.id)));

  const riderRows = riders
    .map((rider, idx) => {
      const stats = statsByRider.get(rider.id);
      const ratingAvg = ratingAverages[idx];
      return {
        riderId: rider.id,
        name: `${rider.firstName} ${rider.lastName}`.trim(),
        completedCount: stats?.completedCount ?? 0,
        avgDeliveryMinutes: stats && stats.completedCount > 0 ? round2(stats.totalMinutes / stats.completedCount) : null,
        averageRating: ratingAvg._count._all > 0 ? round2(ratingAvg._avg.stars ?? 0) : null,
      };
    })
    .sort((a, b) => b.completedCount - a.completedCount);

  return { ...meta, riders: riderRows };
}

// Commission is an ESTIMATE (fixed rider/business split — see
// patterns/commissionSplit.ts — applied to historical order value) — see
// analyticsService.ts's summarizeRevenue for why the schema doesn't support a
// ledger-accurate historical split today.
export async function getCommissionReport(period: ReportPeriod, referenceDate: Date) {
  const { start, end, meta } = resolveRange(period, referenceDate);
  const [totals, byCategory] = await Promise.all([
    errandRepository.aggregateBetween(start, end),
    errandRepository.groupByCategoryBetween(start, end),
  ]);

  const { businessShare: estimatedCommission } = splitRiderBusinessShare(totals._sum.totalCost ?? 0);

  return {
    ...meta,
    estimatedCommission,
    totalDeliveryFees: round2(totals._sum.deliveryFee ?? 0),
    orderCount: totals._count._all,
    byCategory: byCategory.map((c) => ({
      category: c.category,
      orderCount: c._count._all,
      revenue: round2(c._sum.totalCost ?? 0),
    })),
  };
}

export async function getSettlementReport(period: ReportPeriod, referenceDate: Date) {
  const { start, end, meta } = resolveRange(period, referenceDate);
  const rows = await errandRepository.findWithSettlementBetween(start, end);

  const totalDeliveryFees = round2(rows.reduce((sum, r) => sum + r.deliveryFee, 0));

  // Prefers each errand's real reconciled cash (SettlementRecord.collectedAmount)
  // over the calculated totalCost estimate — only known once a COD errand is
  // delivered and settled; falls back to the estimate for everything still in
  // flight, so this never goes empty mid-period.
  const grossRevenue = round2(rows.reduce((sum, r) => sum + (r.settlement?.collectedAmount ?? r.totalCost), 0));
  const { riderShare, businessShare } = splitRiderBusinessShare(grossRevenue);

  return {
    ...meta,
    grossRevenue,
    totalDeliveryFees,
    businessShare,
    riderShare,
    orderCount: rows.length,
  };
}

export async function getTransactionSummary(period: ReportPeriod, referenceDate: Date) {
  const { start, end, meta } = resolveRange(period, referenceDate);
  const transactions = await customerTransactionRepository.findBetween(start, end);

  return {
    ...meta,
    transactions: transactions.map((t) => ({
      transactionId: t.id,
      errandId: t.errandId,
      category: t.errand.category,
      riderName: t.errand.rider ? `${t.errand.rider.firstName} ${t.errand.rider.lastName}`.trim() : null,
      customerName: t.customer.information
        ? `${t.customer.information.firstName} ${t.customer.information.lastName}`.trim()
        : null,
      deliveryAddress: t.errand.deliveryAddress,
      amount: t.amount,
      deliveryFee: t.errand.deliveryFee,
      paymentMethod: t.paymentMethod,
      status: t.status,
      createdAt: t.createdAt.toISOString(),
    })),
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
