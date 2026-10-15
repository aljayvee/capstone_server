import { haversineDistanceKm } from "../geo.js";
import { normalizeStoreName } from "../../services/storePredictionService.js";

/**
 * One store registered twice in the owner's Location Stores (2026-10-13).
 *
 * The server's half of the check the portal already ran in the browser
 * (src/utils/placeDuplicates.ts in the web app), so no client can skip it:
 *   - the same Google Maps place: the same shop, always refused;
 *   - the same name, wherever it is: a duplicate unless the owner says it is
 *     another branch;
 *   - a related name within SAME_PLACE_METERS: the same.
 * Distance alone is not evidence: a commercial strip holds different shops a
 * few metres apart (Cebuana 25 m from Jollibee Main).
 */

/** How close two entries must be before proximity counts as evidence (the portal's figure). */
export const SAME_PLACE_METERS = 40;

export interface DirectoryRow {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  googlePlaceId?: string | null;
  isActive?: boolean;
}

export type DuplicateReason = "google_place" | "name" | "nearby";

export interface DuplicateMatch<T extends DirectoryRow = DirectoryRow> {
  existing: T;
  reason: DuplicateReason;
  metres: number;
}

/** "Jollibee" and "Jollibee Tacurong Center (Main)" are related; "Chowking" and "Greenwich" are not. */
export function namesLookRelated(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return `${longer} `.startsWith(`${shorter} `);
}

/** The row `candidate` duplicates, the strongest reason first. `excludeId` skips the row being edited. */
export function findDuplicate<T extends DirectoryRow>(
  candidate: Omit<DirectoryRow, "id">,
  rows: T[],
  excludeId?: string | null
): DuplicateMatch<T> | null {
  const others = rows.filter((row) => row.id !== excludeId);
  const metres = (row: T) => Math.round(haversineDistanceKm(candidate, row) * 1000);

  if (candidate.googlePlaceId) {
    const same = others.find((row) => row.googlePlaceId === candidate.googlePlaceId);
    if (same) return { existing: same, reason: "google_place", metres: metres(same) };
  }
  const name = normalizeStoreName(candidate.name);
  if (!name) return null;
  const sameName = others.find((row) => normalizeStoreName(row.name) === name);
  if (sameName) return { existing: sameName, reason: "name", metres: metres(sameName) };
  const nearby = others.find(
    (row) => metres(row) < SAME_PLACE_METERS && namesLookRelated(name, normalizeStoreName(row.name))
  );
  return nearby ? { existing: nearby, reason: "nearby", metres: metres(nearby) } : null;
}

/** The sentence the owner reads. */
export function describeDuplicate(match: DuplicateMatch): string {
  const where =
    match.reason === "google_place"
      ? "is already registered as this Google Maps place"
      : match.reason === "name"
        ? "is already registered under that name"
        : `is already registered ${match.metres} m from here`;
  const archived = match.existing.isActive === false ? " (in the Archive)" : "";
  return `"${match.existing.name}"${archived} ${where}.`;
}

/**
 * Every set of rows that duplicate each other, for the portal's warning: each
 * row joins the first group holding a row it duplicates. Groups of one are
 * left out.
 */
export function groupDuplicates<T extends DirectoryRow>(rows: T[]): Array<{ reason: DuplicateReason; rows: T[] }> {
  const groups: Array<{ reason: DuplicateReason; rows: T[] }> = [];
  for (const row of rows) {
    let joined = false;
    for (const group of groups) {
      const match = findDuplicate(row, group.rows);
      if (match) {
        group.rows.push(row);
        joined = true;
        break;
      }
    }
    if (!joined) groups.push({ reason: "name", rows: [row] });
  }
  return groups
    .filter((group) => group.rows.length > 1)
    .map((group) => {
      const [first, ...rest] = group.rows;
      const match = findDuplicate(rest[0], [first]);
      return { reason: match?.reason ?? "name", rows: group.rows };
    });
}
