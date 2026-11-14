/**
 * processState.ts
 *
 * Tells a crash from a restart. A clean stop (PM2 restart, deploy, reboot:
 * all SIGINT or SIGTERM) writes "stopped" on the way out. If the next start
 * finds "running" instead, the last process died without stopping: a crash,
 * the out-of-memory killer, or kill -9.
 *
 * The crash-alert window is kept in the file, not in memory, because a crash
 * loop restarts the process (and would wipe a memory-only limit) every second.
 *
 * Not seen as a crash: PM2's max_memory_restart, which also stops with SIGINT.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { logger } from "./logger.js";

export const PROCESS_STATE_FILE = path.join(process.cwd(), "config", "process-state.json");
export const CRASH_ALERT_WINDOW_MS = 30 * 60 * 1000;
const LAST_ERROR_MAX = 500;

interface ProcessStateRecord {
  state: "running" | "stopped";
  pid: number;
  startedAt: string;
  stoppedAt?: string;
  stopSignal?: string;
  lastError?: string;
  lastCrashAlertAt?: string;
  /** Unexpected restarts since the last crash alert that were not alerted themselves. */
  crashesSinceAlert?: number;
}

export type PreviousExit =
  | { kind: "first_boot" }
  | { kind: "clean" }
  | {
      kind: "unexpected";
      previousPid: number;
      previousStartedAt: string;
      lastError?: string;
      /** False inside the window: a crash loop gets one alert per window, not one per restart. */
      shouldAlert: boolean;
      /** Earlier crashes that were held back, reported with this alert. */
      heldBackCrashes: number;
    };

function readState(file: string): ProcessStateRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed && (parsed.state === "running" || parsed.state === "stopped")) return parsed;
    return null;
  } catch {
    return null;
  }
}

/** Write then rename, so a crash mid-write never leaves half a file behind. */
function writeState(file: string, record: ProcessStateRecord): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2));
  renameSync(tmp, file);
}

/** Never throws: a read-only disk must not stop the API from booting. */
export function recordProcessStart(
  file: string = PROCESS_STATE_FILE,
  nowMs: number = Date.now(),
  pid: number = process.pid,
): PreviousExit {
  const previous = readState(file);
  let lastCrashAlertAt = previous?.lastCrashAlertAt;
  let crashesSinceAlert = previous?.crashesSinceAlert ?? 0;
  let result: PreviousExit;

  if (!previous) {
    result = { kind: "first_boot" };
  } else if (previous.state === "stopped") {
    result = { kind: "clean" };
  } else {
    const lastAlertMs = lastCrashAlertAt ? Date.parse(lastCrashAlertAt) : NaN;
    const shouldAlert = !(nowMs - lastAlertMs < CRASH_ALERT_WINDOW_MS);
    result = {
      kind: "unexpected",
      previousPid: previous.pid,
      previousStartedAt: previous.startedAt,
      lastError: previous.lastError,
      shouldAlert,
      heldBackCrashes: shouldAlert ? crashesSinceAlert : 0,
    };
    if (shouldAlert) {
      lastCrashAlertAt = new Date(nowMs).toISOString();
      crashesSinceAlert = 0;
    } else {
      crashesSinceAlert += 1;
    }
  }

  try {
    writeState(file, {
      state: "running",
      pid,
      startedAt: new Date(nowMs).toISOString(),
      ...(lastCrashAlertAt ? { lastCrashAlertAt } : {}),
      ...(crashesSinceAlert ? { crashesSinceAlert } : {}),
    });
  } catch (err: unknown) {
    logger.error("[ProcessState] Could not record process start:", err);
  }

  return result;
}

export function markProcessStopped(file: string, signal: string, nowMs: number = Date.now()): void {
  const current = readState(file);
  writeState(file, {
    ...(current ?? { pid: process.pid, startedAt: new Date(nowMs).toISOString() }),
    state: "stopped",
    stoppedAt: new Date(nowMs).toISOString(),
    stopSignal: signal,
  });
}

export function markProcessError(file: string, err: unknown): void {
  const current = readState(file);
  if (!current) return;
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  writeState(file, { ...current, lastError: text.slice(0, LAST_ERROR_MAX) });
}

/**
 * A listener on SIGINT/SIGTERM replaces Node's default "exit now", so this one
 * exits itself, immediately and with the code the default would have given
 * (128 + signal number). Nothing else in the server listens for these.
 *
 * uncaughtExceptionMonitor only watches: the process still crashes exactly as
 * it did, but the next start can say why.
 */
export function installExitRecorder(file: string = PROCESS_STATE_FILE): void {
  const exitCodes = { SIGINT: 130, SIGTERM: 143 } as const;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      try {
        markProcessStopped(file, signal);
      } catch {
        // Exiting anyway: the next start reports an unexpected restart, which is the safe mistake.
      }
      process.exit(exitCodes[signal]);
    });
  }
  process.on("uncaughtExceptionMonitor", (err) => {
    try {
      markProcessError(file, err);
    } catch {
      // The crash itself is what matters; it goes ahead regardless.
    }
  });
}
