import { merchantCategoryRepository } from "../repositories/merchantCategoryRepository.js";
import {
  isCategoryServiceConfigured,
  predictItemCategories,
  predictStoreCategory,
  type CategoryPrediction,
} from "../lib/category/categoryServiceClient.js";

/**
 * The category guess, resolved against this environment's own catalogue.
 *
 * The Python service knows category NAMES and nothing else — ids are
 * per-environment, and a model that had learned them would hand staging's ids
 * to production. Resolving the name back to a row is this layer's whole job,
 * and a name the catalogue does not carry (an owner renamed or deactivated a
 * category) resolves to nothing rather than to a stale id.
 */

export interface InferredCategory {
  categoryId: number;
  categoryName: string;
  confidence: number;
  /** True well above the threshold. The console uses it for wording only. */
  strong: boolean;
  /** "name", "google+name" — where the answer actually came from. */
  source: string;
  /** Runner-up categories, so a correction is one glance rather than a list. */
  alternatives: Array<{ categoryId: number; categoryName: string; confidence: number }>;
  reason: string;
}

/** Why there is no answer. The console renders these differently. */
export type InferenceMiss =
  | { available: false; reason: string }
  | { available: true; category: null; confidence: number; reason: string };

export type InferenceResult = ({ available: true } & InferredCategory) | InferenceMiss;

async function activeCategoriesByName(): Promise<Map<string, { id: number; name: string }>> {
  const categories = await merchantCategoryRepository.findMany({ includeInactive: false });
  return new Map(
    categories.map((c: { id: number; name: string }) => [c.name.trim().toLowerCase(), c])
  );
}

function resolve(
  prediction: CategoryPrediction,
  byName: Map<string, { id: number; name: string }>
): InferenceResult {
  if (!prediction.category) {
    return {
      available: true,
      category: null,
      confidence: prediction.confidence,
      reason: prediction.reason,
    };
  }

  const match = byName.get(prediction.category.trim().toLowerCase());
  if (!match) {
    // The model named a category this environment does not have — renamed,
    // deactivated, or a model trained against a different catalogue. Reported
    // as "no answer" rather than silently dropped, because a guess that keeps
    // naming a category nobody can select is worth noticing.
    return {
      available: true,
      category: null,
      confidence: prediction.confidence,
      reason: `Suggested "${prediction.category}", which is not an active category here.`,
    };
  }

  return {
    available: true,
    categoryId: match.id,
    categoryName: match.name,
    confidence: prediction.confidence,
    strong: Boolean(prediction.strong),
    source: prediction.source,
    alternatives: (prediction.alternatives || [])
      .map((alt) => {
        const found = byName.get(alt.category.trim().toLowerCase());
        return found
          ? { categoryId: found.id, categoryName: found.name, confidence: alt.confidence }
          : null;
      })
      .filter((alt): alt is NonNullable<typeof alt> => alt !== null),
    reason: prediction.reason,
  };
}

const UNAVAILABLE: InferenceMiss = {
  available: false,
  reason: "The category service is not reachable. Choose the category by hand.",
};

/** What kind of shop this name refers to. */
export async function inferStoreCategory(
  name: string,
  googleTypes?: string[] | null
): Promise<InferenceResult> {
  if (!isCategoryServiceConfigured()) return UNAVAILABLE;

  const [prediction, byName] = await Promise.all([
    predictStoreCategory(name, googleTypes),
    activeCategoriesByName(),
  ]);
  if (!prediction) return UNAVAILABLE;
  return resolve(prediction, byName);
}

/**
 * What kind of shop each item is bought at.
 *
 * Batched because stage 3 asks about a whole basket at once. The order of the
 * results matches the order of `names`, so the caller can zip them back onto
 * its own rows without matching on the text it sent.
 */
export async function inferItemCategories(names: string[]): Promise<InferenceResult[]> {
  if (!isCategoryServiceConfigured()) return names.map(() => UNAVAILABLE);

  const [predictions, byName] = await Promise.all([
    predictItemCategories(names),
    activeCategoriesByName(),
  ]);
  if (!predictions) return names.map(() => UNAVAILABLE);

  return predictions.map((prediction) => resolve(prediction, byName));
}
