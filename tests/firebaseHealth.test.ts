import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  checkFirebaseHeartbeat,
  checkFirebaseRules,
  changedRuleKeys,
  HEARTBEAT_PATH,
  type RealtimeDb,
} from "../src/lib/firebaseHealth.js";

// The global setup (tests/setup/noLiveFirebase.ts) makes the real database
// handle throw, so every case here injects its own fake.

function fakeDb(opts: { setFails?: boolean; hang?: boolean; echo?: (v: any) => any; rules?: object } = {}) {
  const store = new Map<string, unknown>();
  const db: RealtimeDb = {
    ref(p: string) {
      return {
        async set(value: unknown) {
          if (opts.hang) await new Promise(() => {});
          if (opts.setFails) throw new Error("PERMISSION_DENIED or quota exceeded");
          store.set(p, value);
        },
        async get() {
          const v = store.get(p);
          return { val: () => (opts.echo ? opts.echo(v) : v) };
        },
      };
    },
    async getRulesJSON() {
      return opts.rules ?? {};
    },
  };
  return { db, store };
}

describe("checkFirebaseHeartbeat", () => {
  it("writes the heartbeat and reads the same value back", async () => {
    const { db, store } = fakeDb();
    const result = await checkFirebaseHeartbeat(() => db, () => 1000);
    expect(result).toEqual({ status: "ok", latencyMs: 0 });
    expect(store.get(HEARTBEAT_PATH)).toMatchObject({ at: 1000 });
  });

  it("is not_configured without a service account, so nothing alerts in dev", async () => {
    expect(await checkFirebaseHeartbeat(() => null)).toEqual({ status: "not_configured" });
  });

  it("fails when the write is refused", async () => {
    const { db } = fakeDb({ setFails: true });
    const result = await checkFirebaseHeartbeat(() => db);
    expect(result).toMatchObject({ status: "failed", error: expect.stringContaining("quota exceeded") });
  });

  it("gives up on a hung write within the timeout", async () => {
    const { db } = fakeDb({ hang: true });
    const started = Date.now();
    const result = await checkFirebaseHeartbeat(() => db, Date.now, 40);
    expect(result).toMatchObject({ status: "failed", error: expect.stringContaining("no answer within 40 ms") });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("fails when the value read back is not the one written", async () => {
    const { db } = fakeDb({ echo: () => ({ at: 1 }) });
    const result = await checkFirebaseHeartbeat(() => db, () => 5000);
    expect(result).toMatchObject({ status: "failed", error: "read back 1 instead of 5000" });
  });

  it("never throws, even when getting the handle throws", async () => {
    const result = await checkFirebaseHeartbeat(() => {
      throw new Error("Tests may not reach the live Realtime Database.");
    });
    expect(result).toMatchObject({ status: "failed" });
  });
});

describe("rules drift", () => {
  const reviewed = { rules: { ".read": false, ".write": false, riders: { ".read": "auth != null" }, chats: { ".read": "auth != null" } } };

  it("treats the same rules in a different key order as the same", async () => {
    const live = { rules: { chats: { ".read": "auth != null" }, riders: { ".read": "auth != null" }, ".write": false, ".read": false } };
    const { db } = fakeDb({ rules: live });
    expect(await checkFirebaseRules(() => db, async () => JSON.stringify(reviewed))).toEqual({ status: "same" });
  });

  it("names every changed, added and removed top-level path", () => {
    const live = { rules: { ".read": true, ".write": false, riders: { ".read": "auth != null" }, extra: {} } };
    expect(changedRuleKeys(live, reviewed)).toEqual([".read", "chats", "extra"]);
  });

  it("reports a Console edit as different", async () => {
    const live = { rules: { ...reviewed.rules, chats: { ".read": true } } };
    const { db } = fakeDb({ rules: live });
    expect(await checkFirebaseRules(() => db, async () => JSON.stringify(reviewed))).toEqual({ status: "different", changedKeys: ["chats"] });
  });

  it("fails without throwing when the reviewed file is unreadable", async () => {
    const { db } = fakeDb({ rules: reviewed });
    expect(await checkFirebaseRules(() => db, async () => "{ not json")).toMatchObject({ status: "failed" });
    expect(await checkFirebaseRules(() => null, async () => "{}")).toEqual({ status: "not_configured" });
  });

  it("parses the repository's real rules file and finds it equal to itself", async () => {
    const text = readFileSync(path.resolve(__dirname, "..", "firebase", "database.rules.json"), "utf8");
    const { db } = fakeDb({ rules: JSON.parse(text) });
    expect(await checkFirebaseRules(() => db, async () => text)).toEqual({ status: "same" });
  });
});
