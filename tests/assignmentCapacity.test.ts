import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The concurrency cap, at the point where it is actually enforced.
 *
 * assignRider used to read each candidate's active-errand count and then write
 * the assignment as two separate statements. Two dispatchers auto-assigning in
 * the same second both read `2 < 3`, both passed the check, and both wrote —
 * leaving one rider holding four errands, with nothing in the schema to catch it.
 *
 * The fix moves the count inside the same transaction as the write. These tests
 * model that transaction as strictly serialized, which is what Serializable
 * isolation buys, and assert the decision the code makes given one snapshot.
 * They do not test MariaDB's isolation guarantee itself — that is the database's
 * job, and mocking it would only assert that the mock works.
 */

interface ErrandRow {
  id: string;
  riderId: number | null;
  status: string;
}

let errands: ErrandRow[] = [];
/** Serializes transaction bodies, so no two ever interleave their read and write. */
let lock: Promise<unknown> = Promise.resolve();

const activeCount = (riderId: number) =>
  errands.filter((e) => e.riderId === riderId && ["ASSIGNED", "IN_TRANSIT"].includes(e.status))
    .length;

const tx = {
  errand: {
    count: async ({ where }: { where: { riderId: number } }) => activeCount(where.riderId),
    updateMany: async ({
      where,
      data,
    }: {
      where: { id: string; status: string };
      data: { riderId: number; status: string };
    }) => {
      const row = errands.find((e) => e.id === where.id && e.status === where.status);
      if (!row) return { count: 0 };
      row.riderId = data.riderId;
      row.status = data.status;
      return { count: 1 };
    },
  },
};

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    // Every body runs to completion before the next one starts. Interleaving them
    // is precisely what Serializable forbids and what the old code allowed.
    $transaction: (fn: (t: typeof tx) => Promise<unknown>) => {
      const run = lock.then(() => fn(tx));
      lock = run.catch(() => undefined);
      return run;
    },
  },
}));

import { errandRepository } from "../src/repositories/errandRepository.js";

const MAX = 3;

beforeEach(() => {
  lock = Promise.resolve();
  errands = [
    { id: "held-1", riderId: 7, status: "IN_TRANSIT" },
    { id: "held-2", riderId: 7, status: "ASSIGNED" },
    { id: "new-a", riderId: null, status: "PENDING" },
    { id: "new-b", riderId: null, status: "PENDING" },
  ];
});

describe("claiming an errand for a rider", () => {
  it("gives a rider their third errand", async () => {
    expect(await errandRepository.claimForRider("new-a", 7, MAX)).toBe("CLAIMED");
    expect(activeCount(7)).toBe(3);
  });

  it("refuses a fourth, so the cap is enforced where the write happens", async () => {
    await errandRepository.claimForRider("new-a", 7, MAX);
    expect(await errandRepository.claimForRider("new-b", 7, MAX)).toBe("AT_CAPACITY");
    expect(activeCount(7)).toBe(3);
  });

  it("lets exactly one of two SIMULTANEOUS dispatches take the last slot", async () => {
    // The original bug, reproduced: two dispatchers, two different errands, one
    // rider with one slot left, both firing at once.
    const [first, second] = await Promise.all([
      errandRepository.claimForRider("new-a", 7, MAX),
      errandRepository.claimForRider("new-b", 7, MAX),
    ]);

    expect([first, second].filter((r) => r === "CLAIMED")).toHaveLength(1);
    expect([first, second].filter((r) => r === "AT_CAPACITY")).toHaveLength(1);
    expect(activeCount(7)).toBe(3);
  });

  it("never lets a rider exceed the cap under a burst", async () => {
    errands.push(
      { id: "new-c", riderId: null, status: "PENDING" },
      { id: "new-d", riderId: null, status: "PENDING" }
    );
    const results = await Promise.all(
      ["new-a", "new-b", "new-c", "new-d"].map((id) =>
        errandRepository.claimForRider(id, 7, MAX)
      )
    );

    expect(results.filter((r) => r === "CLAIMED")).toHaveLength(1);
    expect(activeCount(7)).toBe(3);
  });

  it("reports an errand someone else already assigned, rather than overwriting it", async () => {
    // The other half of the race: two dispatchers assigning the SAME errand.
    // Only PENDING may become ASSIGNED, so the second write matches no rows.
    await errandRepository.claimForRider("new-a", 7, MAX);
    expect(await errandRepository.claimForRider("new-a", 9, MAX)).toBe("ERRAND_MOVED");

    const row = errands.find((e) => e.id === "new-a");
    expect(row?.riderId).toBe(7);
  });

  it("does not consume a slot when the errand has moved on", async () => {
    errands.push({ id: "cancelled", riderId: null, status: "CANCELLED" });
    expect(await errandRepository.claimForRider("cancelled", 9, MAX)).toBe("ERRAND_MOVED");
    expect(activeCount(9)).toBe(0);
  });
});
