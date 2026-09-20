import { Response } from "express";
import {
  listAuthAuditLogs,
  listAccountModificationLogs,
  listSecurityThreatLogs,
  listSystemActivityLogs,
} from "../services/sysAdminAuditService.js";
import { ServiceError } from "../services/ServiceError.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";

export async function getAuthAuditLogs(req: AuthenticatedRequest, res: Response) {
  try {
    const { role, status, search, startDate, endDate, page, limit } = req.query;
    const result = await listAuthAuditLogs({
      role: typeof role === "string" ? role : undefined,
      status: typeof status === "string" ? status : undefined,
      search: typeof search === "string" ? search : undefined,
      startDate: typeof startDate === "string" ? startDate : undefined,
      endDate: typeof endDate === "string" ? endDate : undefined,
      page: page ? parseInt(String(page), 10) : 1,
      limit: limit ? parseInt(String(limit), 10) : 25,
    });
    return res.status(200).json(result);
  } catch (err: unknown) {
    if (err instanceof ServiceError) {
      return res.status(err.status).json({ error: err.message });
    }
    const message = err instanceof Error ? err.message : "Failed to fetch authentication audit logs.";
    return res.status(500).json({ error: message });
  }
}

export async function getModificationAuditLogs(req: AuthenticatedRequest, res: Response) {
  try {
    const { role, fieldModified, search, page, limit } = req.query;
    const result = await listAccountModificationLogs({
      role: typeof role === "string" ? role : undefined,
      fieldModified: typeof fieldModified === "string" ? fieldModified : undefined,
      search: typeof search === "string" ? search : undefined,
      page: page ? parseInt(String(page), 10) : 1,
      limit: limit ? parseInt(String(limit), 10) : 25,
    });
    return res.status(200).json(result);
  } catch (err: unknown) {
    if (err instanceof ServiceError) {
      return res.status(err.status).json({ error: err.message });
    }
    const message = err instanceof Error ? err.message : "Failed to fetch account modification logs.";
    return res.status(500).json({ error: message });
  }
}

export async function getSecurityAuditLogs(req: AuthenticatedRequest, res: Response) {
  try {
    const { severity, search, page, limit } = req.query;
    const result = await listSecurityThreatLogs({
      severity: typeof severity === "string" ? severity : undefined,
      search: typeof search === "string" ? search : undefined,
      page: page ? parseInt(String(page), 10) : 1,
      limit: limit ? parseInt(String(limit), 10) : 25,
    });
    return res.status(200).json(result);
  } catch (err: unknown) {
    if (err instanceof ServiceError) {
      return res.status(err.status).json({ error: err.message });
    }
    const message = err instanceof Error ? err.message : "Failed to fetch security threat logs.";
    return res.status(500).json({ error: message });
  }
}

export async function getSystemActivityLogs(req: AuthenticatedRequest, res: Response) {
  try {
    const { status, search, page, limit } = req.query;
    const result = await listSystemActivityLogs({
      status: typeof status === "string" ? status : undefined,
      search: typeof search === "string" ? search : undefined,
      page: page ? parseInt(String(page), 10) : 1,
      limit: limit ? parseInt(String(limit), 10) : 25,
    });
    return res.status(200).json(result);
  } catch (err: unknown) {
    if (err instanceof ServiceError) {
      return res.status(err.status).json({ error: err.message });
    }
    const message = err instanceof Error ? err.message : "Failed to fetch system activity logs.";
    return res.status(500).json({ error: message });
  }
}
