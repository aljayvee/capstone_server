/**
 * Re-derives customer_transactions.status (and paidAt) for every existing row.
 *
 * Until 2026-10-09 the status was written once, as PENDING, and never again.
 * The live triggers (transactionStatusService) only fix an errand when something
 * next happens to it, which a finished errand never has. This brings the old
 * rows in line, using the same rule (deriveTransactionStatus).
 *
 * paidAt is dated from the evidence, not from today: the cash settlement for
 * cash collected at the door, else the ledger row that cleared the bill. Only
 * filled where empty, so a live-stamped paidAt is never moved.
 *
 * Safe to run again: it writes only rows whose answer differs from what is
 * stored, so a second run writes nothing.
 *
 *   npm run transactions:backfill-status            # write
 *   npm run transactions:backfill-status -- --dry   # report only
 */
import { prisma } from "../lib/prisma.js";
import { hasPaymentLedger } from "../services/patterns/paymentModes.js";
import { summarisePaymentPlan } from "../services/patterns/paymentLedger.js";
import { deriveTransactionStatus } from "../services/patterns/transactionStatus.js";

const BATCH = 200;
const PAID_IN = new Set(["UPFRONT", "TOP_UP", "FINAL"]);

async function main() {
  const dry = process.argv.includes("--dry");
  const rows = await prisma.customerTransaction.findMany({
    select: {
      id: true,
      errandId: true,
      status: true,
      paidAt: true,
      errand: {
        select: {
          status: true,
          totalCost: true,
          paymentSelection: { select: { paymentMode: { select: { name: true } } } },
          payments: { select: { kind: true, amount: true, confirmedAt: true } },
          settlement: { select: { status: true, settledAt: true } },
        },
      },
    },
  });

  const transitions = new Map<string, number>();
  const writes: Array<{ id: number; status: string; paidAt?: Date }> = [];

  for (const row of rows) {
    const errand = row.errand;
    const ledger = hasPaymentLedger(errand.paymentSelection)
      ? summarisePaymentPlan({
          grandTotal: errand.totalCost,
          entries: errand.payments.map((p) => ({ kind: p.kind, amount: p.amount })),
          cancelled: errand.status === "CANCELLED",
        })
      : null;
    const status = deriveTransactionStatus({
      errandStatus: String(errand.status),
      ledger,
      settlement: errand.settlement ? { status: errand.settlement.status } : null,
    });

    // When the money arrived: the settlement if the rider collected it, else the
    // last ledger row that brought money in.
    const lastPaidIn = errand.payments
      .filter((p) => PAID_IN.has(p.kind))
      .reduce<Date | null>((latest, p) => (!latest || p.confirmedAt > latest ? p.confirmedAt : latest), null);
    const evidenceAt = errand.settlement?.settledAt ?? lastPaidIn;
    const paidAt = status === "PAID" && !row.paidAt && evidenceAt ? evidenceAt : undefined;

    if (status === row.status && !paidAt) continue;
    const key = `${row.status} -> ${status}${paidAt ? " (+paidAt)" : ""}`;
    transitions.set(key, (transitions.get(key) ?? 0) + 1);
    writes.push({ id: row.id, status, ...(paidAt ? { paidAt } : {}) });
  }

  console.log(`${rows.length} transactions, ${writes.length} to update.${dry ? " Dry run: nothing written." : ""}`);
  for (const [key, count] of [...transitions.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${key}: ${count}`);
  }
  if (dry) return;

  for (let i = 0; i < writes.length; i += BATCH) {
    await prisma.$transaction(
      writes.slice(i, i + BATCH).map((w) =>
        prisma.customerTransaction.update({
          where: { id: w.id },
          data: { status: w.status, ...(w.paidAt ? { paidAt: w.paidAt } : {}) },
        })
      )
    );
    console.log(`written ${Math.min(i + BATCH, writes.length)} / ${writes.length}`);
  }
}

// Exits explicitly, as backfillChatAccess does: imported modules can hold
// handles open and leave a finished run alive.
main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(process.exitCode ?? 0);
  });
