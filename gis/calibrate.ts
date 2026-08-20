// Measures ROAD_DETOUR_FACTOR and FALLBACK_AVG_SPEED_KMH against the live
// routing engine, using real Tacurong POIs from prisma/seedPlaces.ts.
//
// Those two constants feed the haversine fallback, which in turn feeds fare
// calculation whenever the routing engine is unreachable. Guessing them means
// quoting a customer a distance that disagrees with the route they can watch on
// their own screen — so they are measured, and re-measured after any OSM refresh.
//
//   OSRM_BASE_URL=http://your-osrm:5001 npx tsx gis/calibrate.ts
import { OsrmRoutingProvider } from "../src/lib/routing/osrmProvider.js";
import { haversineDistanceKm } from "../src/lib/geo.js";

const POIS: Record<string, { latitude: number; longitude: number }> = {
  "Jollibee Tacurong Center": { latitude: 6.6873, longitude: 124.6752 },
  "Chooks-to-Go City Center": { latitude: 6.6912, longitude: 124.6765 },
  "Chooks-to-Go Highway": { latitude: 6.6854, longitude: 124.6738 },
  "STI College Tacurong": { latitude: 6.6702, longitude: 124.6635 },
  "Tacurong City Center": { latitude: 6.671, longitude: 124.6644 },
};

// Detour ratio is wildly unstable over very short hops: two POIs 130 m apart in
// a straight line can be 1.8 km apart by road because of a one-way loop, giving
// a ratio above 13. Those pairs are real but say nothing about the ratio at the
// distances that actually get billed (the first 2 km is inside the base fee
// anyway), and including them drags the median well off. Sampling is therefore
// restricted to pairs far enough apart for the ratio to be meaningful.
const MIN_PAIR_DISTANCE_M = 1000;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function main() {
  const osrm = new OsrmRoutingProvider();
  if (!osrm.isConfigured()) {
    console.error("OSRM_BASE_URL is not set — nothing to calibrate against.");
    process.exit(1);
  }

  const names = Object.keys(POIS);
  const factors: number[] = [];
  const speeds: number[] = [];
  const skipped: string[] = [];

  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const from = POIS[names[i]];
      const to = POIS[names[j]];
      const result = await osrm.route([from, to]);
      if (!result || result.distanceMeters === 0) {
        console.warn(`  no route: ${names[i]} -> ${names[j]}`);
        continue;
      }

      const straightM = haversineDistanceKm(from, to) * 1000;
      if (straightM < MIN_PAIR_DISTANCE_M) {
        skipped.push(`${names[i]} -> ${names[j]} (${straightM.toFixed(0)}m apart)`);
        continue;
      }
      const factor = result.distanceMeters / straightM;
      const speed = result.distanceMeters / 1000 / (result.durationSeconds / 3600);
      factors.push(factor);
      speeds.push(speed);

      console.log(
        `${names[i]} -> ${names[j]}`.padEnd(56) +
          `straight=${straightM.toFixed(0)}m road=${result.distanceMeters}m ` +
          `factor=${factor.toFixed(3)} speed=${speed.toFixed(1)}km/h`
      );
    }
  }

  if (factors.length === 0) {
    console.error("No routable pairs — is the graph built for this bounding box?");
    process.exit(1);
  }

  console.log(`
Sampled ${factors.length} pairs at least ${MIN_PAIR_DISTANCE_M} m apart.`);
  if (skipped.length > 0) {
    console.log(`Excluded ${skipped.length} short pair(s) as statistically unstable:`);
    skipped.forEach((entry) => console.log(`  - ${entry}`));
  }
  console.log(`ROAD_DETOUR_FACTOR      = ${median(factors).toFixed(2)}  (range ${Math.min(...factors).toFixed(2)}-${Math.max(...factors).toFixed(2)})`);
  console.log(`FALLBACK_AVG_SPEED_KMH  = ${median(speeds).toFixed(0)}  (range ${Math.min(...speeds).toFixed(1)}-${Math.max(...speeds).toFixed(1)})`);
  console.log("\nUpdate these in server/.env (or the defaults in src/config/env.ts).");
}

void main();
