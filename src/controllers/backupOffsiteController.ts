import { Response } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { ServiceError } from "../services/ServiceError.js";
import { offsiteBackupService } from "../services/offsiteBackupService.js";
import { backupRestoreCheckService } from "../services/backupRestoreCheckService.js";
import { logger } from "../lib/logger.js";

export async function getOffsiteStatusHandler(_req: AuthenticatedRequest, res: Response) {
  try {
    return res.status(200).json(await offsiteBackupService.getStatus());
  } catch (err: unknown) {
    logger.error("[BackupOffsite] Status failed:", err);
    return res.status(500).json({ error: "Could not load the off-site backup status." });
  }
}

/** 202: the test runs in the background for 5 to 15 minutes; the tab polls the status. */
export async function startRestoreCheckHandler(req: AuthenticatedRequest, res: Response) {
  try {
    const check = await backupRestoreCheckService.start("MANUAL", req.user?.username || "sysadmin");
    return res.status(202).json({ check: { id: check.id, status: check.status, startedAt: check.startedAt.toISOString() } });
  } catch (err: unknown) {
    if (err instanceof ServiceError) return res.status(err.status).json({ error: err.message });
    logger.error("[BackupOffsite] Restore test did not start:", err);
    return res.status(500).json({ error: "Could not start the restore test." });
  }
}
