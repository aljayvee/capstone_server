import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/repositories/errandRepository.js", () => ({
  errandRepository: { aggregateBetween: vi.fn(), findForCategoryAllocationBetween: vi.fn() },
}));
vi.mock("../src/services/patterns/categoryFeeModes.js", () => ({
  activeCategoryNameSet: vi.fn(),
}));

import { errandRepository } from "../src/repositories/errandRepository.js";
import { activeCategoryNameSet } from "../src/services/patterns/categoryFeeModes.js";
import { getCommissionReport, getSalesReport } from "../src/services/reportService.js";

const ACTIVE = new Set([
  "Fast Food & Restaurant",
  "Pharmacy & Health",
  "Supermarket & Grocery",
  "Retail & General Merchandise",
]);

interface ErrandOptions {
  totalCost: number;
  deliveryFee?: number;
  tip?: number;
  estimatedCost?: number;
  receipts?: Array<{ pinpointId: number | null; amount: number }>;
  customerItems?: Array<{ storeCategory: string | null; quantity: number }>;
  workingItems?: Array<{ storeCategory: string | null; quantity: number }>;
  pinpoints?: Array<{ id: number; categoryName: string | null }>;
}

function errand(id: string, o: ErrandOptions) {
  return {
    id,
    totalCost: o.totalCost,
    deliveryFee: o.deliveryFee ?? 50,
    tip: o.tip ?? 0,
    estimatedCost: o.estimatedCost ?? 0,
    commission: null,
    pabiliItemRequests: o.customerItems ?? [],
    // Zero on every production row — the whole reason weights are not subtotals.
    pabiliDetails: o.workingItems ?? [],
    pinpoints: (o.pinpoints ?? []).map((p) => ({
      id: p.id,
      category: p.categoryName ? { name: p.categoryName, status: "Active" } : null,
    })),
    proofImages: (o.receipts ?? []).map((r) => ({
      pinpointId: r.pinpointId,
      declaredTotal: r.amount,
      extraction: null,
    })),
  };
}

/** A mixed period: receipts, customer picks, a retired name, and nothing at all. */
const FIXTURE = [
  // Receipts across two stops of different kinds — a proportional split.
  errand("a", {
    totalCost: 1000,
    deliveryFee: 60,
    tip: 10,
    estimatedCost: 930,
    pinpoints: [
      { id: 1, categoryName: "Supermarket & Grocery" },
      { id: 2, categoryName: "Pharmacy & Health" },
    ],
    receipts: [
      { pinpointId: 1, amount: 700 },
      { pinpointId: 2, amount: 230 },
    ],
  }),
  // No receipts; falls to the customer's own picks, weighted by quantity.
  errand("b", {
    totalCost: 333.33,
    deliveryFee: 50,
    customerItems: [
      { storeCategory: "Fast Food & Restaurant", quantity: 2 },
      { storeCategory: "Pharmacy & Health", quantity: 1 },
    ],
  }),
  // Customer picked a retired category; the pinned stop is the only signal left.
  errand("c", {
    totalCost: 275.5,
    deliveryFee: 55,
    customerItems: [{ storeCategory: "test1", quantity: 4 }],
    pinpoints: [{ id: 3, categoryName: "Retail & General Merchandise" }],
  }),
  // Nothing at all — must land in Uncategorised, not vanish.
  errand("d", { totalCost: 91.67, deliveryFee: 50 }),
  // A single category, the ordinary case.
  errand("e", {
    totalCost: 500.01,
    deliveryFee: 75,
    tip: 25,
    customerItems: [{ storeCategory: "Supermarket & Grocery", quantity: 3 }],
  }),
];

const TOTAL_REVENUE = 2200.51; // 1000 + 333.33 + 275.50 + 91.67 + 500.01

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(activeCategoryNameSet).mockResolvedValue(ACTIVE);
  vi.mocked(errandRepository.findForCategoryAllocationBetween).mockResolvedValue(FIXTURE as never);
  vi.mocked(errandRepository.aggregateBetween).mockResolvedValue({
    _sum: {
      totalCost: TOTAL_REVENUE,
      deliveryFee: 290,
      estimatedCost: 930,
      tip: 35,
    },
    _count: { _all: FIXTURE.length },
  } as never);
});

const sum = (ns: number[]) => Math.round(ns.reduce((a, b) => a + b, 0) * 100) / 100;

describe("sales report — category allocation reconciles", () => {
  it("sums category revenue exactly to the headline total", async () => {
    // The property the whole report rests on. An owner who adds the column by
    // hand and gets a different number from the tile stops trusting the page.
    const report = await getSalesReport({ period: "MONTHLY", date: new Date() });

    expect(sum(report.byCategory.map((c) => c.revenue))).toBe(report.totalRevenue);
    expect(report.reconciliation.difference).toBe(0);
  });

  it("counts each errand exactly once across the category column", async () => {
    const report = await getSalesReport({ period: "MONTHLY", date: new Date() });

    expect(sum(report.byCategory.map((c) => c.orderCount))).toBe(report.totalOrders);
  });

  it("reports more touched errands than counted ones where an errand spans stops", async () => {
    // Errand "a" touches two categories. touchedOrderCount legitimately exceeds
    // orderCount, which is exactly why the two are separate fields.
    const report = await getSalesReport({ period: "MONTHLY", date: new Date() });

    expect(sum(report.byCategory.map((c) => c.touchedOrderCount))).toBeGreaterThan(report.totalOrders);
  });

  it("names real merchant categories rather than the literal Pabili", async () => {
    const report = await getSalesReport({ period: "MONTHLY", date: new Date() });
    const names = report.byCategory.map((c) => c.category);

    expect(names).not.toContain("Pabili");
    expect(names).toContain("Supermarket & Grocery");
    expect(names).toContain("Pharmacy & Health");
  });

  it("keeps unattributable money instead of dropping it, and sorts it last", async () => {
    const report = await getSalesReport({ period: "MONTHLY", date: new Date() });

    expect(report.uncategorisedRevenue).toBeGreaterThan(0);
    expect(report.byCategory[report.byCategory.length - 1].category).toBe("Uncategorised");
  });

  it("splits a two-stop errand in proportion to what was spent at each stop", async () => {
    // Errand "a": 700 of 930 at the supermarket, 230 at the pharmacy. Its ₱1,000
    // total therefore lands roughly 75/25, not 50/50.
    const report = await getSalesReport({ period: "MONTHLY", date: new Date() });
    const grocery = report.byCategory.find((c) => c.category === "Supermarket & Grocery")!;
    const pharmacy = report.byCategory.find((c) => c.category === "Pharmacy & Health")!;

    expect(grocery.revenue).toBeGreaterThan(pharmacy.revenue);
  });
});

describe("commission report — shares reconcile", () => {
  it("sums business share across categories to the headline commission", async () => {
    // REGRESSION: the headline used to split the period's SUMMED fees while the
    // column split each errand, so they disagreed by a centavo on real data
    // (₱442.20 against ₱442.19) — a total that did not match the column under it.
    const report = await getCommissionReport({ period: "MONTHLY", date: new Date() });

    expect(sum(report.byCategory.map((c) => c.businessShare))).toBe(report.estimatedCommission);
  });

  it("sums rider share across categories to the headline rider commission", async () => {
    const report = await getCommissionReport({ period: "MONTHLY", date: new Date() });

    expect(sum(report.byCategory.map((c) => c.riderShare))).toBe(report.riderCommission);
  });

  it("keeps item money out of both shares", async () => {
    // The fixture fronts ₱930 for goods. Neither share may contain any of it.
    const report = await getCommissionReport({ period: "MONTHLY", date: new Date() });

    expect(report.estimatedCommission + report.riderCommission).toBeLessThan(400);
    expect(report.commissionRate).toBe(0.7);
  });
});
