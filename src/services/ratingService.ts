import { ratingRepository } from "../repositories/ratingRepository.js";
import { errandRepository } from "../repositories/errandRepository.js";
import { ServiceError } from "./ServiceError.js";
import type { CreateRatingInput } from "../validators/ratingValidators.js";

export async function getRating(errandId: string) {
  return ratingRepository.findByErrandId(errandId);
}

export async function submitRating(errandId: string, customerId: number, input: CreateRatingInput) {
  const errand = await errandRepository.findByIdBasic(errandId);
  if (!errand) {
    throw new ServiceError(404, "Errand not found");
  }
  // customerId is a CustomerAccount id. The route's requireRole(["CUSTOMER"])
  // is what makes it one: a staff User id can carry the same number.
  if (errand.customerId !== customerId) {
    throw new ServiceError(403, "Access denied: you can only rate your own errand.");
  }
  // Only once the goods have arrived. A rating left on an ASSIGNED or CANCELLED
  // errand could never be corrected, because the duplicate check below then
  // refuses the real one after delivery.
  if (errand.status !== "DELIVERED" && errand.status !== "COMPLETED") {
    throw new ServiceError(400, "Ratings can only be submitted for delivered or completed errands.");
  }
  if (!errand.riderId) {
    throw new ServiceError(400, "This errand has no assigned rider to rate.");
  }

  const existing = await ratingRepository.findByErrandId(errandId);
  if (existing) {
    throw new ServiceError(409, "This errand has already been rated.");
  }

  return ratingRepository.create(errandId, errand.riderId, input.stars, input.comment);
}
