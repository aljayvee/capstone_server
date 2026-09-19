import { asyncHandler } from "../lib/asyncHandler.js";
import { parseOrThrow } from "../validators/validate.js";
import { dashboardQuerySchema } from "../validators/analyticsValidators.js";
import * as analyticsService from "../services/analyticsService.js";

export const getDashboard = asyncHandler(async (req, res) => {
  const { frequency, date, start, end } = parseOrThrow(dashboardQuerySchema, req.query);
  // The validator guarantees the pair travels together, so one being present is
  // enough to know both are.
  const range = start && end ? { start, end } : undefined;
  const summary = await analyticsService.getDashboardSummary(frequency, range, date);
  res.json(summary);
});
