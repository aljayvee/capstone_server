import { describe, expect, it } from "vitest";
import { percentile } from "../src/services/dwellLearningService.js";

const sorted = (values: number[]) => [...values].sort((a, b) => a - b);

describe("dwell percentile", () => {
  it("returns the nearest-rank value at the median", () => {
    expect(percentile([100, 200, 300, 400, 500], 0.5)).toBe(300);
  });

  it("returns the nearest-rank value at p80", () => {
    expect(percentile([100, 200, 300, 400, 500], 0.8)).toBe(400);
  });

  it("resists the long right tail that would drag a mean upwards", () => {
    // Nine ordinary supermarket runs and one rider stuck behind a price check.
    const values = sorted([600, 620, 640, 660, 680, 700, 720, 740, 760, 3600]);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;

    expect(percentile(values, 0.5)).toBe(680);
    // The median lands on a typical run (~11 min) while the mean is dragged to
    // ~16 min by the single outlier. Promising the mean would over-quote every
    // ordinary errand — which is exactly why the model uses percentiles.
    expect(mean).toBeCloseTo(972, 0);
    expect(mean - percentile(values, 0.5)).toBeGreaterThan(280);
  });

  it("keeps p80 sensitive to the tail without being captured by it", () => {
    const values = sorted([600, 620, 640, 660, 680, 700, 720, 740, 760, 3600]);
    expect(percentile(values, 0.8)).toBe(740);
  });

  it("handles a single observation", () => {
    expect(percentile([450], 0.5)).toBe(450);
    expect(percentile([450], 0.8)).toBe(450);
  });

  it("returns 0 for an empty sample rather than NaN", () => {
    expect(percentile([], 0.5)).toBe(0);
  });

  it("clamps the rank inside the array at both extremes", () => {
    const values = [100, 200, 300];
    expect(percentile(values, 0)).toBe(100);
    expect(percentile(values, 1)).toBe(300);
  });
});
