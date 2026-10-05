/**
 * Exports every real exception in the database as model input, with the
 * dispatcher's own written reason beside it where one was recorded.
 *
 *   DATABASE_URL=... npx tsx scripts/exception-reasons/exportRealJobs.ts ml/exception-reasons/real-jobs.csv
 *
 * Written to a file rather than stdout, because the server's logger also
 * writes to stdout and would land in the middle of the CSV.
 *
 * These are the model's real-life jobs: errands riders actually ran, cleared
 * by dispatchers in their own words. The `label` column is left blank for a
 * person to fill in with the REASONS code the dispatcher's words amount to,
 * or leave blank when none of them fits. The experiments score the model only
 * on rows somebody labelled.
 *
 * Uses the same evidence adapter as the live API (toReasonContext), so a row
 * here is exactly what the model saw when a dispatcher pressed Tab.
 *
 * Carries no customer details: amounts, shop names, photo counts, and the
 * rider's and dispatcher's typed notes about the money.
 */
import { errandRepository } from "../../src/repositories/errandRepository.js";
import { exceptionsFor } from "../../src/services/exceptionService.js";
import { toReasonContext } from "../../src/services/exceptionReasonService.js";
import { writeFileSync } from "node:fs";
import { prisma } from "../../src/lib/prisma.js";
import { toCsv, type LabelledRow } from "./dataset.js";

async function main() {
  const end = new Date();
  const start = new Date(0);
  const errands = await errandRepository.findWithReconciliationEvidenceBetween(start, end);

  const rows: LabelledRow[] = [];
  for (const errand of errands) {
    for (const exception of exceptionsFor(errand)) {
      rows.push({
        context: toReasonContext(errand, exception),
        label: "",
        source: "production",
        extra: {
          errand: errand.id.slice(0, 8),
          occurredAt: exception.occurredAt.toISOString(),
          dispatcherReason: exception.resolutionReason ?? "",
        },
      });
    }
  }

  const out = process.argv[2];
  if (!out) throw new Error("Pass the output path, e.g. ml/exception-reasons/real-jobs.csv");
  writeFileSync(out, toCsv(rows, ["errand", "occurredAt", "dispatcherReason"]));
  console.error(`Wrote ${rows.length} real exceptions from ${errands.length} errands to ${out}`);
  await prisma.$disconnect();
}

void main();
