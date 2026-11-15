import { describe, it, expect } from "vitest";
import {
  createAuditTimeline,
  decodeCursor,
  csvCell,
  stripSensitive,
  actorFor,
  newer,
  type AuditSource,
  type AuditSourceKey,
  type FetchedRow,
  type NameBook,
  type Position,
} from "../src/services/auditTimelineService.js";
import { parseFilters } from "../src/controllers/auditTimelineController.js";
import { ServiceError } from "../src/services/ServiceError.js";

const book: NameBook = {
  user: new Map([[3, { name: "Rhea Rider", role: "RIDER", username: "rhea" }]]),
  customer: new Map([[3, { name: "Carlo Customer", username: "carlo" }]]),
  sysadmin: new Map(),
};

/** A fake source over fixed rows, honouring the (time, id) cursor exactly like the real ones. */
function fakeSource(key: AuditSourceKey, rows: { at: string; id: number; severity?: "info" | "warning" }[], calls: { n: number } = { n: 0 }): AuditSource {
  const sorted = [...rows].sort((a, b) => (a.at === b.at ? b.id - a.id : a.at < b.at ? 1 : -1));
  return {
    key,
    async fetch(ctx) {
      calls.n++;
      const before = ctx.before;
      return sorted
        .filter((r) => !before || newer(before, { at: r.at, id: String(r.id) }))
        .slice(0, ctx.take)
        .map((r): FetchedRow => ({
          pos: { at: r.at, id: String(r.id) },
          event: { key: `${key}:${r.id}`, source: key, rowId: String(r.id), at: r.at, severity: r.severity ?? "info", action: "x", summary: "", actor: null, ip: null },
        }));
    },
    async detail() {
      return null;
    },
  };
}

const t = (m: number) => new Date(Date.UTC(2026, 10, 15, 0, m)).toISOString();
const empty = (key: AuditSourceKey) => fakeSource(key, []);
const ALL_EMPTY = Object.fromEntries(
  (["signin", "account_change", "password_reset", "staff_session", "rider_session", "rider_connectivity", "dispatch", "report_print", "ip_block", "it_alert", "pma"] as AuditSourceKey[]).map((k) => [k, empty(k)]),
) as Record<AuditSourceKey, AuditSource>;

function timeline(over: Partial<Record<AuditSourceKey, AuditSource>>) {
  return createAuditTimeline({ sources: { ...ALL_EMPTY, ...over }, loadNames: async () => book });
}

describe("activity timeline", () => {
  it("merges sources newest first", async () => {
    const tl = timeline({ signin: fakeSource("signin", [{ at: t(1), id: 1 }, { at: t(5), id: 2 }]), it_alert: fakeSource("it_alert", [{ at: t(3), id: 9 }]) });
    const p = await tl.page({}, null, 10);
    expect(p.events.map((e) => e.key)).toEqual(["signin:2", "it_alert:9", "signin:1"]);
    expect(p.nextCursor).toBeNull();
  });

  it("pages through everything exactly once, even when many rows share a timestamp", async () => {
    const a = Array.from({ length: 23 }, (_, i) => ({ at: t(i % 3), id: i + 1 }));
    const b = Array.from({ length: 17 }, (_, i) => ({ at: t(i % 2), id: 100 + i }));
    const tl = timeline({ signin: fakeSource("signin", a), dispatch: fakeSource("dispatch", b) });
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const p = await tl.page({}, cursor, 7);
      seen.push(...p.events.map((e) => e.key));
      cursor = p.nextCursor;
      pages++;
    } while (cursor && pages < 20);
    expect(seen).toHaveLength(40);
    expect(new Set(seen).size).toBe(40);
    const ats = seen.map((k) => (k.startsWith("signin") ? a.find((r) => `signin:${r.id}` === k)!.at : b.find((r) => `dispatch:${r.id}` === k)!.at));
    expect([...ats].sort().reverse()).toEqual(ats);
  });

  it("keeps filling the page when a severity filter skips rows", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ at: t(i), id: i + 1, severity: (i % 10 === 0 ? "warning" : "info") as "info" | "warning" }));
    const tl = timeline({ signin: fakeSource("signin", rows) });
    const p = await tl.page({ minSeverity: "warning" }, null, 3);
    expect(p.events.map((e) => e.rowId)).toEqual(["21", "11", "1"]);
  });

  it("only asks the chosen sources", async () => {
    const calls = { n: 0 };
    const tl = timeline({ signin: fakeSource("signin", [{ at: t(1), id: 1 }]), dispatch: fakeSource("dispatch", [{ at: t(2), id: 2 }], calls) });
    const p = await tl.page({ sources: ["signin"] }, null, 10);
    expect(p.events.map((e) => e.source)).toEqual(["signin"]);
    expect(calls.n).toBe(0);
  });

  it("rejects a tampered page link with a readable 400", () => {
    expect(() => decodeCursor("not-base64-json")).toThrow(ServiceError);
    expect(decodeCursor(Buffer.from(JSON.stringify({ signin: { at: "2026-11-15T00:00:00.000Z", id: "4" }, bogus: 1 })).toString("base64url"))).toEqual({
      signin: { at: "2026-11-15T00:00:00.000Z", id: "4" },
    });
  });

  it("orders ties by number, not text", () => {
    const p = (id: string): Position => ({ at: t(1), id });
    expect(newer(p("10"), p("9"))).toBe(true);
    expect(newer(p("b"), p("a"))).toBe(true);
  });
});

describe("safety", () => {
  it("neutralises spreadsheet formulas and quotes CSV cells", () => {
    expect(csvCell("=HYPERLINK(\"x\")")).toBe("\"'=HYPERLINK(\"\"x\"\")\"");
    expect(csvCell("+63 912")).toBe("'+63 912");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell(null)).toBe("");
  });

  it("drops secret-looking fields from an entry's detail", () => {
    const out = stripSensitive({ id: 1, tokenHash: "abc", previousHash: "def", passwordHash: "x", ipAddress: "1.2.3.4", createdAt: new Date(0) });
    expect(out).toEqual({ id: 1, ipAddress: "1.2.3.4", createdAt: "1970-01-01T00:00:00.000Z" });
  });

  it("names customer 3 and staff 3 as two different people", () => {
    expect(actorFor(book, "customer", 3).name).toBe("Carlo Customer (carlo)");
    expect(actorFor(book, "user", 3).name).toBe("Rhea Rider (rhea)");
    expect(actorFor(book, "user", 99).name).toBe("Staff #99 (deleted)");
  });
});

describe("filters from the query string", () => {
  it("accepts a full, valid set", () => {
    const f = parseFilters({ sources: "signin,ip_block", q: "rhea", ip: "203.0.113.5", from: "2026-11-01", to: "2026-11-15", minSeverity: "warning", actor: "customer:3" });
    expect(f.sources).toEqual(["signin", "ip_block"]);
    expect(f.actor).toEqual({ kind: "customer", id: 3 });
    expect(f.minSeverity).toBe("warning");
  });

  it("refuses unknown sources, bad IPs, reversed dates and odd person filters", () => {
    expect(() => parseFilters({ sources: "signin,token_blocklist" })).toThrow(/Unknown log source: token_blocklist/);
    expect(() => parseFilters({ ip: "1.2.3.4' OR 1=1" })).toThrow(/IP filter/);
    expect(() => parseFilters({ from: "2026-11-15", to: "2026-11-01" })).toThrow(/From is after To/);
    expect(() => parseFilters({ actor: "admin:1" })).toThrow(/Person filter/);
    expect(() => parseFilters({ q: "x".repeat(101) })).toThrow(/100 characters/);
  });
});
