import { describe, expect, it } from "vitest";
import {
  activeHoursFor,
  meanMinutesBetween,
  onTimePerformance,
} from "../src/services/riderPerformanceService.js";

const AT = (iso: string) => new Date(iso);

interface ErrandFixture {
  riderId: number | null;
  assignedAt: Date | null;
  acceptedAt: Date | null;
  deliveredAt: Date | null;
  completedAt: Date | null;
  etaHighAt: Date | null;
  etaIsDegraded: boolean;
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
  it("divides by errands that carried an ETA, not by every errand", () => {
    // 10 finished errands, 4 quoted, 3 of those on time. The rate is 0.75.
    // Dividing by all 10 would give 0.3 and score the rider down for every job
    // the routing layer never quoted — the system's silence, not their lateness.
    const quoted = (deliveredIso: string, etaIso: string) =>
      errand({ deliveredAt: AT(deliveredIso), etaHighAt: AT(etaIso) });

    const rows = [
      quoted("2026-09-01T10:00:00Z", "2026-09-01T10:30:00Z"),
      quoted("2026-09-01T11:00:00Z", "2026-09-01T11:30:00Z"),
      quoted("2026-09-01T12:00:00Z", "2026-09-01T12:30:00Z"),
      quoted("2026-09-01T14:00:00Z", "2026-09-01T13:30:00Z"), // late
      ...Array.from({ length: 6 }, () => errand({ deliveredAt: AT("2026-09-01T15:00:00Z") })),
    ];

    const result = onTimePerformance(rows);
    expect(result.onTimeRate).toBe(0.75);
    expect(result.onTimeDenominator).toBe(4);
  });

  it("counts delivery exactly at the ETA high bound as on time", () => {
    const rows = [
      errand({ deliveredAt: AT("2026-09-01T10:30:00Z"), etaHighAt: AT("2026-09-01T10:30:00Z") }),
    ];

    expect(onTimePerformance(rows).onTimeRate).toBe(1);
  });

  it("returns null, not zero, when no errand carried an ETA", () => {
    const rows = [errand({ deliveredAt: AT("2026-09-01T10:00:00Z") })];
    const result = onTimePerformance(rows);

    expect(result.onTimeRate).toBeNull();
    expect(result.onTimeDenominator).toBe(0);
  });

  it("reports how many of the quoted ETAs were degraded estimates", () => {
    // etaIsDegraded marks an ETA the router fell back to rather than measured.
    // Being judged late against a guess is worth being able to see.
    const rows = [
      errand({
        deliveredAt: AT("2026-09-01T11:00:00Z"),
        etaHighAt: AT("2026-09-01T10:30:00Z"),
        etaIsDegraded: true,
      }),
      errand({ deliveredAt: AT("2026-09-01T10:00:00Z"), etaHighAt: AT("2026-09-01T10:30:00Z") }),
    ];

    const result = onTimePerformance(rows);
    expect(result.onTimeDenominator).toBe(2);
    expect(result.degradedEtaCount).toBe(1);
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
