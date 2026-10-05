import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { smoothPath, MAX_OFFSET_METERS } from "../src/lib/routing/smoothPath.js";
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
    // The alignment guarantee: never more than half a lane off the centreline.
    // The 0.05 m is the local-plane approximation, not slack in the rule.
    const worst = Math.max(...smoothed.map((p) => deviationFrom(p, route.coordinates)));
    expect(worst).toBeLessThanOrEqual(MAX_OFFSET_METERS + 0.05);
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
    // 133 in; more out, but not an explosion. Gentle bends get a few points
    // each, right angles about a dozen.
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
    expect(Math.max(...twice.map((p) => deviationFrom(p, once)))).toBeLessThan(MAX_OFFSET_METERS);
  });
});

describe("the shape of a corner", () => {
  // 200 m north, then 200 m east: a plain right-angle street corner.
  const corner: GeoPoint[] = [
    { latitude: 6.69, longitude: 124.675 },
    { latitude: 6.6918, longitude: 124.675 },
    { latitude: 6.6918, longitude: 124.6768 },
  ];

  it("draws a right angle as a circular arc, not a mitre", () => {
    const result = smoothPath(corner);
    const arc = result.slice(1, -1);
    expect(arc.length).toBeGreaterThanOrEqual(10);

    // Every arc point is the same distance from one centre: a true circle.
    const first = arc[0];
    const last = arc[arc.length - 1];
    const centre = { latitude: first.latitude, longitude: last.longitude };
    const radii = arc.map((p) => metres(p, centre));
    const spread = Math.max(...radii) - Math.min(...radii);
    expect(spread).toBeLessThan(0.05);
    // Roughly an 8.5 m radius: visibly a curve, well inside the junction.
    expect(radii[0]).toBeGreaterThan(7);
    expect(radii[0]).toBeLessThan(10);
  });

  it("pulls a right angle no further inside than the offset budget", () => {
    const result = smoothPath(corner);
    const nearest = Math.min(...result.map((p) => metres(p, corner[1])));
    expect(nearest).toBeLessThanOrEqual(MAX_OFFSET_METERS + 0.05);
    expect(nearest).toBeGreaterThan(MAX_OFFSET_METERS - 0.5);
  });

  it("turns a faceted highway bend into one continuous curve", () => {
    // Nine 40 m segments each kinking 6 degrees: how OSM draws a highway curve.
    const bend: GeoPoint[] = [];
    let lat = 6.6;
    let lng = 124.7;
    let bearing = 0;
    for (let i = 0; i < 10; i++) {
      bend.push({ latitude: lat, longitude: lng });
      lat += (40 * Math.cos((bearing * Math.PI) / 180)) / 111_195;
      lng += (40 * Math.sin((bearing * Math.PI) / 180)) / (111_195 * Math.cos((lat * Math.PI) / 180));
      bearing += 6;
    }

    const result = smoothPath(bend);
    // The old smoother skipped every bend under 15 degrees, so this came back
    // unchanged. Now no vertex along it kinks by more than one arc step.
    expect(result.length).toBeGreaterThan(bend.length);
    for (let i = 1; i < result.length - 1; i++) {
      const a = result[i - 1];
      const v = result[i];
      const b = result[i + 1];
      const h1 = Math.atan2(v.longitude - a.longitude, v.latitude - a.latitude);
      const h2 = Math.atan2(b.longitude - v.longitude, b.latitude - v.latitude);
      const kink = Math.abs(((h2 - h1) * 180) / Math.PI);
      expect(kink).toBeLessThan(6);
    }
    expect(Math.max(...result.map((p) => deviationFrom(p, bend)))).toBeLessThan(1);
  });

  it("keeps a turnaround exactly, rather than rounding it across the median", () => {
    const uTurn: GeoPoint[] = [
      { latitude: 6.69, longitude: 124.675 },
      { latitude: 6.691, longitude: 124.675 },
      { latitude: 6.69, longitude: 124.67501 },
    ];
    expect(smoothPath(uTurn)).toEqual(uTurn);
  });
});
