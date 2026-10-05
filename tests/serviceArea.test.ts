import { describe, expect, it } from "vitest";
import {
  distanceOutsideServiceAreaKm,
  isServiceAreaConfigured,
  isWithinServiceArea,
  isWithinServiceBuffer,
} from "../src/lib/serviceArea.js";

describe("Tacurong service area", () => {
  it("loads a polygon from the GeoJSON on disk", () => {
    expect(isServiceAreaConfigured()).toBe(true);
  });

  it.each([
    ["Jollibee Tacurong Center", 6.6873, 124.6752],
    ["STI College Tacurong", 6.6702, 124.6635],
    ["Tacurong City Center", 6.671, 124.6644],
  ])("accepts %s, inside the service area", (_name, latitude, longitude) => {
    expect(isWithinServiceArea({ latitude, longitude })).toBe(true);
    expect(isWithinServiceBuffer({ latitude, longitude })).toBe(true);
    expect(distanceOutsideServiceAreaKm({ latitude, longitude })).toBe(0);
  });

  it.each([
    ["Koronadal", 6.5031, 124.8469],
    ["Manila", 14.5995, 120.9842],
    ["just north of the boundary", 6.75, 124.66],
    ["just west of the boundary", 6.68, 124.59],
  ])("rejects %s, outside the service area", (_name, latitude, longitude) => {
    expect(isWithinServiceArea({ latitude, longitude })).toBe(false);
  });

  it("accepts a point within the 100m highway buffer but rejects points beyond it", () => {
    // Point ~50m west of western boundary (124.61901 vs border 124.61947): outside polygon but inside 100m buffer
    const point50m = { latitude: 6.68388, longitude: 124.61901 };
    expect(isWithinServiceArea(point50m)).toBe(false);
    expect(isWithinServiceBuffer(point50m, 0.1)).toBe(true);
    const dist50m = distanceOutsideServiceAreaKm(point50m);
    expect(dist50m).toBeGreaterThan(0.04);
    expect(dist50m).toBeLessThan(0.07);

    // Point ~200m west of boundary: outside polygon and outside 100m buffer
    const point200m = { latitude: 6.68388, longitude: 124.61765 };
    expect(isWithinServiceArea(point200m)).toBe(false);
    expect(isWithinServiceBuffer(point200m, 0.1)).toBe(false);
    expect(distanceOutsideServiceAreaKm(point200m)).toBeGreaterThan(0.18);

    // 6.68, 124.59 is ~3.2 km west of Tacurong western border (124.619)
    expect(isWithinServiceArea({ latitude: 6.68, longitude: 124.59 })).toBe(false);
    expect(isWithinServiceBuffer({ latitude: 6.68, longitude: 124.59 }, 0.1)).toBe(false);
    expect(distanceOutsideServiceAreaKm({ latitude: 6.68, longitude: 124.59 })).toBeGreaterThan(3);
  });

  it("safely rejects NaN and non-finite coordinates", () => {
    const nanPoint = { latitude: NaN, longitude: NaN };
    expect(isWithinServiceArea(nanPoint)).toBe(false);
    expect(isWithinServiceBuffer(nanPoint, 0.1)).toBe(false);
    expect(distanceOutsideServiceAreaKm(nanPoint)).toBe(Infinity);
  });

  it("handles numeric string coordinates gracefully", () => {
    const stringPoint = { latitude: "6.671" as any, longitude: "124.6644" as any };
    expect(isWithinServiceArea(stringPoint)).toBe(true);
    expect(isWithinServiceBuffer(stringPoint, 0.1)).toBe(true);
  });

  it("rejects a transposed lat/lng pair", () => {
    // Swapping the two is the single most likely coordinate bug in this codebase
    // (OSRM and GeoJSON both use lon,lat while everything else uses lat,lng), so
    // the guard should catch it rather than silently pass.
    expect(isWithinServiceArea({ latitude: 124.6752, longitude: 6.6873 })).toBe(false);
  });
});
