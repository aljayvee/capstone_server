import { asyncHandler } from "../lib/asyncHandler.js";
import { parseOrThrow } from "../validators/validate.js";
import { updateRateConfigSchema } from "../validators/rateConfigValidators.js";
import * as rateConfigService from "../services/rateConfigService.js";
import { invalidateRateConfigCache } from "../lib/rateConfigCache.js";

export const getRateConfig = asyncHandler(async (req, res) => {
  const config = await rateConfigService.getRateConfig();
  res.json(config);
});

export const updateRateConfig = asyncHandler(async (req, res) => {
  const input = parseOrThrow(updateRateConfigSchema, req.body);
  const updated = await rateConfigService.updateRateConfig(input);
  invalidateRateConfigCache();
  res.json(updated);
});
