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

interface BoundedRing {
  ring: Ring;
  envelope: Envelope;
}

const GEOJSON_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../gis/tacurong-service-area.geojson");

// Loaded once at boot. The polygon is the operating boundary for the Pabili
// service — used to reject a delivery point or a candidate rider that sits
// outside the area the routing graph actually covers, rather than letting OSRM
// silently return a route across half of Mindanao.
const boundedPolygons: BoundedRing[] = loadPolygons();

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

function loadPolygons(): BoundedRing[] {
  try {
    const raw = JSON.parse(readFileSync(GEOJSON_PATH, "utf-8"));
    const rings: BoundedRing[] = [];

    for (const feature of raw?.features ?? []) {
      const geometry = feature?.geometry;
      if (geometry?.type === "Polygon") {
        // Outer ring only; holes are not meaningful for a service boundary.
        const ring = geometry.coordinates[0] as Ring;
        rings.push({ ring, envelope: computeEnvelope(ring) });
      } else if (geometry?.type === "MultiPolygon") {
        for (const polygon of geometry.coordinates) {
          const ring = polygon[0] as Ring;
          rings.push({ ring, envelope: computeEnvelope(ring) });
        }
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

export function isWithinServiceArea(point: GeoPoint): boolean {
  const lat = Number(point?.latitude);
  const lng = Number(point?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;

  // No boundary configured means no restriction — see loadPolygons().
  if (boundedPolygons.length === 0) return true;
  return boundedPolygons.some((bounded) => isInsideRing({ latitude: lat, longitude: lng }, bounded));
}

/**
 * Checks if a point is within the service area OR within a small edge buffer (default 100m = 0.1km).
 * Used to accommodate stores and drop-off points sitting directly along municipal perimeter highways.
 */
export function isWithinServiceBuffer(point: GeoPoint, bufferKm: number = 0.1): boolean {
  const lat = Number(point?.latitude);
  const lng = Number(point?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;

  if (boundedPolygons.length === 0) return true;
  if (isWithinServiceArea({ latitude: lat, longitude: lng })) return true;
  return distanceOutsideServiceAreaKm({ latitude: lat, longitude: lng }) <= bufferKm;
}

/**
 * How far outside the service area `point` lies, in km. Zero when inside, and
 * zero when no boundary is configured (the same fail-open rule as above).
 *
 * Distance to the nearest boundary edge, measured on a local flat projection:
 * across the tens of km this is ever asked about, the error against a true
 * geodesic is well under a percent.
 */
export function distanceOutsideServiceAreaKm(point: GeoPoint): number {
  const lat = Number(point?.latitude);
  const lng = Number(point?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return Infinity;

  if (boundedPolygons.length === 0 || isWithinServiceArea({ latitude: lat, longitude: lng })) return 0;

  const kmPerDegLat = 111.195;
  const kmPerDegLng = kmPerDegLat * Math.cos((lat * Math.PI) / 180);
  let nearest = Infinity;

  for (const { ring } of boundedPolygons) {
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

export function isServiceAreaConfigured(): boolean {
  return boundedPolygons.length > 0;
}

/** The box around every service-area polygon, or null when none is loaded. */
export function serviceAreaEnvelope(): Envelope | null {
  if (boundedPolygons.length === 0) return null;
  return boundedPolygons.reduce<Envelope>(
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
// "near me" search that has no location of its own.
export const SERVICE_AREA_CENTRE: GeoPoint = { latitude: 6.671, longitude: 124.6644 };
