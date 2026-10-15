/**
 * Links each Location Store registered before 2026-10-13 to its Google Maps
 * place, and moves its pin to Google's position: the rows typed in with a
 * guessed spot ("National Highway, Tacurong City") become real places.
 *
 *   tsx src/scripts/linkLocationStoresToGoogle.ts           report only
 *   tsx src/scripts/linkLocationStoresToGoogle.ts --apply   write the links
 *
 * A store is linked only when Google's answer has a related name (the same,
 * or one starting with the other) and is within MATCH_METERS of the pin, or
 * is the only related answer in the city. Anything else is reported for the
 * owner to link by hand in the portal. Each search is one Pro-tier Google
 * request, counted against the free allowance (lib/places/placesBudget.ts).
 */
import { prisma } from "../lib/prisma.js";
import { matchGooglePlace } from "../lib/places/googlePlaceMatch.js";

const apply = process.argv.includes("--apply");

async function main() {
  const rows = await prisma.verifiedPlace.findMany({ orderBy: { name: "asc" } });
  const taken = new Set(rows.map((r) => r.googlePlaceId).filter(Boolean));
  let linked = 0;
  for (const row of rows) {
    if (row.googlePlaceId) continue;
    const best = await matchGooglePlace(row.name, row, (id) => taken.has(id));
    if (best.status === "unavailable") {
      console.log(`?  ${row.name}: Google could not be asked; run again later.`);
      continue;
    }
    if (best.status === "none") {
      console.log(`-  ${row.name}: no Google Maps match (${best.related} related). Link by hand.`);
      continue;
    }
    if (best.status === "taken") {
      console.log(`=  ${row.name}: Google Maps place ${best.place.name} already belongs to another store (a duplicate).`);
      continue;
    }
    taken.add(best.place.googlePlaceId);
    linked += 1;
    console.log(`+  ${row.name} -> ${best.place.name} (${best.place.googlePlaceId}), pin moved ${best.metres} m`);
    if (apply) {
      await prisma.verifiedPlace.update({
        where: { id: row.id },
        data: { googlePlaceId: best.place.googlePlaceId, latitude: best.place.latitude, longitude: best.place.longitude },
      });
    }
  }
  console.log(`${linked} of ${rows.filter((r) => !r.googlePlaceId).length} unlinked stores ${apply ? "linked" : "would be linked (run with --apply)"}.`);
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
