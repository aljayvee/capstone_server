/**
 * sysAdminThreatService.ts
 *
 * Dual-tier IP blacklist & whitelist management service with in-memory O(1) caching,
 * automated heuristic bans, and Nginx edge-configuration synchronization.
 */

import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { sysAdminAlertService } from "./sysAdminAlertService.js";
import fs from "fs";
import { isIP } from "net";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export interface BanCacheEntry {
  blockedUntil: Date | null;
  reason: string;
  severity: string;
}

const activeBanMap = new Map<string, BanCacheEntry>();
const activeWhitelistSet = new Set<string>();
let isInitialized = false;

// Immune default addresses (never bannable)
const IMMUNE_IPS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost", "109.123.239.182"]);

export const sysAdminThreatService = {
  /**
   * Initializes the in-memory threat cache on server startup.
   */
  async initThreatEngine(): Promise<void> {
    if (isInitialized) return;
    try {
      // 1. Seed immune IPs into whitelist
      for (const immuneIp of IMMUNE_IPS) {
        activeWhitelistSet.add(immuneIp);
      }

      // 2. Load whitelisted IPs from database
      const dbWhitelists = await prisma.whitelistedIp.findMany();
      for (const w of dbWhitelists) {
        activeWhitelistSet.add(w.ipAddress);
      }

      // 3. Load active bans from database
      const now = new Date();
      const dbBans = await prisma.blockedIp.findMany({
        where: {
          status: "ACTIVE",
          OR: [{ blockedUntil: null }, { blockedUntil: { gt: now } }],
        },
      });

      for (const b of dbBans) {
        activeBanMap.set(b.ipAddress, {
          blockedUntil: b.blockedUntil,
          reason: b.reason,
          severity: b.severity,
        });
      }

      isInitialized = true;
      logger.info(
        `[ThreatEngine] Initialized with ${activeBanMap.size} active bans and ${activeWhitelistSet.size} whitelisted IPs.`
      );

      // 4. Initial Nginx sync in production
      if (process.platform === "linux") {
        this.syncNginxBlocklist().catch((err) => {
          logger.error("[ThreatEngine] Initial Nginx blocklist sync failed:", err);
        });
      }
    } catch (err) {
      logger.error("[ThreatEngine] Failed to initialize threat cache:", err);
    }
  },

  /**
   * Fast O(1) in-memory check if an IP address is whitelisted.
   */
  isIpWhitelisted(ip: string): boolean {
    if (IMMUNE_IPS.has(ip) || activeWhitelistSet.has(ip)) {
      return true;
    }
    // Normalize IPv6-mapped IPv4
    const normalized = ip.replace(/^::ffff:/, "");
    if (IMMUNE_IPS.has(normalized) || activeWhitelistSet.has(normalized)) {
      return true;
    }
    return false;
  },

  /**
   * Fast O(1) in-memory check if an IP address is blacklisted.
   */
  checkIpBlocked(ip: string): {
    isBlocked: boolean;
    reason?: string;
    severity?: string;
    blockedUntil?: Date | null;
  } {
    const normalized = ip.replace(/^::ffff:/, "");
    if (this.isIpWhitelisted(normalized)) {
      return { isBlocked: false };
    }

    const entry = activeBanMap.get(normalized);
    if (!entry) {
      return { isBlocked: false };
    }

    // Check expiration
    if (entry.blockedUntil && entry.blockedUntil < new Date()) {
      // Ban has expired — purge from memory and queue DB update
      activeBanMap.delete(normalized);
      prisma.blockedIp
        .updateMany({
          where: { ipAddress: normalized, status: "ACTIVE" },
          data: { status: "EXPIRED" },
        })
        .catch(() => {});
      return { isBlocked: false };
    }

    // Still blocked — record attack hit asynchronously
    this.recordAttackHit(normalized);

    return {
      isBlocked: true,
      reason: entry.reason,
      severity: entry.severity,
      blockedUntil: entry.blockedUntil,
    };
  },

  /**
   * Records an attack hit attempt from an already-blocked IP.
   */
  recordAttackHit(ip: string): void {
    prisma.blockedIp
      .updateMany({
        where: { ipAddress: ip, status: "ACTIVE" },
        data: {
          attackCount: { increment: 1 },
          lastSeenAt: new Date(),
        },
      })
      .catch(() => {});
  },

  /**
   * Blacklists an IP address (auto or manual).
   */
  async blockIp(params: {
    ipAddress: string;
    reason: string;
    banType?: "AUTOMATIC" | "MANUAL";
    severity?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    durationHours?: number | null; // null = permanent
    bannedById?: number;
    metadata?: any;
  }): Promise<any> {
    const normalizedIp = params.ipAddress.replace(/^::ffff:/, "").trim();

    // Every active ban is written into nginx as `deny <ip>;`. Anything but a
    // plain address could smuggle in directives, and a line nginx -t rejects
    // would fail every later sync while the row stays ACTIVE.
    if (!isIP(normalizedIp)) {
      throw new Error("Enter a single IPv4 or IPv6 address.");
    }

    if (this.isIpWhitelisted(normalizedIp)) {
      throw new Error(`Cannot ban IP ${normalizedIp}: This IP is on the whitelist or has immunity.`);
    }

    const blockedUntil =
      params.durationHours && params.durationHours > 0
        ? new Date(Date.now() + params.durationHours * 3600 * 1000)
        : null;

    // Check existing active ban
    const existing = await prisma.blockedIp.findFirst({
      where: { ipAddress: normalizedIp, status: "ACTIVE" },
    });

    let record;
    if (existing) {
      record = await prisma.blockedIp.update({
        where: { id: existing.id },
        data: {
          reason: params.reason,
          banType: params.banType || existing.banType,
          severity: params.severity || existing.severity,
          blockedUntil: blockedUntil ?? existing.blockedUntil,
          attackCount: { increment: 1 },
          lastSeenAt: new Date(),
          bannedById: params.bannedById ?? existing.bannedById,
          metadata: params.metadata ?? existing.metadata,
        },
      });
    } else {
      record = await prisma.blockedIp.create({
        data: {
          ipAddress: normalizedIp,
          reason: params.reason,
          banType: params.banType || "AUTOMATIC",
          severity: params.severity || "HIGH",
          status: "ACTIVE",
          blockedUntil,
          bannedById: params.bannedById,
          metadata: params.metadata,
        },
      });
    }

    // Update in-memory cache
    activeBanMap.set(normalizedIp, {
      blockedUntil: record.blockedUntil,
      reason: record.reason,
      severity: record.severity,
    });

    logger.warn(
      `[ThreatEngine] IP BANNED: ${normalizedIp} | Reason: ${params.reason} | Type: ${params.banType || "AUTOMATIC"} | Until: ${blockedUntil ? blockedUntil.toISOString() : "PERMANENT"}`
    );

    // Sync to Nginx
    if (process.platform === "linux") {
      try {
        await this.syncNginxBlocklist();
      } catch (err) {
        logger.error("[ThreatEngine] Failed to sync Nginx blocklist:", err);
      }
    }

    // Dispatch Telegram alert for High/Critical or Automatic bans
    if (record.severity === "CRITICAL" || record.severity === "HIGH" || params.banType === "AUTOMATIC") {
      sysAdminAlertService
        .sendTelegramAlert({
          alertType: "CRITICAL_INTRUSION",
          severity: (record.severity as any) || "HIGH",
          title: `IP Blacklisted: ${normalizedIp}`,
          // One key for every IP: the title varies per IP, and bans arrive in
          // bursts (769 recorded by 2026-11-15) that would flood the chat.
          repeatKey: "CRITICAL_INTRUSION",
          message: `Intrusion threat neutralized. IP ${normalizedIp} has been banned. Reason: ${params.reason}. Ban Type: ${params.banType || "AUTOMATIC"}.`,
          metadata: {
            ip: normalizedIp,
            reason: params.reason,
            banType: params.banType || "AUTOMATIC",
            severity: record.severity,
            blockedUntil: blockedUntil ? blockedUntil.toISOString() : "PERMANENT",
          },
        })
        .catch(() => {});
    }

    return record;
  },

  /**
   * Revokes an IP ban.
   */
  async unblockIp(
    idOrIp: string | number,
    adminId?: number,
    reason?: string
  ): Promise<{ success: boolean; ipAddress: string }> {
    let targetRecord;
    if (typeof idOrIp === "number" || !isNaN(Number(idOrIp))) {
      targetRecord = await prisma.blockedIp.findUnique({ where: { id: Number(idOrIp) } });
    } else {
      targetRecord = await prisma.blockedIp.findFirst({
        where: { ipAddress: idOrIp, status: "ACTIVE" },
      });
    }

    if (!targetRecord) {
      throw new Error("No active ban record found for this identifier.");
    }

    await prisma.blockedIp.update({
      where: { id: targetRecord.id },
      data: {
        status: "REVOKED",
        updatedAt: new Date(),
      },
    });

    // Remove from in-memory cache
    activeBanMap.delete(targetRecord.ipAddress);

    logger.info(
      `[ThreatEngine] IP UNBANNED: ${targetRecord.ipAddress} by admin #${adminId || "CLI"}. Reason: ${reason || "Administrative revoke"}`
    );

    // Sync to Nginx
    if (process.platform === "linux") {
      try {
        await this.syncNginxBlocklist();
      } catch (err) {
        logger.error("[ThreatEngine] Failed to sync Nginx blocklist:", err);
      }
    }

    return { success: true, ipAddress: targetRecord.ipAddress };
  },

  /**
   * Adds an IP or subnet to the whitelist.
   */
  async addWhitelistedIp(params: {
    ipAddress: string;
    cidrBlock?: string;
    description: string;
    createdById?: number;
  }): Promise<any> {
    const normalizedIp = params.ipAddress.replace(/^::ffff:/, "").trim();
    if (!isIP(normalizedIp)) {
      throw new Error("Enter a single IPv4 or IPv6 address.");
    }

    const record = await prisma.whitelistedIp.upsert({
      where: { ipAddress: normalizedIp },
      update: {
        cidrBlock: params.cidrBlock,
        description: params.description,
        createdById: params.createdById,
      },
      create: {
        ipAddress: normalizedIp,
        cidrBlock: params.cidrBlock,
        description: params.description,
        createdById: params.createdById,
      },
    });

    activeWhitelistSet.add(normalizedIp);

    // If previously banned, auto-unblock
    if (activeBanMap.has(normalizedIp)) {
      await this.unblockIp(normalizedIp, params.createdById, "Auto-unblocked upon addition to whitelist");
    }

    return record;
  },

  /**
   * Removes an IP from the whitelist.
   */
  async removeWhitelistedIp(id: number): Promise<void> {
    const record = await prisma.whitelistedIp.findUnique({ where: { id } });
    if (!record) throw new Error("Whitelist entry not found.");
    if (record.isImmune || IMMUNE_IPS.has(record.ipAddress)) {
      throw new Error("Cannot delete immune server or loopback address from whitelist.");
    }

    await prisma.whitelistedIp.delete({ where: { id } });
    activeWhitelistSet.delete(record.ipAddress);
  },

  /**
   * Synchronizes active bans to the Nginx edge blocklist file.
   */
  async syncNginxBlocklist(): Promise<void> {
    const nginxConfPath = "/etc/nginx/conf.d/blocked_ips.conf";
    const tempConfPath = "/etc/nginx/conf.d/blocked_ips.conf.tmp";

    try {
      const activeBans = await prisma.blockedIp.findMany({
        where: { status: "ACTIVE" },
        select: { ipAddress: true, reason: true },
      });

      let content = "# =============================================================================\n";
      content += "# SUGO EXPRESS EDGE IP BLOCKLIST — AUTO-GENERATED BY SYSADMIN THREAT ENGINE\n";
      content += `# Updated: ${new Date().toISOString()} | Active Entries: ${activeBans.length}\n`;
      content += "# =============================================================================\n\n";

      for (const ban of activeBans) {
        // Rows saved before blockIp validated addresses: one bad line would
        // make nginx -t refuse the whole file, every sync, so skip it.
        if (!isIP(ban.ipAddress)) {
          logger.warn(`[ThreatEngine] Skipped a ban with an invalid address: ${JSON.stringify(ban.ipAddress)}`);
          continue;
        }
        const safeReason = ban.reason.replace(/[\r\n]/g, " ");
        content += `deny ${ban.ipAddress}; # ${safeReason}\n`;
      }

      fs.writeFileSync(tempConfPath, content, "utf8");

      // Validate Nginx syntax before replacing
      await execAsync("nginx -t");
      fs.renameSync(tempConfPath, nginxConfPath);
      await execAsync("systemctl reload nginx");

      logger.info(`[ThreatEngine] Synced ${activeBans.length} blocked IPs to ${nginxConfPath} and reloaded Nginx.`);
    } catch (err) {
      if (fs.existsSync(tempConfPath)) {
        try {
          fs.unlinkSync(tempConfPath);
        } catch {}
      }
      logger.error("[ThreatEngine] Error during Nginx blocklist sync:", err);
    }
  },

  /**
   * Prunes expired temporary bans from active status.
   */
  async pruneExpiredBans(): Promise<number> {
    const now = new Date();
    const result = await prisma.blockedIp.updateMany({
      where: {
        status: "ACTIVE",
        blockedUntil: { lte: now },
      },
      data: { status: "EXPIRED" },
    });

    if (result.count > 0) {
      // Clean memory cache
      for (const [ip, entry] of activeBanMap.entries()) {
        if (entry.blockedUntil && entry.blockedUntil <= now) {
          activeBanMap.delete(ip);
        }
      }
      logger.info(`[ThreatEngine] Pruned ${result.count} expired IP bans.`);
      if (process.platform === "linux") {
        this.syncNginxBlocklist().catch(() => {});
      }
    }
    return result.count;
  },

  /**
   * Retrieves summary telemetry for the Threat Center dashboard.
   */
  async getThreatOverview(): Promise<{
    totalActiveBans: number;
    permanentBans: number;
    temporaryBans: number;
    totalAttacksBlocked24h: number;
    totalWhitelisted: number;
    recentIntrusions: any[];
  }> {
    const now = new Date();
    const past24h = new Date(Date.now() - 24 * 3600 * 1000);

    const [totalActiveBans, permanentBans, temporaryBans, totalWhitelisted, recentIntrusions, attacksAgg] =
      await Promise.all([
        prisma.blockedIp.count({ where: { status: "ACTIVE" } }),
        prisma.blockedIp.count({ where: { status: "ACTIVE", blockedUntil: null } }),
        prisma.blockedIp.count({ where: { status: "ACTIVE", blockedUntil: { not: null } } }),
        prisma.whitelistedIp.count(),
        prisma.blockedIp.findMany({
          orderBy: { lastSeenAt: "desc" },
          take: 10,
          include: {
            bannedBy: {
              select: { id: true, username: true, nickname: true },
            },
          },
        }),
        prisma.blockedIp.aggregate({
          where: { lastSeenAt: { gte: past24h } },
          _sum: { attackCount: true },
        }),
      ]);

    return {
      totalActiveBans,
      permanentBans,
      temporaryBans,
      totalAttacksBlocked24h: attacksAgg._sum.attackCount || 0,
      totalWhitelisted,
      recentIntrusions,
    };
  },

  /**
   * Retrieves paginated list of blocked IP records.
   */
  async getBlockedIps(params?: {
    search?: string;
    status?: string;
    banType?: string;
    severity?: string;
    page?: number;
    limit?: number;
  }): Promise<{
    records: any[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = Math.max(1, Number(params?.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(params?.limit) || 20));
    const skip = (page - 1) * limit;

    const where: any = {};
    if (params?.status && params.status !== "ALL") {
      where.status = params.status;
    }
    if (params?.banType && params.banType !== "ALL") {
      where.banType = params.banType;
    }
    if (params?.severity && params.severity !== "ALL") {
      where.severity = params.severity;
    }
    if (params?.search && params.search.trim()) {
      const q = params.search.trim();
      where.OR = [
        { ipAddress: { contains: q } },
        { reason: { contains: q } },
      ];
    }

    const [total, records] = await Promise.all([
      prisma.blockedIp.count({ where }),
      prisma.blockedIp.findMany({
        where,
        skip,
        take: limit,
        orderBy: { lastSeenAt: "desc" },
        include: {
          bannedBy: {
            select: { id: true, username: true, nickname: true },
          },
        },
      }),
    ]);

    return {
      records,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  },

  /**
   * Retrieves all whitelisted IP addresses.
   */
  async getWhitelistedIps(): Promise<any[]> {
    return prisma.whitelistedIp.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        createdBy: {
          select: { id: true, username: true, nickname: true },
        },
      },
    });
  },
};
