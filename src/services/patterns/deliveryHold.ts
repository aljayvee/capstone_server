import { haversineDistanceKm } from "../../lib/geo.js";

/**
 * One trip to a customer's door, not two.
 *
 * A rider already carrying a customer's order ("On the way") can be given a
 * second errand for the same customer. Delivering the first and then riding
 * back with the second takes them to that door twice. Instead the first is
 * HELD: the rider shops the second, and both are delivered together.
 *
 * An errand is held while it is bought (itemsPurchasedAt) and the same rider
 * has accepted another errand, for the same customer and the same drop-off,
 * that is not bought yet. Everything here is read from columns that already
 * exist, so the hold needs no state of its own and ends by itself: the other
 * errand bought, cancelled or handed to another rider is a hold no longer.
 *
 * Mirrored in the rider app (RiderMobileApp src/services/errandQueue.ts),
 * which decides what the rider does next from the same rule.
 */

/** Two drop-offs this close are the same door. */
export const SAME_DROP_OFF_KM = 0.1;

export interface HoldCandidate {
  id: string;
  customerId: number;
  riderId: number | null;
  status: string;
  itemsPurchasedAt: Date | string | null;
  acceptedAt?: Date | string | null;
  deliveryLatitude: number | null;
  deliveryLongitude: number | null;
  deliveryAddress?: string | null;
}

/**
 * The same door: within SAME_DROP_OFF_KM, or, when either has no pin, the same
 * written address. A customer sending one order home and one to work gets two
 * deliveries, not one held for the other.
 */
export function sameDropOff(a: HoldCandidate, b: HoldCandidate): boolean {
  if (
    a.deliveryLatitude != null &&
    a.deliveryLongitude != null &&
    b.deliveryLatitude != null &&
    b.deliveryLongitude != null
  ) {
    return (
      haversineDistanceKm(
        { latitude: a.deliveryLatitude, longitude: a.deliveryLongitude },
        { latitude: b.deliveryLatitude, longitude: b.deliveryLongitude }
      ) <= SAME_DROP_OFF_KM
    );
  }
  const left = a.deliveryAddress?.trim().toLowerCase();
  const right = b.deliveryAddress?.trim().toLowerCase();
  return Boolean(left) && left === right;
}

function acceptedMs(errand: HoldCandidate): number {
  const ms = errand.acceptedAt ? new Date(errand.acceptedAt).getTime() : NaN;
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/**
 * The errand this one is waiting for, or null when it is not held. With more
 * than one still being shopped, the first the rider accepted.
 */
export function holdingSiblingFor<T extends HoldCandidate>(errand: HoldCandidate, others: T[]): T | null {
  if (errand.status !== "IN_TRANSIT" || !errand.itemsPurchasedAt || errand.riderId == null) return null;
  const waitingOn = others
    .filter(
      (other) =>
        other.id !== errand.id &&
        other.status === "IN_TRANSIT" &&
        other.riderId === errand.riderId &&
        other.customerId === errand.customerId &&
        !other.itemsPurchasedAt &&
        sameDropOff(errand, other)
    )
    .sort((a, b) => acceptedMs(a) - acceptedMs(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return waitingOn[0] ?? null;
}
