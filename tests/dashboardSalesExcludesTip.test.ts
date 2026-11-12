import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/repositories/userRepository.js", () => ({
  userRepository: { findAllRiders: vi.fn() },
}));
vi.mock("../src/repositories/errandRepository.js", () => ({
  errandRepository: { countByStatus: vi.fn(), findRevenueRowsBetween: vi.fn() },
}));
vi.mock("../src/services/riderBeaconService.js", () => ({
  availabilityForRiders: vi.fn(),
}));

import { userRepository } from "../src/repositories/userRepository.js";
import { errandRepository } from "../src/repositories/errandRepository.js";
import * as riderBeaconService from "../src/services/riderBeaconService.js";
import { getDashboardSummary } from "../src/services/analyticsService.js";

// totalCost is items + delivery fee + tip, as every prod row is. The business
// takes no tips, so sales is items + delivery fee: 480 + 50 and 430 + 58.
const ROWS = [
  { createdAt: new Date(2026, 9, 2, 10), totalCost: 550, deliveryFee: 50, tip: 20, estimatedCost: 480 },
  { createdAt: new Date(2026, 9, 3, 10), totalCost: 488, deliveryFee: 58, tip: 0, estimatedCost: 430 },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(userRepository.findAllRiders).mockResolvedValue([] as never);
  vi.mocked(errandRepository.countByStatus).mockResolvedValue([] as never);
  vi.mocked(errandRepository.findRevenueRowsBetween).mockResolvedValue(ROWS as never);
  vi.mocked(riderBeaconService.availabilityForRiders).mockResolvedValue(new Map());
});

describe("dashboard sales leave the tip out", () => {
  it("states gross as items plus delivery fees, the Sales report's figure", async () => {
    // REGRESSION: gross summed totalCost, so 100 seeded ₱20 tips on prod put the
    // tile ₱2,000 above the Sales report's Total sales.
    const summary = await getDashboardSummary("MONTH", {
      start: new Date(2026, 9, 1),
      end: new Date(2026, 9, 7),
    });

    expect(summary.revenue.gross).toBe(1018);
  });

  it("charts the same tip-free figure in every trend point", async () => {
    const summary = await getDashboardSummary("MONTH", {
      start: new Date(2026, 9, 1),
      end: new Date(2026, 9, 7),
    });
    const revenueOf = (day: number) => summary.trend.find((p) => p.label.endsWith(`10/${day}`))?.revenue;

    expect(revenueOf(2)).toBe(530);
    expect(revenueOf(3)).toBe(488);
    expect(summary.trend.reduce((sum, p) => sum + p.revenue, 0)).toBe(summary.revenue.gross);
  });
});
