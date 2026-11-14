import { Response } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { ServiceError } from "../services/ServiceError.js";
import { sysAdminIncidentService } from "../services/sysAdminIncidentService.js";
import { parseOrThrow } from "../validators/validate.js";
import {
  createIncidentSchema,
  incidentIdSchema,
  listIncidentsQuerySchema,
  updateIncidentSchema,
} from "../validators/sysAdminIncidentValidators.js";
import { logger } from "../lib/logger.js";

function fail(res: Response, err: unknown, fallback: string) {
  if (err instanceof ServiceError) return res.status(err.status).json({ error: err.message });
  logger.error(`[IncidentController] ${fallback}`, err);
  return res.status(500).json({ error: fallback });
}

const username = (req: AuthenticatedRequest) => req.user?.username || "sysadmin";

export async function listIncidentsHandler(req: AuthenticatedRequest, res: Response) {
  try {
    const { view, page } = parseOrThrow(listIncidentsQuerySchema, req.query);
    return res.status(200).json(await sysAdminIncidentService.list(view, page));
  } catch (err: unknown) {
    return fail(res, err, "Could not load incidents.");
  }
}

export async function getIncidentHandler(req: AuthenticatedRequest, res: Response) {
  try {
    const id = parseOrThrow(incidentIdSchema, req.params.id);
    return res.status(200).json({ incident: await sysAdminIncidentService.get(id) });
  } catch (err: unknown) {
    return fail(res, err, "Could not load this incident.");
  }
}

export async function createIncidentHandler(req: AuthenticatedRequest, res: Response) {
  try {
    const input = parseOrThrow(createIncidentSchema, req.body);
    const incident = await sysAdminIncidentService.create(input, username(req));
    return res.status(201).json({ incident });
  } catch (err: unknown) {
    return fail(res, err, "Could not open the incident.");
  }
}

export async function updateIncidentHandler(req: AuthenticatedRequest, res: Response) {
  try {
    const id = parseOrThrow(incidentIdSchema, req.params.id);
    const patch = parseOrThrow(updateIncidentSchema, req.body);
    const incident = await sysAdminIncidentService.update(id, patch, username(req));
    return res.status(200).json({ incident });
  } catch (err: unknown) {
    return fail(res, err, "Could not save the incident.");
  }
}
