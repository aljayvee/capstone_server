/**
 * sysAdminIncidentService.ts
 *
 * Incident records: one per outage, with the short report an owner can read
 * afterwards (impact, cause, fix, prevention).
 *
 * Life cycle: OPEN (broken) -> MONITORING (working again, report pending) ->
 * RESOLVED (report written, closed by a person). The health watch moves an
 * automatic incident to MONITORING when service returns; only an admin can
 * resolve, and only with a cause and a fix written down.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { ServiceError } from "./ServiceError.js";

export const INCIDENT_STATUSES = ["OPEN", "MONITORING", "RESOLVED"] as const;
export const INCIDENT_SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

/** Automatic incidents, one active per key at a time. */
export type IncidentSourceKey = "DB_DOWN" | "DISK" | "BACKEND_CRASH" | "BACKUP" | "FIREBASE";

export const INCIDENT_PAGE_SIZE = 20;
const TIMELINE_ALERTS_MAX = 50;

const SEVERITY_RANK: Record<string, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
const ACTIVE: Prisma.SysAdminIncidentWhereInput = { status: { in: ["OPEN", "MONITORING"] } };

export interface CreateIncidentInput {
  title: string;
  severity: IncidentSeverity;
  startedAt: Date;
  impact?: string | null;
}

export interface UpdateIncidentInput {
  title?: string;
  severity?: IncidentSeverity;
  status?: IncidentStatus;
  impact?: string | null;
  cause?: string | null;
  fix?: string | null;
  prevention?: string | null;
  recoveredAt?: Date | null;
}

export interface AutomaticIncidentInput {
  sourceKey: IncidentSourceKey;
  title: string;
  severity: IncidentSeverity;
  startedAt: Date;
  detectedAt?: Date;
  impact?: string;
  alertId?: number | null;
  /** Already working again when it is recorded (a crash PM2 restarted from). */
  recoveredAt?: Date;
}

export interface RecoverIncidentInput {
  sourceKey: IncidentSourceKey;
  recoveredAt: Date;
  alertId?: number | null;
  /** When the outage could not be recorded while it lasted (the database itself was down). */
  createIfMissing?: Omit<AutomaticIncidentInput, "sourceKey" | "alertId" | "recoveredAt">;
}

export type IncidentView = "active" | "resolved" | "all";

function blankToNull(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function higherSeverity(a: string, b: string): string {
  return (SEVERITY_RANK[b] ?? 0) > (SEVERITY_RANK[a] ?? 0) ? b : a;
}

async function linkAlert(alertId: number | null | undefined, incidentId: number): Promise<void> {
  if (!alertId) return;
  await prisma.sysAdminAlert.update({ where: { id: alertId }, data: { incidentId } });
}

export const sysAdminIncidentService = {
  async list(view: IncidentView = "active", page = 1) {
    const where: Prisma.SysAdminIncidentWhereInput =
      view === "active" ? ACTIVE : view === "resolved" ? { status: "RESOLVED" } : {};
    const safePage = Math.max(1, Math.floor(page) || 1);

    const [incidents, total, activeCount] = await Promise.all([
      prisma.sysAdminIncident.findMany({
        where,
        orderBy: [{ startedAt: "desc" }, { id: "desc" }],
        skip: (safePage - 1) * INCIDENT_PAGE_SIZE,
        take: INCIDENT_PAGE_SIZE,
        include: { _count: { select: { alerts: true } } },
      }),
      prisma.sysAdminIncident.count({ where }),
      prisma.sysAdminIncident.count({ where: ACTIVE }),
    ]);

    return {
      incidents: incidents.map(({ _count, ...incident }) => ({ ...incident, alertCount: _count.alerts })),
      total,
      activeCount,
      page: safePage,
      pageSize: INCIDENT_PAGE_SIZE,
    };
  },

  async get(id: number) {
    const incident = await prisma.sysAdminIncident.findUnique({
      where: { id },
      include: {
        alerts: {
          orderBy: { createdAt: "asc" },
          take: TIMELINE_ALERTS_MAX,
          select: { id: true, alertType: true, severity: true, title: true, status: true, createdAt: true },
        },
        _count: { select: { alerts: true } },
      },
    });
    if (!incident) throw new ServiceError(404, "That incident does not exist.");
    const { _count, ...rest } = incident;
    return { ...rest, alertCount: _count.alerts };
  },

  async create(input: CreateIncidentInput, username: string) {
    return prisma.sysAdminIncident.create({
      data: {
        title: input.title.trim(),
        severity: input.severity,
        startedAt: input.startedAt,
        impact: blankToNull(input.impact) ?? null,
        openedBy: username,
      },
    });
  },

  async update(id: number, patch: UpdateIncidentInput, username: string) {
    const current = await prisma.sysAdminIncident.findUnique({ where: { id } });
    if (!current) throw new ServiceError(404, "That incident does not exist.");

    const data: Prisma.SysAdminIncidentUpdateInput = {};
    if (patch.title !== undefined) data.title = patch.title.trim();
    if (patch.severity !== undefined) data.severity = patch.severity;
    for (const field of ["impact", "cause", "fix", "prevention"] as const) {
      const value = blankToNull(patch[field]);
      if (value !== undefined) data[field] = value;
    }

    const recoveredAt = patch.recoveredAt !== undefined ? patch.recoveredAt : current.recoveredAt;
    if (recoveredAt && recoveredAt < current.startedAt) {
      throw new ServiceError(400, "Recovered time cannot be before the incident started.");
    }
    if (patch.recoveredAt !== undefined) data.recoveredAt = patch.recoveredAt;

    const nextStatus = patch.status ?? (current.status as IncidentStatus);

    if (nextStatus === "RESOLVED" && current.status !== "RESOLVED") {
      const cause = data.cause !== undefined ? data.cause : current.cause;
      const fix = data.fix !== undefined ? data.fix : current.fix;
      const missing = [!cause && "what caused it", !fix && "what fixed it"].filter(Boolean);
      if (missing.length > 0) {
        throw new ServiceError(400, `Write down ${missing.join(" and ")} before resolving this incident.`);
      }
      data.status = "RESOLVED";
      data.resolvedAt = new Date();
      data.resolvedBy = username;
      // Resolving says service is back; if nobody noted when, now is the best known time.
      if (!recoveredAt) data.recoveredAt = new Date();
    } else if (nextStatus !== current.status) {
      data.status = nextStatus;
      if (current.status === "RESOLVED") {
        data.resolvedAt = null;
        data.resolvedBy = null;
      }
      if (nextStatus === "MONITORING" && !recoveredAt) data.recoveredAt = new Date();
    }

    if (Object.keys(data).length === 0) return current;
    return prisma.sysAdminIncident.update({ where: { id }, data });
  },

  /**
   * Opens the automatic incident for this key, or joins the one already open
   * (raising its severity if this is worse). Never throws: it runs from the
   * health watch, often while something is already failing.
   */
  async openAutomatic(input: AutomaticIncidentInput): Promise<number | null> {
    try {
      const existing = await prisma.sysAdminIncident.findFirst({
        where: { ...ACTIVE, sourceKey: input.sourceKey },
        orderBy: { startedAt: "desc" },
      });
      if (existing) {
        const severity = higherSeverity(existing.severity, input.severity);
        if (severity !== existing.severity) {
          await prisma.sysAdminIncident.update({ where: { id: existing.id }, data: { severity } });
        }
        await linkAlert(input.alertId, existing.id);
        return existing.id;
      }
      const created = await prisma.sysAdminIncident.create({
        data: {
          title: input.title,
          severity: input.severity,
          sourceKey: input.sourceKey,
          startedAt: input.startedAt,
          detectedAt: input.detectedAt ?? new Date(),
          impact: input.impact ?? null,
          ...(input.recoveredAt ? { recoveredAt: input.recoveredAt, status: "MONITORING" } : {}),
        },
      });
      await linkAlert(input.alertId, created.id);
      return created.id;
    } catch (err: unknown) {
      logger.error(`[IncidentService] Could not open ${input.sourceKey} incident:`, err);
      return null;
    }
  },

  /** Service is back: OPEN becomes MONITORING, waiting for the report. Never throws. */
  async recoverAutomatic(input: RecoverIncidentInput): Promise<number | null> {
    try {
      const existing = await prisma.sysAdminIncident.findFirst({
        where: { ...ACTIVE, sourceKey: input.sourceKey },
        orderBy: { startedAt: "desc" },
      });
      if (existing) {
        await prisma.sysAdminIncident.update({
          where: { id: existing.id },
          data: {
            recoveredAt: existing.recoveredAt ?? input.recoveredAt,
            ...(existing.status === "OPEN" ? { status: "MONITORING" } : {}),
          },
        });
        await linkAlert(input.alertId, existing.id);
        return existing.id;
      }
      if (!input.createIfMissing) return null;
      return await sysAdminIncidentService.openAutomatic({
        ...input.createIfMissing,
        sourceKey: input.sourceKey,
        alertId: input.alertId,
        recoveredAt: input.recoveredAt,
      });
    } catch (err: unknown) {
      logger.error(`[IncidentService] Could not record ${input.sourceKey} recovery:`, err);
      return null;
    }
  },
};
