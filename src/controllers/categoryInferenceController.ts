import { asyncHandler } from "../lib/asyncHandler.js";
import { parseOrThrow } from "../validators/validate.js";
import {
  inferItemCategoriesSchema,
  inferStoreCategorySchema,
  suggestItemPlacementsSchema,
} from "../validators/categoryInferenceValidators.js";
import * as categoryInferenceService from "../services/categoryInferenceService.js";
import * as itemPlacementService from "../services/itemPlacementService.js";

/**
 * Category guessing for the dispatcher console.
 *
 * Both endpoints answer 200 with an "I don't know" body rather than a 4xx or
 * 5xx when the sidecar is down. The caller is a panel the dispatcher is looking
 * at, and a red error toast for "the optional guess was unavailable" would
 * teach them to ignore toasts. `available: false` is the whole signal, and the
 * console already knows how to render a pin with no category.
 */

export const inferStoreCategory = asyncHandler(async (req, res) => {
  const input = parseOrThrow(inferStoreCategorySchema, req.body);
  const result = await categoryInferenceService.inferStoreCategory(
    input.name,
    input.googleTypes
  );
  res.json(result);
});

export const inferItemCategories = asyncHandler(async (req, res) => {
  const input = parseOrThrow(inferItemCategoriesSchema, req.body);
  const results = await categoryInferenceService.inferItemCategories(input.names);
  // Index-aligned with the names that were sent, so the console can zip them
  // back onto its own rows without matching on the text it submitted.
  res.json({ results });
});

/**
 * Where each item should be bought, for one errand.
 *
 * Answers from what dispatchers have already decided before falling back to the
 * model — see itemPlacementService. Like the endpoints above it reports "no
 * suggestion" in the body rather than failing the request, because the caller
 * is a panel someone is looking at.
 */
export const suggestItemPlacements = asyncHandler(async (req, res) => {
  const input = parseOrThrow(suggestItemPlacementsSchema, req.body);
  const placements = await itemPlacementService.suggestItemPlacements(
    req.params.errandId,
    input.names
  );
  res.json({ placements });
});
