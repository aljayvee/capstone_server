import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";

/**
 * The errand reference number people read and say aloud: YYMMDD-KKKKK-NNNN.
 *
 *  - YYMMDD: the Manila calendar day the order was placed. Manila, not server
 *    UTC, or every order placed between midnight and 8 AM would carry yesterday.
 *  - KKKKK: the last 5 characters of the errand's UUID, upper case. Ties the
 *    number to the row at a glance; not unique on its own.
 *  - NNNN: that day's order number from 0001 (errand_ref_counters). Widens to
 *    5 digits past 9999 rather than wrapping.
 *
 * Display and search only. The UUID stays the only key for routes, sockets,
 * Firebase paths and RTDB rules: a day's sequence is guessable.
 */

/** Manila is UTC+8 all year; the Philippines has no daylight saving time. */
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

const MAX_ATTEMPTS = 3;

/** The Manila calendar day of `at` as YYMMDD. */
export function referenceDay(at: Date): string {
  const manila = new Date(at.getTime() + MANILA_OFFSET_MS);
  const yy = String(manila.getUTCFullYear() % 100).padStart(2, "0");
  const mm = String(manila.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(manila.getUTCDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

/** The last 5 letters or digits of an errand id, upper case. */
export function referenceKey(errandId: string): string {
  return errandId.replace(/[^a-zA-Z0-9]/g, "").slice(-5).toUpperCase();
}

export function formatReferenceNo(day: string, errandId: string, sequence: number): string {
  return `${day}-${referenceKey(errandId)}-${String(sequence).padStart(4, "0")}`;
}

/**
 * Takes the next number for `day`. Must run inside the transaction that writes
 * the errand: the counter row stays locked until that commits, so two orders
 * placed at once queue for it instead of sharing a number, and a write that
 * fails rolls its number back instead of leaving a gap.
 */
export async function nextDaySequence(tx: Prisma.TransactionClient, day: string): Promise<number> {
  await tx.$executeRaw`INSERT INTO errand_ref_counters (day, last) VALUES (${day}, 1) ON DUPLICATE KEY UPDATE last = last + 1`;
  const rows = await tx.$queryRaw<Array<{ last: number | bigint }>>`SELECT last FROM errand_ref_counters WHERE day = ${day}`;
  return Number(rows[0].last);
}

/**
 * The number to print for an errand in a notification or a report: its
 * reference, or the key alone for a row the backfill has not reached yet. Never
 * throws: a message must not fail because its label could not be read.
 */
export async function referenceLabel(errandId: string): Promise<string> {
  try {
    const row = await prisma.errand.findUnique({ where: { id: errandId }, select: { referenceNo: true } });
    return row?.referenceNo ?? referenceKey(errandId);
  } catch {
    return referenceKey(errandId);
  }
}

// Two orders opening the same day's counter row at the same instant can
// deadlock in InnoDB; MariaDB rolls one back, and it is safe to run again.
function isWriteConflict(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (err.code === "P2034") return true;
  return err.code === "P2010" && String((err.meta as { code?: unknown } | undefined)?.code) === "1213";
}

/**
 * Runs `write` in a transaction with a fresh errand id and its reference number.
 * `write` must create the errand with both, on `tx`.
 */
export async function withErrandReference<T>(
  write: (tx: Prisma.TransactionClient, ref: { id: string; referenceNo: string }) => Promise<T>,
  id: string = randomUUID(),
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        const day = referenceDay(new Date());
        const sequence = await nextDaySequence(tx, day);
        return write(tx, { id, referenceNo: formatReferenceNo(day, id, sequence) });
      });
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS || !isWriteConflict(err)) throw err;
    }
  }
}
