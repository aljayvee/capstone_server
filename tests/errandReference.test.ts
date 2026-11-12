import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

/**
 * Errand reference numbers, YYMMDD-KKKKK-NNNN (2026-10-19). The day is the
 * Manila day, the key is the id's tail, and the number comes from a per-day
 * counter taken inside the errand's own transaction.
 */

const db = vi.hoisted(() => ({
  counters: new Map<string, number>(),
  failures: [] as unknown[],
}));

vi.mock("../src/lib/prisma.js", () => {
  // Stands in for MariaDB: the upsert bumps the day's row, the select reads it
  // back. Raw queries arrive as tagged templates, so the day is the 2nd arg.
  const tx = {
    $executeRaw: vi.fn(async (_sql: TemplateStringsArray, day: string) => {
      db.counters.set(day, (db.counters.get(day) ?? 0) + 1);
      return 1;
    }),
    $queryRaw: vi.fn(async (_sql: TemplateStringsArray, day: string) => [{ last: BigInt(db.counters.get(day)!) }]),
  };
  return {
    prisma: {
      $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => {
        if (db.failures.length) throw db.failures.shift();
        return fn(tx);
      }),
      errand: { findUnique: vi.fn() },
    },
  };
});

import { prisma } from "../src/lib/prisma.js";
import {
  formatReferenceNo,
  referenceDay,
  referenceKey,
  referenceLabel,
  withErrandReference,
} from "../src/lib/errandReference.js";

const ID = "bf80487e-8141-4800-90c9-dff97d11badd";

function conflict(code: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError("write conflict", { code, clientVersion: "test", meta });
}

describe("reference number parts", () => {
  it("dates by the Manila calendar, not UTC", () => {
    // 00:30 on the 19th in Manila is still the 18th in UTC.
    expect(referenceDay(new Date("2026-10-18T16:30:00Z"))).toBe("261019");
    expect(referenceDay(new Date("2026-10-18T15:59:59Z"))).toBe("261018");
    expect(referenceDay(new Date("2026-12-31T16:00:00Z"))).toBe("270101");
  });

  it("keys on the last five characters of the id, upper case", () => {
    expect(referenceKey(ID)).toBe("1BADD");
  });

  it("pads the day's number to four digits and widens past 9999", () => {
    expect(formatReferenceNo("261019", ID, 42)).toBe("261019-1BADD-0042");
    expect(formatReferenceNo("261019", ID, 12345)).toBe("261019-1BADD-12345");
  });
});

describe("withErrandReference", () => {
  beforeEach(() => {
    db.counters.clear();
    db.failures.length = 0;
    vi.mocked(prisma.$transaction).mockClear();
    vi.useFakeTimers({ now: new Date("2026-10-18T16:30:00Z"), toFake: ["Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("hands the write an id and a number that carries that id's key", async () => {
    const ref = await withErrandReference(async (_tx, r) => r, ID);
    expect(ref).toEqual({ id: ID, referenceNo: "261019-1BADD-0001" });
  });

  it("mints a fresh id when the caller has none", async () => {
    const ref = await withErrandReference(async (_tx, r) => r);
    expect(ref.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(ref.referenceNo).toBe(`261019-${referenceKey(ref.id)}-0001`);
  });

  it("numbers a day's orders in turn and starts again the next day", async () => {
    const first = await withErrandReference(async (_tx, r) => r.referenceNo, ID);
    const second = await withErrandReference(async (_tx, r) => r.referenceNo, ID);
    vi.setSystemTime(new Date("2026-10-19T16:00:00Z"));
    const nextDay = await withErrandReference(async (_tx, r) => r.referenceNo, ID);
    expect([first, second, nextDay]).toEqual(["261019-1BADD-0001", "261019-1BADD-0002", "261020-1BADD-0001"]);
  });

  it("runs again after a deadlock, with the same id", async () => {
    db.failures.push(conflict("P2010", { code: "1213" }));
    const ref = await withErrandReference(async (_tx, r) => r, ID);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(ref.id).toBe(ID);
  });

  it("gives up after three conflicts", async () => {
    db.failures.push(conflict("P2034"), conflict("P2034"), conflict("P2034"));
    await expect(withErrandReference(async (_tx, r) => r, ID)).rejects.toMatchObject({ code: "P2034" });
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
  });

  it("does not retry any other failure", async () => {
    db.failures.push(conflict("P2002"));
    await expect(withErrandReference(async (_tx, r) => r, ID)).rejects.toMatchObject({ code: "P2002" });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe("referenceLabel", () => {
  it("prints the stored number", async () => {
    vi.mocked(prisma.errand.findUnique).mockResolvedValueOnce({ referenceNo: "261019-1BADD-0042" } as never);
    await expect(referenceLabel(ID)).resolves.toBe("261019-1BADD-0042");
  });

  it("falls back to the key before the backfill, or when the read fails", async () => {
    vi.mocked(prisma.errand.findUnique).mockResolvedValueOnce({ referenceNo: null } as never);
    await expect(referenceLabel(ID)).resolves.toBe("1BADD");
    vi.mocked(prisma.errand.findUnique).mockRejectedValueOnce(new Error("db down"));
    await expect(referenceLabel(ID)).resolves.toBe("1BADD");
  });
});
