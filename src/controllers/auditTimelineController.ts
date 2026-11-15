import { Response } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { ServiceError } from "../services/ServiceError.js";
import {
  AUDIT_SOURCES,
  SEVERITIES,
  auditTimeline,
  exportAuditCsv,
  getAuditEvent,
  getAuditInsights,
  type AuditSeverity,
  type AuditSourceKey,
  type TimelineFilters,
} from "../services/auditTimelineService.js";
import { getRiderActivity, todayInManila } from "../services/riderActivityService.js";
import { logger } from "../lib/logger.js";

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

function date(v: unknown, name: string): Date | undefined {
  const s = str(v);
  if (!s) return undefined;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new ServiceError(400, `${name} is not a valid date.`);
  return d;
}

/** Query string to filters. Throws 400 with a readable reason. */
export function parseFilters(query: Record<string, unknown>): TimelineFilters {
  const f: TimelineFilters = {};
  const sources = str(query.sources);
  if (sources) {
    const list = sources.split(",").map((s) => s.trim()).filter(Boolean);
    const bad = list.filter((s) => !(AUDIT_SOURCES as readonly string[]).includes(s));
    if (bad.length) throw new ServiceError(400, `Unknown log source: ${bad.join(", ")}.`);
    f.sources = list as AuditSourceKey[];
  }
  const q = str(query.q);
  if (q) {
    if (q.length > 100) throw new ServiceError(400, "Search text is limited to 100 characters.");
    f.q = q;
  }
  const ip = str(query.ip);
  if (ip) {
    if (ip.length > 64 || !/^[0-9a-fA-F:.]+$/.test(ip)) throw new ServiceError(400, "IP filter takes digits, dots and colons only.");
    f.ip = ip;
  }
  f.from = date(query.from, "From");
  f.to = date(query.to, "To");
  if (f.from && f.to && f.from > f.to) throw new ServiceError(400, "From is after To.");
  const sev = str(query.minSeverity);
  if (sev) {
    if (!(SEVERITIES as readonly string[]).includes(sev)) throw new ServiceError(400, "Unknown severity.");
    f.minSeverity = sev as AuditSeverity;
  }
  const actor = str(query.actor);
  if (actor) {
    const m = /^(user|customer|sysadmin):(\d{1,9})$/.exec(actor);
    if (!m) throw new ServiceError(400, "Person filter must look like user:12, customer:3 or sysadmin:1.");
    f.actor = { kind: m[1] as "user" | "customer" | "sysadmin", id: Number(m[2]) };
  }
  return f;
}

function fail(res: Response, err: unknown, what: string) {
  if (err instanceof ServiceError) return res.status(err.status).json({ error: err.message });
  logger.error(`[AuditTimeline] ${what} failed:`, err);
  return res.status(500).json({ error: `Could not load the ${what}.` });
}

export async function getAuditTimelineHandler(req: AuthenticatedRequest, res: Response) {
  try {
    const filters = parseFilters(req.query as Record<string, unknown>);
    const limit = Number(req.query.limit) || 50;
    return res.status(200).json(await auditTimeline.page(filters, str(req.query.cursor), limit));
  } catch (err) {
    return fail(res, err, "activity timeline");
  }
}

export async function getAuditEventHandler(req: AuthenticatedRequest, res: Response) {
  try {
    const source = String(req.params.source);
    if (!(AUDIT_SOURCES as readonly string[]).includes(source)) throw new ServiceError(400, "Unknown log source.");
    const id = String(req.params.id);
    if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) throw new ServiceError(400, "Bad entry id.");
    return res.status(200).json(await getAuditEvent(source as AuditSourceKey, id));
  } catch (err) {
    return fail(res, err, "log entry");
  }
}

export async function getAuditInsightsHandler(_req: AuthenticatedRequest, res: Response) {
  try {
    return res.status(200).json(await getAuditInsights());
  } catch (err) {
    return fail(res, err, "audit insights");
  }
}

export async function exportAuditTimelineHandler(req: AuthenticatedRequest, res: Response) {
  try {
    const filters = parseFilters(req.query as Record<string, unknown>);
    const { csv, rows, truncated } = await exportAuditCsv(filters, req.user?.username || "sysadmin");
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="sugo-activity-${stamp}.csv"`);
    res.setHeader("X-Export-Rows", String(rows));
    res.setHeader("X-Export-Truncated", truncated ? "1" : "0");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(csv);
  } catch (err) {
    return fail(res, err, "export");
  }
}

export async function getRiderActivityHandler(req: AuthenticatedRequest, res: Response) {
  try {
    return res.status(200).json(await getRiderActivity(str(req.query.date) ?? todayInManila()));
  } catch (err) {
    return fail(res, err, "rider activity");
  }
}
