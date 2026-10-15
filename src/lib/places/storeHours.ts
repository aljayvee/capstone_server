/**
 * A Location Store's weekly opening hours, set by the owner (2026-10-13).
 *
 * Stored as `verified_places.openingHours`: one entry per day of the week,
 * day 0 = Sunday as Google numbers them, times in Philippine time as the shop
 * door shows them ("07:00" to "21:00"). A closing time at or before the opening
 * time runs past midnight; "00:00" to "24:00" is open all day.
 *
 * The owner's hours beat every estimate (establishmentService
 * evaluateStoreOperatingStatus): they are what the shop actually keeps.
 */

export interface DayHours {
  /** 0 Sunday ... 6 Saturday. */
  day: number;
  /** Closed all day. `open` and `close` are then ignored. */
  closed: boolean;
  /** "HH:MM", 24-hour. */
  open: string;
  /** "HH:MM", 24-hour, or "24:00" for midnight at the end of the day. */
  close: string;
}

export interface WeeklyHours {
  days: DayHours[];
}

export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export const OPEN_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
export const CLOSE_TIME = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;

const PH_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MINUTES = 24 * 60;

function minutesOf(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

/** Philippine day of the week (0 Sunday) and minute of the day for `now`. */
function philippineClock(now: Date): { day: number; minute: number } {
  const ph = new Date(now.getTime() + PH_OFFSET_MS);
  return { day: ph.getUTCDay(), minute: ph.getUTCHours() * 60 + ph.getUTCMinutes() };
}

/**
 * The stored value read back safely: a well-formed week, or null for anything
 * else (nothing set, or a row written by hand). Days missing from the list
 * count as closed.
 */
export function parseWeeklyHours(raw: unknown): WeeklyHours | null {
  const list = (raw as { days?: unknown } | null)?.days;
  if (!Array.isArray(list)) return null;
  const days: DayHours[] = [];
  for (const entry of list) {
    const day = Number((entry as DayHours)?.day);
    if (!Number.isInteger(day) || day < 0 || day > 6 || days.some((d) => d.day === day)) continue;
    const closed = (entry as DayHours).closed === true;
    const open = String((entry as DayHours).open ?? "");
    const close = String((entry as DayHours).close ?? "");
    if (!closed && (!OPEN_TIME.test(open) || !CLOSE_TIME.test(close))) continue;
    days.push({ day, closed, open: closed ? "" : open, close: closed ? "" : close });
  }
  if (days.length === 0) return null;
  return { days: days.sort((a, b) => a.day - b.day) };
}

/** The window of `day`, in minutes from that day's midnight; the end may pass 1440 (after midnight). */
function windowOf(hours: WeeklyHours, day: number): { start: number; end: number } | null {
  const entry = hours.days.find((d) => d.day === day);
  if (!entry || entry.closed) return null;
  const start = minutesOf(entry.open);
  let end = minutesOf(entry.close);
  if (end <= start) end += DAY_MINUTES; // closes after midnight
  return { start, end };
}

/** Open at `now` by the owner's hours. */
export function isOpenByHours(hours: WeeklyHours, now: Date): boolean {
  const { day, minute } = philippineClock(now);
  const today = windowOf(hours, day);
  if (today && minute >= today.start && minute < today.end) return true;
  // Yesterday's hours can run past midnight into this morning.
  const yesterday = windowOf(hours, (day + 6) % 7);
  return Boolean(yesterday && yesterday.end > DAY_MINUTES && minute < yesterday.end - DAY_MINUTES);
}

function time12(minute: number): string {
  const m = ((minute % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  const h24 = Math.floor(m / 60);
  const mins = m % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(mins).padStart(2, "0")} ${h24 >= 12 ? "PM" : "AM"}`;
}

/**
 * When a closed store opens next, as the customer reads it: "Opens at 7:00 AM"
 * later today, "Opens tomorrow at 7:00 AM", or "Opens Monday at 7:00 AM".
 * "Temporarily Unavailable" when no day of the week is open.
 */
export function nextOpeningNotice(hours: WeeklyHours, now: Date): string {
  const { day, minute } = philippineClock(now);
  for (let ahead = 0; ahead < 7; ahead++) {
    const window = windowOf(hours, (day + ahead) % 7);
    if (!window || (ahead === 0 && window.start <= minute)) continue;
    const at = time12(window.start);
    if (ahead === 0) return `Opens at ${at}`;
    if (ahead === 1) return `Opens tomorrow at ${at}`;
    return `Opens ${DAY_NAMES[(day + ahead) % 7]} at ${at}`;
  }
  return "Temporarily Unavailable";
}

/**
 * Google's `regularOpeningHours.periods` as a week of owner hours, to prefill
 * the form. Several windows in one day (a lunch break) become one, first
 * opening to last closing. A period with no close is open all the time.
 */
export function weeklyHoursFromGoogle(periods: unknown): WeeklyHours | null {
  if (!Array.isArray(periods) || periods.length === 0) return null;
  const pad = (n: unknown) => String(Number(n) || 0).padStart(2, "0");
  const timeOf = (point: any) => `${pad(point?.hour)}:${pad(point?.minute)}`;
  const first = periods[0] as any;
  if (periods.length === 1 && first?.open && !first?.close) {
    return { days: DAY_NAMES.map((_, day) => ({ day, closed: false, open: "00:00", close: "24:00" })) };
  }
  const byDay = new Map<number, { open: number; close: number }>();
  for (const period of periods as any[]) {
    const day = Number(period?.open?.day);
    if (!Number.isInteger(day) || day < 0 || day > 6 || !period?.close) continue;
    const open = minutesOf(timeOf(period.open));
    let close = minutesOf(timeOf(period.close));
    if (Number(period.close.day) !== day || close <= open) close += DAY_MINUTES;
    const known = byDay.get(day);
    byDay.set(day, known ? { open: Math.min(known.open, open), close: Math.max(known.close, close) } : { open, close });
  }
  if (byDay.size === 0) return null;
  const hhmm = (minute: number) => `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`;
  return {
    days: DAY_NAMES.map((_, day) => {
      const window = byDay.get(day);
      if (!window) return { day, closed: true, open: "", close: "" };
      const allDay = window.close - window.open >= DAY_MINUTES;
      // A close at or before the open reads as after midnight (windowOf), so a
      // full day from 08:00 is "08:00" to "08:00", and from midnight "00:00" to "24:00".
      const close = allDay ? (window.open === 0 ? "24:00" : hhmm(window.open)) : hhmm(window.close % DAY_MINUTES);
      return { day, closed: false, open: hhmm(window.open), close };
    }),
  };
}
