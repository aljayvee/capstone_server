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
  if (errand.customerId !== customerId) {
    throw new ServiceError(403, "Access denied: you can only rate your own errand.");
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
