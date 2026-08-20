import type { GeoPoint } from "../geo.js";

// Google's Encoded Polyline Algorithm. Both Google Directions and OSRM emit
// this format (OSRM at precision 5 by default, 6 for the `polyline6` geometry
// option), so one codec serves every provider.
//
// This replaces the hand-inlined decoder that previously lived inside
// routingController.ts — decoding is a pure transform and has no business in a
// controller.

export function decodePolyline(encoded: string, precision = 5): GeoPoint[] {
  const factor = Math.pow(10, precision);
  const points: GeoPoint[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    lat += decodeSignedValue(encoded, index, (next) => (index = next));
    lng += decodeSignedValue(encoded, index, (next) => (index = next));
    points.push({ latitude: lat / factor, longitude: lng / factor });
  }

  return points;
}

// Reads one varint-encoded, zigzag-signed delta starting at `start`, reporting
// the new cursor position through `setIndex`.
function decodeSignedValue(encoded: string, start: number, setIndex: (next: number) => void): number {
  let index = start;
  let shift = 0;
  let result = 0;
  let byte: number;

  do {
    byte = encoded.charCodeAt(index++) - 63;
    result |= (byte & 0x1f) << shift;
    shift += 5;
  } while (byte >= 0x20);

  setIndex(index);
  return result & 1 ? ~(result >> 1) : result >> 1;
}

export function encodePolyline(points: GeoPoint[], precision = 5): string {
  const factor = Math.pow(10, precision);
  let lastLat = 0;
  let lastLng = 0;
  let output = "";

  for (const point of points) {
    const lat = Math.round(point.latitude * factor);
    const lng = Math.round(point.longitude * factor);
    output += encodeSignedValue(lat - lastLat) + encodeSignedValue(lng - lastLng);
    lastLat = lat;
    lastLng = lng;
  }

  return output;
}

function encodeSignedValue(value: number): string {
  let v = value < 0 ? ~(value << 1) : value << 1;
  let output = "";

  while (v >= 0x20) {
    output += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  output += String.fromCharCode(v + 63);
  return output;
}
