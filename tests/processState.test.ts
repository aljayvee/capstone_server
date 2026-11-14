import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  recordProcessStart,
  markProcessStopped,
  markProcessError,
  CRASH_ALERT_WINDOW_MS,
} from "../src/lib/processState.js";

let dir: string;
let file: string;
const T0 = Date.parse("2026-11-15T00:00:00Z");

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "process-state-"));
  file = path.join(dir, "config", "process-state.json");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const read = () => JSON.parse(readFileSync(file, "utf8"));

describe("processState", () => {
  it("first boot creates the file and reports nothing", () => {
    expect(recordProcessStart(file, T0, 100)).toEqual({ kind: "first_boot" });
    expect(read()).toMatchObject({ state: "running", pid: 100 });
  });

  it("a clean stop then start is not a crash", () => {
    recordProcessStart(file, T0, 100);
    markProcessStopped(file, "SIGINT", T0 + 1000);
    expect(read()).toMatchObject({ state: "stopped", stopSignal: "SIGINT" });
    expect(recordProcessStart(file, T0 + 2000, 101)).toEqual({ kind: "clean" });
  });

  it("a start that finds 'running' is an unexpected restart, with the last error", () => {
    recordProcessStart(file, T0, 100);
    markProcessError(file, new TypeError("Cannot read properties of undefined"));
    const result = recordProcessStart(file, T0 + 5000, 101);
    expect(result).toMatchObject({
      kind: "unexpected",
      previousPid: 100,
      lastError: "TypeError: Cannot read properties of undefined",
      shouldAlert: true,
      heldBackCrashes: 0,
    });
    // The new run starts without the old error.
    expect(read().lastError).toBeUndefined();
  });

  it("a crash loop alerts once per window and counts the rest", () => {
    recordProcessStart(file, T0, 100);
    const results = [1, 2, 3, 4].map((i) => recordProcessStart(file, T0 + i * 1000, 100 + i));
    expect(results.map((r) => r.kind === "unexpected" && r.shouldAlert)).toEqual([true, false, false, false]);

    const later = recordProcessStart(file, T0 + 1000 + CRASH_ALERT_WINDOW_MS, 200);
    expect(later).toMatchObject({ kind: "unexpected", shouldAlert: true, heldBackCrashes: 3 });
  });

  it("the crash window survives a clean restart in between", () => {
    recordProcessStart(file, T0, 100);
    recordProcessStart(file, T0 + 1000, 101); // crash, alerted
    markProcessStopped(file, "SIGINT", T0 + 2000); // deploy
    recordProcessStart(file, T0 + 3000, 102);
    const crash = recordProcessStart(file, T0 + 4000, 103);
    expect(crash).toMatchObject({ kind: "unexpected", shouldAlert: false });
  });

  it("an unreadable file counts as a first boot, not a crash", () => {
    recordProcessStart(file, T0, 100);
    writeFileSync(file, "{ half a fi");
    expect(recordProcessStart(file, T0 + 1000, 101)).toEqual({ kind: "first_boot" });
  });

  it("cuts a long error to 500 characters", () => {
    recordProcessStart(file, T0, 100);
    markProcessError(file, new Error("x".repeat(2000)));
    expect(read().lastError.length).toBe(500);
  });

  it("does not throw when the file cannot be written", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // A regular file where the config directory should be makes every write fail.
    const blocked = path.join(dir, "blocked");
    writeFileSync(blocked, "");
    const bad = path.join(blocked, "process-state.json");
    expect(() => recordProcessStart(bad, T0, 100)).not.toThrow();
    expect(existsSync(bad)).toBe(false);
  });
});
