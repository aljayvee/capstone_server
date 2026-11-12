import { Response } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { AuthenticatedRequest } from "../middleware/auth.js";
import * as routingService from "../services/routingService.js";
import { parseOrThrow } from "../validators/validate.js";
import * as riderRouteService from "../services/riderRouteService.js";
import { directionsSchema, riderRouteQuerySchema } from "../validators/routingValidators.js";

// Road-network directions for the live tracking maps. All routing-engine
// selection, caching, fallback, and polyline decoding live in
// services/routingService.ts + lib/routing/ — this only parses and responds.
export const getDirections = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const {
    origin,
    destination,
    waypoints,
    provider,
    choose,
    keep,
    errandId,
    originHeading,
    originSpeedMps,
    originAccuracyMeters,
  } = parseOrThrow(directionsSchema, req.body);
  const result = await routingService.getDirections(origin, destination, waypoints ?? [], {
    prefer: provider,
    choose,
    keep,
    errandId,
    origin: routingService.originHintFor({
      heading: originHeading,
      speedMps: originSpeedMps,
      accuracyMeters: originAccuracyMeters,
    }),
    caller: req.user ? { id: req.user.id, role: req.user.role } : undefined,
  });
  res.status(200).json(result);

  // After the answer, and not awaited: a rider's route is also the line their
  // customer and dispatch should be drawing (riderRouteService). Never throws.
  if (req.user) {
    void riderRouteService.recordRiderRoute(
      { id: req.user.id, role: req.user.role },
      { origin, destination, keep },
      result
    );
  }
});

// The line a rider is following right now, for the customer tracking that
// errand or for staff. Authorisation and what each caller may see live in
// services/riderRouteService.ts.
export const getRiderRoute = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const query = parseOrThrow(riderRouteQuerySchema, req.query);
  const reply = await riderRouteService.riderRouteForViewer(
    req.user ? { id: req.user.id, role: req.user.role } : undefined,
    query
  );
  res.status(200).json(reply);
});
