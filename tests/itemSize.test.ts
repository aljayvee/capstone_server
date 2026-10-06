import { describe, expect, it } from "vitest";
import { formatItemLabel } from "../src/services/patterns/itemLabel.js";
import {
  buildCreatedItemRows,
  buildReplacementRows,
  type ExistingDetailRow,
} from "../src/services/patterns/pabiliItemRows.js";
import { pabiliItemSchema } from "../src/validators/pabiliItemValidators.js";

/**
 * A pabili item's size, kept apart from its name.
 *
 * "5 Kilo of Chicken 2qty" is three facts: Chicken, 5 kg, two of them. The
 * size column holds the middle one. What a rider reads depends on two rules
 * tested here: fold mode, for rider builds that only read itemName, and the
 * carry-over, so a dispatcher build that predates the column cannot erase every
 * size on an order by saving it.
 */

describe("formatItemLabel", () => {
  it("joins name and size with a middle dot", () => {
    expect(formatItemLabel("Chicken", "5 kg")).toBe("Chicken · 5 kg");
  });

  it("is just the name when there is no size", () => {
    expect(formatItemLabel("Chicken", null)).toBe("Chicken");
    expect(formatItemLabel("Chicken", "  ")).toBe("Chicken");
  });

  it("does not repeat a size the name already ends with", () => {
    expect(formatItemLabel("Rice (5kg)", "5 kg")).toBe("Rice (5kg)");
    expect(formatItemLabel("Chicken · 5 kg", "5 kg")).toBe("Chicken · 5 kg");
  });

  it("still appends a size that only appears mid-name", () => {
    expect(formatItemLabel("Coke 1.5L Zero", "1.5 L")).toBe("Coke 1.5L Zero · 1.5 L");
  });
});

describe("creating an order's item rows", () => {
  const items = [{ itemName: "Chicken", size: "5 kg", quantity: 2, storeCategory: "Retail" }];

  it("keeps size in its own column in column mode", () => {
    const [row] = buildCreatedItemRows(items, "column");
    expect(row).toMatchObject({ itemName: "Chicken", size: "5 kg", quantity: 2, storeCategory: "Retail" });
  });

  it("folds size into the name in fold mode, for riders on an older build", () => {
    const [row] = buildCreatedItemRows(items, "fold");
    expect(row).toMatchObject({ itemName: "Chicken · 5 kg", size: null, quantity: 2 });
  });

  it("treats a missing or blank size as none", () => {
    const rows = buildCreatedItemRows([{ itemName: "Eggs" }, { name: "Milk", size: " " }], "column");
    expect(rows.map((r) => [r.itemName, r.size, r.quantity])).toEqual([
      ["Eggs", null, 1],
      ["Milk", null, 1],
    ]);
  });
});

describe("a dispatcher saving the list", () => {
  const stored: ExistingDetailRow[] = [
    { itemName: "Chicken", size: "5 kg", quantity: 2, storeCategory: "Retail", notes: null, fulfillmentStatus: "PURCHASED" },
    { itemName: "Rice", size: "25 kg", quantity: 1, storeCategory: "Grocery", notes: "Jasmine only", fulfillmentStatus: "PENDING" },
  ];

  it("keeps the stored size when an older client omits the field", () => {
    const rows = buildReplacementRows(
      stored,
      [
        { itemName: "Chicken", quantity: 2, storeCategory: "Retail" },
        { itemName: "Rice", quantity: 1, storeCategory: "Grocery" },
      ],
      "column"
    );
    expect(rows.map((r) => r.size)).toEqual(["5 kg", "25 kg"]);
    // Nothing changed, so the rider's PURCHASED tick survives.
    expect(rows[0].fulfillmentStatus).toBe("PURCHASED");
  });

  it("follows the item, not the position, when the list was reordered", () => {
    const rows = buildReplacementRows(
      stored,
      [
        { itemName: "Rice", quantity: 1, storeCategory: "Grocery" },
        { itemName: "Chicken", quantity: 2, storeCategory: "Retail" },
      ],
      "column"
    );
    expect(rows.map((r) => [r.itemName, r.size])).toEqual([
      ["Rice", "25 kg"],
      ["Chicken", "5 kg"],
    ]);
  });

  it("clears a size the dispatcher cleared", () => {
    const [row] = buildReplacementRows(stored, [{ itemName: "Chicken", quantity: 2, storeCategory: "Retail", size: null }], "column");
    expect(row.size).toBeNull();
  });

  it("counts a size change as a change, so the rider's checkbox comes back", () => {
    const [row] = buildReplacementRows(
      stored,
      [{ itemName: "Chicken", quantity: 2, storeCategory: "Retail", size: "3 kg" }],
      "column"
    );
    expect(row.size).toBe("3 kg");
    expect(row.fulfillmentStatus).toBe("PENDING");
  });

  it("does not hand a renamed item the old item's size", () => {
    const [row] = buildReplacementRows(stored, [{ itemName: "Pork", quantity: 2, storeCategory: "Retail" }], "column");
    expect(row.size).toBeNull();
  });

  it("keeps a folded row folded and its tick, in fold mode", () => {
    const folded: ExistingDetailRow[] = [
      { itemName: "Chicken · 5 kg", size: null, notes: null, quantity: 2, storeCategory: "Retail", fulfillmentStatus: "PURCHASED" },
    ];
    const [row] = buildReplacementRows(folded, [{ itemName: "Chicken", size: "5 kg", quantity: 2, storeCategory: "Retail" }], "fold");
    expect(row).toMatchObject({ itemName: "Chicken · 5 kg", size: null, fulfillmentStatus: "PURCHASED" });
  });
});

describe("item notes", () => {
  it("keeps notes in their own column in column mode", () => {
    const [row] = buildCreatedItemRows([{ itemName: "Sibuyas", size: "1/2 kg", notes: " paki pili yung walang bulok ", quantity: 1 }], "column");
    expect(row).toMatchObject({ itemName: "Sibuyas", size: "1/2 kg", notes: "paki pili yung walang bulok" });
  });

  it("folds the note into the name in fold mode, for riders on an older build", () => {
    const [row] = buildCreatedItemRows([{ itemName: "Sibuyas", size: "1/2 kg", notes: "walang bulok", quantity: 1 }], "fold");
    expect(row).toMatchObject({ itemName: "Sibuyas · 1/2 kg · Note: walang bulok", size: null, notes: null });
  });

  it("shortens a long folded note to fit the name column", () => {
    const [row] = buildCreatedItemRows([{ itemName: "x".repeat(120), size: "1 kg", notes: "y".repeat(200), quantity: 1 }], "fold");
    expect(row.itemName.length).toBeLessThanOrEqual(191);
    expect(row.itemName.endsWith("…")).toBe(true);
  });

  it("keeps the stored note when an older client omits it, and counts a changed note as a change", () => {
    const stored: ExistingDetailRow[] = [
      { itemName: "Rice", size: "25 kg", notes: "Jasmine only", quantity: 1, storeCategory: "Grocery", fulfillmentStatus: "PURCHASED" },
    ];
    const [kept] = buildReplacementRows(stored, [{ itemName: "Rice", quantity: 1, storeCategory: "Grocery" }], "column");
    expect(kept).toMatchObject({ notes: "Jasmine only", fulfillmentStatus: "PURCHASED" });
    const [changed] = buildReplacementRows(stored, [{ itemName: "Rice", quantity: 1, storeCategory: "Grocery", notes: "any brand" }], "column");
    expect(changed).toMatchObject({ notes: "any brand", fulfillmentStatus: "PENDING" });
  });
});

describe("the item validator's size field", () => {
  it("accepts a size, stores a blank one as null, and leaves an absent one absent", () => {
    expect(pabiliItemSchema.parse({ itemName: "Chicken", quantity: 2, size: " 5 kg " }).size).toBe("5 kg");
    expect(pabiliItemSchema.parse({ itemName: "Chicken", quantity: 2, size: "" }).size).toBeNull();
    expect("size" in pabiliItemSchema.parse({ itemName: "Chicken", quantity: 2 })).toBe(false);
  });

  it("refuses a size over 40 characters", () => {
    expect(() => pabiliItemSchema.parse({ itemName: "Chicken", quantity: 1, size: "x".repeat(41) })).toThrow();
  });
});
