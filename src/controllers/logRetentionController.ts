import { Response } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { ServiceError } from "../services/ServiceError.js";
import { logRetention, type PolicyKey } from "../services/logRetentionService.js";
import { logger } from "../lib/logger.js";

function fail(res: Response, err: unknown, what: string) {
  if (err instanceof ServiceError) return res.status(err.status).json({ error: err.message });
  logger.error(`[LogRetention] ${what} failed:`, err);
  return res.status(500).json({ error: `Could not ${what}.` });
}

export async function getLogRetentionHandler(_req: AuthenticatedRequest, res: Response) {
  try {
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(await logRetention.status());
  } catch (err) {
    return fail(res, err, "load the log storage status");
  }
}

export async function updateLogRetentionHandler(req: AuthenticatedRequest, res: Response) {
  try {
    const days = (req.body as { days?: unknown })?.days;
    if (!days || typeof days !== "object" || Array.isArray(days)) throw new ServiceError(400, "Send the new retention as { days: { ... } }.");
    return res.status(200).json(await logRetention.updateDays(days as Partial<Record<PolicyKey, number>>, req.user?.username || "sysadmin"));
  } catch (err) {
    return fail(res, err, "save the retention settings");
  }
}

export async function runLogRetentionHandler(_req: AuthenticatedRequest, res: Response) {
  try {
    return res.status(200).json(await logRetention.run("MANUAL"));
  } catch (err) {
    return fail(res, err, "run the cleanup");
  }
}
