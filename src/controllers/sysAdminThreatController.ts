/**
 * sysAdminThreatController.ts
 *
 * Controller endpoints for SysAdmin Threat Center, IP blocklists, and whitelists.
 */

import { Request, Response } from "express";
import { sysAdminThreatService } from "../services/sysAdminThreatService.js";
import { getClientIp } from "../middleware/threatInterceptor.js";
import { logger } from "../lib/logger.js";

export async function getThreatOverviewHandler(req: Request, res: Response): Promise<void> {
  try {
    const overview = await sysAdminThreatService.getThreatOverview();
    res.json(overview);
  } catch (err: any) {
    logger.error("[ThreatController] getThreatOverviewHandler error:", err);
    res.status(500).json({ error: "Failed to retrieve threat telemetry overview." });
  }
}

export async function getBlockedIpsHandler(req: Request, res: Response): Promise<void> {
  try {
    const result = await sysAdminThreatService.getBlockedIps(req.query as any);
    res.json(result);
  } catch (err: any) {
    logger.error("[ThreatController] getBlockedIpsHandler error:", err);
    res.status(500).json({ error: "Failed to retrieve blocked IP records." });
  }
}

export async function manuallyBlockIpHandler(req: Request, res: Response): Promise<void> {
  try {
    const { ipAddress, reason, durationHours, severity } = req.body;
    if (!ipAddress || typeof ipAddress !== "string" || !ipAddress.trim()) {
      res.status(400).json({ error: "A valid IP address is required." });
      return;
    }
    if (!reason || typeof reason !== "string" || !reason.trim()) {
      res.status(400).json({ error: "A written justification reason is mandatory." });
      return;
    }

    const normIp = ipAddress.replace(/^::ffff:/, "").trim();
    const callerIp = getClientIp(req);

    // Self-ban safeguard
    if (callerIp === normIp) {
      res.status(400).json({
        error: "Self-Ban Protection: You cannot ban your own active workstation IP address.",
      });
      return;
    }

    const adminId = (req as any).user?.id;
    const record = await sysAdminThreatService.blockIp({
      ipAddress: normIp,
      reason: reason.trim(),
      banType: "MANUAL",
      severity: severity || "HIGH",
      durationHours: durationHours !== undefined && durationHours !== null ? Number(durationHours) : null,
      bannedById: adminId,
      metadata: {
        manuallyBannedAt: new Date().toISOString(),
        bannedByIp: callerIp,
      },
    });

    res.status(201).json({
      message: `IP ${normIp} successfully blacklisted.`,
      record,
    });
  } catch (err: any) {
    logger.error("[ThreatController] manuallyBlockIpHandler error:", err);
    res.status(400).json({ error: err.message || "Failed to blacklist IP address." });
  }
}

export async function unblockIpHandler(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const adminId = (req as any).user?.id;

    const result = await sysAdminThreatService.unblockIp(id, adminId, reason);
    res.json({
      message: `IP ${result.ipAddress} ban has been successfully revoked.`,
      result,
    });
  } catch (err: any) {
    logger.error("[ThreatController] unblockIpHandler error:", err);
    res.status(400).json({ error: err.message || "Failed to revoke IP ban." });
  }
}

export async function getWhitelistedIpsHandler(req: Request, res: Response): Promise<void> {
  try {
    const list = await sysAdminThreatService.getWhitelistedIps();
    res.json({ whitelists: list });
  } catch (err: any) {
    logger.error("[ThreatController] getWhitelistedIpsHandler error:", err);
    res.status(500).json({ error: "Failed to retrieve whitelisted IPs." });
  }
}

export async function addWhitelistedIpHandler(req: Request, res: Response): Promise<void> {
  try {
    const { ipAddress, cidrBlock, description } = req.body;
    if (!ipAddress || typeof ipAddress !== "string" || !ipAddress.trim()) {
      res.status(400).json({ error: "A valid IP address is required." });
      return;
    }
    if (!description || typeof description !== "string" || !description.trim()) {
      res.status(400).json({ error: "A description is required for whitelist entries." });
      return;
    }

    const adminId = (req as any).user?.id;
    const record = await sysAdminThreatService.addWhitelistedIp({
      ipAddress: ipAddress.trim(),
      cidrBlock: cidrBlock?.trim(),
      description: description.trim(),
      createdById: adminId,
    });

    res.status(201).json({
      message: `IP ${record.ipAddress} added to whitelist.`,
      record,
    });
  } catch (err: any) {
    logger.error("[ThreatController] addWhitelistedIpHandler error:", err);
    res.status(400).json({ error: err.message || "Failed to add IP to whitelist." });
  }
}

export async function removeWhitelistedIpHandler(req: Request, res: Response): Promise<void> {
  try {
    const id = Number(req.params.id);
    if (!id || isNaN(id)) {
      res.status(400).json({ error: "Invalid whitelist ID." });
      return;
    }

    await sysAdminThreatService.removeWhitelistedIp(id);
    res.json({ message: "Whitelist entry removed successfully." });
  } catch (err: any) {
    logger.error("[ThreatController] removeWhitelistedIpHandler error:", err);
    res.status(400).json({ error: err.message || "Failed to remove whitelist entry." });
  }
}
