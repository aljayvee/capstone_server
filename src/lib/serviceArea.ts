import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger.js";
import type { GeoPoint } from "./geo.js";

// GeoJSON stores positions as [longitude, latitude].
type Ring = [number, number][];

export interface Envelope {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

/**
 * The municipalities SUGO Express operates in (2026-11-09). Tacurong City is
 * the primary service; Banga, South Cotabato is where the rider app is field
 * tested. Both run in the same system, but every errand stays inside one zone
 * (validateIntraZone) and is dispatched only to riders in that zone
 * (errandService.assignRider). The zone is never stored: it is derived from
 * coordinates every time, so no schema change carries it.
 */
export type ServiceZone = "TACURONG" | "BANGA";

export interface ServiceZoneDefinition {
  /** How customers and dispatchers name the place. */
  name: string;
  /** Where a search with no location of its own starts. */
  center: GeoPoint;
  /** The boundary file, relative to this module. */
  file: string;
}

export const SERVICE_ZONES: Record<ServiceZone, ServiceZoneDefinition> = {
  TACURONG: {
    name: "Tacurong City",
    center: { latitude: 6.671, longitude: 124.6644 },
    file: "../../gis/tacurong-service-area.geojson",
  },
  BANGA: {
    name: "Banga",
    center: { latitude: 6.4232, longitude: 124.7762 },
    file: "../../gis/banga-service-area.geojson",
  },
};

const SERVICE_ZONE_IDS = Object.keys(SERVICE_ZONES) as ServiceZone[];

/** Refusal for an errand whose stops and drop-off sit in different zones. */
export const CROSS_ZONE_MESSAGE =
  "Cross-zone delivery is not permitted. All pickup locations and the delivery location must be within the same municipality (Tacurong or Banga).";
/** Refusal for a point in no zone at all. */
export const OUTSIDE_ALL_ZONES_MESSAGE = "Location is outside all supported service areas.";

interface BoundedRing {
  zone: ServiceZone;
  ring: Ring;
  envelope: Envelope;
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

// Loaded once at boot. The polygons are the operating boundaries for the Pabili
// service — used to reject a delivery point or a candidate rider that sits
// outside the area the routing graph actually covers, rather than letting OSRM
// silently return a route across half of Mindanao.
const boundedPolygons: BoundedRing[] = loadPolygons();

function ringsFor(zone?: ServiceZone): BoundedRing[] {
  return zone ? boundedPolygons.filter((bounded) => bounded.zone === zone) : boundedPolygons;
}

function computeEnvelope(ring: Ring): Envelope {
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const [lng, lat] of ring) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  return { minLat, maxLat, minLng, maxLng };
}

function loadZonePolygons(zone: ServiceZone): BoundedRing[] {
  try {
    const raw = JSON.parse(readFileSync(join(MODULE_DIR, SERVICE_ZONES[zone].file), "utf-8"));
    const rings: BoundedRing[] = [];

    for (const feature of raw?.features ?? []) {
      const geometry = feature?.geometry;
      if (geometry?.type === "Polygon") {
        // Outer ring only; holes are not meaningful for a service boundary.
        const ring = geometry.coordinates[0] as Ring;
        rings.push({ zone, ring, envelope: computeEnvelope(ring) });
      } else if (geometry?.type === "MultiPolygon") {
        for (const polygon of geometry.coordinates) {
          const ring = polygon[0] as Ring;
          rings.push({ zone, ring, envelope: computeEnvelope(ring) });
        }
      }
    }

    if (rings.length === 0) {
      logger.error(`Service area GeoJSON for ${zone} contained no polygons.`);
    }
    return rings;
  } catch (error) {
    // Deliberately non-fatal, and per zone: a missing Banga file must not take
    // the API down or switch off the Tacurong boundary. That zone then simply
    // has no area, so its points read as outside.
    logger.error(`Could not load service area GeoJSON for ${zone}:`, error);
    return [];
  }
}

function loadPolygons(): BoundedRing[] {
  const rings = SERVICE_ZONE_IDS.flatMap(loadZonePolygons);
  if (rings.length === 0) {
    // No zone loaded at all. isWithinServiceArea() then returns true for
    // everything, which is the same behaviour as before this guard existed.
    logger.error("No service area GeoJSON loaded: area checks will pass everything.");
  }
  return rings;
}

// Fast-path envelope pre-check + standard ray-casting test.
function isInsideRing(point: GeoPoint, bounded: BoundedRing): boolean {
  const y = Number(point?.latitude);
  const x = Number(point?.longitude);
  if (!Number.isFinite(y) || !Number.isFinite(x)) return false;

  const { envelope, ring } = bounded;

  // Fast envelope check: reject immediately if outside bounding box
  if (y < envelope.minLat || y > envelope.maxLat || x < envelope.minLng || x > envelope.maxLng) {
    return false;
  }

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

/**
 * True when `point` is inside `zone`, or inside any zone when none is named.
 */
export function isWithinServiceArea(point: GeoPoint, zone?: ServiceZone): boolean {
  const lat = Number(point?.latitude);
  const lng = Number(point?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;

  // No boundary configured means no restriction — see loadPolygons().
  if (boundedPolygons.length === 0) return true;
  return ringsFor(zone).some((bounded) => isInsideRing({ latitude: lat, longitude: lng }, bounded));
}

/**
 * Checks if a point is within the service area OR within a small edge buffer (default 100m = 0.1km).
 * Used to accommodate stores and drop-off points sitting directly along municipal perimeter highways.
 * `zone` narrows the check to one zone; without it any zone counts.
 */
export function isWithinServiceBuffer(point: GeoPoint, bufferKm: number = 0.1, zone?: ServiceZone): boolean {
  const lat = Number(point?.latitude);
  const lng = Number(point?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;

  if (boundedPolygons.length === 0) return true;
  if (isWithinServiceArea({ latitude: lat, longitude: lng }, zone)) return true;
  return distanceOutsideServiceAreaKm({ latitude: lat, longitude: lng }, zone) <= bufferKm;
}

/**
 * How far outside the service area `point` lies, in km. Zero when inside, and
 * zero when no boundary is configured (the same fail-open rule as above).
 * `zone` measures to that zone's border only; without it, to the nearest zone.
 *
 * Distance to the nearest boundary edge, measured on a local flat projection:
 * across the tens of km this is ever asked about, the error against a true
 * geodesic is well under a percent.
 */
export function distanceOutsideServiceAreaKm(point: GeoPoint, zone?: ServiceZone): number {
  const lat = Number(point?.latitude);
  const lng = Number(point?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return Infinity;

  if (boundedPolygons.length === 0 || isWithinServiceArea({ latitude: lat, longitude: lng }, zone)) return 0;

  const kmPerDegLat = 111.195;
  const kmPerDegLng = kmPerDegLat * Math.cos((lat * Math.PI) / 180);
  let nearest = Infinity;

  for (const { ring } of ringsFor(zone)) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const ax = (ring[j][0] - lng) * kmPerDegLng;
      const ay = (ring[j][1] - lat) * kmPerDegLat;
      const bx = (ring[i][0] - lng) * kmPerDegLng;
      const by = (ring[i][1] - lat) * kmPerDegLat;
      const dx = bx - ax;
      const dy = by - ay;
      const lengthSquared = dx * dx + dy * dy;
      // Projection of the origin (the point) onto segment ab, clamped.
      const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared));
      nearest = Math.min(nearest, Math.hypot(ax + dx * t, ay + dy * t));
    }
  }
  return Number.isFinite(nearest) ? nearest : Infinity;
}

/** True when any zone's boundary loaded, or `zone`'s when one is named. */
export function isServiceAreaConfigured(zone?: ServiceZone): boolean {
  return ringsFor(zone).length > 0;
}

/**
 * The zone `point` belongs to: the zone it is inside, else the nearest zone
 * whose border is within `bufferKm` (the 100 m highway buffer by default).
 * Null when it is in no zone, is not a number, or no boundary is loaded.
 */
export function detectServiceZone(point: GeoPoint, bufferKm: number = 0.1): ServiceZone | null {
  const lat = Number(point?.latitude);
  const lng = Number(point?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || boundedPolygons.length === 0) return null;

  const safePoint: GeoPoint = { latitude: lat, longitude: lng };
  let nearest: ServiceZone | null = null;
  let nearestKm = Infinity;
  for (const zone of SERVICE_ZONE_IDS) {
    if (!isServiceAreaConfigured(zone)) continue;
    if (isWithinServiceArea(safePoint, zone)) return zone;
    const km = distanceOutsideServiceAreaKm(safePoint, zone);
    if (km <= bufferKm && km < nearestKm) {
      nearest = zone;
      nearestKm = km;
    }
  }
  return nearest;
}

export interface IntraZoneResult {
  valid: boolean;
  /** The one zone every point is in, when valid and there was a point to check. */
  zone?: ServiceZone;
  error?: string;
  /** Why it failed: a point in no zone, or points in two zones. */
  reason?: "OUTSIDE_SERVICE_AREA" | "CROSS_ZONE";
  /** The first point that failed: the one outside, or the first in a second zone. */
  index?: number;
}

/**
 * Whether every point (an errand's stores and its drop-off) is in the same
 * zone. Fails on the first point in no zone, or the first in a different zone
 * from the points before it. Passes everything when no boundary is loaded,
 * the same fail-open rule as isWithinServiceArea.
 */
export function validateIntraZone(points: GeoPoint[], bufferKm: number = 0.1): IntraZoneResult {
  if (boundedPolygons.length === 0) return { valid: true };

  let zone: ServiceZone | undefined;
  for (let index = 0; index < points.length; index++) {
    const pointZone = detectServiceZone(points[index], bufferKm);
    if (pointZone === null) {
      return { valid: false, reason: "OUTSIDE_SERVICE_AREA", index, error: OUTSIDE_ALL_ZONES_MESSAGE };
    }
    if (zone !== undefined && pointZone !== zone) {
      return { valid: false, reason: "CROSS_ZONE", index, error: CROSS_ZONE_MESSAGE };
    }
    zone = pointZone;
  }
  return zone === undefined ? { valid: true } : { valid: true, zone };
}

/** Where a search with no location starts in `zone`. Tacurong when none is named. */
export function getZoneCenter(zone?: ServiceZone): GeoPoint {
  return SERVICE_ZONES[zone ?? "TACURONG"].center;
}

/** "Tacurong City" or "Banga", for messages. */
export function serviceZoneName(zone: ServiceZone): string {
  return SERVICE_ZONES[zone].name;
}

/** The box around every service-area polygon (or `zone`'s), or null when none is loaded. */
export function serviceAreaEnvelope(zone?: ServiceZone): Envelope | null {
  const rings = ringsFor(zone);
  if (rings.length === 0) return null;
  return rings.reduce<Envelope>(
    (box, { envelope }) => ({
      minLat: Math.min(box.minLat, envelope.minLat),
      maxLat: Math.max(box.maxLat, envelope.maxLat),
      minLng: Math.min(box.minLng, envelope.minLng),
      maxLng: Math.max(box.maxLng, envelope.maxLng),
    }),
    { minLat: Infinity, maxLat: -Infinity, minLng: Infinity, maxLng: -Infinity }
  );
}

// The centre the web portal's maps open on (TACURONG_CENTER in the web repo's
// constants/serviceArea.ts). Only a starting point for ranking by distance, for a
// "near me" search that has no location of its own. Tacurong, the primary zone.
export const SERVICE_AREA_CENTRE: GeoPoint = SERVICE_ZONES.TACURONG.center;
