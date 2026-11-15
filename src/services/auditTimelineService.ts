/**
 * auditTimelineService.ts
 *
 * One readable, newest-first stream over every log table the database keeps,
 * for the SysAdmin Audit Logs "Activity timeline". Before this, most of these
 * tables were written and never read anywhere (2026-11-15 survey).
 *
 * Paging: each source is read in (time, id) order on its own, and the sources
 * are merged. The cursor remembers how far each source has been consumed, so a
 * page never skips or repeats a row even when two sources share a timestamp.
 *
 * Never shown: sign-in token values (token_blocklist is not a source at all),
 * and any field whose name looks like a secret (see SENSITIVE_FIELD).
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { ServiceError } from "./ServiceError.js";

export const AUDIT_SOURCES = [
  "signin",
  "account_change",
  "password_reset",
  "staff_session",
  "rider_session",
  "rider_connectivity",
  "dispatch",
  "report_print",
  "ip_block",
  "it_alert",
  "pma",
] as const;
export type AuditSourceKey = (typeof AUDIT_SOURCES)[number];

export const SOURCE_LABELS: Record<AuditSourceKey, string> = {
  signin: "Sign-ins",
  account_change: "Account changes",
  password_reset: "Password resets",
  staff_session: "Sessions",
  rider_session: "Rider shifts (login)",
  rider_connectivity: "Rider connection drops",
  dispatch: "Dispatch",
  report_print: "Report prints",
  ip_block: "IP bans",
  it_alert: "IT alerts",
  pma: "IT admin permissions",
};

export const SEVERITIES = ["info", "notice", "warning", "critical"] as const;
export type AuditSeverity = (typeof SEVERITIES)[number];
const SEVERITY_RANK: Record<AuditSeverity, number> = { info: 0, notice: 1, warning: 2, critical: 3 };

export type ActorKind = "user" | "customer" | "sysadmin" | "system";
export interface AuditActor {
  kind: ActorKind;
  id: number | null;
  name: string;
  role: string | null;
}

export interface AuditEvent {
  key: string; // `${source}:${rowId}`
  source: AuditSourceKey;
  rowId: string;
  at: string;
  severity: AuditSeverity;
  action: string;
  summary: string;
  actor: AuditActor | null;
  ip: string | null;
}

export const PAGE_MAX = 100;
export const EXPORT_MAX_ROWS = 20000;
const MAX_FETCH_ROUNDS = 25;
export const SENSITIVE_FIELD = /hash|token|secret|password|otp|code|jti/i;

/* ------------------------------------------------------------------ */
/* Names                                                               */
/* ------------------------------------------------------------------ */

export interface NameBook {
  user: Map<number, { name: string; role: string; username: string }>;
  customer: Map<number, { name: string; username: string }>;
  sysadmin: Map<number, { name: string; username: string }>;
}

export async function loadNameBook(): Promise<NameBook> {
  const [users, customers, admins] = await Promise.all([
    prisma.user.findMany({ select: { id: true, username: true, firstName: true, lastName: true, role: true } }),
    prisma.customerAccount.findMany({ select: { id: true, username: true, information: { select: { firstName: true, lastName: true } } } }),
    prisma.sysAdmin.findMany({ select: { id: true, username: true, firstName: true, lastName: true } }),
  ]);
  return {
    user: new Map(users.map((u) => [u.id, { name: `${u.firstName} ${u.lastName}`.trim() || u.username, role: String(u.role), username: u.username }])),
    customer: new Map(customers.map((c) => [c.id, { name: c.information ? `${c.information.firstName} ${c.information.lastName}`.trim() : c.username, username: c.username }])),
    sysadmin: new Map(admins.map((s) => [s.id, { name: [s.firstName, s.lastName].filter(Boolean).join(" ") || s.username, username: s.username }])),
  };
}

/** Customer and staff ids are separate sequences (they collide), so the role always picks the table. */
export function actorFor(book: NameBook, kind: ActorKind, id: number | null | undefined, role?: string | null): AuditActor {
  if (kind === "system" || id === null || id === undefined) return { kind: "system", id: null, name: "System", role: null };
  const hit = kind === "user" ? book.user.get(id) : kind === "customer" ? book.customer.get(id) : book.sysadmin.get(id);
  const fallback = `${kind === "customer" ? "Customer" : kind === "sysadmin" ? "IT admin" : "Staff"} #${id} (deleted)`;
  return { kind, id, name: hit ? `${hit.name} (${hit.username})` : fallback, role: role ?? (kind === "user" ? (book.user.get(id)?.role ?? null) : kind.toUpperCase()) };
}

function kindForRole(role: string | null | undefined): ActorKind {
  if (role === "CUSTOMER") return "customer";
  if (role === "SYSADMIN") return "sysadmin";
  return "user";
}

/** Ids of everyone whose name or username contains the search text. */
export function matchActors(book: NameBook, text: string): Record<Exclude<ActorKind, "system">, number[]> {
  const t = text.toLowerCase();
  const pick = (m: Map<number, { name: string; username: string }>) =>
    [...m.entries()].filter(([, v]) => v.name.toLowerCase().includes(t) || v.username.toLowerCase().includes(t)).map(([k]) => k);
  return { user: pick(book.user), customer: pick(book.customer), sysadmin: pick(book.sysadmin) };
}

/* ------------------------------------------------------------------ */
/* Sources                                                             */
/* ------------------------------------------------------------------ */

export interface Position {
  at: string;
  id: string;
}

export interface TimelineFilters {
  sources?: AuditSourceKey[];
  q?: string;
  ip?: string;
  from?: Date;
  to?: Date;
  minSeverity?: AuditSeverity;
  actor?: { kind: Exclude<ActorKind, "system">; id: number };
}

interface FetchContext {
  filters: TimelineFilters;
  before: Position | null;
  take: number;
  book: NameBook;
  matched: Record<Exclude<ActorKind, "system">, number[]> | null;
}

export interface FetchedRow {
  pos: Position;
  event: AuditEvent;
}

export interface AuditSource {
  key: AuditSourceKey;
  fetch(ctx: FetchContext): Promise<FetchedRow[]>;
  detail(rowId: string): Promise<Record<string, unknown> | null>;
}

const clip = (s: string | null | undefined, n = 140) => (!s ? "" : s.length > n ? `${s.slice(0, n - 1)}…` : s);
const shortUa = (ua: string | null | undefined) => {
  if (!ua) return "";
  if (/okhttp/i.test(ua)) return "Android app";
  if (/Expo|CFNetwork/i.test(ua)) return "Mobile app";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "";
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return [browser, os].filter(Boolean).join(" on ") || clip(ua, 40);
};
const minutes = (ms: number) => (ms < 60000 ? `${Math.round(ms / 1000)} s` : ms < 3600000 ? `${Math.round(ms / 60000)} min` : `${(ms / 3600000).toFixed(1)} h`);

/** Rows strictly older than `before` in (time, id) order, inside the date range. */
function timeWindow(field: string, ctx: FetchContext, numericId: boolean): Record<string, unknown>[] {
  const and: Record<string, unknown>[] = [];
  const range: Record<string, Date> = {};
  if (ctx.filters.from) range.gte = ctx.filters.from;
  if (ctx.filters.to) range.lte = ctx.filters.to;
  if (Object.keys(range).length) and.push({ [field]: range });
  if (ctx.before) {
    const at = new Date(ctx.before.at);
    const id = numericId ? Number(ctx.before.id) : ctx.before.id;
    and.push({ OR: [{ [field]: { lt: at } }, { [field]: at, id: { lt: id } }] });
  }
  return and;
}

function textOr(ctx: FetchContext, fields: string[], actorClauses: Record<string, unknown>[]): Record<string, unknown>[] {
  const q = ctx.filters.q?.trim();
  if (!q) return [];
  return [{ OR: [...fields.map((f) => ({ [f]: { contains: q } })), ...actorClauses] }];
}

function ipClause(ctx: FetchContext, field: string | null): Record<string, unknown>[] | null {
  if (!ctx.filters.ip) return [];
  if (!field) return null; // this source has no IP: nothing can match
  return [{ [field]: { contains: ctx.filters.ip.trim() } }];
}

const order = (field: string) => [{ [field]: "desc" as const }, { id: "desc" as const }];

const signin: AuditSource = {
  key: "signin",
  async fetch(ctx) {
    const ip = ipClause(ctx, "ipAddress");
    if (ip === null) return [];
    const m = ctx.matched;
    const actorOr = m
      ? [
          { role: "CUSTOMER", userId: { in: m.customer } },
          { role: "SYSADMIN", userId: { in: m.sysadmin } },
          { role: { notIn: ["CUSTOMER", "SYSADMIN"] }, userId: { in: m.user } },
        ]
      : [];
    const a = ctx.filters.actor;
    const actor = a ? [a.kind === "customer" ? { role: "CUSTOMER", userId: a.id } : a.kind === "sysadmin" ? { role: "SYSADMIN", userId: a.id } : { role: { notIn: ["CUSTOMER", "SYSADMIN"] }, userId: a.id }] : [];
    const rows = await prisma.accountLoginLog.findMany({
      where: { AND: [...timeWindow("createdAt", ctx, true), ...textOr(ctx, ["ipAddress", "userAgent", "deviceInfo", "status"], actorOr), ...ip, ...actor] } as Prisma.AccountLoginLogWhereInput,
      orderBy: order("createdAt") as Prisma.AccountLoginLogOrderByWithRelationInput[],
      take: ctx.take,
    });
    return rows.map((r) => {
      const failed = r.status.startsWith("FAILED") || r.status === "LOCKED";
      const action = r.status === "SUCCESS" ? "Signed in" : r.status === "LOGOUT" ? "Signed out" : `Sign-in refused (${r.status.replace(/_/g, " ").toLowerCase()})`;
      const device = r.deviceInfo || shortUa(r.userAgent);
      const ended = r.revokedAt ? `; session ended ${r.revokedAt.toISOString()}${r.revokedReason ? ` (${r.revokedReason})` : ""}` : "";
      return {
        pos: { at: r.createdAt.toISOString(), id: String(r.id) },
        event: {
          key: `signin:${r.id}`, source: "signin", rowId: String(r.id), at: r.createdAt.toISOString(),
          severity: failed ? "warning" : "info", action, summary: `${r.role} via ${device || "unknown device"}${ended}`,
          actor: actorFor(ctx.book, kindForRole(r.role), r.userId, r.role), ip: r.ipAddress,
        },
      };
    });
  },
  detail: (id) => prisma.accountLoginLog.findUnique({ where: { id: Number(id) } }) as Promise<Record<string, unknown> | null>,
};

const HIDDEN_VALUE = /password|token|secret|otp|code|hash/i;

const accountChange: AuditSource = {
  key: "account_change",
  async fetch(ctx) {
    const ip = ipClause(ctx, "ipAddress");
    if (ip === null) return [];
    const m = ctx.matched;
    const actorOr = m ? [{ userId: { in: m.user } }, { customerId: { in: m.customer } }] : [];
    const a = ctx.filters.actor;
    if (a?.kind === "sysadmin") return [];
    const actor = a ? [a.kind === "customer" ? { customerId: a.id } : { userId: a.id }] : [];
    const rows = await prisma.accountModificationLog.findMany({
      where: { AND: [...timeWindow("createdAt", ctx, true), ...textOr(ctx, ["fieldModified", "verifiedVia", "ipAddress", "role"], actorOr), ...ip, ...actor] } as Prisma.AccountModificationLogWhereInput,
      orderBy: order("createdAt") as Prisma.AccountModificationLogOrderByWithRelationInput[],
      take: ctx.take,
    });
    return rows.map((r) => {
      const hidden = HIDDEN_VALUE.test(r.fieldModified);
      const change = hidden ? "value hidden" : `${clip(r.oldValue, 40) || "(empty)"} → ${clip(r.newValue, 40) || "(empty)"}`;
      const by = r.verifiedVia.includes(":") ? ` by ${r.verifiedVia.split(":").slice(1).join(":")}` : ` (verified via ${r.verifiedVia.toLowerCase().replace(/_/g, " ")})`;
      const severe = r.fieldModified === "account_status" || r.fieldModified.startsWith("permission");
      return {
        pos: { at: r.createdAt.toISOString(), id: String(r.id) },
        event: {
          key: `account_change:${r.id}`, source: "account_change", rowId: String(r.id), at: r.createdAt.toISOString(),
          severity: severe ? "warning" : "notice", action: `Changed ${r.fieldModified.replace(/_/g, " ")}`, summary: `${change}${by}`,
          actor: r.customerId ? actorFor(ctx.book, "customer", r.customerId) : actorFor(ctx.book, "user", r.userId, r.role), ip: r.ipAddress,
        },
      };
    });
  },
  async detail(id) {
    const r = await prisma.accountModificationLog.findUnique({ where: { id: Number(id) } });
    if (!r) return null;
    return HIDDEN_VALUE.test(r.fieldModified) ? { ...r, oldValue: "[hidden]", newValue: "[hidden]" } : r;
  },
};

const RESET_SEVERITY: Record<string, AuditSeverity> = { CODE_REJECTED: "notice", THROTTLED: "warning", UNKNOWN_ACCOUNT: "notice", COOLDOWN: "notice" };

const passwordReset: AuditSource = {
  key: "password_reset",
  async fetch(ctx) {
    const ip = ipClause(ctx, "ipAddress");
    if (ip === null) return [];
    const a = ctx.filters.actor;
    if (a && a.kind !== "customer") return [];
    const actorOr = ctx.matched ? [{ customerId: { in: ctx.matched.customer } }] : [];
    const rows = await prisma.passwordResetAttempt.findMany({
      where: { AND: [...timeWindow("createdAt", ctx, true), ...textOr(ctx, ["identifier", "outcome", "ipAddress"], actorOr), ...ip, ...(a ? [{ customerId: a.id }] : [])] } as Prisma.PasswordResetAttemptWhereInput,
      orderBy: order("createdAt") as Prisma.PasswordResetAttemptOrderByWithRelationInput[],
      take: ctx.take,
    });
    return rows.map((r) => ({
      pos: { at: r.createdAt.toISOString(), id: String(r.id) },
      event: {
        key: `password_reset:${r.id}`, source: "password_reset", rowId: String(r.id), at: r.createdAt.toISOString(),
        severity: RESET_SEVERITY[r.outcome] ?? "info", action: `Password reset: ${r.outcome.replace(/_/g, " ").toLowerCase()}`,
        summary: `for ${clip(r.identifier, 60)}`, actor: r.customerId ? actorFor(ctx.book, "customer", r.customerId) : null, ip: r.ipAddress,
      },
    }));
  },
  detail: (id) => prisma.passwordResetAttempt.findUnique({ where: { id: Number(id) } }) as Promise<Record<string, unknown> | null>,
};

const staffSession: AuditSource = {
  key: "staff_session",
  async fetch(ctx) {
    const ip = ipClause(ctx, "ipAddress");
    if (ip === null) return [];
    const m = ctx.matched;
    const actorOr = m
      ? [
          { subjectType: "CUSTOMER", subjectId: { in: m.customer } },
          { subjectType: "SYSADMIN", subjectId: { in: m.sysadmin } },
          { subjectType: "USER", subjectId: { in: m.user } },
        ]
      : [];
    const a = ctx.filters.actor;
    const actor = a ? [{ subjectType: a.kind === "customer" ? "CUSTOMER" : a.kind === "sysadmin" ? "SYSADMIN" : "USER", subjectId: a.id }] : [];
    const rows = await prisma.userSession.findMany({
      where: { AND: [...timeWindow("createdAt", ctx, false), ...textOr(ctx, ["ipAddress", "userAgent", "revokedReason", "role"], actorOr), ...ip, ...actor] } as Prisma.UserSessionWhereInput,
      orderBy: order("createdAt") as Prisma.UserSessionOrderByWithRelationInput[],
      take: ctx.take,
      select: { id: true, subjectId: true, subjectType: true, role: true, userAgent: true, ipAddress: true, createdAt: true, lastUsedAt: true, expiresAt: true, revokedAt: true, revokedReason: true },
    });
    return rows.map((r) => {
      const kind: ActorKind = r.subjectType === "CUSTOMER" ? "customer" : r.subjectType === "SYSADMIN" ? "sysadmin" : "user";
      const state = r.revokedAt ? `ended ${r.revokedAt.toISOString()}${r.revokedReason ? ` (${r.revokedReason})` : ""}` : r.expiresAt < new Date() ? "expired" : `active, last used ${r.lastUsedAt.toISOString()}`;
      return {
        pos: { at: r.createdAt.toISOString(), id: r.id },
        event: {
          key: `staff_session:${r.id}`, source: "staff_session", rowId: r.id, at: r.createdAt.toISOString(), severity: "info",
          action: "Session started", summary: `${r.role} on ${shortUa(r.userAgent) || "unknown device"}; ${state}`,
          actor: actorFor(ctx.book, kind, r.subjectId, r.role), ip: r.ipAddress,
        },
      };
    });
  },
  // Token hashes are never returned.
  detail: (id) =>
    prisma.userSession.findUnique({
      where: { id },
      select: { id: true, subjectId: true, subjectType: true, role: true, deviceId: true, userAgent: true, ipAddress: true, createdAt: true, lastUsedAt: true, rotatedAt: true, expiresAt: true, revokedAt: true, revokedReason: true },
    }) as Promise<Record<string, unknown> | null>,
};

function riderOnly(ctx: FetchContext): { ok: boolean; ids: number[] | null } {
  const a = ctx.filters.actor;
  if (a && a.kind !== "user") return { ok: false, ids: null };
  if (ctx.filters.ip) return { ok: false, ids: null };
  return { ok: true, ids: a ? [a.id] : null };
}

const riderSession: AuditSource = {
  key: "rider_session",
  async fetch(ctx) {
    const r0 = riderOnly(ctx);
    if (!r0.ok) return [];
    const q = ctx.filters.q?.trim();
    if (q && !ctx.matched?.user.length) return [];
    const rows = await prisma.riderLoginSession.findMany({
      where: { AND: [...timeWindow("loginAt", ctx, true), ...(q ? [{ riderId: { in: ctx.matched!.user } }] : []), ...(r0.ids ? [{ riderId: { in: r0.ids } }] : [])] } as Prisma.RiderLoginSessionWhereInput,
      orderBy: order("loginAt") as Prisma.RiderLoginSessionOrderByWithRelationInput[],
      take: ctx.take,
    });
    return rows.map((r) => ({
      pos: { at: r.loginAt.toISOString(), id: String(r.id) },
      event: {
        key: `rider_session:${r.id}`, source: "rider_session", rowId: String(r.id), at: r.loginAt.toISOString(), severity: "info",
        action: "Rider went on shift",
        summary: r.logoutAt ? `until ${r.logoutAt.toISOString()} (${minutes((r.durationSeconds ?? (r.logoutAt.getTime() - r.loginAt.getTime()) / 1000) * 1000)})` : "still on shift or ended without logging out",
        actor: actorFor(ctx.book, "user", r.riderId, "RIDER"), ip: null,
      },
    }));
  },
  detail: (id) => prisma.riderLoginSession.findUnique({ where: { id: Number(id) } }) as Promise<Record<string, unknown> | null>,
};

const riderConnectivity: AuditSource = {
  key: "rider_connectivity",
  async fetch(ctx) {
    const r0 = riderOnly(ctx);
    if (!r0.ok) return [];
    const q = ctx.filters.q?.trim();
    const rows = await prisma.connectivityIncident.findMany({
      where: {
        AND: [
          ...timeWindow("disconnectedAt", ctx, true),
          ...(q ? [{ OR: [{ riderId: { in: ctx.matched?.user ?? [] } }, { errand: { referenceNo: { contains: q } } }] }] : []),
          ...(r0.ids ? [{ riderId: { in: r0.ids } }] : []),
        ],
      } as Prisma.ConnectivityIncidentWhereInput,
      orderBy: order("disconnectedAt") as Prisma.ConnectivityIncidentOrderByWithRelationInput[],
      take: ctx.take,
      include: { errand: { select: { referenceNo: true } } },
    });
    return rows.map((r) => {
      const gap = r.reconnectedAt ? r.reconnectedAt.getTime() - r.disconnectedAt.getTime() : null;
      return {
        pos: { at: r.disconnectedAt.toISOString(), id: String(r.id) },
        event: {
          key: `rider_connectivity:${r.id}`, source: "rider_connectivity", rowId: String(r.id), at: r.disconnectedAt.toISOString(),
          severity: gap === null || gap > 10 * 60000 ? "notice" : "info", action: "Rider lost connection",
          summary: `${gap === null ? "no reconnection recorded" : `back after ${minutes(gap)}`}${r.errand?.referenceNo ? ` during errand ${r.errand.referenceNo}` : ""}`,
          actor: actorFor(ctx.book, "user", r.riderId, "RIDER"), ip: null,
        },
      };
    });
  },
  detail: (id) => prisma.connectivityIncident.findUnique({ where: { id: Number(id) } }) as Promise<Record<string, unknown> | null>,
};

const dispatch: AuditSource = {
  key: "dispatch",
  async fetch(ctx) {
    const r0 = riderOnly(ctx); // dispatchers are staff users too, and the table has no IP
    if (!r0.ok) return [];
    const q = ctx.filters.q?.trim();
    const rows = await prisma.dispatchLog.findMany({
      where: {
        AND: [
          ...timeWindow("dispatchedAt", ctx, true),
          ...(q ? [{ OR: [{ dispatcherId: { in: ctx.matched?.user ?? [] } }, { notes: { contains: q } }, { errand: { referenceNo: { contains: q } } }] }] : []),
          ...(r0.ids ? [{ dispatcherId: { in: r0.ids } }] : []),
        ],
      } as Prisma.DispatchLogWhereInput,
      orderBy: order("dispatchedAt") as Prisma.DispatchLogOrderByWithRelationInput[],
      take: ctx.take,
      include: { errand: { select: { referenceNo: true } } },
    });
    return rows.map((r) => ({
      pos: { at: r.dispatchedAt.toISOString(), id: String(r.id) },
      event: {
        key: `dispatch:${r.id}`, source: "dispatch", rowId: String(r.id), at: r.dispatchedAt.toISOString(), severity: "info",
        action: `Dispatched errand ${r.errand?.referenceNo ?? r.errandId.slice(0, 8)}`, summary: clip(r.notes) || (r.verifiedAt ? `verified ${r.verifiedAt.toISOString()}` : ""),
        actor: actorFor(ctx.book, "user", r.dispatcherId, "DISPATCHER"), ip: null,
      },
    }));
  },
  detail: (id) => prisma.dispatchLog.findUnique({ where: { id: Number(id) } }) as Promise<Record<string, unknown> | null>,
};

const reportPrint: AuditSource = {
  key: "report_print",
  async fetch(ctx) {
    const ip = ipClause(ctx, "ipAddress");
    if (ip === null) return [];
    const a = ctx.filters.actor;
    if (a && a.kind !== "user") return [];
    const actorOr = ctx.matched ? [{ userId: { in: ctx.matched.user } }] : [];
    const rows = await prisma.reportPrintLog.findMany({
      where: { AND: [...timeWindow("createdAt", ctx, true), ...textOr(ctx, ["printedByName", "reportType", "coverageLabel", "ipAddress"], actorOr), ...ip, ...(a ? [{ userId: a.id }] : [])] } as Prisma.ReportPrintLogWhereInput,
      orderBy: order("createdAt") as Prisma.ReportPrintLogOrderByWithRelationInput[],
      take: ctx.take,
    });
    return rows.map((r) => ({
      pos: { at: r.createdAt.toISOString(), id: String(r.id) },
      event: {
        key: `report_print:${r.id}`, source: "report_print", rowId: String(r.id), at: r.createdAt.toISOString(), severity: "info",
        action: `Printed ${r.reportType.replace(/_/g, " ").toLowerCase()} report`, summary: clip(r.coverageLabel),
        actor: r.userId ? actorFor(ctx.book, "user", r.userId, r.role) : { kind: "user", id: null, name: r.printedByName, role: r.role }, ip: r.ipAddress,
      },
    }));
  },
  detail: (id) => prisma.reportPrintLog.findUnique({ where: { id: Number(id) } }) as Promise<Record<string, unknown> | null>,
};

const ipBlock: AuditSource = {
  key: "ip_block",
  async fetch(ctx) {
    const ip = ipClause(ctx, "ipAddress");
    if (ip === null) return [];
    const a = ctx.filters.actor;
    if (a && a.kind !== "sysadmin") return [];
    const actorOr = ctx.matched ? [{ bannedById: { in: ctx.matched.sysadmin } }] : [];
    const rows = await prisma.blockedIp.findMany({
      where: { AND: [...timeWindow("createdAt", ctx, true), ...textOr(ctx, ["ipAddress", "reason"], actorOr), ...ip, ...(a ? [{ bannedById: a.id }] : [])] } as Prisma.BlockedIpWhereInput,
      orderBy: order("createdAt") as Prisma.BlockedIpOrderByWithRelationInput[],
      take: ctx.take,
      select: { id: true, ipAddress: true, reason: true, banType: true, severity: true, status: true, blockedUntil: true, attackCount: true, bannedById: true, createdAt: true },
    });
    return rows.map((r) => {
      const manual = r.banType !== "AUTOMATIC";
      return {
        pos: { at: r.createdAt.toISOString(), id: String(r.id) },
        event: {
          key: `ip_block:${r.id}`, source: "ip_block", rowId: String(r.id), at: r.createdAt.toISOString(),
          severity: manual ? "notice" : "warning", action: manual ? "IP banned by an IT admin" : "IP banned automatically",
          summary: `${clip(r.reason, 100)}; ${String(r.status).toLowerCase()}${r.blockedUntil ? ` until ${r.blockedUntil.toISOString()}` : ", permanent"}${r.attackCount > 1 ? `; ${r.attackCount} attempts` : ""}`,
          actor: r.bannedById ? actorFor(ctx.book, "sysadmin", r.bannedById) : actorFor(ctx.book, "system", null), ip: r.ipAddress,
        },
      };
    });
  },
  detail: (id) => prisma.blockedIp.findUnique({ where: { id: Number(id) } }) as Promise<Record<string, unknown> | null>,
};

const ALERT_SEVERITY: Record<string, AuditSeverity> = { LOW: "info", MEDIUM: "notice", HIGH: "warning", CRITICAL: "critical" };

const itAlert: AuditSource = {
  key: "it_alert",
  async fetch(ctx) {
    if (ctx.filters.ip || ctx.filters.actor) return [];
    const q = ctx.filters.q?.trim();
    const rows = await prisma.sysAdminAlert.findMany({
      where: { AND: [...timeWindow("createdAt", ctx, true), ...(q ? [{ OR: [{ title: { contains: q } }, { message: { contains: q } }, { alertType: { contains: q } }] }] : [])] } as Prisma.SysAdminAlertWhereInput,
      orderBy: order("createdAt") as Prisma.SysAdminAlertOrderByWithRelationInput[],
      take: ctx.take,
      select: { id: true, alertType: true, severity: true, title: true, message: true, status: true, createdAt: true },
    });
    return rows.map((r) => ({
      pos: { at: r.createdAt.toISOString(), id: String(r.id) },
      event: {
        key: `it_alert:${r.id}`, source: "it_alert", rowId: String(r.id), at: r.createdAt.toISOString(),
        severity: ALERT_SEVERITY[r.severity] ?? "notice", action: clip(r.title, 90), summary: `${clip(r.message.replace(/\s+/g, " "), 120)} [${r.status.toLowerCase()}]`,
        actor: actorFor(ctx.book, "system", null), ip: null,
      },
    }));
  },
  detail: (id) => prisma.sysAdminAlert.findUnique({ where: { id: Number(id) } }) as Promise<Record<string, unknown> | null>,
};

const pma: AuditSource = {
  key: "pma",
  async fetch(ctx) {
    if (ctx.filters.ip) return [];
    const a = ctx.filters.actor;
    if (a && a.kind === "customer") return [];
    const m = ctx.matched;
    const actorOr = m ? [{ actorRole: "SYSADMIN", actorId: { in: m.sysadmin } }, { actorRole: { not: "SYSADMIN" }, actorId: { in: m.user } }] : [];
    const actor = a ? [a.kind === "sysadmin" ? { actorRole: "SYSADMIN", actorId: a.id } : { actorRole: { not: "SYSADMIN" }, actorId: a.id }] : [];
    const rows = await prisma.sysAdminPmaAuditLog.findMany({
      where: { AND: [...timeWindow("createdAt", ctx, true), ...textOr(ctx, ["action", "targetUsername", "groupName", "actorUsername", "fieldModified"], actorOr), ...actor] } as Prisma.SysAdminPmaAuditLogWhereInput,
      orderBy: order("createdAt") as Prisma.SysAdminPmaAuditLogOrderByWithRelationInput[],
      take: ctx.take,
    });
    return rows.map((r) => ({
      pos: { at: r.createdAt.toISOString(), id: String(r.id) },
      event: {
        key: `pma:${r.id}`, source: "pma", rowId: String(r.id), at: r.createdAt.toISOString(), severity: "warning",
        action: `${r.action.replace(/_/g, " ").toLowerCase()}${r.targetUsername ? ` for ${r.targetUsername}` : ""}${r.groupName ? ` (group ${r.groupName})` : ""}`,
        summary: `${r.fieldModified}: ${clip(r.oldValue, 50) || "(none)"} → ${clip(r.newValue, 50) || "(none)"}`,
        actor: actorFor(ctx.book, r.actorRole === "SYSADMIN" ? "sysadmin" : "user", r.actorId, r.actorRole), ip: null,
      },
    }));
  },
  detail: (id) => prisma.sysAdminPmaAuditLog.findUnique({ where: { id: Number(id) } }) as Promise<Record<string, unknown> | null>,
};

export const DEFAULT_SOURCES: Record<AuditSourceKey, AuditSource> = {
  signin, account_change: accountChange, password_reset: passwordReset, staff_session: staffSession, rider_session: riderSession,
  rider_connectivity: riderConnectivity, dispatch, report_print: reportPrint, ip_block: ipBlock, it_alert: itAlert, pma,
};

/* ------------------------------------------------------------------ */
/* Cursor and merge                                                    */
/* ------------------------------------------------------------------ */

export type Cursor = Partial<Record<AuditSourceKey, Position | null>>;

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

export function decodeCursor(raw: string | undefined | null): Cursor {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    const out: Cursor = {};
    for (const k of AUDIT_SOURCES) {
      const v = parsed[k];
      if (v === null) out[k] = null;
      else if (v && typeof v.at === "string" && typeof v.id === "string" && !Number.isNaN(Date.parse(v.at))) out[k] = { at: v.at, id: v.id };
    }
    return out;
  } catch {
    throw new ServiceError(400, "That page link is no longer valid. Start from the newest entries.");
  }
}

/** Newer first; at equal time, the larger id first (ids compare numerically when both are numbers). */
export function newer(a: Position, b: Position): boolean {
  if (a.at !== b.at) return a.at > b.at;
  const na = Number(a.id), nb = Number(b.id);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na > nb;
  return a.id > b.id;
}

export interface TimelinePage {
  events: AuditEvent[];
  nextCursor: string | null;
}

export interface TimelineDeps {
  sources?: Partial<Record<AuditSourceKey, AuditSource>>;
  loadNames?: () => Promise<NameBook>;
}

export function createAuditTimeline(deps: TimelineDeps = {}) {
  const sources = { ...DEFAULT_SOURCES, ...deps.sources };
  const loadNames = deps.loadNames ?? loadNameBook;

  async function page(filters: TimelineFilters, cursorRaw: string | null | undefined, limit: number, book?: NameBook): Promise<TimelinePage> {
    const take = Math.min(Math.max(1, Math.floor(limit) || 50), PAGE_MAX);
    const cursor = decodeCursor(cursorRaw);
    const names = book ?? (await loadNames());
    const matched = filters.q?.trim() ? matchActors(names, filters.q.trim()) : null;
    const minRank = SEVERITY_RANK[filters.minSeverity ?? "info"];
    const keys = (filters.sources?.length ? filters.sources : [...AUDIT_SOURCES]).filter((k) => cursor[k] !== null);

    const state = new Map<AuditSourceKey, { buf: FetchedRow[]; last: Position | null; exhausted: boolean }>();
    const fill = async (k: AuditSourceKey) => {
      const s = state.get(k)!;
      const rows = await sources[k].fetch({ filters, before: s.last, take, book: names, matched });
      s.buf = rows;
      s.exhausted = rows.length < take;
    };
    for (const k of keys) state.set(k, { buf: [], last: cursor[k] ?? null, exhausted: false });
    await Promise.all(keys.map(fill));

    const out: AuditEvent[] = [];
    let rounds = 0;
    while (out.length < take) {
      let best: AuditSourceKey | null = null;
      for (const [k, s] of state) if (s.buf.length && (!best || newer(s.buf[0].pos, state.get(best)!.buf[0].pos))) best = k;
      if (!best) break;
      const s = state.get(best)!;
      const row = s.buf.shift()!;
      s.last = row.pos;
      if (SEVERITY_RANK[row.event.severity] >= minRank) out.push(row.event);
      if (!s.buf.length && !s.exhausted) {
        if (++rounds > MAX_FETCH_ROUNDS) break;
        await fill(best);
      }
    }

    const next: Cursor = {};
    let more = false;
    for (const [k, s] of state) {
      const done = s.exhausted && s.buf.length === 0;
      // null = fully read; absent = not started yet (must not be confused, or an unread source vanishes).
      if (done) next[k] = null;
      else {
        if (s.last) next[k] = s.last;
        more = true;
      }
    }
    for (const k of AUDIT_SOURCES) if (cursor[k] === null) next[k] = null;
    return { events: out, nextCursor: more ? encodeCursor(next) : null };
  }

  return { page, sources };
}

export const auditTimeline = createAuditTimeline();

/* ------------------------------------------------------------------ */
/* Detail, insights, export                                            */
/* ------------------------------------------------------------------ */

export function stripSensitive(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (SENSITIVE_FIELD.test(k)) continue;
    out[k] = v instanceof Date ? v.toISOString() : typeof v === "bigint" ? v.toString() : v;
  }
  return out;
}

export async function getAuditEvent(source: AuditSourceKey, rowId: string) {
  const src = DEFAULT_SOURCES[source];
  const raw = await src.detail(rowId).catch(() => null);
  if (!raw) throw new ServiceError(404, "That log entry no longer exists.");
  const book = await loadNameBook();

  // The event as the timeline shows it: read it back through the source at its own position.
  const at = (raw.loginAt ?? raw.disconnectedAt ?? raw.dispatchedAt ?? raw.createdAt) as Date;
  const sameMoment = await src.fetch({ filters: { from: at, to: at }, before: null, take: 50, book, matched: null });
  const event = sameMoment.find((r) => r.event.rowId === String(raw.id))?.event ?? null;

  // Everything the same person, or the same IP, did within an hour either side.
  const from = new Date(at.getTime() - 3600_000), to = new Date(at.getTime() + 3600_000);
  const related: AuditEvent[] = [];
  if (event?.actor && event.actor.kind !== "system" && event.actor.id !== null) {
    const p = await auditTimeline.page({ actor: { kind: event.actor.kind, id: event.actor.id }, from, to }, null, 40, book);
    related.push(...p.events);
  }
  if (event?.ip) {
    const p = await auditTimeline.page({ ip: event.ip, from, to }, null, 40, book);
    for (const e of p.events) if (!related.some((r) => r.key === e.key)) related.push(e);
  }
  related.sort((a, b) => (a.at < b.at ? 1 : -1));
  return { event, raw: stripSensitive(raw), related: related.filter((e) => e.key !== event?.key).slice(0, 40) };
}

export async function getAuditInsights(now: Date = new Date()) {
  const since = new Date(now.getTime() - 24 * 3600_000);
  const failedWhere = { createdAt: { gte: since }, OR: [{ status: { startsWith: "FAILED" } }, { status: "LOCKED" }] };
  const [failedSignins, resetRejected, newBans, activeBans, newDevices, failingIps, staffSessions] = await Promise.all([
    prisma.accountLoginLog.count({ where: failedWhere }),
    prisma.passwordResetAttempt.count({ where: { createdAt: { gte: since }, outcome: { in: ["CODE_REJECTED", "THROTTLED", "UNKNOWN_ACCOUNT"] } } }),
    prisma.blockedIp.count({ where: { createdAt: { gte: since } } }),
    prisma.blockedIp.count({ where: { status: "ACTIVE" } }),
    prisma.userKnownDevice.count({ where: { firstSeenAt: { gte: since } } }),
    prisma.accountLoginLog.groupBy({ by: ["ipAddress"], where: failedWhere, _count: { _all: true }, orderBy: { _count: { ipAddress: "desc" } }, take: 5 }),
    prisma.userSession.count({ where: { createdAt: { gte: since } } }),
  ]);
  return {
    since: since.toISOString(),
    failedSignins,
    resetRejected,
    newBans,
    activeBans,
    newDevices,
    newSessions: staffSessions,
    topFailingIps: failingIps.map((r) => ({ ip: r.ipAddress, count: r._count._all })),
  };
}

/** A cell a spreadsheet will not run as a formula. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CSV_HEADER = ["time_utc", "source", "severity", "action", "person", "role", "ip", "details", "entry"];

export function eventCsvRow(e: AuditEvent): string {
  return [e.at, SOURCE_LABELS[e.source], e.severity, e.action, e.actor?.name ?? "", e.actor?.role ?? "", e.ip ?? "", e.summary, e.key].map(csvCell).join(",");
}

export async function exportAuditCsv(filters: TimelineFilters, exportedBy: string, timeline = auditTimeline) {
  const book = await loadNameBook();
  const lines = [CSV_HEADER.join(",")];
  let cursor: string | null = null;
  let truncated = false;
  do {
    const p = await timeline.page(filters, cursor, PAGE_MAX, book);
    for (const e of p.events) lines.push(eventCsvRow(e));
    cursor = p.nextCursor;
    if (lines.length - 1 >= EXPORT_MAX_ROWS) {
      truncated = cursor !== null;
      break;
    }
  } while (cursor);
  const rows = lines.length - 1;
  // The export is itself audited: who took which slice of the logs, and how much.
  await prisma.sysAdminAlert
    .create({
      data: {
        alertType: "AUDIT_EXPORT",
        severity: "LOW",
        title: `Audit log exported by ${exportedBy}`,
        message: `${rows} entries${truncated ? ` (stopped at the ${EXPORT_MAX_ROWS}-row limit)` : ""}. Filters: ${JSON.stringify({ ...filters, from: filters.from?.toISOString(), to: filters.to?.toISOString() })}`,
        channel: "AUDIT",
        status: "RECORDED",
        metadata: { exportedBy, rows, truncated },
      },
    })
    .catch(() => undefined);
  return { csv: `﻿${lines.join("\r\n")}\r\n`, rows, truncated };
}
