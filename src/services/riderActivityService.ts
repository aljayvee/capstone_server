/**
 * riderActivityService.ts
 *
 * Turns rider_status_logs (one ONLINE/OFFLINE sample per rider every 2 minutes,
 * written by jobs/riderStatusSnapshot.ts and, until now, read by nothing) into a
 * readable day per rider: online and offline periods, gaps where nothing was
 * recorded (the API was down or restarting), login sessions and connection drops.
 */

import { prisma } from "../lib/prisma.js";
import { ServiceError } from "./ServiceError.js";

export const SAMPLE_MS = 2 * 60_000;
/** Two samples further apart than this mean nothing was recorded in between. */
export const MAX_GAP_MS = 5 * 60_000;
const MANILA_OFFSET_MS = 8 * 3600_000;

export type PeriodStatus = "ONLINE" | "OFFLINE" | "NO_DATA";

export interface Period {
  status: PeriodStatus;
  start: string;
  end: string;
  minutes: number;
}

export interface Sample {
  status: "ONLINE" | "OFFLINE";
  at: Date;
}

/** Merges consecutive samples into periods. Each sample covers the 2 minutes after it. Pure. */
export function buildPeriods(samples: Sample[], dayStart: Date, dayEnd: Date, now: Date = new Date()): Period[] {
  if (samples.length === 0) return [];
  const sorted = [...samples].sort((a, b) => a.at.getTime() - b.at.getTime());
  const limit = Math.min(dayEnd.getTime(), now.getTime());
  const periods: Period[] = [];
  const push = (status: PeriodStatus, start: number, end: number) => {
    if (end <= start) return;
    const last = periods[periods.length - 1];
    if (last && last.status === status && Date.parse(last.end) === start) {
      last.end = new Date(end).toISOString();
      last.minutes = Math.round((end - Date.parse(last.start)) / 60_000);
      return;
    }
    periods.push({ status, start: new Date(start).toISOString(), end: new Date(end).toISOString(), minutes: Math.round((end - start) / 60_000) });
  };

  let cursor = dayStart.getTime();
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i].at.getTime();
    if (t < dayStart.getTime() || t >= limit) continue;
    if (t - cursor > MAX_GAP_MS) push("NO_DATA", cursor, t);
    else if (t > cursor && periods.length) push(periods[periods.length - 1].status, cursor, t);
    const next = sorted[i + 1]?.at.getTime();
    const end = Math.min(limit, next !== undefined && next - t <= MAX_GAP_MS ? next : t + SAMPLE_MS);
    push(sorted[i].status, t, end);
    cursor = end;
  }
  if (limit - cursor > MAX_GAP_MS) push("NO_DATA", cursor, limit);
  return periods;
}

/** The Manila calendar day `YYYY-MM-DD` as a UTC window. */
export function manilaDay(date: string): { start: Date; end: Date } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ServiceError(400, "Use a date like 2026-11-15.");
  const start = new Date(Date.parse(`${date}T00:00:00Z`) - MANILA_OFFSET_MS);
  if (Number.isNaN(start.getTime())) throw new ServiceError(400, "That is not a real date.");
  return { start, end: new Date(start.getTime() + 24 * 3600_000) };
}

export function todayInManila(now: Date = new Date()): string {
  return new Date(now.getTime() + MANILA_OFFSET_MS).toISOString().slice(0, 10);
}

export async function getRiderActivity(date: string, now: Date = new Date()) {
  const { start, end } = manilaDay(date);
  if (start.getTime() > now.getTime()) throw new ServiceError(400, "That day has not started yet.");

  const [riders, samples, sessions, drops] = await Promise.all([
    prisma.user.findMany({ where: { role: "RIDER" }, select: { id: true, username: true, firstName: true, lastName: true, status: true }, orderBy: { firstName: "asc" } }),
    prisma.riderStatusLog.findMany({ where: { recordedAt: { gte: start, lt: end } }, select: { riderId: true, status: true, recordedAt: true }, orderBy: { recordedAt: "asc" } }),
    prisma.riderLoginSession.findMany({
      where: { loginAt: { lt: end }, OR: [{ logoutAt: null }, { logoutAt: { gte: start } }] },
      select: { id: true, riderId: true, loginAt: true, logoutAt: true },
      orderBy: { loginAt: "asc" },
    }),
    prisma.connectivityIncident.findMany({
      where: { disconnectedAt: { gte: start, lt: end } },
      select: { id: true, riderId: true, disconnectedAt: true, reconnectedAt: true, errand: { select: { referenceNo: true } } },
      orderBy: { disconnectedAt: "asc" },
    }),
  ]);

  const byRider = new Map<number, Sample[]>();
  for (const s of samples) {
    const list = byRider.get(s.riderId) ?? [];
    list.push({ status: s.status, at: s.recordedAt });
    byRider.set(s.riderId, list);
  }

  const rows = riders.map((r) => {
    const own = byRider.get(r.id) ?? [];
    const periods = own.length ? buildPeriods(own, start, end, now) : [];
    const sum = (st: PeriodStatus) => periods.filter((p) => p.status === st).reduce((a, p) => a + p.minutes, 0);
    return {
      riderId: r.id,
      name: `${r.firstName} ${r.lastName}`.trim(),
      username: r.username,
      accountStatus: r.status,
      onlineMinutes: sum("ONLINE"),
      offlineMinutes: sum("OFFLINE"),
      noDataMinutes: sum("NO_DATA"),
      samples: own.length,
      periods,
      sessions: sessions.filter((s) => s.riderId === r.id).map((s) => ({ id: s.id, loginAt: s.loginAt.toISOString(), logoutAt: s.logoutAt?.toISOString() ?? null })),
      connectionDrops: drops
        .filter((d) => d.riderId === r.id)
        .map((d) => ({ id: d.id, disconnectedAt: d.disconnectedAt.toISOString(), reconnectedAt: d.reconnectedAt?.toISOString() ?? null, errandRef: d.errand?.referenceNo ?? null })),
    };
  });

  // Riders who did anything that day first, most online time first.
  rows.sort((a, b) => b.onlineMinutes - a.onlineMinutes || b.samples - a.samples || a.name.localeCompare(b.name));
  return { date, dayStart: start.toISOString(), dayEnd: end.toISOString(), sampleMinutes: SAMPLE_MS / 60_000, riders: rows };
}
