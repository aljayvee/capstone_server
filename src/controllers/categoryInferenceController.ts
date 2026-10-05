import { asyncHandler } from "../lib/asyncHandler.js";
import { parseOrThrow } from "../validators/validate.js";
import {
  inferItemCategoriesSchema,
  inferStoreCategorySchema,
  suggestItemPlacementsSchema,
  predictStoresSchema,
} from "../validators/categoryInferenceValidators.js";
import * as categoryInferenceService from "../services/categoryInferenceService.js";
import * as itemPlacementService from "../services/itemPlacementService.js";
import * as storePredictionService from "../services/storePredictionService.js";

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

/**
 * Which stores to pin for this errand, predicted from its item list.
 *
 * Answers 200 with an empty prediction rather than failing, for the same reason
 * as the endpoints above: it is a suggestion on a panel, and "nothing to
 * suggest" is a normal answer. Only a missing errand is an error.
 */
export const predictStores = asyncHandler(async (req, res) => {
  const input = parseOrThrow(predictStoresSchema, req.body ?? {});
  const prediction = await storePredictionService.predictStores(req.params.errandId, input.names);
  res.json(prediction);
});
