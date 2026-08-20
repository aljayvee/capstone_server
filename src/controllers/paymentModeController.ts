import { asyncHandler } from "../lib/asyncHandler.js";
import * as paymentModeService from "../services/paymentModeService.js";

export const listPaymentModes = asyncHandler(async (req, res) => {
  const modes = await paymentModeService.listPaymentModes();
  res.json(modes);
});
