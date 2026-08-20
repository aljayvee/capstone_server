import { Response } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { AuthenticatedRequest } from "../middleware/auth.js";
import * as routingService from "../services/routingService.js";
import { parseOrThrow } from "../validators/validate.js";
import { directionsSchema } from "../validators/routingValidators.js";

// Road-network directions for the live tracking maps. All routing-engine
// selection, caching, fallback, and polyline decoding live in
// services/routingService.ts + lib/routing/ — this only parses and responds.
export const getDirections = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { origin, destination, waypoints } = parseOrThrow(directionsSchema, req.body);
  const result = await routingService.getDirections(origin, destination, waypoints ?? []);
  res.status(200).json(result);
});
