import dotenv from "dotenv";

dotenv.config();

// Ensure required environment variables exist (Fail fast per security standards)
if (!process.env.JWT_SECRET || !process.env.JWT_REFRESH_SECRET) {
  throw new Error("FATAL: JWT_SECRET or JWT_REFRESH_SECRET missing from environment variables.");
}

export const PORT = process.env.PORT || 5000;
export const JWT_SECRET = process.env.JWT_SECRET;
export const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;
export const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "1h";
export const JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || "7d";

export const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((origin) => origin.trim())
  : ["http://localhost:5173", "http://localhost:8081"];

// --- GIS / routing ---
// Ordered provider chain for road-network routing. Each name maps to an adapter
// in lib/routing/; the resilient service walks this list left-to-right and uses
// the first provider that answers. "haversine" is always a safe terminal entry
// since it needs no external service — see lib/routing/haversineProvider.ts.
export const OSRM_BASE_URL = process.env.OSRM_BASE_URL || "";
export const ROUTING_PROVIDER_ORDER = (process.env.ROUTING_PROVIDER_ORDER || "osrm,google,haversine")
  .split(",")
  .map((name) => name.trim().toLowerCase())
  .filter(Boolean);

// Straight-line distance under-states real road distance. Both constants below
// were measured, not guessed: six real Tacurong POI pairs from prisma/seedPlaces.ts
// were routed against OSRM and compared to their haversine distance. Observed
// detour factors ranged 1.42-1.66 (median 1.48) and effective speeds 21-30 km/h
// (median 25). Re-run server/gis/calibrate.ts after any OSM extract refresh.
//
// Pairs closer than 1 km are deliberately excluded from that sample: the ratio
// is unstable at short range (two POIs 133 m apart measured 1.8 km by road
// around a one-way loop, a ratio of 13.6) and would badly skew the median.
//
// Getting this wrong is not cosmetic: the fallback feeds fare calculation, so an
// under-stated factor quotes a customer less than the route they can watch on
// their own screen.
export const ROAD_DETOUR_FACTOR = Number(process.env.ROAD_DETOUR_FACTOR) || 1.48;

// Average achievable speed on Tacurong city streets (tricycle/motorcycle traffic),
// used only to synthesise a duration when no routing engine is reachable.
export const FALLBACK_AVG_SPEED_KMH = Number(process.env.FALLBACK_AVG_SPEED_KMH) || 25;
