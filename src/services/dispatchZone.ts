import type { GeoPoint } from "../lib/geo.js";
import { detectServiceZone, isServiceAreaConfigured, type ServiceZone } from "../lib/serviceArea.js";

/**
 * Dispatch isolation between service zones (2026-11-09).
 *
 * Tacurong City and Banga run in one system, but a rider working in one never
 * receives an errand from the other. Neither the errand's zone nor the rider's
 * is stored: both come from coordinates at the moment of dispatch, so there is
 * no column to keep in step and no migration.
 *
 * With no boundary loaded at all, every rule here passes everything, the same
 * fail-open rule as lib/serviceArea.ts.
 */

interface DispatchErrandPoints {
  pinpoints?: Array<{ latitude: unknown; longitude: unknown }> | null;
  deliveryLatitude?: number | null;
  deliveryLongitude?: number | null;
}

function deliveryPoint(errand: DispatchErrandPoints): GeoPoint | null {
  return errand.deliveryLatitude != null && errand.deliveryLongitude != null
    ? { latitude: Number(errand.deliveryLatitude), longitude: Number(errand.deliveryLongitude) }
    : null;
}

/** Where dispatch is aimed: the errand's first store, else its drop-off. */
export function dispatchTargetPoint(errand: DispatchErrandPoints): GeoPoint | null {
  const store1 = errand.pinpoints && errand.pinpoints.length > 0 ? errand.pinpoints[0] : null;
  return store1 ? { latitude: Number(store1.latitude), longitude: Number(store1.longitude) } : deliveryPoint(errand);
}

/**
 * The zone an errand belongs to: its dispatch target's, else its drop-off's.
 * Every stop and the drop-off are in one zone (validateIntraZone at checkout
 * and on every pin save), so either answers the same for any new errand. Null
 * when neither is in a zone, or the errand has no location yet.
 */
export function errandServiceZone(errand: DispatchErrandPoints): ServiceZone | null {
  const target = dispatchTargetPoint(errand);
  const fromTarget = target ? detectServiceZone(target) : null;
  if (fromTarget) return fromTarget;
  const delivery = deliveryPoint(errand);
  return delivery ? detectServiceZone(delivery) : null;
}

/**
 * Whether automatic dispatch may offer an errand in `errandZone` to a rider
 * whose fresh fix is `riderPoint`. Only a rider whose fix is in that same zone
 * qualifies: no fix, a fix in the other zone, a fix outside every zone, or an
 * errand in no zone all say no, because none of them proves the rider is
 * working where the errand is.
 */
export function riderMayTakeZone(riderPoint: GeoPoint | null | undefined, errandZone: ServiceZone | null): boolean {
  if (!isServiceAreaConfigured()) return true;
  if (!riderPoint || errandZone === null) return false;
  return detectServiceZone(riderPoint) === errandZone;
}

/**
 * For a rider the dispatcher named: the OTHER zone their last known fix puts
 * them in, or null when there is no conflict. Only a provable conflict refuses;
 * a rider with no fix, or one outside every zone, is the dispatcher's call.
 */
export function namedRiderZoneConflict(
  lastKnownPoint: GeoPoint | null | undefined,
  errandZone: ServiceZone | null
): ServiceZone | null {
  if (!lastKnownPoint || errandZone === null || !isServiceAreaConfigured()) return null;
  const riderZone = detectServiceZone(lastKnownPoint);
  return riderZone !== null && riderZone !== errandZone ? riderZone : null;
}
