/**
 * Which built-in vocabulary each live merchant category carries, read from the
 * same file the category models train with (server/ml/sugo_category/roles.json)
 * and bound by the same rule (server/ml/sugo_category/catalogue.py).
 *
 * The store suggester needs it for the mapped Tacurong shops
 * (ml/data/tacurong_places_review.csv), which are filed by category NAME as it
 * stood when the map was read. Renaming "Bakery" to "Breads & Pastries" made
 * every mapped bakery match no category at all, so they quietly dropped out of
 * the suggestions. Through the roles, "Bakery" on the sheet finds whichever
 * category now carries the bakery role.
 */

import { readFileSync } from "node:fs";
import { logger } from "../lib/logger.js";

export interface CategoryRole {
  key: string;
  names: string[];
  keywords: string[];
  parent?: string;
}

const ROLES_PATH = new URL("../../ml/sugo_category/roles.json", import.meta.url);

let roles: CategoryRole[] | null = null;

/** The roles file, or no roles when it is missing (an install without the ml folder). */
export function loadCategoryRoles(): CategoryRole[] {
  if (roles) return roles;
  try {
    const raw = JSON.parse(readFileSync(ROLES_PATH, "utf8"));
    roles = (raw.roles ?? []).map((r: CategoryRole) => ({ ...r, keywords: r.keywords.map(words) }));
  } catch (err: any) {
    logger.warn(`Category roles unavailable (${err?.message ?? err}); mapped shops match by exact name only.`);
    roles = [];
  }
  return roles!;
}

/** Test seam. */
export function setCategoryRolesForTests(value: CategoryRole[] | null): void {
  roles = value ? value.map((r) => ({ ...r, keywords: r.keywords.map(words) })) : null;
}

export function words(text: string | null | undefined): string {
  return (text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9ñ]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const mentions = (text: string, keyword: string) => ` ${text} `.includes(` ${keyword} `);

export function roleScore(role: CategoryRole, name: string, description = ""): number {
  const n = words(name);
  const d = words(description);
  return role.keywords.reduce((sum, k) => sum + 2 * Number(mentions(n, k)) + Number(mentions(d, k)), 0);
}

/**
 * `{role key: category name}`. Exact names first; then, repeatedly, the
 * strongest remaining match, a role whose best two categories tie sitting the
 * round out. Each category carries at most one role. Mirrors bind_roles in
 * catalogue.py; tests/categoryRoles.test.ts and tests/test_catalogue.py check
 * the same cases.
 */
export function bindRoles(categories: Array<{ name: string; description?: string | null }>): Map<string, string> {
  const all = loadCategoryRoles();
  const binding = new Map<string, string>();
  const taken = new Set<string>();
  const byWords = new Map(categories.map((c) => [words(c.name), c.name]));

  for (const role of all) {
    for (const canonical of role.names) {
      const name = byWords.get(words(canonical));
      if (name && !taken.has(name)) {
        binding.set(role.key, name);
        taken.add(name);
        break;
      }
    }
  }

  for (;;) {
    let best: { score: number; key: string; name: string } | null = null;
    for (const role of all) {
      if (binding.has(role.key)) continue;
      const scores = categories
        .filter((c) => !taken.has(c.name))
        .map((c) => ({ score: roleScore(role, c.name, c.description ?? ""), name: c.name }))
        .sort((a, b) => b.score - a.score);
      if (!scores.length || scores[0].score <= 0) continue;
      if (scores.length > 1 && scores[1].score === scores[0].score) continue;
      if (!best || scores[0].score > best.score) best = { score: scores[0].score, key: role.key, name: scores[0].name };
    }
    if (!best) return binding;
    binding.set(best.key, best.name);
    taken.add(best.name);
  }
}

/**
 * A stored category label as a live category name, or null. Live names pass
 * through; a canonical name or concept ("Bakery", "bakery") goes to the
 * category carrying its role, or its parent role's when none does.
 */
export function resolveCategoryLabel(
  label: string | null | undefined,
  categories: Array<{ name: string; description?: string | null }>,
  binding: Map<string, string> = bindRoles(categories)
): string | null {
  if (!label) return null;
  if (categories.some((c) => c.name === label)) return label;
  const key = words(label);
  const role = loadCategoryRoles().find((r) => r.key === key || r.names.some((n) => words(n) === key));
  let current: CategoryRole | undefined = role;
  while (current) {
    const bound = binding.get(current.key);
    if (bound) return bound;
    current = current.parent ? loadCategoryRoles().find((r) => r.key === current!.parent) : undefined;
  }
  return null;
}
