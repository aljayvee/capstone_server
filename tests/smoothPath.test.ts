import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { smoothPath, TURN_RADIUS_METERS } from "../src/lib/routing/smoothPath.js";
import { haversineDistanceKm, type GeoPoint } from "../src/lib/geo.js";

/**
 * Measured against a real route off the local OSRM instance — 7,135 m across
 * Tacurong, 133 points — captured to a fixture so these need no network.
 */
const route: { coordinates: GeoPoint[]; distanceMeters: number } = JSON.parse(
  readFileSync(new URL("./fixtures/routes/tacurong-route.json", import.meta.url), "utf8")
);

const metres = (a: GeoPoint, b: GeoPoint) => haversineDistanceKm(a, b) * 1000;

const lengthOf = (path: GeoPoint[]) =>
  path.slice(1).reduce((sum, point, i) => sum + metres(path[i], point), 0);

/** Shortest distance from `point` to the segment ab. */
function distanceToSegment(point: GeoPoint, a: GeoPoint, b: GeoPoint): number {
  const scale = Math.cos((a.latitude * Math.PI) / 180);
  const ax = 0;
  const ay = 0;
  const bx = (b.longitude - a.longitude) * scale;
  const by = b.latitude - a.latitude;
  const px = (point.longitude - a.longitude) * scale;
  const py = point.latitude - a.latitude;

  const lengthSquared = bx * bx + by * by;
  const t =
    lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * bx + (py - ay) * by) / lengthSquared));

  const closest = {
    latitude: a.latitude + by * t,
    longitude: a.longitude + (b.longitude - a.longitude) * t,
  };
  return metres(point, closest);
}

/** How far `point` strays from the nearest part of the original path. */
function deviationFrom(point: GeoPoint, original: GeoPoint[]): number {
  let nearest = Infinity;
  for (let i = 0; i < original.length - 1; i++) {
    nearest = Math.min(nearest, distanceToSegment(point, original[i], original[i + 1]));
  }
  return nearest;
}

describe("rounding the corners of a real route", () => {
  const smoothed = smoothPath(route.coordinates);

  it("keeps the drawn line on the road", () => {
    // The point of capping the corner cut. Anything much beyond a lane width
    // would visibly leave the carriageway.
    const worst = Math.max(...smoothed.map((p) => deviationFrom(p, route.coordinates)));
    expect(worst).toBeLessThanOrEqual(TURN_RADIUS_METERS);
  });

  it("barely changes the length of the route", () => {
    const before = lengthOf(route.coordinates);
    const after = lengthOf(smoothed);
    // Cutting corners shortens slightly; it must never grow the path.
    expect(after).toBeLessThanOrEqual(before);
    expect((before - after) / before).toBeLessThan(0.01);
  });

  it("starts and ends exactly where the route does", () => {
    expect(smoothed[0]).toEqual(route.coordinates[0]);
    expect(smoothed[smoothed.length - 1]).toEqual(route.coordinates[route.coordinates.length - 1]);
  });

  it("adds points only where there are corners to round", () => {
    // 133 in; more out, but not an explosion — most vertices are near-straight
    // and are passed through untouched.
    expect(smoothed.length).toBeGreaterThan(route.coordinates.length);
    expect(smoothed.length).toBeLessThan(route.coordinates.length * 6);
  });

  it("softens the sharpest corners", () => {
    const sharpest = (path: GeoPoint[]) => {
      let worst = 180;
      for (let i = 1; i < path.length - 1; i++) {
        const a = path[i - 1];
        const v = path[i];
        const b = path[i + 1];
        const scale = Math.cos((v.latitude * Math.PI) / 180);
        const ax = (a.longitude - v.longitude) * scale;
        const ay = a.latitude - v.latitude;
        const bx = (b.longitude - v.longitude) * scale;
        const by = b.latitude - v.latitude;
        const magA = Math.hypot(ax, ay);
        const magB = Math.hypot(bx, by);
        if (magA === 0 || magB === 0) continue;
        const cos = Math.min(1, Math.max(-1, (ax * bx + ay * by) / (magA * magB)));
        worst = Math.min(worst, (Math.acos(cos) * 180) / Math.PI);
      }
      return worst;
    };

    // The original turns through 102 degrees at its sharpest corner; after
    // rounding, no single vertex bends anywhere near that hard.
    expect(sharpest(route.coordinates)).toBeLessThan(90);
    expect(sharpest(smoothed)).toBeGreaterThan(sharpest(route.coordinates) + 20);
  });
});

describe("paths that should come back unchanged", () => {
  it("leaves a dead-straight line alone", () => {
    const straight: GeoPoint[] = [
      { latitude: 6.69, longitude: 124.675 },
      { latitude: 6.695, longitude: 124.675 },
      { latitude: 6.7, longitude: 124.675 },
      { latitude: 6.705, longitude: 124.675 },
    ];
    expect(smoothPath(straight)).toEqual(straight);
  });

  it("handles paths too short to have a corner", () => {
    const one = [{ latitude: 6.69, longitude: 124.675 }];
    const two = [...one, { latitude: 6.7, longitude: 124.675 }];

    expect(smoothPath([])).toEqual([]);
    expect(smoothPath(one)).toEqual(one);
    expect(smoothPath(two)).toEqual(two);
  });

  it("does not throw on rubbish input", () => {
    expect(smoothPath(null as unknown as GeoPoint[])).toEqual([]);
    expect(smoothPath(undefined as unknown as GeoPoint[])).toEqual([]);
  });

  it("returns the path untouched when the radius is zero", () => {
    expect(smoothPath(route.coordinates, 0)).toEqual(route.coordinates);
  });
});

describe("corner cases in the geometry itself", () => {
  it("drops duplicated points rather than drawing a degenerate arc", () => {
    const withDuplicate: GeoPoint[] = [
      { latitude: 6.69, longitude: 124.675 },
      { latitude: 6.695, longitude: 124.675 },
      { latitude: 6.695, longitude: 124.675 },
      { latitude: 6.695, longitude: 124.68 },
    ];
    const result = smoothPath(withDuplicate);
    const duplicates = result.filter(
      (p, i) => i > 0 && p.latitude === result[i - 1].latitude && p.longitude === result[i - 1].longitude
    );
    expect(duplicates).toHaveLength(0);
  });

  it("never cuts more than a fraction of a short block", () => {
    // A 10 m block between two turns: a flat 12 m radius would consume it whole
    // and pull the line clean off the corner.
    const tightBlock: GeoPoint[] = [
      { latitude: 6.69, longitude: 124.675 },
      { latitude: 6.6901, longitude: 124.675 },
      { latitude: 6.6901, longitude: 124.6751 },
      { latitude: 6.6902, longitude: 124.6751 },
    ];
    const result = smoothPath(tightBlock);
    expect(Math.max(...result.map((p) => deviationFrom(p, tightBlock)))).toBeLessThan(6);
  });

  it("is stable when run twice", () => {
    // Applied to an already-smoothed path it must not keep eating the corners.
    const once = smoothPath(route.coordinates);
    const twice = smoothPath(once);
    expect(Math.max(...twice.map((p) => deviationFrom(p, once)))).toBeLessThan(TURN_RADIUS_METERS);
  });
});
