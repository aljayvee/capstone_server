import { errandRepository } from "../repositories/errandRepository.js";
import { holdingSiblingFor, sameDropOff, type HoldCandidate } from "./patterns/deliveryHold.js";

/**
 * Delivery holds read from the database (the rule is patterns/deliveryHold.ts).
 *
 * Nothing is stored: a hold is a fact about a rider's accepted errands for one
 * customer, so it is worked out whenever it is needed, and is never left
 * behind by an errand that was cancelled or reassigned.
 */

/** The errand this one is waiting for, or null. */
export async function findDeliveryHold(errand: HoldCandidate): Promise<HoldCandidate | null> {
  if (String(errand.status) !== "IN_TRANSIT" || !errand.itemsPurchasedAt || errand.riderId == null) return null;
  const others = await errandRepository.findHoldCandidates(errand.customerId, errand.riderId);
  return holdingSiblingFor({ ...errand, status: String(errand.status) }, others);
}

/** The shape clients read: which errand it waits for, or null. */
export async function deliveryHoldOf(errand: HoldCandidate): Promise<{ errandId: string } | null> {
  const sibling = await findDeliveryHold(errand);
  return sibling ? { errandId: sibling.id } : null;
}

/**
 * The bought errands at this one's door, each with its hold as it stands now.
 * Read after this errand is accepted or bought, which is when a hold begins or
 * ends for any of them.
 */
export async function boughtNeighbours(
  errand: HoldCandidate
): Promise<Array<{ errandId: string; heldFor: HoldCandidate | null }>> {
  if (errand.riderId == null) return [];
  const all = await errandRepository.findHoldCandidates(errand.customerId, errand.riderId);
  return all
    .filter((other) => other.id !== errand.id && other.itemsPurchasedAt && sameDropOff(errand, other))
    .map((other) => ({ errandId: other.id, heldFor: holdingSiblingFor(other, all) }));
}
