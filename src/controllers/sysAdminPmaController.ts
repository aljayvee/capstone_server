import { Response } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { getEffectiveSysAdminPermissions } from "../lib/sysAdminPermissionCache.js";
import { logger } from "../lib/logger.js";
import { ServiceError } from "../services/ServiceError.js";
import { parseOrThrow } from "../validators/validate.js";
import {
  createSysAdminGroupSchema,
  listSysAdminPmaAuditQuerySchema,
  sysAdminAccountIdParamSchema,
  sysAdminGroupIdParamSchema,
  updateSysAdminAccountAccessSchema,
  updateSysAdminAccountStatusSchema,
  updateSysAdminGroupSchema,
} from "../validators/sysAdminPmaValidators.js";
import {
  createSysAdminGroup,
  deleteSysAdminGroup,
  getSysAdminPermissionCatalog,
  listSysAdminAccounts,
  listSysAdminGroups,
  listSysAdminPmaAuditLogs,
  updateSysAdminAccountAccess,
  updateSysAdminAccountStatus,
  updateSysAdminGroup,
  type SysAdminPmaActor,
} from "../services/sysAdminPmaService.js";

function actorOf(req: AuthenticatedRequest): SysAdminPmaActor {
  const role = String(req.user?.role ?? "").toUpperCase();
  if (role !== "SYSADMIN" && role !== "OWNER") {
    throw new ServiceError(403, "Unauthorized actor for SysAdmin PMA.");
  }
  return {
    role,
    id: req.user!.id,
    username: req.user!.username || role.toLowerCase(),
  };
}

function handlePmaError(res: Response, err: unknown, fallback: string) {
  if (err instanceof ServiceError) {
    const details = (err.details && typeof err.details === "object") ? (err.details as Record<string, unknown>) : {};
    return res.status(err.status).json({
      error: err.message,
      ...details,
    });
  }
  logger.error(`[SysAdminPmaController] ${fallback}:`, err);
  return res.status(500).json({ error: fallback });
}

/**
 * Available to ANY active authenticated SysAdmin so the portal knows which
 * views and actions to render without exposing management rosters.
 */
export async function getMySysAdminPermissionsHandler(req: AuthenticatedRequest, res: Response) {
  try {
    if (!req.user || String(req.user.role).toUpperCase() !== "SYSADMIN") {
      return res.status(403).json({ error: "SysAdmin session required." });
    }
    const effective = await getEffectiveSysAdminPermissions(req.user.id);
    if (!effective) {
      return res.status(403).json({ error: "SysAdmin account is not active." });
    }
    return res.status(200).json({
      sysAdminId: effective.sysAdminId,
      isMainSysAdmin: effective.isMainSysAdmin,
      group: effective.groupId !== null ? { id: effective.groupId, name: effective.groupName } : null,
      baselineName: effective.baselineName,
      permissions: effective.permissions,
    });
  } catch (err: unknown) {
    return handlePmaError(res, err, "Could not load your SysAdmin access profile.");
  }
}

export async function getSysAdminCatalogHandler(_req: AuthenticatedRequest, res: Response) {
  try {
    return res.status(200).json(getSysAdminPermissionCatalog());
  } catch (err: unknown) {
    return handlePmaError(res, err, "Failed to load SysAdmin permission catalog.");
  }
}

export async function listSysAdminGroupsHandler(_req: AuthenticatedRequest, res: Response) {
  try {
    const groups = await listSysAdminGroups();
    return res.status(200).json({ groups });
  } catch (err: unknown) {
    return handlePmaError(res, err, "Failed to list SysAdmin access groups.");
  }
}

export async function createSysAdminGroupHandler(req: AuthenticatedRequest, res: Response) {
  try {
    const input = parseOrThrow(createSysAdminGroupSchema, req.body);
    const group = await createSysAdminGroup(input, actorOf(req));
    return res.status(201).json({ group });
  } catch (err: unknown) {
    return handlePmaError(res, err, "Failed to create SysAdmin access group.");
  }
}

export async function updateSysAdminGroupHandler(req: AuthenticatedRequest, res: Response) {
  try {
    const groupId = parseOrThrow(sysAdminGroupIdParamSchema, req.params.id);
    const input = parseOrThrow(updateSysAdminGroupSchema, req.body);
    const group = await updateSysAdminGroup(groupId, input, actorOf(req));
    return res.status(200).json({ group });
  } catch (err: unknown) {
    return handlePmaError(res, err, "Failed to update SysAdmin access group.");
  }
}

export async function deleteSysAdminGroupHandler(req: AuthenticatedRequest, res: Response) {
  try {
    const groupId = parseOrThrow(sysAdminGroupIdParamSchema, req.params.id);
    const result = await deleteSysAdminGroup(groupId, actorOf(req));
    return res.status(200).json(result);
  } catch (err: unknown) {
    return handlePmaError(res, err, "Failed to delete SysAdmin access group.");
  }
}

export async function listSysAdminAccountsHandler(_req: AuthenticatedRequest, res: Response) {
  try {
    const accounts = await listSysAdminAccounts();
    return res.status(200).json({ accounts });
  } catch (err: unknown) {
    return handlePmaError(res, err, "Failed to list IT Administrator accounts.");
  }
}

export async function updateSysAdminAccountAccessHandler(req: AuthenticatedRequest, res: Response) {
  try {
    const targetId = parseOrThrow(sysAdminAccountIdParamSchema, req.params.id);
    const input = parseOrThrow(updateSysAdminAccountAccessSchema, req.body);
    const result = await updateSysAdminAccountAccess(targetId, input, actorOf(req));
    return res.status(200).json(result);
  } catch (err: unknown) {
    return handlePmaError(res, err, "Failed to update IT Administrator access.");
  }
}

export async function updateSysAdminAccountStatusHandler(req: AuthenticatedRequest, res: Response) {
  try {
    const targetId = parseOrThrow(sysAdminAccountIdParamSchema, req.params.id);
    const input = parseOrThrow(updateSysAdminAccountStatusSchema, req.body);
    const result = await updateSysAdminAccountStatus(targetId, input, actorOf(req));
    return res.status(200).json(result);
  } catch (err: unknown) {
    return handlePmaError(res, err, "Failed to update IT Administrator status.");
  }
}

export async function listSysAdminPmaAuditHandler(req: AuthenticatedRequest, res: Response) {
  try {
    const query = parseOrThrow(listSysAdminPmaAuditQuerySchema, req.query);
    const result = await listSysAdminPmaAuditLogs(query);
    return res.status(200).json(result);
  } catch (err: unknown) {
    return handlePmaError(res, err, "Failed to load SysAdmin PMA audit logs.");
  }
}
