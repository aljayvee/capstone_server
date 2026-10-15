import fs from "node:fs";
import path from "node:path";
import { logger } from "../logger.js";

/**
 * A hard ceiling on Google Places spending: never past the free tier (2026-10-13).
 *
 * Places API (New) bills each kind of request (a "SKU") separately, and each
 * SKU has a free monthly allowance. Past it every request is paid, which in
 * the first half of October 2026 came to USD 23.88. This counts every request
 * the server sends, per SKU and calendar month, and refuses one that would go
 * past the free allowance. A refused request answers as if Google were down,
 * so every list falls back the way it already does when Google cannot answer:
 * the owner's Location Stores, a category picture instead of a photo.
 *
 * The allowance builds up through the month (a thirtieth or so each day, and
 * what one day leaves unused carries over), so a busy day of testing on the
 * 3rd cannot leave the app without Google for the rest of the month.
 *
 * The counts survive restarts in a small JSON file. Google bills by its own
 * clock (Pacific time), so the month turns over by that clock. The free
 * allowance is shared by everything using the same billing account, which is
 * why the ceiling sits a tenth below it.
 */

export type PlacesSku =
  | "nearbyPro"
  | "nearbyEnterprise"
  | "textPro"
  | "textEnterprise"
  | "photo"
  | "detailsPro"
  | "detailsEnterprise";

/**
 * Google's free requests per month for each SKU (since March 2025): Pro 5,000,
 * Enterprise 1,000, and photos (Place Details Photos) 1,000. One place's
 * details (the owner registering a Location Store) bill the same two tiers.
 * Pro: name, position, address, types, status, photo names.
 * Enterprise: any of those plus opening hours or ratings.
 */
export const FREE_MONTHLY_REQUESTS: Record<PlacesSku, number> = {
  nearbyPro: 5000,
  nearbyEnterprise: 1000,
  textPro: 5000,
  textEnterprise: 1000,
  photo: 1000,
  detailsPro: 5000,
  detailsEnterprise: 1000,
};

/** The share of the free allowance this server may use: room for the dispatcher and for counting slips. */
export const BUDGET_SHARE = 0.9;

const SKUS = Object.keys(FREE_MONTHLY_REQUESTS) as PlacesSku[];

interface Usage {
  month: string;
  used: Record<PlacesSku, number>;
}

let file: string | null = process.env.VITEST ? null : path.resolve(process.cwd(), "var", "places-usage.json");
let enabled = !process.env.VITEST;
let usage: Usage | null = null;
const warned = new Set<string>();

/** The billing month by Google's clock, "2026-10". */
export function billingMonth(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}`;
}

function dayOfBillingMonth(now: Date): { day: number; days: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(now);
  const num = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const year = num("year");
  const month = num("month");
  return { day: num("day"), days: new Date(Date.UTC(year, month, 0)).getUTCDate() };
}

/** Requests of `sku` allowed so far this month: the month's share, built up day by day. */
export function allowanceSoFar(sku: PlacesSku, now: Date = new Date()): number {
  const { day, days } = dayOfBillingMonth(now);
  return Math.floor((FREE_MONTHLY_REQUESTS[sku] * BUDGET_SHARE * day) / days);
}

function emptyUsage(month: string): Usage {
  return { month, used: Object.fromEntries(SKUS.map((sku) => [sku, 0])) as Record<PlacesSku, number> };
}

function current(now: Date): Usage {
  const month = billingMonth(now);
  if (!usage) usage = read(month);
  if (usage.month !== month) {
    usage = emptyUsage(month);
    warned.clear();
    save();
  }
  return usage;
}

function read(month: string): Usage {
  if (!file) return emptyUsage(month);
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (raw?.month !== month) return emptyUsage(month);
    const fresh = emptyUsage(month);
    for (const sku of SKUS) {
      const n = Number(raw.used?.[sku]);
      if (Number.isFinite(n) && n > 0) fresh.used[sku] = Math.floor(n);
    }
    return fresh;
  } catch {
    return emptyUsage(month);
  }
}

function save(): void {
  if (!file || !usage) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(usage, null, 2));
    fs.renameSync(temp, file);
  } catch (error) {
    if (!warned.has("save")) {
      warned.add("save");
      logger.warn(`Places budget could not be saved: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** True while `sku` has free requests left so far this month. Spends nothing. */
export function hasPlacesAllowance(sku: PlacesSku, now: Date = new Date()): boolean {
  if (!enabled) return true;
  return current(now).used[sku] < allowanceSoFar(sku, now);
}

/**
 * Spends one request of `sku`, or refuses (false) when that would go past the
 * free allowance so far. Call it just before sending the request.
 */
export function spendPlacesRequest(sku: PlacesSku, now: Date = new Date()): boolean {
  if (!enabled) return true;
  const state = current(now);
  if (state.used[sku] >= allowanceSoFar(sku, now)) {
    if (!warned.has(sku)) {
      warned.add(sku);
      logger.warn(
        `Google Places ${sku} paused: ${state.used[sku]} of this month's free requests used. ` +
          `Lists fall back to Location Stores until more of the free allowance builds up.`
      );
    }
    return false;
  }
  state.used[sku] += 1;
  save();
  return true;
}

/** This month's requests per SKU, with what is allowed so far and the month's free total. */
export function placesUsage(now: Date = new Date()) {
  const state = current(now);
  return {
    month: state.month,
    skus: SKUS.map((sku) => ({
      sku,
      used: state.used[sku],
      allowedSoFar: allowanceSoFar(sku, now),
      freePerMonth: FREE_MONTHLY_REQUESTS[sku],
    })),
  };
}

/** Tests only: turn the ceiling on or off, keep the counts in `file` (null: memory only), start from zero. */
export function configurePlacesBudget(options: { enabled: boolean; file?: string | null }): void {
  enabled = options.enabled;
  file = options.file ?? null;
  usage = null;
  warned.clear();
}
