import { describe, expect, it } from "vitest";
import { decodePolyline, encodePolyline } from "../src/lib/routing/polyline.js";

describe("polyline codec", () => {
  // The canonical fixture from Google's Encoded Polyline Algorithm spec.
  const ENCODED = "_p~iF~ps|U_ulLnnqC_mqNvxq`@";
  const DECODED = [
    { latitude: 38.5, longitude: -120.2 },
    { latitude: 40.7, longitude: -120.95 },
    { latitude: 43.252, longitude: -126.453 },
  ];

  it("decodes the reference fixture exactly", () => {
    expect(decodePolyline(ENCODED)).toEqual(DECODED);
  });

  it("round-trips losslessly", () => {
    expect(encodePolyline(DECODED)).toBe(ENCODED);
  });

  it("handles an empty string", () => {
    expect(decodePolyline("")).toEqual([]);
  });

  it("round-trips Tacurong coordinates at 5dp", () => {
    const points = [
      { latitude: 6.6873, longitude: 124.6752 },
      { latitude: 6.6912, longitude: 124.6765 },
      { latitude: 6.6702, longitude: 124.6635 },
    ];
    const decoded = decodePolyline(encodePolyline(points));
    decoded.forEach((point, i) => {
      expect(point.latitude).toBeCloseTo(points[i].latitude, 5);
      expect(point.longitude).toBeCloseTo(points[i].longitude, 5);
    });
  });
});
