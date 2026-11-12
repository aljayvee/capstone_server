import { Response } from "express";
import {
  getSystemTelemetry,
  toggleMaintenanceMode,
  getPortalMaintenanceStatus,
  ensureMaintenanceLoaded,
  triggerDatabaseBackupSnapshot,
  listItAdministrators,
  createItAdministrator,
  restartService,
  getServerErrorStatus,
  setServerErrorStatus,
  getDispatcherAiSuggestionsEnabled,
  setDispatcherAiSuggestionsEnabled,
  getKuyaSugoEnabled,
  setKuyaSugoEnabled,
} from "../services/sysAdminDevOpsService.js";
import { sysAdminBackupService } from "../services/sysAdminBackupService.js";
import { sysAdminLogService, type LogSource } from "../services/sysAdminLogService.js";
import { sysAdminAlertService } from "../services/sysAdminAlertService.js";
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
    const { portal, active, notice, maintenanceType, header, message, supportContact, customColor, footnote } = req.body;
    const validPortals = ["owner", "dispatcher", "rider", "customer"];
    if (!portal || !validPortals.includes(portal)) {
      return res.status(400).json({ error: `Property 'portal' must be one of: ${validPortals.join(", ")}.` });
    }
    if (typeof active !== "boolean") {
      return res.status(400).json({ error: "Property 'active' must be a boolean." });
    }
    const validTypes = ["SCHEDULED", "EMERGENCY", "UPGRADE", "SECURITY", "ADVISORY", "LIVE_NOTICE"];
    if (maintenanceType && !validTypes.includes(maintenanceType)) {
      return res.status(400).json({ error: `Property 'maintenanceType' must be one of: ${validTypes.join(", ")}.` });
    }

    const operator = req.user?.username || req.user?.email || "Administrator";
    const result = await toggleMaintenanceMode(
      portal,
      active,
      {
        maintenanceType,
        header,
        message: message || notice,
        supportContact,
        customColor,
        footnote,
      },
      operator
    );
    return res.status(200).json(result);
  } catch (err: unknown) {
    if (err instanceof ServiceError) {
      return res.status(err.status).json({ error: err.message });
    }
    return res.status(500).json({ error: "Failed to update maintenance mode." });
  }
}

// Public endpoint — no auth required — for portal polling
export async function getPublicMaintenanceStatusHandler(req: AuthenticatedRequest, res: Response) {
  const { portal } = req.query;
  const validPortals = ["owner", "dispatcher", "rider", "customer"];
  if (!portal || typeof portal !== "string" || !validPortals.includes(portal)) {
    return res.status(400).json({ error: `Query param 'portal' must be one of: ${validPortals.join(", ")}.` });
  }
  await ensureMaintenanceLoaded();
  const status = getPortalMaintenanceStatus(portal as "owner" | "dispatcher" | "rider" | "customer");
  return res.status(200).json(status);
}

// Public endpoint — no auth required — for login screen error overlay check
export function getServerErrorStatusHandler(req: AuthenticatedRequest, res: Response) {
  const active = getServerErrorStatus();
  return res.status(200).json({ active });
}

// SysAdmin mutation endpoint — toggles simulated 500 error overlay
export async function toggleServerErrorHandler(req: AuthenticatedRequest, res: Response) {
  try {
    const { active } = req.body;
    if (typeof active !== "boolean") {
      return res.status(400).json({ error: "Property 'active' must be a boolean." });
    }
    const operator = req.user?.username || req.user?.email || "Administrator";
    const result = await setServerErrorStatus(active, operator);
    return res.status(200).json({
      active: result.active,
      message: result.active
        ? "500 Server Error simulation activated on login screen."
        : "500 Server Error simulation deactivated.",
    });
  } catch (err: unknown) {
    if (err instanceof ServiceError) {
      return res.status(err.status).json({ error: err.message });
    }
    return res.status(500).json({ error: "Failed to update 500 server error status." });
  }
}

// Staff endpoint — read by the dispatcher portal to show or hide the AI reason suggestions
export function getDispatcherAiSuggestionsHandler(req: AuthenticatedRequest, res: Response) {
  return res.status(200).json({ enabled: getDispatcherAiSuggestionsEnabled() });
}

// SysAdmin mutation endpoint — turns the dispatchers' AI reason suggestions on or off
export async function toggleDispatcherAiSuggestionsHandler(req: AuthenticatedRequest, res: Response) {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "Property 'enabled' must be a boolean." });
    }
    const operator = req.user?.username || req.user?.email || "Administrator";
    const result = await setDispatcherAiSuggestionsEnabled(enabled, operator);
    return res.status(200).json(result);
  } catch (err: unknown) {
    if (err instanceof ServiceError) {
      return res.status(err.status).json({ error: err.message });
    }
    return res.status(500).json({ error: "Failed to update dispatcher AI suggestions." });
  }
}

// Staff endpoint — read by owner portal to show or hide the Kuya Sugo AI copilot button & drawer
export function getKuyaSugoHandler(req: AuthenticatedRequest, res: Response) {
  return res.status(200).json({ enabled: getKuyaSugoEnabled() });
}

// SysAdmin mutation endpoint — turns the Kuya Sugo AI assistant on or off
export async function toggleKuyaSugoHandler(req: AuthenticatedRequest, res: Response) {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "Property 'enabled' must be a boolean." });
    }
    const operator = req.user?.username || req.user?.email || "Administrator";
    const result = await setKuyaSugoEnabled(enabled, operator);
    return res.status(200).json(result);
  } catch (err: unknown) {
    if (err instanceof ServiceError) {
      return res.status(err.status).json({ error: err.message });
    }
    return res.status(500).json({ error: "Failed to update Kuya Sugo status." });
  }
}


export async function triggerBackupHandler(req: AuthenticatedRequest, res: Response) {
  try {
    const result = await triggerDatabaseBackupSnapshot(req.user?.id);
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

export async function restartServiceHandler(req: AuthenticatedRequest, res: Response) {
  try {
    const { service } = req.params;
    if (service !== "backend" && service !== "nginx") {
      return res.status(400).json({ error: "Invalid service identifier. Supported: backend, nginx." });
    }
    const adminUsername = req.user?.username || "sysadmin";
    const result = await restartService(service, adminUsername);
    return res.status(200).json(result);
  } catch (err: unknown) {
    if (err instanceof ServiceError) {
      return res.status(err.status).json({ error: err.message });
    }
    const message = err instanceof Error ? err.message : "Failed to restart service.";
    return res.status(500).json({ error: message });
  }
}

export async function listBackupsHandler(req: AuthenticatedRequest, res: Response) {
  try {
    const backups = await sysAdminBackupService.listBackups();
    return res.status(200).json({ backups });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to list backups.";
    return res.status(500).json({ error: message });
  }
}

export async function downloadBackupHandler(req: AuthenticatedRequest, res: Response) {
  try {
    const { id } = req.params;
    const { filePath, fileName } = await sysAdminBackupService.getBackupDownloadPath(id);
    return res.download(filePath, fileName);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Backup not found or inaccessible.";
    return res.status(404).json({ error: message });
  }
}

export async function deleteBackupHandler(req: AuthenticatedRequest, res: Response) {
  try {
    const { id } = req.params;
    const backupId = Number(id);
    if (isNaN(backupId)) {
      return res.status(400).json({ error: "Invalid backup ID." });
    }
    const result = await sysAdminBackupService.deleteBackup(backupId);
    return res.status(200).json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to delete backup.";
    return res.status(500).json({ error: message });
  }
}

export async function getLogsHandler(req: AuthenticatedRequest, res: Response) {
  try {
    const source = (req.query.source as LogSource) || "pm2_out";
    const validSources: LogSource[] = ["pm2_out", "pm2_error", "nginx_access", "nginx_error"];
    if (!validSources.includes(source)) {
      return res.status(400).json({ error: `Query param 'source' must be one of: ${validSources.join(", ")}.` });
    }

    const lines = req.query.lines ? parseInt(req.query.lines as string, 10) : 100;
    const search = typeof req.query.search === "string" ? req.query.search : undefined;

    const result = await sysAdminLogService.getTailLogs(source, lines, search);
    return res.status(200).json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to read system logs.";
    return res.status(500).json({ error: message });
  }
}

export async function getAlertStatusHandler(req: AuthenticatedRequest, res: Response) {
  try {
    const status = await sysAdminAlertService.getAlertStatus();
    return res.status(200).json(status);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to fetch alert configuration.";
    return res.status(500).json({ error: message });
  }
}

export async function sendTestAlertHandler(req: AuthenticatedRequest, res: Response) {
  try {
    const adminUsername = req.user?.username || "sysadmin";
    const result = await sysAdminAlertService.sendTestAlert(adminUsername);
    return res.status(result.success ? 200 : 500).json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to dispatch test alert.";
    return res.status(500).json({ error: message });
  }
}

