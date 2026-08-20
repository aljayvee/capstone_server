import { asyncHandler } from "../lib/asyncHandler.js";
import { parseOrThrow } from "../validators/validate.js";
import { createMerchantCategorySchema, updateMerchantCategorySchema } from "../validators/merchantCategoryValidators.js";
import * as merchantCategoryService from "../services/merchantCategoryService.js";

export const listMerchantCategories = asyncHandler(async (req, res) => {
  // Active-only by default so the customer's store-category picker can never
  // offer a retired type; the owner portal passes ?includeInactive=true to
  // manage them.
  const includeInactive = req.query.includeInactive === "true";
  const categories = await merchantCategoryService.listMerchantCategories(includeInactive);
  res.json(categories);
});

export const createMerchantCategory = asyncHandler(async (req, res) => {
  const input = parseOrThrow(createMerchantCategorySchema, req.body);
  const category = await merchantCategoryService.createMerchantCategory(input);
  res.status(201).json(category);
});

export const updateMerchantCategory = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const input = parseOrThrow(updateMerchantCategorySchema, req.body);
  const category = await merchantCategoryService.updateMerchantCategory(id, input);
  res.json(category);
});
