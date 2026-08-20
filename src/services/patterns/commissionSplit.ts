// Fixed rider/business revenue split for commission & settlement estimates
// (Dashboard revenue overview, Commission Report, Settlement Report). This
// replaces the old serviceFeePercent-based estimate — it's now a fixed
// business rule, not an owner-configurable rate, so it's computed in exactly
// one place instead of the ratio being duplicated as a magic number per report.
export const RIDER_SHARE_RATE = 0.7;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// businessShare is derived as the remainder (not totalCost * 0.3 independently)
// so the two always sum exactly to totalCost even after rounding.
export function splitRiderBusinessShare(totalCost: number): { riderShare: number; businessShare: number } {
  const riderShare = round2(totalCost * RIDER_SHARE_RATE);
  return { riderShare, businessShare: round2(totalCost - riderShare) };
}
