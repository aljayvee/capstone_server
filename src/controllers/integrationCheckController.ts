import { Response } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { integrationCheckService } from "../services/integrationCheckService.js";
import { logger } from "../lib/logger.js";

/** One live answer per outside service. Repeat requests within 20 s reuse the last run. */
export async function getIntegrationReportHandler(_req: AuthenticatedRequest, res: Response) {
  try {
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(await integrationCheckService.report());
  } catch (err: unknown) {
    logger.error("[IntegrationCheck] Report failed:", err);
    return res.status(500).json({ error: "Could not check the integrations." });
  }
}
