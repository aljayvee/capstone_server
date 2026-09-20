import { Response } from "express";
import {
  getSystemTelemetry,
  toggleMaintenanceMode,
  triggerDatabaseBackupSnapshot,
  listItAdministrators,
  createItAdministrator,
} from "../services/sysAdminDevOpsService.js";
import { ServiceError } from "../services/ServiceError.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";

export async function getTelemetryHandler(req: AuthenticatedRequest, res: Response) {
  try {
    const telemetry = await getSystemTelemetry();
    return res.status(200).json(telemetry);
  } catch (err: unknown) {
    if (err instanceof ServiceError) {
      return res.status(err.status).json({ error: err.message });
    }
    const message = err instanceof Error ? err.message : "Failed to fetch system telemetry.";
    return res.status(500).json({ error: message });
  }
}

export async function toggleMaintenanceHandler(req: AuthenticatedRequest, res: Response) {
  try {
    const { active, notice } = req.body;
    if (typeof active !== "boolean") {
      return res.status(400).json({ error: "Property 'active' must be a boolean." });
    }
    const result = toggleMaintenanceMode(active, notice);
    return res.status(200).json(result);
  } catch (err: unknown) {
    if (err instanceof ServiceError) {
      return res.status(err.status).json({ error: err.message });
    }
    return res.status(500).json({ error: "Failed to update maintenance mode." });
  }
}

export async function triggerBackupHandler(req: AuthenticatedRequest, res: Response) {
  try {
    const result = await triggerDatabaseBackupSnapshot();
    return res.status(200).json(result);
  } catch (err: unknown) {
    if (err instanceof ServiceError) {
      return res.status(err.status).json({ error: err.message });
    }
    return res.status(500).json({ error: "Failed to generate database backup." });
  }
}

export async function listItAdminsHandler(req: AuthenticatedRequest, res: Response) {
  try {
    const admins = await listItAdministrators();
    return res.status(200).json({ admins });
  } catch (err: unknown) {
    if (err instanceof ServiceError) {
      return res.status(err.status).json({ error: err.message });
    }
    return res.status(500).json({ error: "Failed to fetch IT administrators." });
  }
}

export async function createItAdminHandler(req: AuthenticatedRequest, res: Response) {
  try {
    const result = await createItAdministrator(req.body);
    return res.status(201).json(result);
  } catch (err: unknown) {
    if (err instanceof ServiceError) {
      return res.status(err.status).json({ error: err.message });
    }
    const message = err instanceof Error ? err.message : "Failed to create IT administrator.";
    return res.status(500).json({ error: message });
  }
}
