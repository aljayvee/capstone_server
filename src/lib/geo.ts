const EARTH_RADIUS_KM = 6371;

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

// Great-circle distance between two points.
export function haversineDistanceKm(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);

  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.asin(Math.sqrt(h));
}

// Total route distance across an ordered list of stops (e.g. dispatcher
// pinpoints in `sequence` order) plus a final leg to the delivery point.
// Returns 0 when there aren't at least 2 points to form a leg — i.e. before
// pinpoints exist yet, distance genuinely isn't known (see
// errandService.recalculateFee).
export function totalRouteDistanceKm(stops: GeoPoint[], destination: GeoPoint | null): number {
  const points = destination ? [...stops, destination] : stops;
  if (points.length < 2) return 0;

  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    total += haversineDistanceKm(points[i], points[i + 1]);
  }
  return total;
}
