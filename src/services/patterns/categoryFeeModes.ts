import { prisma } from "../../lib/prisma.js";
import type { HandlingFeeMode } from "./pricingStrategy.js";

/**
 * Which fee modes apply to one errand — that is, which handling fee it carries.
 *
 * Two sources, available at two different moments:
 *
 *  - **The customer's own categories**, picked when they listed their items and
 *    recorded as `PabiliItemRequest.storeCategory`. Immutable, and the basis on
 *    which they were quoted.
 *  - **The dispatcher's pinned stops**, where `ErrandPinpoint.categoryId` is a
 *    real foreign key to the shop the rider will stand in.
 *
 * The customer's categories win, and the pinned stops are consulted only when
 * the customer's yield nothing resolvable.
 *
 * This preference used to run the other way, on the reasoning that a dispatcher
 * who pins a supermarket has made the better judgement about what kind of errand
 * this is. That reasoning is sound and the outcome was still wrong, because the
 * fee modes differ: moving one mis-filed item to a PERCENT category re-priced
 * the WHOLE basket at a percentage. A customer who ordered ₱5,000 of goods under
 * one FLAT category was quoted ₱50 and charged ₱500 — a charge that appeared
 * after they had agreed, for a decision they did not make and cannot audit.
 *
 * It is the same rule as pricingStoreCount, for the same reason: the dispatcher
 * decides how the errand is FULFILLED, and that properly moves the distance fee,
 * which tracks real kilometres. It does not decide what the customer agreed to
 * pay for handling.
 *
 * The company does absorb the float when a customer genuinely mis-files a large
 * grocery run as fast food. That is the accepted cost of a fee a customer can
 * predict from what they themselves selected.
 *
 * An unresolvable category — retired, renamed, or the leftover "test1" — yields
 * nothing rather than an error, and the caller falls back to THRESHOLD. That is
 * deliberate: live rows still carry a "test1" storeCategory, and they must price
 * the way they always have rather than failing.
 */
export async function resolveCategoryModes(errandId: string): Promise<HandlingFeeMode[]> {
  const items = await prisma.pabiliItemRequest.findMany({
    where: { errandId, storeCategory: { not: null } },
    select: { storeCategory: true },
  });

  if (items.length > 0) {
    const names = dedupe(items.map((i) => i.storeCategory!));
    const modes = await modesForCategoryNames(names);
    if (modes.length > 0) return modes;
  }

  // Nothing the customer chose still resolves to an active category. The stops
  // are the only remaining signal for what kind of shopping this is.
  const pinpoints = await prisma.errandPinpoint.findMany({
    where: { errandId, categoryId: { not: null } },
    select: { category: { select: { handlingFeeMode: true } } },
  });

  return dedupe(pinpoints.map((p) => p.category!.handlingFeeMode as HandlingFeeMode));
}

/**
 * Modes for a set of category NAMES — the pre-creation path, where no errand row
 * exists yet to look pinpoints up from.
 *
 * Matches on name because that is the only handle the client has. Inactive
 * categories are excluded: a retired store type must not carry pricing authority.
 */
export async function modesForCategoryNames(names: string[]): Promise<HandlingFeeMode[]> {
  const wanted = dedupe(names.map((n) => n.trim()).filter(Boolean));
  if (wanted.length === 0) return [];

  const categories = await prisma.merchantCategory.findMany({
    where: { name: { in: wanted }, status: "Active" },
    select: { handlingFeeMode: true },
  });

  return dedupe(categories.map((c) => c.handlingFeeMode as HandlingFeeMode));
}

function dedupe<T>(values: T[]): T[] {
  return [...new Set(values)];
}
