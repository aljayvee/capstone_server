import { Response } from "express";
import {
  listMonitoredAccounts,
  getAccountSessions,
  terminateAccountSession,
  updateAccountStatus,
} from "../services/sysAdminUserService.js";
import { ServiceError } from "../services/ServiceError.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";

export async function getMonitoredAccounts(req: AuthenticatedRequest, res: Response) {
  try {
    const { role, search, status, page, limit } = req.query;
    const result = await listMonitoredAccounts({
      role: typeof role === "string" ? role : undefined,
      search: typeof search === "string" ? search : undefined,
      status: typeof status === "string" ? status : undefined,
      page: page ? parseInt(String(page), 10) : 1,
      limit: limit ? parseInt(String(limit), 10) : 50,
    });
    return res.status(200).json(result);
  } catch (err: unknown) {
    if (err instanceof ServiceError) {
      return res.status(err.status).json({ error: err.message });
    }
    const message = err instanceof Error ? err.message : "Failed to fetch accounts.";
    return res.status(500).json({ error: message });
  }
}

export async function getSessionsForAccount(req: AuthenticatedRequest, res: Response) {
  try {
    const { role, id } = req.params;
    const accountId = parseInt(id, 10);
    if (isNaN(accountId)) {
      return res.status(400).json({ error: "Invalid account ID." });
    }

    const sessions = await getAccountSessions(role, accountId);
    return res.status(200).json({ sessions });
  } catch (err: unknown) {
    if (err instanceof ServiceError) {
      return res.status(err.status).json({ error: err.message });
    }
    return res.status(500).json({ error: "Failed to fetch account sessions." });
  }
}

export async function terminateSession(req: AuthenticatedRequest, res: Response) {
  try {
    const { sessionId } = req.params;
    const adminNickname = req.user?.username || "SysAdmin";

    const result = await terminateAccountSession(sessionId, adminNickname);
    return res.status(200).json(result);
  } catch (err: unknown) {
    if (err instanceof ServiceError) {
      return res.status(err.status).json({ error: err.message });
    }
    return res.status(500).json({ error: "Failed to terminate session." });
  }
}

export async function updateAccountStatusHandler(req: AuthenticatedRequest, res: Response) {
  try {
    const { role, id } = req.params;
    const accountId = parseInt(id, 10);
    if (isNaN(accountId)) {
      return res.status(400).json({ error: "Invalid account ID." });
    }

    const { status, reason } = req.body;
    if (!status) {
      return res.status(400).json({ error: "Status field is required." });
    }

    const adminNickname = req.user?.username || "SysAdmin";
    const result = await updateAccountStatus(role, accountId, status, adminNickname, reason);
    return res.status(200).json(result);
  } catch (err: unknown) {
    if (err instanceof ServiceError) {
      return res.status(err.status).json({ error: err.message });
    }
    return res.status(500).json({ error: "Failed to update account status." });
  }
}
