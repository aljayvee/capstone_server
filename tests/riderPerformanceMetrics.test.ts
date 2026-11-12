import { describe, expect, it } from "vitest";
import {
  activeHoursFor,
  classifyDelivery,
  meanMinutesBetween,
  onTimePerformance,
} from "../src/services/riderPerformanceService.js";

const AT = (iso: string) => new Date(iso);

interface ErrandFixture {
  id?: string;
  riderId: number | null;
  assignedAt: Date | null;
  acceptedAt: Date | null;
  deliveredAt: Date | null;
  completedAt: Date | null;
  etaHighAt: Date | null;
  etaIsDegraded: boolean;
  itemsPurchasedAt?: Date | null;
  etaPromisedAt?: Date | null;
  etaPromisedHighAt?: Date | null;
}

function errand(partial: Partial<ErrandFixture> = {}): ErrandFixture {
  return {
    riderId: 1,
    assignedAt: null,
    acceptedAt: null,
    deliveredAt: null,
    completedAt: null,
    etaHighAt: null,
    etaIsDegraded: false,
    ...partial,
  };
}

describe("meanMinutesBetween", () => {
  it("measures accepted to delivered, not the whole errand lifetime", () => {
    // The defect this replaces: the old report used updatedAt - createdAt, which
    // starts when the CUSTOMER placed the order — including however long it sat
    // in the dispatcher queue before any rider saw it.
    const rows = [
      errand({ acceptedAt: AT("2026-09-01T10:00:00Z"), deliveredAt: AT("2026-09-01T10:30:00Z") }),
      errand({ acceptedAt: AT("2026-09-01T12:00:00Z"), deliveredAt: AT("2026-09-01T12:50:00Z") }),
    ];

    expect(meanMinutesBetween(rows, (e) => e.acceptedAt, (e) => e.deliveredAt)).toEqual({
      mean: 40,
      count: 2,
    });
  });

  it("is unmoved by a row touched long after delivery", () => {
    // A rating or settlement written hours later used to extend updatedAt and
    // silently inflate this rider's average. The stamps it reads now cannot be
    // moved by anything that happens after the handover.
    const delivered = [
      errand({
        acceptedAt: AT("2026-09-01T10:00:00Z"),
        deliveredAt: AT("2026-09-01T10:30:00Z"),
        completedAt: AT("2026-09-01T18:00:00Z"),
      }),
    ];

    expect(meanMinutesBetween(delivered, (e) => e.acceptedAt, (e) => e.deliveredAt).mean).toBe(30);
  });

  it("excludes an errand missing either stamp from both mean and count", () => {
    const rows = [
      errand({ acceptedAt: AT("2026-09-01T10:00:00Z"), deliveredAt: AT("2026-09-01T10:20:00Z") }),
      errand({ acceptedAt: null, deliveredAt: AT("2026-09-01T11:00:00Z") }),
      errand({ acceptedAt: AT("2026-09-01T12:00:00Z"), deliveredAt: null }),
    ];

    expect(meanMinutesBetween(rows, (e) => e.acceptedAt, (e) => e.deliveredAt)).toEqual({
      mean: 20,
      count: 1,
    });
  });

  it("returns null rather than zero when nothing carries both stamps", () => {
    // "Delivered instantly" and "no record of when this rider accepted" are
    // different facts. A table that shows 0 for the second gets someone
    // congratulated for a missing column.
    expect(meanMinutesBetween([errand()], (e) => e.acceptedAt, (e) => e.deliveredAt)).toEqual({
      mean: null,
      count: 0,
    });
  });

  it("drops a negative interval instead of letting a clock artefact lower the mean", () => {
    const rows = [
      errand({ acceptedAt: AT("2026-09-01T10:00:00Z"), deliveredAt: AT("2026-09-01T10:40:00Z") }),
      errand({ acceptedAt: AT("2026-09-01T12:00:00Z"), deliveredAt: AT("2026-09-01T11:00:00Z") }),
    ];

    expect(meanMinutesBetween(rows, (e) => e.acceptedAt, (e) => e.deliveredAt)).toEqual({
      mean: 40,
      count: 1,
    });
  });
});

describe("onTimePerformance", () => {
  // A delivery leg that checks out: items bought 10:00, promise frozen 10:01
  // for 10:30, delivered 10:25 with the rider's GPS 20 m from the door.
  const checked = (over: Partial<ErrandFixture> = {}, id = `e-${Math.random()}`): ErrandFixture => ({
    ...errand({
      id,
      acceptedAt: AT("2026-09-01T09:30:00Z"),
      itemsPurchasedAt: AT("2026-09-01T10:00:00Z"),
      etaPromisedAt: AT("2026-09-01T10:01:00Z"),
      etaPromisedHighAt: AT("2026-09-01T10:30:00Z"),
      deliveredAt: AT("2026-09-01T10:25:00Z"),
    }),
    ...over,
  });
  const atDoor = (...rows: ErrandFixture[]) => new Map(rows.map((r) => [r.id as string, 20]));

  it("judges a delivery against the frozen promise, not the ETA that kept moving", () => {
    // REGRESSION (production, 2026-10-22): etaHighAt is recomputed about every
    // minute up to the door, so it was always just after the delivery. This one
    // was promised for 10:30, delivered at 13:45, and etaHighAt (computed at
    // 13:45) still said 14:41. It used to read "on time".
    const late = checked({
      deliveredAt: AT("2026-09-01T13:45:00Z"),
      etaHighAt: AT("2026-09-01T14:41:00Z"),
    });

    const result = onTimePerformance([late], atDoor(late));
    expect(result.onTimeRate).toBe(0);
    expect(result.onTimeDenominator).toBe(1);
    expect(result.onTimeCount).toBe(0);
  });

  it("divides by checked deliveries only and counts the rest apart", () => {
    // 3 checked (2 on time), 1 with no promise, 1 with no GPS at the door.
    const onTimeA = checked();
    const onTimeB = checked();
    const late = checked({ deliveredAt: AT("2026-09-01T10:45:00Z") });
    const noPromise = checked({ etaPromisedAt: null, etaPromisedHighAt: null });
    const noGps = checked();

    const result = onTimePerformance(
      [onTimeA, onTimeB, late, noPromise, noGps],
      atDoor(onTimeA, onTimeB, late, noPromise)
    );
    expect(result.onTimeRate).toBe(0.67);
    expect(result.onTimeDenominator).toBe(3);
    expect(result.onTimeCount).toBe(2);
    expect(result.noPromiseCount).toBe(1);
    expect(result.unverifiedCount).toBe(1);
    expect(result.notCheckedCount).toBe(2);
  });

  it("counts a delivery exactly at the promise as on time", () => {
    const row = checked({ deliveredAt: AT("2026-09-01T10:30:00Z") });
    expect(onTimePerformance([row], atDoor(row)).onTimeRate).toBe(1);
  });

  it("does not count a promise made long after the leg began", () => {
    // A phone dark for the whole trip only produces a promise near the gate;
    // that promise could not be missed, so it proves nothing.
    const row = checked({
      etaPromisedAt: AT("2026-09-01T10:40:00Z"),
      etaPromisedHighAt: AT("2026-09-01T10:50:00Z"),
      deliveredAt: AT("2026-09-01T10:45:00Z"),
    });

    const result = onTimePerformance([row], atDoor(row));
    expect(result.onTimeDenominator).toBe(0);
    expect(result.noPromiseCount).toBe(1);
  });

  it("does not count a promise made moments before the delivery", () => {
    const row = checked({
      itemsPurchasedAt: AT("2026-09-01T10:20:00Z"),
      etaPromisedAt: AT("2026-09-01T10:24:00Z"),
      deliveredAt: AT("2026-09-01T10:25:00Z"),
    });

    expect(onTimePerformance([row], atDoor(row)).noPromiseCount).toBe(1);
  });

  it("starts the leg at acceptance when the errand had no stores", () => {
    const row = checked({
      itemsPurchasedAt: null,
      acceptedAt: AT("2026-09-01T10:00:00Z"),
    });

    expect(onTimePerformance([row], atDoor(row)).onTimeDenominator).toBe(1);
  });

  it("does not trust a delivery time set before the acceptance or the promise", () => {
    // The delivery time comes from the phone. One set back to before the
    // promise was made would otherwise always be on time.
    const beforePromise = checked({ deliveredAt: AT("2026-09-01T10:00:30Z") });
    const beforeAccept = checked({
      acceptedAt: AT("2026-09-01T10:26:00Z"),
      itemsPurchasedAt: AT("2026-09-01T10:00:00Z"),
    });

    const result = onTimePerformance([beforePromise, beforeAccept], atDoor(beforePromise, beforeAccept));
    expect(result.onTimeDenominator).toBe(0);
    expect(result.notCheckedCount).toBe(2);
  });

  it("needs the rider's GPS at the door when they marked it delivered", () => {
    const far = checked();
    const result = onTimePerformance([far], new Map([[far.id as string, 900]]));

    expect(result.onTimeDenominator).toBe(0);
    expect(result.unverifiedCount).toBe(1);
  });

  it("returns null, not zero, when nothing could be checked", () => {
    const result = onTimePerformance([checked({ etaPromisedAt: null })]);

    expect(result.onTimeRate).toBeNull();
    expect(result.onTimeDenominator).toBe(0);
  });

  it("never reports a fallback estimate, because none is ever frozen as a promise", () => {
    const row = checked({ etaIsDegraded: true });
    expect(onTimePerformance([row], atDoor(row)).degradedEtaCount).toBe(0);
  });
});

describe("activeHoursFor", () => {
  const START = AT("2026-09-01T00:00:00Z");
  const END = AT("2026-09-02T00:00:00Z");

  it("trusts the recorded duration of a closed session", () => {
    const hours = activeHoursFor(
      [
        {
          riderId: 1,
          loginAt: AT("2026-09-01T08:00:00Z"),
          logoutAt: AT("2026-09-01T16:00:00Z"),
          durationSeconds: 8 * 3600,
        },
      ],
      START,
      END,
      AT("2026-09-01T20:00:00Z")
    );

    expect(hours).toBe(8);
  });

  it("clamps a still-open session to now rather than dropping it", () => {
    // A rider mid-shift has real hours on the clock. Excluding them would divide
    // their errands by a smaller number and flatter whoever is not yet finished.
    const hours = activeHoursFor(
      [{ riderId: 1, loginAt: AT("2026-09-01T08:00:00Z"), logoutAt: null, durationSeconds: null }],
      START,
      END,
      AT("2026-09-01T11:00:00Z")
    );

    expect(hours).toBe(3);
  });

  it("returns zero hours when the rider never signed in", () => {
    // The caller turns this into a null ratio rather than dividing by zero.
    expect(activeHoursFor([], START, END, AT("2026-09-01T12:00:00Z"))).toBe(0);
  });

  it("falls back to the timestamps when a closed session recorded no duration", () => {
    const hours = activeHoursFor(
      [
        {
          riderId: 1,
          loginAt: AT("2026-09-01T08:00:00Z"),
          logoutAt: AT("2026-09-01T09:30:00Z"),
          durationSeconds: null,
        },
      ],
      START,
      END,
      AT("2026-09-01T12:00:00Z")
    );

    expect(hours).toBe(1.5);
  });
});

describe("classifyDelivery", () => {
  const base = {
    id: "e-1",
    riderId: 1,
    assignedAt: null,
    acceptedAt: AT("2026-09-01T09:30:00Z"),
    completedAt: null,
    etaHighAt: null,
    etaIsDegraded: false,
    itemsPurchasedAt: AT("2026-09-01T10:00:00Z"),
    etaPromisedAt: AT("2026-09-01T10:01:00Z"),
    etaPromisedHighAt: AT("2026-09-01T10:30:00Z"),
    deliveredAt: AT("2026-09-01T10:25:00Z"),
  };
  const near = new Map([["e-1", 20]]);

  it("says how late, in whole minutes", () => {
    expect(classifyDelivery({ ...base, deliveredAt: AT("2026-09-01T10:41:30Z") }, near)).toEqual({
      result: "LATE",
      minutesLate: 12,
      nearestMeters: 20,
    });
  });

  it("names each reason a delivery could not be checked", () => {
    expect(classifyDelivery({ ...base, etaPromisedAt: null }, near)).toMatchObject({ reason: "NO_PROMISE" });
    expect(
      classifyDelivery({ ...base, etaPromisedAt: AT("2026-09-01T10:20:00Z") }, near)
    ).toMatchObject({ reason: "PROMISE_TOO_LATE" });
    expect(
      classifyDelivery({ ...base, deliveredAt: AT("2026-09-01T10:02:00Z") }, near)
    ).toMatchObject({ reason: "PROMISE_TOO_CLOSE" });
    expect(
      classifyDelivery({ ...base, deliveredAt: AT("2026-09-01T10:00:30Z") }, near)
    ).toMatchObject({ reason: "TIME_DOES_NOT_ADD_UP" });
    expect(classifyDelivery(base, new Map())).toMatchObject({ reason: "NO_GPS_AT_DELIVERY" });
    expect(classifyDelivery(base, new Map([["e-1", 32325]]))).toMatchObject({
      reason: "FAR_FROM_ADDRESS",
      nearestMeters: 32325,
    });
  });

  it("returns null for an errand never marked delivered", () => {
    expect(classifyDelivery({ ...base, deliveredAt: null }, near)).toBeNull();
  });
});
