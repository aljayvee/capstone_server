import { asyncHandler } from "../lib/asyncHandler.js";
import { parseOrThrow } from "../validators/validate.js";
import { storeLocationCheckSchema } from "../validators/placeValidators.js";
import { checkStoreLocation } from "../services/storeLocationGuard.js";

/**
 * May a store be pinned here? The dispatcher console asks before every pin;
 * savePinpoints asks again, so the answer holds for any client.
 */
export const checkStoreLocationHandler = asyncHandler(async (req, res) => {
  const point = parseOrThrow(storeLocationCheckSchema, req.body);
  res.json(await checkStoreLocation(point));
});
