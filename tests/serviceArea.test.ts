import { describe, expect, it } from "vitest";
import { isServiceAreaConfigured, isWithinServiceArea } from "../src/lib/serviceArea.js";

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
  });

  it.each([
    ["Koronadal", 6.5031, 124.8469],
    ["Manila", 14.5995, 120.9842],
    ["just north of the boundary", 6.75, 124.66],
    ["just west of the boundary", 6.68, 124.59],
  ])("rejects %s, outside the service area", (_name, latitude, longitude) => {
    expect(isWithinServiceArea({ latitude, longitude })).toBe(false);
  });

  it("rejects a transposed lat/lng pair", () => {
    // Swapping the two is the single most likely coordinate bug in this codebase
    // (OSRM and GeoJSON both use lon,lat while everything else uses lat,lng), so
    // the guard should catch it rather than silently pass.
    expect(isWithinServiceArea({ latitude: 124.6752, longitude: 6.6873 })).toBe(false);
  });
});
