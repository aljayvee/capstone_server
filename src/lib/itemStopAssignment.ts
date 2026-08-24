/**
 * Deciding which pinned stop each requested item is bought at.
 *
 * The customer picks store *categories*, not stores — "Fast Food & Restaurant",
 * with everything they want filed under it. The dispatcher then reads the list,
 * works out that the noodles are not fast food, and pins two real shops. From
 * that moment the authoritative answer to "what do I buy here?" is the
 * dispatcher's, not the customer's.
 *
 * The dispatcher records that answer inside the item's `storeCategory` string,
 * which their editor writes as "<store label> | <merchant category>" — for
 * example "Store 2 - Primark Save More | Supermarket & Grocery". Items the
 * dispatcher never touched keep the customer's plain category name.
 *
 * Both forms are resolved here, in one pure function, so the rule is testable
 * without a database and identical wherever it is applied.
 */

export interface AssignableItem {
  id: number;
  storeCategory: string | null;
}

export interface AssignableStop {
  id: number;
  /** 1-based position in the visit order, as shown to the dispatcher. */
  sequence: number;
  storeName: string;
  categoryName: string | null;
}

/** "Store 2", "Store 2 - Primark Save More" — the dispatcher's store labels. */
const STORE_LABEL_PATTERN = /^store\s*\d+\b/i;

const normalise = (value: string | null | undefined): string =>
  (value ?? "").trim().toLowerCase();

/**
 * Splits the dispatcher's composite label. Items the dispatcher never edited
 * have no separator, in which case the whole string is the category — which is
 * exactly what the customer's app wrote.
 */
export function parseStoreCategory(raw: string | null): {
  storeLabel: string | null;
  categoryName: string | null;
} {
  if (!raw) return { storeLabel: null, categoryName: null };

  const separator = raw.indexOf("|");
  if (separator !== -1) {
    return {
      storeLabel: raw.slice(0, separator).trim() || null,
      categoryName: raw.slice(separator + 1).trim() || null,
    };
  }

  // No separator. Usually the customer's plain category name — but the
  // dispatcher's editor also defaults an item with no category at all to a bare
  // "Store 1 - Jollibee", with no category half. Read that as the store it
  // plainly is, rather than hunting for a merchant category by that name and
  // finding none.
  const bare = raw.trim();
  if (!bare) return { storeLabel: null, categoryName: null };
  if (STORE_LABEL_PATTERN.test(bare)) return { storeLabel: bare, categoryName: null };

  return { storeLabel: null, categoryName: bare };
}

/**
 * "Store 2 - Primark Save More" -> 2. The dispatcher's editor numbers stores by
 * their position in the visit order, so this is the most reliable signal it
 * gives us: it survives the store being renamed.
 */
function storeOrdinalFrom(label: string): number | null {
  const match = /^store\s*(\d+)\b/i.exec(label.trim());
  if (!match) return null;

  const ordinal = Number(match[1]);
  return Number.isInteger(ordinal) && ordinal > 0 ? ordinal : null;
}

function matchByStoreLabel(label: string, stops: AssignableStop[]): AssignableStop | null {
  const ordinal = storeOrdinalFrom(label);
  if (ordinal !== null) {
    const bySequence = stops.find((s) => s.sequence === ordinal);
    if (bySequence) return bySequence;
  }

  const wanted = normalise(label);
  if (!wanted) return null;

  const exact = stops.find((s) => normalise(s.storeName) === wanted);
  if (exact) return exact;

  // The label carries the store name inside it ("Store 2 - Primark Save More"),
  // so fall back to containment before giving up. Longest name first, so
  // "Save More Primark" is preferred over a shop merely called "Save".
  const byName = [...stops]
    .sort((a, b) => b.storeName.length - a.storeName.length)
    .find((s) => {
      const name = normalise(s.storeName);
      return name.length > 0 && wanted.includes(name);
    });

  return byName ?? null;
}

function matchByCategory(categoryName: string, stops: AssignableStop[]): AssignableStop | null {
  const wanted = normalise(categoryName);
  if (!wanted) return null;
  // First stop of that category: with two branches of one chain pinned, the
  // earlier one is visited first and there is nothing else to separate them.
  return stops.find((s) => normalise(s.categoryName) === wanted) ?? null;
}

/**
 * Maps each item to the stop it should be bought at.
 *
 * Items that match nothing are simply absent from the result — they stay
 * unattached and show to the rider as a general list rather than being
 * invented onto a store they were never assigned to.
 */
export function assignItemsToStops(
  items: AssignableItem[],
  stops: AssignableStop[]
): { id: number; pinpointId: number }[] {
  if (items.length === 0 || stops.length === 0) return [];

  const assignments: { id: number; pinpointId: number }[] = [];

  for (const item of items) {
    const { storeLabel, categoryName } = parseStoreCategory(item.storeCategory);

    // The dispatcher's explicit store assignment wins over the category it
    // happens to be filed under: naming the store IS the correction.
    const stop =
      (storeLabel ? matchByStoreLabel(storeLabel, stops) : null) ??
      (categoryName ? matchByCategory(categoryName, stops) : null);

    if (stop) assignments.push({ id: item.id, pinpointId: stop.id });
  }

  return assignments;
}
