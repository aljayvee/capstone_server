/**
 * Splitting one errand's money across the merchant categories it touched.
 *
 * The Sales and Commission reports used to group on `Errand.category`, which
 * `errandValidators.ts` pins to the literal "Pabili" — so a "revenue by
 * category" chart had exactly one bar. The real store dimension is
 * `MerchantCategory`, and an errand can touch up to three of them.
 *
 * Pure by design: no Prisma import, no dates, no I/O. Callers hand it evidence
 * already loaded and get numbers back — the same shape as commissionSplit.ts,
 * and for the same reason: the arithmetic that decides money is the part that
 * most needs to be testable without a database.
 */

/** Where money lands when nothing in the record says which shop it went to. */
export const UNCATEGORISED = "Uncategorised";

/**
 * Which evidence decides the split, strongest first. The first tier that yields
 * a positive total wins outright; tiers below it are not consulted.
 *
 * Exported as one array so changing the policy is a one-line edit rather than a
 * hunt through branches.
 */
export const REVENUE_WEIGHT_TIERS = [
  "RECEIPTS",
  "CUSTOMER_ITEMS",
  "WORKING_ITEMS",
  "PINNED_STOPS",
  "UNCATEGORISED",
] as const;

export type WeightTier = (typeof REVENUE_WEIGHT_TIERS)[number];

export interface CategoryEvidence {
  /** Receipts and no-receipt declarations, bucketed by their stop's category. */
  receipts: Array<{ categoryName: string | null; amount: number }>;
  /** The customer's own original picks (`PabiliItemRequest.storeCategory`). */
  customerItems: Array<{ categoryName: string | null; quantity: number }>;
  /** The dispatcher-corrected working copy (`PabiliDetail.storeCategory`). */
  workingItems: Array<{ categoryName: string | null; quantity: number }>;
  /** Categories of the stops a dispatcher actually pinned. */
  pinnedCategories: Array<string | null>;
}

export interface WeightResult {
  /** Category name to relative weight. Never empty; never all-zero. */
  weights: Map<string, number>;
  /** Which tier produced these, so a disputed figure traces to a rule. */
  source: WeightTier;
}

/**
 * Decides how one errand's money divides between categories.
 *
 * ## Why receipts outrank the customer's own picks here
 *
 * This deliberately INVERTS the authority order in `categoryFeeModes.ts`, which
 * lets the customer's `PabiliItemRequest.storeCategory` beat the dispatcher's
 * pins. That file is right for its question and this one is right for a
 * different question:
 *
 *  - A **fee** is a price the customer agreed to and must be able to predict
 *    from what they themselves selected. Letting a dispatcher's re-pin move the
 *    basket into a PERCENT category re-priced the whole order after the fact —
 *    the 50-peso quote that became a 500-peso charge described in that file.
 *  - **Revenue attribution** asks which kind of shop the money physically
 *    passed through. A receipt with a stop attached answers that; a category
 *    typed before anyone pinned a store only guesses at it.
 *
 * The decisive practical point: `Errand.estimatedCost` IS the sum of these
 * receipt amounts (`proofImageService.confirmedReceiptTotal` feeds
 * `errandService.markItemsPurchased`). Weighting by anything else would make the
 * per-category item totals contradict the receipts sitting in the same database.
 *
 * The consequence to keep in view: a grocery run the customer filed as fast food
 * reports its MONEY under grocery while its FEE was computed under fast food.
 * Both are correct for their own question, and the Sales report says so in its
 * notes rather than leaving an owner to discover the mismatch.
 *
 * ## Why item quantity, and not item subtotal, is the fallback weight
 *
 * `PabiliDetail.estimatedSubtotal` and `.unitPrice` are zero on every row: the
 * CustomerApp posts literal zeros, and `pabiliDetailRepository.replaceForErrand`
 * does not write those columns at all, so a dispatcher edit resets them to the
 * schema default. `PabiliItemRequest` carries no price columns whatsoever.
 * Weighting by subtotal would divide by zero on 100% of errands. Quantity is the
 * only per-item magnitude the record actually holds.
 *
 * @param activeNames Names of Active MerchantCategory rows. Free-text
 *   `storeCategory` values that no longer match one (retired, renamed, or the
 *   leftover "test1") are dropped rather than invented as categories — the same
 *   treatment `categoryFeeModes.modesForCategoryNames` gives them.
 */
export function buildWeights(
  evidence: CategoryEvidence,
  activeNames: ReadonlySet<string>
): WeightResult {
  // Money that was actually spent, at a stop of a known kind.
  const receipts = new Map<string, number>();
  for (const r of evidence.receipts) {
    const name = resolve(r.categoryName, activeNames);
    if (!name || !(r.amount > 0)) continue;
    receipts.set(name, (receipts.get(name) ?? 0) + r.amount);
  }
  if (receipts.size > 0) return { weights: receipts, source: "RECEIPTS" };

  const customer = quantityWeights(evidence.customerItems, activeNames);
  if (customer.size > 0) return { weights: customer, source: "CUSTOMER_ITEMS" };

  const working = quantityWeights(evidence.workingItems, activeNames);
  if (working.size > 0) return { weights: working, source: "WORKING_ITEMS" };

  // No item anywhere resolves. The stops are the last thing that says what kind
  // of shopping this was — mirroring resolveCategoryModes' own final fallback.
  // Each distinct stop counts once, so a two-stop errand splits evenly.
  const pinned = new Map<string, number>();
  for (const raw of evidence.pinnedCategories) {
    const name = resolve(raw, activeNames);
    if (!name) continue;
    pinned.set(name, 1);
  }
  if (pinned.size > 0) return { weights: pinned, source: "PINNED_STOPS" };

  // Nothing at all. The money still has to be reported somewhere — dropping it
  // would silently shrink the report's total below the business's own takings.
  return { weights: new Map([[UNCATEGORISED, 1]]), source: "UNCATEGORISED" };
}

function quantityWeights(
  items: Array<{ categoryName: string | null; quantity: number }>,
  activeNames: ReadonlySet<string>
): Map<string, number> {
  const weights = new Map<string, number>();
  for (const item of items) {
    const name = resolve(item.categoryName, activeNames);
    if (!name) continue;
    // A row with quantity 0 or a bad value is still one requested thing.
    const qty = Number.isFinite(item.quantity) && item.quantity > 0 ? item.quantity : 1;
    weights.set(name, (weights.get(name) ?? 0) + qty);
  }
  return weights;
}

function resolve(raw: string | null, activeNames: ReadonlySet<string>): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return activeNames.has(trimmed) ? trimmed : null;
}

/**
 * Divides `amount` across `weights` so the parts sum to `amount` exactly.
 *
 * Integer centavos with largest-remainder distribution. Floats are never summed,
 * because the obvious implementation does not reconcile: 1,000 pesos across
 * three equal categories is 333.33 three times, and the report is then a centavo
 * short of its own headline. An owner who adds a column by hand and gets a
 * different number than the tile above it stops trusting the whole page.
 *
 * Largest-remainder rather than dumping the residual into the biggest bucket:
 * it bounds the error at one centavo per bucket instead of concentrating it.
 *
 * The tie-break is three-deep (remainder, then weight, then name) so the same
 * input always produces byte-identical output. A report that changes between two
 * refreshes is a report nobody can act on.
 *
 * Negative amounts are supported — settlement variance is a real figure that
 * runs both ways — and reconcile with the sign preserved.
 */
export function allocate(
  amount: number,
  weights: ReadonlyMap<string, number>
): Map<string, number> {
  const entries = [...weights.entries()].filter(([, w]) => Number.isFinite(w) && w > 0);
  const totalWeight = entries.reduce((sum, [, w]) => sum + w, 0);

  // Nothing to divide by. Route the money to the residual bucket rather than
  // throwing or, worse, returning an empty map that quietly loses it.
  if (entries.length === 0 || totalWeight <= 0) {
    return new Map([[UNCATEGORISED, round2(amount)]]);
  }

  const sign = amount < 0 ? -1 : 1;
  const totalCentavos = Math.round(Math.abs(amount) * 100);

  // Zero still returns every key, so a caller folding many errands together sees
  // a stable key set rather than categories blinking in and out of existence.
  if (totalCentavos === 0) {
    return new Map(entries.map(([name]) => [name, 0]));
  }

  const parts = entries.map(([name, weight]) => {
    const raw = (totalCentavos * weight) / totalWeight;
    const floor = Math.floor(raw);
    return { name, weight, floor, remainder: raw - floor };
  });

  const distributed = parts.reduce((sum, p) => sum + p.floor, 0);
  let short = totalCentavos - distributed; // 0 <= short < parts.length

  const ordered = [...parts].sort(
    (a, b) => b.remainder - a.remainder || b.weight - a.weight || a.name.localeCompare(b.name)
  );
  for (const part of ordered) {
    if (short <= 0) break;
    part.floor += 1;
    short -= 1;
  }

  return new Map(parts.map((p) => [p.name, (sign * p.floor) / 100]));
}

/**
 * The single category an errand counts as one order under.
 *
 * Order counts cannot be allocated the way money can — half an errand is not a
 * thing. Counting the errand once in every category it touched would push the
 * column past the report's own `totalOrders`, so it lands in whichever category
 * holds the largest share of its money, ties broken by name for determinism.
 */
export function primaryCategory(weights: ReadonlyMap<string, number>): string {
  let best: { name: string; weight: number } | null = null;
  for (const [name, weight] of weights) {
    if (!best || weight > best.weight || (weight === best.weight && name < best.name)) {
      best = { name, weight };
    }
  }
  return best?.name ?? UNCATEGORISED;
}

/**
 * The shape of a loaded errand this module can read evidence out of.
 *
 * Structural rather than a Prisma type, so this file stays free of the client
 * and its tests need no database. Both `errandRepository
 * .findForCategoryAllocationBetween` and `customerTransactionRepository`'s
 * report include select exactly these fields.
 */
export interface ErrandCategoryRow {
  pabiliItemRequests: Array<{ storeCategory: string | null; quantity: number }>;
  pabiliDetails: Array<{ storeCategory: string | null; quantity: number }>;
  pinpoints: Array<{ id: number; category: { name: string } | null }>;
  proofImages: Array<{
    pinpointId: number | null;
    declaredTotal: number | null;
    extraction: { confirmedTotal: number | null } | null;
  }>;
}

/**
 * Reads one loaded errand into the evidence `buildWeights` consumes.
 *
 * The receipt amount mirrors `proofImageService.confirmedReceiptTotal` exactly —
 * a confirmed extraction, else the rider's declared figure. A machine's
 * unconfirmed guess never counts, and a declared amount from a receiptless shop
 * spends the same money as a read one, so it joins on the same terms.
 *
 * A receipt with no `pinpointId` cannot be attributed to a shop and yields a
 * null category, which `buildWeights` then ignores — so an errand whose receipts
 * are all unattached falls through to its items rather than pretending the money
 * has a home.
 */
export function toCategoryEvidence(row: ErrandCategoryRow): CategoryEvidence {
  const pinpoints = row.pinpoints ?? [];
  const proofImages = row.proofImages ?? [];
  const pabiliItemRequests = row.pabiliItemRequests ?? [];
  const pabiliDetails = row.pabiliDetails ?? [];

  const categoryByPinpoint = new Map<number, string | null>(
    pinpoints.map((p) => [p.id, p.category?.name ?? null])
  );

  return {
    receipts: proofImages.map((img) => ({
      categoryName: img.pinpointId === null ? null : categoryByPinpoint.get(img.pinpointId) ?? null,
      amount: img.extraction?.confirmedTotal ?? img.declaredTotal ?? 0,
    })),
    customerItems: pabiliItemRequests.map((i) => ({
      categoryName: i.storeCategory,
      quantity: i.quantity,
    })),
    workingItems: pabiliDetails.map((i) => ({
      categoryName: i.storeCategory,
      quantity: i.quantity,
    })),
    pinnedCategories: pinpoints.map((p) => p.category?.name ?? null),
  };
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
