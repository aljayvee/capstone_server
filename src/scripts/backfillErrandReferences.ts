/**
 * Gives every errand created before reference numbers existed its
 * YYMMDD-KKKKK-NNNN number (lib/errandReference.ts).
 *
 * Oldest first within each Manila day, continuing that day's counter, so a day
 * that already has numbered orders (the deploy day) carries on after them.
 * Safe to run again: only rows still without a number are touched.
 *
 * Writes with raw SQL on purpose. A Prisma update stamps @updatedAt, and older
 * rows with no deliveredAt/completedAt are windowed on updatedAt by the
 * delivery reports, so a backfill through Prisma would move them all to today.
 *
 * `--number-last=<id prefix>` numbers rows whose id starts with the prefix
 * after every other row of their day. Production holds ~500 synthetic errands
 * from the 2026-10-16 seeder (ids `e0000000-0000-4000-8000-...`); numbered in
 * date order they pushed real orders to numbers like 0085 on a day with five.
 *
 *   npm run errand-ref:backfill            # write
 *   npm run errand-ref:backfill -- --dry   # count and preview only
 *   npm run errand-ref:backfill -- --dry --number-last=e0000000-0000-4000-8000-
 */
import { prisma } from "../lib/prisma.js";
import { formatReferenceNo, nextDaySequence, referenceDay } from "../lib/errandReference.js";

async function main() {
  const dry = process.argv.includes("--dry");
  const lastPrefix = process.argv.find((a) => a.startsWith("--number-last="))?.slice("--number-last=".length) || null;
  const found = await prisma.errand.findMany({
    where: { referenceNo: null },
    select: { id: true, createdAt: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  // Stable split: each group keeps its date order, and since numbers run per
  // day, the deferred rows land after the others of their own day.
  const deferred = (id: string) => lastPrefix !== null && id.startsWith(lastPrefix);
  const later = found.filter((e) => deferred(e.id));
  const pending = [...found.filter((e) => !deferred(e.id)), ...later];
  if (lastPrefix) console.log(`${later.length} rows starting "${lastPrefix}" numbered after the rest of their day.`);
  const days = new Set(pending.map((e) => referenceDay(e.createdAt)));
  console.log(`${pending.length} errands without a reference number, over ${days.size} days.`);

  if (dry) {
    // What the first few would get, continuing each day's existing counter.
    const counters = await prisma.errandRefCounter.findMany({ where: { day: { in: [...days] } } });
    const last = new Map(counters.map((c) => [c.day, c.last]));
    for (const e of pending.slice(0, 5)) {
      const day = referenceDay(e.createdAt);
      const sequence = (last.get(day) ?? 0) + 1;
      last.set(day, sequence);
      console.log(`  ${e.id} -> ${formatReferenceNo(day, e.id, sequence)}`);
    }
    console.log("Dry run: nothing written.");
    return;
  }

  let written = 0;
  for (const e of pending) {
    await prisma.$transaction(async (tx) => {
      const day = referenceDay(e.createdAt);
      const referenceNo = formatReferenceNo(day, e.id, await nextDaySequence(tx, day));
      const changed = await tx.$executeRaw`UPDATE errands SET referenceNo = ${referenceNo} WHERE id = ${e.id} AND referenceNo IS NULL`;
      // Numbered by something else since the read: give the number back.
      if (changed !== 1) throw new Error(`skip ${e.id}`);
    }).then(
      () => written++,
      (err: Error) => {
        if (!err.message.startsWith("skip ")) throw err;
      },
    );
    if (written > 0 && written % 100 === 0) console.log(`written ${written} / ${pending.length}`);
  }
  console.log(`Done: ${written} numbered, ${pending.length - written} already had one.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(process.exitCode ?? 0);
  });
