// Repairs delivery addresses that were stored as Open Location Codes.
//
// Android's geocoder returns a plus code as the whole formatted address when a
// coordinate has no street address of its own — so a pin dropped on the STI
// College campus was saved as "MMM8+F22, Road, City of Tacurong, Sultan Kudarat,
// Philippines". The capture path no longer does this (see
// CustomerApp/src/hooks/useReverseGeocodedAddress.ts), but rows written before
// that fix keep the code forever: the Track tab renders the stored string and
// never re-resolves it.
//
// Each match is re-resolved against the VerifiedPlace catalogue. Only the
// display string is ever written — latitude and longitude are correct and are
// never touched.
//
//   npx tsx scripts/backfillPlusCodeAddresses.ts --dry-run
//   npx tsx scripts/backfillPlusCodeAddresses.ts
import { prisma } from "../src/lib/prisma.js";
import { placeService } from "../src/services/placeService.js";
import { ERRAND_STATUSES, type ErrandStatusValue } from "../src/services/patterns/errandStateMachine.js";

// Must stay in step with isPlusCode() in the customer app's
// useReverseGeocodedAddress.ts — same grid alphabet, same shape.
const PLUS_CODE = /^[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3}$/i;

function isPlusCodeAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  return PLUS_CODE.test(address.split(",")[0].trim());
}

// A bare "Road" is the geocoder's placeholder for an unnamed way — it is what it
// emits when it has nothing specific to put in that slot.
const PLACEHOLDER_PARTS = new Set(["road", "unnamed road"]);

/**
 * Salvages the address that was already sitting behind the plus code.
 *
 * The code is a *prefix*, not the whole string, and what follows is often a
 * perfectly good address: "MMMJ+949, Rafael Alunan Ave, City of Tacurong, ..."
 * only needs its first segment removed.
 *
 * Whether that is worth doing is decided by the segment immediately after the
 * code, because that is the slot the geocoder fills with the most specific thing
 * it knows. A real street name there means the rest of the string is a usable
 * address. A placeholder there means the geocoder had nothing specific to say,
 * and the remainder is just "city, province, country" — which reads like an
 * address without being one, and would be a worse thing to hand a rider than an
 * obviously-cryptic code. Those rows are left alone for the catalogue to answer.
 */
function stripPlusCodePrefix(address: string): string | null {
  const segments = address.split(",").map((segment) => segment.trim()).filter(Boolean);
  if (segments.length < 2) return null;

  const remainder = segments.slice(1);
  if (PLACEHOLDER_PARTS.has(remainder[0].toLowerCase())) return null;

  return remainder.join(", ");
}

// Completed and cancelled errands are historical delivery records. What address
// was shown at the time is part of that record, so they are deliberately left
// alone — only errands still in flight, where the string is still being read by
// a customer and a rider, are repaired.
//
// Derived from the canonical status list by subtraction rather than written out,
// so a status added later is treated as active and repaired, instead of being
// silently skipped by a list nobody remembered to update.
const TERMINAL_STATUSES: ErrandStatusValue[] = ["COMPLETED", "CANCELLED"];
const ACTIVE_STATUSES = ERRAND_STATUSES.filter((status) => !TERMINAL_STATUSES.includes(status));

interface Candidate {
  id: string | number;
  address: string;
  latitude: number | null;
  longitude: number | null;
}

interface Repair {
  id: string | number;
  before: string;
  after: string;
  // How the replacement was arrived at, so the dry-run output can be judged
  // rather than just trusted.
  via: string;
}

async function resolveAll(candidates: Candidate[]): Promise<{ repairs: Repair[]; unresolved: Candidate[] }> {
  const repairs: Repair[] = [];
  const unresolved: Candidate[] = [];

  for (const row of candidates) {
    // The catalogue is tried first: an establishment name is the most useful
    // answer a rider can get, and it is the only one that can beat a street.
    if (row.latitude != null && row.longitude != null) {
      const match = await placeService.reverseLookup({
        latitude: row.latitude,
        longitude: row.longitude,
      });
      if (match) {
        repairs.push({
          id: row.id,
          before: row.address,
          after: match.place.name,
          via: `verified place, ${Math.round(match.distanceMeters)} m`,
        });
        continue;
      }
    }

    const salvaged = stripPlusCodePrefix(row.address);
    if (salvaged) {
      repairs.push({ id: row.id, before: row.address, after: salvaged, via: "stripped plus-code prefix" });
      continue;
    }

    unresolved.push(row);
  }

  return { repairs, unresolved };
}

function report(label: string, scanned: number, repairs: Repair[], unresolved: Candidate[]) {
  console.log(`\n${label}`);
  console.log(`  with a plus-code address: ${scanned}`);
  console.log(`  repairable:               ${repairs.length}`);
  console.log(`  left alone:               ${unresolved.length}`);

  for (const repair of repairs.slice(0, 10)) {
    console.log(`    #${repair.id}  "${repair.before}"`);
    console.log(`         -> "${repair.after}"   [${repair.via}]`);
  }
  if (repairs.length > 10) {
    console.log(`    ... and ${repairs.length - 10} more`);
  }

  // Named explicitly rather than counted silently: each of these is a pin whose
  // only description is a grid reference, and the fix is to add the place it
  // sits on to the catalogue.
  for (const row of unresolved) {
    console.log(`    #${row.id}  UNRESOLVED  "${row.address}"  (${row.latitude}, ${row.longitude})`);
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  console.log(dryRun ? "DRY RUN — nothing will be written." : "Writing changes.");

  // Neither table can be filtered on the plus-code shape in SQL, so the shape
  // test happens here. Both are small enough for that to be fine.
  const savedLocations = await prisma.savedDeliveryLocation.findMany({
    select: { id: true, address: true, latitude: true, longitude: true },
  });
  const savedCandidates = savedLocations.filter((row) => isPlusCodeAddress(row.address));
  const saved = await resolveAll(savedCandidates);
  report("SavedDeliveryLocation", savedCandidates.length, saved.repairs, saved.unresolved);

  const errands = await prisma.errand.findMany({
    where: { status: { in: ACTIVE_STATUSES } },
    select: { id: true, deliveryAddress: true, deliveryLatitude: true, deliveryLongitude: true },
  });
  const errandCandidates: Candidate[] = errands
    .filter((row) => isPlusCodeAddress(row.deliveryAddress))
    .map((row) => ({
      id: row.id,
      address: row.deliveryAddress,
      latitude: row.deliveryLatitude,
      longitude: row.deliveryLongitude,
    }));
  const errand = await resolveAll(errandCandidates);
  report("Errand (active only)", errandCandidates.length, errand.repairs, errand.unresolved);

  if (dryRun) {
    console.log("\nDry run complete — re-run without --dry-run to apply.");
    return;
  }

  // Per-row updates rather than one transaction: these are independent display
  // strings, and a single unresolvable row should not roll back the rest.
  for (const repair of saved.repairs) {
    await prisma.savedDeliveryLocation.update({
      where: { id: repair.id as number },
      data: { address: repair.after },
    });
  }
  for (const repair of errand.repairs) {
    await prisma.errand.update({
      where: { id: repair.id as string },
      data: { deliveryAddress: repair.after },
    });
  }

  console.log(
    `\nUpdated ${saved.repairs.length} saved location(s) and ${errand.repairs.length} active errand(s).`
  );
}

main()
  .catch((error) => {
    console.error("Backfill failed:", error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
