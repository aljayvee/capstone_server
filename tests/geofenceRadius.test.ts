import { describe, expect, it } from "vitest";
import { GEOFENCE_RADIUS_METERS, radiusOf } from "../src/services/geofenceService.js";

describe("how close counts as arrived", () => {
  it("uses the category's own radius when it has one", () => {
    // A supermarket's car park alone can hold a rider further from the pin than
    // 75 m reaches.
    expect(radiusOf({ radiusMeters: 150 })).toBe(150);
    // And a roadside carinderia wants a tighter circle than the road is wide.
    expect(radiusOf({ radiusMeters: 40 })).toBe(40);
  });

  it("falls back to the default for a pin dropped outside the catalogue", () => {
    // No category, so no radius of its own — behaviour is unchanged from before
    // the column existed.
    expect(radiusOf({ radiusMeters: null })).toBe(GEOFENCE_RADIUS_METERS);
    expect(radiusOf({})).toBe(GEOFENCE_RADIUS_METERS);
    expect(radiusOf({ radiusMeters: undefined })).toBe(GEOFENCE_RADIUS_METERS);
  });

  it("refuses a radius that would make arrival impossible", () => {
    // Zero or negative would mean the rider must stand on the exact pin, which
    // no GPS fix can prove. Fall back rather than strand them.
    expect(radiusOf({ radiusMeters: 0 })).toBe(GEOFENCE_RADIUS_METERS);
    expect(radiusOf({ radiusMeters: -10 })).toBe(GEOFENCE_RADIUS_METERS);
  });

  it("keeps 75 m as the default it has always been", () => {
    // Every existing category defaults to this, so shipping the column changes
    // nothing until an owner deliberately moves one.
    expect(GEOFENCE_RADIUS_METERS).toBe(75);
  });
});
