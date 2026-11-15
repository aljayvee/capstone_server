/**
 * integrationCheckService.ts
 *
 * One answer per outside service the API depends on: is it configured, and
 * does it answer right now. Shown on the SysAdmin DevOps "Integrations" tab so
 * an IT admin can tell "our code is broken" from "a provider or a key is".
 *
 * Rules for a probe:
 * - Free and side-effect-free. Services billed per call (Google Places, Google
 *   Routes, Google Vision) are never called from here; they are judged from
 *   their real recent calls (circuit breakers, the Places budget) and say so.
 * - Bounded: every probe races PROBE_TIMEOUT_MS, so one hung provider cannot
 *   hold the page.
 * - Never leaks: any text that leaves this file has every configured secret
 *   replaced, because provider errors sometimes echo the URL they were given.
 */

import { checkReadiness } from "../lib/readiness.js";
import { checkFirebaseHeartbeat, checkFirebaseRules } from "../lib/firebaseHealth.js";
import { verifyEmailTransport } from "../lib/mailer.js";
import { routingProviderHealth } from "../lib/routing/resilientRoutingService.js";
import { ocrEngineHealth } from "../lib/ocr/resilientOcrService.js";
import { placesUsage } from "../lib/places/placesBudget.js";
import { CATEGORY_SERVICE_URL, GOOGLE_PLACES_API_KEY, OSRM_BASE_URL } from "../config/env.js";
import { FRESHNESS_HOURS, offsiteBackupService } from "./offsiteBackupService.js";
import { resolveGeminiApiKey } from "./ownerCopilotService.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";

export const PROBE_TIMEOUT_MS = 8000;
const HTTP_TIMEOUT_MS = 5000;
/** Repeated clicks within this window get the same answer instead of new calls to every provider. */
export const REPORT_CACHE_MS = 20 * 1000;
/** Tacurong city hall: any point the local OSRM map covers would do. */
const OSRM_PROBE_POINT = "124.6764,6.6925";
/** The model the owner assistant calls (ownerCopilotService). A models.get is free. */
const GEMINI_MODEL = "gemini-3.8-flash";

const SECRET_ENV_NAMES = [
  "TELEGRAM_BOT_TOKEN",
  "SMTP_PASS",
  "GEMINI_API_KEY",
  "GEMMA_API_KEY",
  "GOOGLE_MAPS_API_KEY",
  "GOOGLE_PLACES_API_KEY",
  "GOOGLE_VISION_API_KEY",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "JWT_SECRET",
  "JWT_REFRESH_SECRET",
  "DATABASE_URL",
];

/**
 * ok: answers. warn: works, but something needs fixing. down: not working.
 * off: deliberately not set up here. unchecked: configured, but only judged
 * from recent real use (billed per call).
 */
export type IntegrationStatus = "ok" | "warn" | "down" | "off" | "unchecked";

export type IntegrationKey =
  | "database"
  | "firebase"
  | "telegram"
  | "email"
  | "offsite"
  | "routing"
  | "category"
  | "places"
  | "vision"
  | "gemini";

export interface ProbeOutcome {
  status: IntegrationStatus;
  summary: string;
}

export interface IntegrationResult extends ProbeOutcome {
  key: IntegrationKey;
  label: string;
  purpose: string;
  group: "core" | "features";
  latencyMs: number;
}

export interface IntegrationReport {
  checkedAt: string;
  durationMs: number;
  overall: "ok" | "warn" | "down";
  results: IntegrationResult[];
}

type Probe = () => Promise<ProbeOutcome>;

interface Definition {
  key: IntegrationKey;
  label: string;
  purpose: string;
  group: "core" | "features";
}

export const INTEGRATIONS: Definition[] = [
  { key: "database", group: "core", label: "Database", purpose: "Every errand, account and payment." },
  { key: "firebase", group: "core", label: "Live tracking and chat", purpose: "Rider positions and both chat channels (Firebase Realtime Database)." },
  { key: "telegram", group: "core", label: "Telegram alerts", purpose: "Tells the IT admin about outages, intrusions and failed backups." },
  { key: "email", group: "core", label: "Email", purpose: "Staff sign-in codes, verification and password resets." },
  { key: "offsite", group: "core", label: "Off-site backups", purpose: "Encrypted nightly copy of the database in Cloudflare R2." },
  { key: "routing", group: "features", label: "Routes and fares", purpose: "Road distance for fares, ETAs and the route line." },
  { key: "category", group: "features", label: "Store category guesser", purpose: "Suggests what kind of shop a store or item belongs to." },
  { key: "places", group: "features", label: "Google Places", purpose: "Store search when a customer picks a shop." },
  { key: "vision", group: "features", label: "Receipt reading", purpose: "Reads receipt and transfer photos (Google Vision)." },
  { key: "gemini", group: "features", label: "Owner assistant AI", purpose: "Answers the owner's questions in the Owner portal (Gemini)." },
];

export class ProbeTimeoutError extends Error {}

export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const name of SECRET_ENV_NAMES) {
    const value = env[name]?.trim();
    if (value && value.length >= 6) out = out.split(value).join("[hidden]");
  }
  return out.length > 300 ? `${out.slice(0, 297)}...` : out;
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    const causeText = cause instanceof Error && cause.message && cause.message !== err.message ? ` (${cause.message})` : "";
    return `${err.message}${causeText}`;
  }
  return String(err);
}

export function ago(fromMs: number, nowMs: number): string {
  const minutes = Math.max(0, Math.floor((nowMs - fromMs) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

async function getJson(url: string, init: RequestInit = {}, timeoutMs = HTTP_TIMEOUT_MS): Promise<{ status: number; body: any }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

// --- Default probes (production). Each is replaceable in tests. ---------------

async function probeDatabase(): Promise<ProbeOutcome> {
  const result = await checkReadiness();
  const db = result.checks.database;
  if (db.ok) return { status: "ok", summary: `Answers in ${db.latencyMs} ms.` };
  return { status: "down", summary: db.error === "timeout" ? "No answer within 2 seconds." : "Cannot be reached." };
}

async function probeFirebase(): Promise<ProbeOutcome> {
  const [beat, rules] = await Promise.all([checkFirebaseHeartbeat(), checkFirebaseRules()]);
  if (beat.status === "not_configured") {
    return { status: "down", summary: "No Firebase service account is set, so live tracking and chat cannot work." };
  }
  if (beat.status === "failed") return { status: "down", summary: `Heartbeat failed: ${beat.error}` };
  const speed = `Heartbeat written and read back in ${beat.latencyMs} ms.`;
  if (rules.status === "different") {
    return {
      status: "warn",
      summary: `${speed} The live rules differ from firebase/database.rules.json at: ${rules.changedKeys.join(", ")}.`,
    };
  }
  if (rules.status === "failed") return { status: "warn", summary: `${speed} Could not compare the rules: ${rules.error}` };
  return { status: "ok", summary: `${speed} Live rules match the reviewed copy.` };
}

async function probeTelegram(): Promise<ProbeOutcome> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_ALERT_CHAT_ID?.trim();
  if (!token || !chatId) {
    return { status: "warn", summary: "Not set up: alerts are recorded in the Alerts tab but nobody is told." };
  }
  const me = await getJson(`https://api.telegram.org/bot${token}/getMe`);
  if (!me.body?.ok) {
    return { status: "down", summary: `The bot token was refused (${me.status}${me.body?.description ? `: ${me.body.description}` : ""}).` };
  }
  const chat = await getJson(`https://api.telegram.org/bot${token}/getChat?chat_id=${encodeURIComponent(chatId)}`);
  if (!chat.body?.ok) {
    return {
      status: "down",
      summary: `Bot @${me.body.result?.username} works but cannot reach the alert chat (${chat.body?.description || chat.status}).`,
    };
  }
  return { status: "ok", summary: `Bot @${me.body.result?.username} can post to the alert chat.` };
}

async function probeEmail(): Promise<ProbeOutcome> {
  const verified = await verifyEmailTransport();
  if (!verified) {
    return { status: "down", summary: "SMTP is not set, so staff cannot receive sign-in codes." };
  }
  return { status: "ok", summary: `Signed in to ${verified.host} (nothing was sent).` };
}

async function probeOffsite(nowMs: number): Promise<ProbeOutcome> {
  const cfg = offsiteBackupService.config();
  if (!cfg) return { status: "warn", summary: "Not set up: the only backups are on this server's own disk." };
  try {
    await offsiteBackupService.checkKeyFile(cfg.keyFile);
  } catch (err: unknown) {
    return { status: "down", summary: `Encryption key file problem: ${errorText(err)}` };
  }
  const newest = await offsiteBackupService.latestRemote();
  if (!newest) return { status: "warn", summary: `R2 bucket ${cfg.bucket} answers but holds no daily copy yet.` };
  const name = newest.key.split("/").pop() || newest.key;
  const record = await prisma.databaseBackup.findFirst({
    where: { offsiteStatus: "UPLOADED" },
    orderBy: { offsiteAt: "desc" },
    select: { offsiteAt: true },
  });
  const sizeMb = (newest.sizeBytes / 1024 / 1024).toFixed(1);
  const at = record?.offsiteAt?.getTime() ?? null;
  if (at === null) return { status: "ok", summary: `R2 answers. Newest copy: ${name} (${sizeMb} MB).` };
  const stale = nowMs - at > FRESHNESS_HOURS * 3600 * 1000;
  return {
    status: stale ? "warn" : "ok",
    summary: `R2 answers. Newest copy uploaded ${ago(at, nowMs)} (${sizeMb} MB)${stale ? `, older than ${FRESHNESS_HOURS} hours` : ""}.`,
  };
}

async function probeOsrm(): Promise<{ ok: boolean; ms: number; error?: string } | null> {
  if (!OSRM_BASE_URL) return null;
  const started = Date.now();
  try {
    const { status, body } = await getJson(`${OSRM_BASE_URL}/nearest/v1/driving/${OSRM_PROBE_POINT}?number=1`, {}, 3000);
    if (status === 200 && body?.code === "Ok") return { ok: true, ms: Date.now() - started };
    return { ok: false, ms: Date.now() - started, error: `answered ${status}${body?.code ? ` ${body.code}` : ""}` };
  } catch (err: unknown) {
    return { ok: false, ms: Date.now() - started, error: errorText(err) };
  }
}

function describeRouting(
  health: ReturnType<typeof routingProviderHealth>,
  osrm: Awaited<ReturnType<typeof probeOsrm>>,
  nowMs: number,
): ProbeOutcome {
  const parts: string[] = [];
  let status: IntegrationStatus = "ok";
  const live = health.providers.filter((p) => p.configured && p.name !== "haversine");

  for (const p of live) {
    if (p.name === "osrm" && osrm) {
      parts.push(osrm.ok ? `OSRM answers in ${osrm.ms} ms` : `OSRM does not answer (${osrm.error})`);
      if (!osrm.ok) status = "warn";
      continue;
    }
    const label = p.name === "google" ? "Google" : p.name.toUpperCase();
    if (p.open) {
      parts.push(`${label} is being skipped after ${p.consecutiveFailures} failures in a row`);
      status = "warn";
    } else if (p.lastSuccessAt) {
      parts.push(`${label} last answered ${ago(p.lastSuccessAt, nowMs)}`);
    } else if (p.lastFailureAt) {
      parts.push(`${label} failed ${ago(p.lastFailureAt, nowMs)}`);
      status = "warn";
    } else {
      parts.push(`${label} not used since the API started`);
    }
  }

  if (live.length === 0) {
    status = "warn";
    parts.push("No road routing is configured; fares use straight-line estimates");
  } else if (live.every((p) => p.open || (p.name === "osrm" && osrm && !osrm.ok))) {
    status = "down";
    parts.push("fares and ETAs are falling back to straight-line estimates");
  }
  if (health.ignoredNames.length > 0) {
    status = status === "down" ? "down" : "warn";
    parts.push(`ROUTING_PROVIDER_ORDER has unknown ${health.ignoredNames.length === 1 ? "name" : "names"} ${health.ignoredNames.map((n) => `"${n}"`).join(", ")}, which the API ignores`);
  }
  const order = health.providers.map((p) => p.name).join(" > ");
  return { status, summary: `${parts.join(". ")}. Order: ${order}.` };
}

async function probeRouting(nowMs: number): Promise<ProbeOutcome> {
  return describeRouting(routingProviderHealth(), await probeOsrm(), nowMs);
}

async function probeCategory(): Promise<ProbeOutcome> {
  if (!CATEGORY_SERVICE_URL) return { status: "off", summary: "Not set up: dispatchers pick categories by hand." };
  const { status, body } = await getJson(`${CATEGORY_SERVICE_URL}/health`, {}, 3000);
  if (status !== 200) return { status: "down", summary: `Health check answered ${status}.` };
  if (body?.ready !== true) {
    return { status: "warn", summary: `Running but no model is loaded${body?.error ? ` (${body.error})` : ""}.` };
  }
  return { status: "ok", summary: `Model version ${body.model_version ?? "?"} loaded.` };
}

function probePlaces(): ProbeOutcome {
  if (!GOOGLE_PLACES_API_KEY) return { status: "off", summary: "No key: store search uses the verified store list only." };
  const usage = placesUsage();
  const tight = usage.skus.filter((s) => s.freePerMonth > 0 && s.used >= s.freePerMonth * 0.9);
  const used = usage.skus.map((s) => `${s.sku} ${s.used}/${s.freePerMonth}`).join(", ");
  return {
    status: tight.length > 0 ? "warn" : "unchecked",
    summary: `Not called from here (billed per call). Free-tier use in ${usage.month}: ${used}.${tight.length > 0 ? " Nearly used up; searches stop at the cap." : ""}`,
  };
}

function probeVision(nowMs: number): ProbeOutcome {
  const engine = ocrEngineHealth().find((e) => e.configured);
  if (!engine) return { status: "off", summary: "No key: riders type receipt amounts by hand." };
  if (engine.open) {
    return { status: "warn", summary: `Being skipped after ${engine.consecutiveFailures} failed reads in a row.` };
  }
  const last = engine.lastSuccessAt
    ? `Last read a photo ${ago(engine.lastSuccessAt, nowMs)}.`
    : engine.lastFailureAt
      ? `Last read failed ${ago(engine.lastFailureAt, nowMs)}.`
      : "Not used since the API started.";
  return {
    status: engine.lastFailureAt && (!engine.lastSuccessAt || engine.lastFailureAt > engine.lastSuccessAt) ? "warn" : "unchecked",
    summary: `Not called from here (billed per call). ${last}`,
  };
}

async function probeGemini(): Promise<ProbeOutcome> {
  const key = resolveGeminiApiKey();
  if (!key) return { status: "off", summary: "No key: the owner assistant gives fixed answers without AI." };
  const { status, body } = await getJson(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}`, {
    headers: { "x-goog-api-key": key },
  });
  if (status === 200) return { status: "ok", summary: `Key accepted; model ${GEMINI_MODEL} is available.` };
  return { status: "down", summary: `Google answered ${status}${body?.error?.status ? ` ${body.error.status}` : ""}.` };
}

// --- Runner ------------------------------------------------------------------

export interface IntegrationCheckDeps {
  probes?: Partial<Record<IntegrationKey, Probe>>;
  now?: () => number;
  timeoutMs?: number;
  cacheMs?: number;
  env?: NodeJS.ProcessEnv;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new ProbeTimeoutError(`No answer within ${Math.round(ms / 1000)} seconds.`)), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

const RANK: Record<IntegrationStatus, number> = { ok: 0, off: 0, unchecked: 0, warn: 1, down: 2 };

export function createIntegrationChecks(deps: IntegrationCheckDeps = {}) {
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
  const cacheMs = deps.cacheMs ?? REPORT_CACHE_MS;
  const defaults: Record<IntegrationKey, Probe> = {
    database: probeDatabase,
    firebase: probeFirebase,
    telegram: probeTelegram,
    email: probeEmail,
    offsite: () => probeOffsite(now()),
    routing: () => probeRouting(now()),
    category: probeCategory,
    places: async () => probePlaces(),
    vision: async () => probeVision(now()),
    gemini: probeGemini,
  };
  const probes = { ...defaults, ...deps.probes };

  let cached: { at: number; report: IntegrationReport } | null = null;
  let inFlight: Promise<IntegrationReport> | null = null;

  async function runOne(def: Definition): Promise<IntegrationResult> {
    const started = now();
    let outcome: ProbeOutcome;
    try {
      outcome = await withTimeout(probes[def.key](), timeoutMs);
    } catch (err: unknown) {
      if (!(err instanceof ProbeTimeoutError)) logger.warn(`[IntegrationCheck] ${def.key} probe failed:`, redactSecrets(errorText(err), deps.env));
      outcome = { status: "down", summary: err instanceof ProbeTimeoutError ? err.message : `Check failed: ${errorText(err)}` };
    }
    return {
      ...def,
      status: outcome.status,
      summary: redactSecrets(outcome.summary, deps.env),
      latencyMs: Math.max(0, now() - started),
    };
  }

  async function runAll(): Promise<IntegrationReport> {
    const started = now();
    const results = await Promise.all(INTEGRATIONS.map(runOne));
    const worst = Math.max(...results.map((r) => RANK[r.status]));
    return {
      checkedAt: new Date(now()).toISOString(),
      durationMs: Math.max(0, now() - started),
      overall: worst === 2 ? "down" : worst === 1 ? "warn" : "ok",
      results,
    };
  }

  /** Never throws. Concurrent callers share one run; a run younger than cacheMs is reused. */
  async function report(): Promise<IntegrationReport> {
    if (cached && now() - cached.at < cacheMs) return cached.report;
    if (!inFlight) {
      inFlight = runAll()
        .then((r) => {
          cached = { at: now(), report: r };
          return r;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  }

  return { report, runOne };
}

export const integrationCheckService = createIntegrationChecks();

/** Exposed for tests. */
export const __test = { describeRouting, probePlaces, probeVision };
