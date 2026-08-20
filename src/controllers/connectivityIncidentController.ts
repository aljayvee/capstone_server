import { Response } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { ServiceError } from "../services/ServiceError.js";
import * as connectivityIncidentService from "../services/connectivityIncidentService.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { parseOrThrow } from "../validators/validate.js";
import { openIncidentSchema } from "../validators/connectivityIncidentValidators.js";

export const openIncident = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const { errandId, disconnectedAt } = parseOrThrow(openIncidentSchema, req.body);
  const incident = await connectivityIncidentService.openIncident(req.user!.id, errandId, disconnectedAt);
  res.status(201).json(incident);
});

export const resolveIncident = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    throw new ServiceError(400, "Invalid connectivity incident ID");
  }
  const incident = await connectivityIncidentService.resolveIncident(id, req.user!.id);
  res.json(incident);
});
