import { formatItemLabel } from "./itemLabel.js";

/**
 * Turning item input into the rows both item tables store.
 *
 * Pure, so the two rules that decide what a rider reads are testable without a
 * database:
 *
 *  - Fold or column. Rider builds that predate the size and notes columns read
 *    itemName only. Until every rider phone has the build that renders them,
 *    ITEM_SIZE_STORAGE=fold writes "Sibuyas · 1/2 kg · Note: walang bulok" into
 *    itemName and leaves both columns null, so no rider ever misses a size or
 *    an instruction. Switching to column needs no client release: the customer
 *    app always sends them apart.
 *
 *  - Carry-over. replaceForErrand deletes and recreates every row. A client
 *    built before these columns existed sends neither, and without carrying
 *    the stored values forward its first save would erase them all.
 */

export type ItemSizeStorage = "fold" | "column";

/** The itemName column: Prisma's default String, VARCHAR(191) on MariaDB. */
const ITEM_NAME_MAX = 191;

export interface ItemRowInput {
  itemName?: string;
  name?: string;
  storeCategory?: string;
  quantity?: number;
  /** undefined: the client did not say. null: the client cleared it. */
  size?: string | null;
  /** Same three states as size. */
  notes?: string | null;
  unitPrice?: number;
  estimatedSubtotal?: number;
}

export interface StoredItemRow {
  itemName: string;
  storeCategory: string | null;
  quantity: number;
  size: string | null;
  notes: string | null;
}

function clean(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed ? trimmed : null;
}

/** "Sibuyas · 1/2 kg · Note: paki pili", cut to fit itemName with the note shortened first. */
function foldedName(name: string, size: string | null, notes: string | null): string {
  const label = formatItemLabel(name, size);
  if (!notes) return label.slice(0, ITEM_NAME_MAX);
  const prefix = `${label} · Note: `;
  const room = ITEM_NAME_MAX - prefix.length;
  if (room < 8) return label.slice(0, ITEM_NAME_MAX);
  return prefix + (notes.length > room ? `${notes.slice(0, room - 1).trimEnd()}…` : notes);
}

/** Name, size and notes as this mode stores them. */
export function storedFields(
  name: string,
  size: string | null | undefined,
  notes: string | null | undefined,
  mode: ItemSizeStorage
): { itemName: string; size: string | null; notes: string | null } {
  const resolvedSize = clean(size);
  const resolvedNotes = clean(notes);
  if (mode === "fold") return { itemName: foldedName(name, resolvedSize, resolvedNotes), size: null, notes: null };
  return { itemName: name, size: resolvedSize, notes: resolvedNotes };
}

/** Rows for a new order, the same shape for the working copy and the audit mirror. */
export function buildCreatedItemRows(items: ItemRowInput[], mode: ItemSizeStorage) {
  return items.map((item) => {
    const { itemName, size, notes } = storedFields(item.itemName || item.name || "Item", item.size, item.notes, mode);
    return {
      itemName,
      size,
      notes,
      storeCategory: item.storeCategory || null,
      quantity: parseInt(String(item.quantity || 1), 10),
      unitPrice: parseFloat(String(item.unitPrice || 0)),
      estimatedSubtotal: parseFloat(String(item.estimatedSubtotal || 0)),
    };
  });
}

const normalize = (v?: string | null) => String(v ?? "").trim().toLowerCase();

export interface ExistingDetailRow extends StoredItemRow {
  fulfillmentStatus: string | null;
}

export interface ReplacementInput {
  itemName: string;
  storeCategory?: string;
  quantity: number;
  size?: string | null;
  notes?: string | null;
}

/**
 * The working copy after a dispatcher saves.
 *
 * Same index rule as before for fulfillmentStatus: an item left exactly as it
 * was keeps PURCHASED or OUT_OF_STOCK, anything changed goes back to PENDING so
 * the rider's checkbox comes back. Size and notes count as changes.
 */
export function buildReplacementRows(
  existing: ExistingDetailRow[],
  items: ReplacementInput[],
  mode: ItemSizeStorage
) {
  const claimed = new Set<number>();

  return items.map((item, index) => {
    // The stored row this one continues: same position and name first, then any
    // unclaimed row with the same name, for a list the client reordered.
    let prevIndex = -1;
    if (existing[index] && normalize(existing[index].itemName) === normalize(item.itemName)) {
      prevIndex = index;
    } else {
      prevIndex = existing.findIndex(
        (row, i) => !claimed.has(i) && normalize(row.itemName) === normalize(item.itemName)
      );
    }
    if (prevIndex !== -1) claimed.add(prevIndex);
    const carried = prevIndex !== -1 ? existing[prevIndex] : undefined;

    const requestedSize = item.size === undefined ? carried?.size ?? null : item.size;
    const requestedNotes = item.notes === undefined ? carried?.notes ?? null : item.notes;
    const { itemName, size, notes } = storedFields(item.itemName, requestedSize, requestedNotes, mode);

    const prev = existing[index];
    const isUnmodified =
      prev !== undefined &&
      normalize(prev.itemName) === normalize(itemName) &&
      Number(prev.quantity) === Number(item.quantity) &&
      normalize(prev.storeCategory) === normalize(item.storeCategory) &&
      normalize(prev.size) === normalize(size) &&
      normalize(prev.notes) === normalize(notes);

    return {
      itemName,
      size,
      notes,
      storeCategory: item.storeCategory || null,
      quantity: item.quantity,
      fulfillmentStatus: isUnmodified ? prev.fulfillmentStatus || "PENDING" : "PENDING",
    };
  });
}
