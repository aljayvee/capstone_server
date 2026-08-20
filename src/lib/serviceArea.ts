import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger.js";
import type { GeoPoint } from "./geo.js";

// GeoJSON stores positions as [longitude, latitude].
type Ring = [number, number][];

const GEOJSON_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../gis/tacurong-service-area.geojson");

// Loaded once at boot. The polygon is the operating boundary for the Pabili
// service — used to reject a delivery point or a candidate rider that sits
// outside the area the routing graph actually covers, rather than letting OSRM
// silently return a route across half of Mindanao.
const polygons: Ring[] = loadPolygons();

function loadPolygons(): Ring[] {
  try {
    const raw = JSON.parse(readFileSync(GEOJSON_PATH, "utf-8"));
    const rings: Ring[] = [];

    for (const feature of raw?.features ?? []) {
      const geometry = feature?.geometry;
      if (geometry?.type === "Polygon") {
        // Outer ring only; holes are not meaningful for a service boundary.
        rings.push(geometry.coordinates[0] as Ring);
      } else if (geometry?.type === "MultiPolygon") {
        for (const polygon of geometry.coordinates) rings.push(polygon[0] as Ring);
      }
    }

    if (rings.length === 0) {
      logger.error("Service area GeoJSON contained no polygons — area checks will pass everything.");
    }
    return rings;
  } catch (error) {
    // Deliberately non-fatal: a missing boundary file must not take the API
    // down. isWithinServiceArea() then returns true for everything, which is
    // the same behaviour as before this guard existed.
    logger.error("Could not load service area GeoJSON — area checks disabled:", error);
    return [];
  }
}

// Standard ray-casting test. Points exactly on an edge are not guaranteed
// either way, which is acceptable for a boundary drawn well outside the built-up
// area.
function isInsideRing(point: GeoPoint, ring: Ring): boolean {
  const { latitude: y, longitude: x } = point;
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const straddles = yi > y !== yj > y;
    if (straddles && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export function isWithinServiceArea(point: GeoPoint): boolean {
  // No boundary configured means no restriction — see loadPolygons().
  if (polygons.length === 0) return true;
  return polygons.some((ring) => isInsideRing(point, ring));
}

export function isServiceAreaConfigured(): boolean {
  return polygons.length > 0;
}
