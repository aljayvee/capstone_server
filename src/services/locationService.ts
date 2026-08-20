import { locationRepository } from "../repositories/locationRepository.js";
import { ServiceError } from "./ServiceError.js";
import type { LocationInput } from "../validators/locationValidators.js";

const MAX_LOCATIONS = 5;

export function listLocations(customerId: number) {
  return locationRepository.findByCustomerId(customerId);
}

export async function createLocation(customerId: number, input: LocationInput) {
  const count = await locationRepository.countByCustomerId(customerId);
  if (count >= MAX_LOCATIONS) {
    throw new ServiceError(400, `Maximum of ${MAX_LOCATIONS} saved locations allowed. Delete one to add another.`);
  }

  const isFirstLocation = count === 0;
  return locationRepository.create(
    customerId,
    { label: input.label, address: input.address, latitude: input.latitude, longitude: input.longitude },
    isFirstLocation
  );
}

export async function getLocationOwner(id: number) {
  const existing = await locationRepository.findById(id);
  if (!existing) {
    throw new ServiceError(404, "Location not found.");
  }
  return existing;
}

export async function updateLocation(id: number, customerId: number, input: LocationInput) {
  return locationRepository.updateWithOptionalDefault(
    id,
    customerId,
    { label: input.label, address: input.address, latitude: input.latitude, longitude: input.longitude },
    input.isDefault === true
  );
}

export async function deleteLocation(id: number, wasDefault: boolean, customerId: number) {
  await locationRepository.delete(id);

  // If the deleted location was the default, promote the oldest remaining to default
  if (wasDefault) {
    const next = await locationRepository.findOldestByCustomerId(customerId);
    if (next) {
      await locationRepository.setDefault(next.id);
    }
  }
}
