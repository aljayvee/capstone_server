import { asyncHandler } from "../lib/asyncHandler.js";
import { parseOrThrow } from "../validators/validate.js";
import { dashboardQuerySchema } from "../validators/analyticsValidators.js";
import * as analyticsService from "../services/analyticsService.js";

export const getDashboard = asyncHandler(async (req, res) => {
  const { frequency } = parseOrThrow(dashboardQuerySchema, req.query);
  const summary = await analyticsService.getDashboardSummary(frequency);
  res.json(summary);
});
