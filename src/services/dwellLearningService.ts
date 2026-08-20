import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { dwellObservationRepository } from "../repositories/dwellObservationRepository.js";

// How many recent observations feed a category's percentiles. Bounded on
// purpose: dwell behaviour drifts as a store reorganises or a branch gets
// busier, and a year-old sample should not anchor today's promise.
const SAMPLE_SIZE = 200;

// Below this, the sample says more about chance than about the store type, so
// the seeded default is left in place (and the ETA keeps padding its upper bound
// while sampleCount stays low).
const MIN_SAMPLES_TO_LEARN = 10;

// Sanity bounds. One pathological observation — a rider who forgot to close an
// errand, a geofence that never registered a departure — must not be able to
// move a whole category's estimate to something absurd.
const MIN_DWELL_SECONDS = 60;
const MAX_DWELL_SECONDS = 3600;

// Nearest-rank percentile on a sorted ascending array.
export function percentile(sortedValues: number[], fraction: number): number {
  if (sortedValues.length === 0) return 0;
  const rank = Math.ceil(fraction * sortedValues.length);
  return sortedValues[Math.min(Math.max(rank, 1), sortedValues.length) - 1];
}

export interface CategoryLearningResult {
  categoryId: number;
  name: string;
  sampleCount: number;
  p50: number;
  p80: number;
  applied: boolean;
  reason?: string;
}

// Recomputes each category's dwell percentiles from real observations.
//
// Percentiles rather than a mean: queue time has a long right tail (most
// supermarket runs are ordinary, a few land behind a price check and a full
// trolley), and a mean would be dragged up by those few until every ordinary
// errand was over-promised.
export async function relearnDwellTimes(): Promise<CategoryLearningResult[]> {
  const categories = await prisma.merchantCategory.findMany({
    where: { status: "Active" },
    select: { id: true, name: true },
  });

  const results: CategoryLearningResult[] = [];

  for (const category of categories) {
    const rows = await dwellObservationRepository.recentDwellSecondsForCategory(category.id, SAMPLE_SIZE);

    const values = rows
      .map((row) => row.dwellSeconds)
      .filter((seconds) => seconds >= MIN_DWELL_SECONDS && seconds <= MAX_DWELL_SECONDS)
      .sort((a, b) => a - b);

    if (values.length < MIN_SAMPLES_TO_LEARN) {
      results.push({
        categoryId: category.id,
        name: category.name,
        sampleCount: values.length,
        p50: 0,
        p80: 0,
        applied: false,
        reason: `only ${values.length} usable sample(s), need ${MIN_SAMPLES_TO_LEARN}`,
      });
      continue;
    }

    const p50 = Math.round(percentile(values, 0.5));
    // Guarantees a non-degenerate range even if the sample is unusually tight,
    // so the customer is never shown "23-23 min" for something inherently
    // uncertain.
    const p80 = Math.max(Math.round(percentile(values, 0.8)), p50 + 60);

    await prisma.merchantCategory.update({
      where: { id: category.id },
      data: {
        dwellP50Seconds: p50,
        dwellP80Seconds: p80,
        dwellSampleCount: values.length,
        dwellUpdatedAt: new Date(),
      },
    });

    results.push({
      categoryId: category.id,
      name: category.name,
      sampleCount: values.length,
      p50,
      p80,
      applied: true,
    });
  }

  const applied = results.filter((result) => result.applied).length;
  logger.info(`Dwell learning: updated ${applied}/${results.length} categories.`);
  return results;
}
