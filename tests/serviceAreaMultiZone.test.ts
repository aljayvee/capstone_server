import { describe, expect, it } from "vitest";
import {
  CROSS_ZONE_MESSAGE,
  OUTSIDE_ALL_ZONES_MESSAGE,
  SERVICE_ZONES,
  detectServiceZone,
  distanceOutsideServiceAreaKm,
  getZoneCenter,
  isServiceAreaConfigured,
  isWithinServiceArea,
  isWithinServiceBuffer,
  serviceAreaEnvelope,
  serviceZoneName,
  validateIntraZone,
} from "../src/lib/serviceArea.js";
import { createErrandSchema } from "../src/validators/errandValidators.js";

/**
 * Dual-zone isolation (2026-11-09): Tacurong City and Banga, South Cotabato,
 * against the real boundary files in gis/. Banga is OSM relation 20011844.
 */

const TACURONG_PLAZA = { latitude: 6.6873, longitude: 124.6752 };
const TACURONG_MARKET = { latitude: 6.688, longitude: 124.676 };
const BANGA_CENTRE = { latitude: 6.4232, longitude: 124.7762 };
const BANGA_SOUTH = { latitude: 6.4, longitude: 124.78 };
// Koronadal sits inside Banga's bounding box but outside its polygon.
const KORONADAL = { latitude: 6.5025, longitude: 124.8469 };
const GENERAL_SANTOS = { latitude: 6.1164, longitude: 125.1716 };
// Banga's westernmost vertex is [124.7074706, 6.45088]. Due west of it, the
// distance to the boundary is the distance to that vertex.
const BANGA_WEST_50M = { latitude: 6.45088, longitude: 124.70702 };
const BANGA_WEST_200M = { latitude: 6.45088, longitude: 124.70566 };

describe("both boundaries load", () => {
  it("has a polygon for each zone", () => {
    expect(isServiceAreaConfigured("TACURONG")).toBe(true);
    expect(isServiceAreaConfigured("BANGA")).toBe(true);
    expect(isServiceAreaConfigured()).toBe(true);
  });

  it("reports Banga's envelope as the OSM bounding box", () => {
    expect(serviceAreaEnvelope("BANGA")).toEqual({
      minLat: 6.282736,
      maxLat: 6.5140662,
      minLng: 124.7074706,
      maxLng: 124.918899,
    });
  });

  it("keeps the two zones apart: neither envelope overlaps the other", () => {
    const tacurong = serviceAreaEnvelope("TACURONG")!;
    const banga = serviceAreaEnvelope("BANGA")!;
    expect(banga.maxLat).toBeLessThan(tacurong.minLat);
  });
});

describe("detectServiceZone", () => {
  it("detects a Tacurong coordinate as TACURONG", () => {
    expect(detectServiceZone(TACURONG_PLAZA)).toBe("TACURONG");
  });

  it("detects a Banga coordinate as BANGA", () => {
    expect(detectServiceZone(BANGA_CENTRE)).toBe("BANGA");
    expect(detectServiceZone(BANGA_SOUTH)).toBe("BANGA");
  });

  it("returns null for a point outside both zones", () => {
    expect(detectServiceZone(KORONADAL)).toBeNull();
    expect(detectServiceZone(GENERAL_SANTOS)).toBeNull();
  });

  it("counts the 100 m highway buffer, and no further", () => {
    expect(isWithinServiceArea(BANGA_WEST_50M)).toBe(false);
    expect(detectServiceZone(BANGA_WEST_50M)).toBe("BANGA");
    expect(detectServiceZone(BANGA_WEST_200M)).toBeNull();
    // A wider buffer is the caller's choice.
    expect(detectServiceZone(BANGA_WEST_200M, 0.5)).toBe("BANGA");
  });

  it("returns null for coordinates that are not numbers", () => {
    expect(detectServiceZone({ latitude: NaN, longitude: NaN })).toBeNull();
    expect(detectServiceZone(null as any)).toBeNull();
  });
});

describe("isWithinServiceArea and isWithinServiceBuffer with a zone", () => {
  it("checks any zone when none is named, as before", () => {
    expect(isWithinServiceArea(TACURONG_PLAZA)).toBe(true);
    expect(isWithinServiceArea(BANGA_CENTRE)).toBe(true);
    expect(isWithinServiceArea(KORONADAL)).toBe(false);
    expect(isWithinServiceBuffer(BANGA_CENTRE)).toBe(true);
  });

  it("checks only the named zone", () => {
    expect(isWithinServiceArea(BANGA_CENTRE, "BANGA")).toBe(true);
    expect(isWithinServiceArea(BANGA_CENTRE, "TACURONG")).toBe(false);
    expect(isWithinServiceArea(TACURONG_PLAZA, "BANGA")).toBe(false);
    expect(isWithinServiceBuffer(BANGA_WEST_50M, 0.1, "BANGA")).toBe(true);
    expect(isWithinServiceBuffer(BANGA_WEST_50M, 0.1, "TACURONG")).toBe(false);
  });

  it("measures the distance outside to the named zone's border", () => {
    expect(distanceOutsideServiceAreaKm(BANGA_CENTRE)).toBe(0);
    expect(distanceOutsideServiceAreaKm(BANGA_CENTRE, "BANGA")).toBe(0);
    // Banga's northern tip is about 6 km south of Tacurong's southern edge, and its centre much further.
    expect(distanceOutsideServiceAreaKm(BANGA_CENTRE, "TACURONG")).toBeGreaterThan(10);
    expect(distanceOutsideServiceAreaKm(KORONADAL)).toBeGreaterThan(0.1);
  });
});

describe("validateIntraZone", () => {
  it("passes two Banga points as BANGA", () => {
    expect(validateIntraZone([BANGA_CENTRE, BANGA_SOUTH])).toEqual({ valid: true, zone: "BANGA" });
  });

  it("passes two Tacurong points as TACURONG", () => {
    expect(validateIntraZone([TACURONG_PLAZA, TACURONG_MARKET])).toEqual({ valid: true, zone: "TACURONG" });
  });

  it("refuses a Tacurong point with a Banga point, naming the second", () => {
    const verdict = validateIntraZone([TACURONG_PLAZA, BANGA_CENTRE]);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe("CROSS_ZONE");
    expect(verdict.index).toBe(1);
    expect(verdict.error).toBe(CROSS_ZONE_MESSAGE);
  });

  it("refuses a point outside both zones", () => {
    const verdict = validateIntraZone([BANGA_CENTRE, KORONADAL]);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe("OUTSIDE_SERVICE_AREA");
    expect(verdict.index).toBe(1);
    expect(verdict.error).toBe(OUTSIDE_ALL_ZONES_MESSAGE);
  });

  it("passes an empty list with no zone", () => {
    expect(validateIntraZone([])).toEqual({ valid: true });
  });
});

describe("zone centres and names", () => {
  it("defaults to Tacurong", () => {
    expect(getZoneCenter()).toEqual({ latitude: 6.671, longitude: 124.6644 });
    expect(getZoneCenter("BANGA")).toEqual({ latitude: 6.4232, longitude: 124.7762 });
    expect(SERVICE_ZONES.BANGA.center).toEqual(getZoneCenter("BANGA"));
  });

  it("names each zone for messages", () => {
    expect(serviceZoneName("TACURONG")).toBe("Tacurong City");
    expect(serviceZoneName("BANGA")).toBe("Banga");
  });
});

describe("createErrandSchema keeps an errand inside one zone", () => {
  const store = (point: { latitude: number; longitude: number }, name = "Store") => ({ name, ...point });
  const firstMessage = (body: unknown) => {
    const result = createErrandSchema.safeParse(body);
    return result.success ? null : result.error.issues[0]?.message;
  };

  it("accepts a Banga drop-off with a Banga store", () => {
    expect(
      firstMessage({
        deliveryLatitude: BANGA_CENTRE.latitude,
        deliveryLongitude: BANGA_CENTRE.longitude,
        stores: [store(BANGA_SOUTH)],
      })
    ).toBeNull();
  });

  it("accepts a Tacurong drop-off with a Tacurong store", () => {
    expect(
      firstMessage({
        deliveryLatitude: TACURONG_MARKET.latitude,
        deliveryLongitude: TACURONG_MARKET.longitude,
        stores: [store(TACURONG_PLAZA)],
      })
    ).toBeNull();
  });

  it("refuses a Tacurong store delivered to Banga", () => {
    expect(
      firstMessage({
        deliveryLatitude: BANGA_CENTRE.latitude,
        deliveryLongitude: BANGA_CENTRE.longitude,
        stores: [store(TACURONG_PLAZA)],
      })
    ).toBe(CROSS_ZONE_MESSAGE);
  });

  it("refuses two stores in different zones, even with no drop-off pin yet", () => {
    expect(firstMessage({ stores: [store(TACURONG_PLAZA, "A"), store(BANGA_CENTRE, "B")] })).toBe(CROSS_ZONE_MESSAGE);
  });

  it("refuses a drop-off outside both zones in its own words", () => {
    expect(
      firstMessage({ deliveryLatitude: KORONADAL.latitude, deliveryLongitude: KORONADAL.longitude })
    ).toMatch(/outside all supported service areas/);
  });
});
