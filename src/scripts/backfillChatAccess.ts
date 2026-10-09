/**
 * Writes `chat_access/<errandId>` in the Realtime Database for every errand:
 * its customer, and the dispatcher on its latest dispatch log.
 *
 * Run once before publishing the rules that read it (firebase/database.rules.json),
 * or every existing chat closes for its own customer and dispatcher. Safe to run
 * again: each entry is rewritten from MariaDB, the source of truth.
 *
 *   npm run chat-access:backfill            # write
 *   npm run chat-access:backfill -- --dry   # count only
 */
import { prisma } from "../lib/prisma.js";
import { firebaseUidFor } from "../lib/firebaseAdmin.js";
import { writeChatAccessBatch, type ChatAccessEntry } from "../lib/chatAccess.js";

const BATCH = 500;

async function main() {
  const dry = process.argv.includes("--dry");
  const errands = await prisma.errand.findMany({
    select: {
      id: true,
      customerId: true,
      dispatchLogs: { orderBy: { dispatchedAt: "desc" }, take: 1, select: { dispatcherId: true } },
    },
  });

  let claimed = 0;
  const entries: Array<[string, ChatAccessEntry]> = errands.map((e) => {
    const dispatcherId = e.dispatchLogs[0]?.dispatcherId ?? null;
    if (dispatcherId !== null) claimed++;
    return [
      e.id,
      {
        customer: firebaseUidFor("CUSTOMER", e.customerId),
        dispatcher: dispatcherId === null ? null : firebaseUidFor("DISPATCHER", dispatcherId),
      },
    ];
  });

  console.log(`${entries.length} errands, ${claimed} with a dispatcher.${dry ? " Dry run: nothing written." : ""}`);
  if (dry) return;

  for (let i = 0; i < entries.length; i += BATCH) {
    await writeChatAccessBatch(Object.fromEntries(entries.slice(i, i + BATCH)));
    console.log(`written ${Math.min(i + BATCH, entries.length)} / ${entries.length}`);
  }
}

// Exits explicitly: the modules this imports keep handles open (the Realtime
// Database connection among them), and the first production run sat finished
// but alive until it was killed.
main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(process.exitCode ?? 0);
  });
