import { merchantCategoryRepository } from "../repositories/merchantCategoryRepository.js";
import { ServiceError } from "./ServiceError.js";
import type { CreateMerchantCategoryInput, UpdateMerchantCategoryInput } from "../validators/merchantCategoryValidators.js";

export function listMerchantCategories(includeInactive = false) {
  return merchantCategoryRepository.findMany({ includeInactive });
}

export function createMerchantCategory(input: CreateMerchantCategoryInput) {
  return merchantCategoryRepository.create(input);
}

export async function updateMerchantCategory(id: number, input: UpdateMerchantCategoryInput) {
  const existing = await merchantCategoryRepository.findById(id);
  if (!existing) {
    throw new ServiceError(404, "Merchant category not found");
  }
  return merchantCategoryRepository.update(id, input);
}
