/**
 * Establishment Matcher Service.
 *
 * Categorizes establishment locations and matches them to active MerchantCategory
 * records in MariaDB.
 *
 * Invariant: Enforces a strict 0.75 (75%) confidence threshold. Any classification
 * below 0.75 is flagged with needsReview: true for staff/dispatcher confirmation.
 */

import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { inferStoreCategory, type InferenceResult } from "./categoryInferenceService.js";

export const MIN_AUTO_ACCEPT_CONFIDENCE = 0.75;

export interface EstablishmentInput {
  name: string;
  address: string;
  barangay?: string | null;
  latitude: number;
  longitude: number;
  googleTypes?: string[];
}

export interface EstablishmentMatchResult {
  storeName: string;
  categoryId: number | null;
  categoryName: string | null;
  confidence: number;
  needsReview: boolean;
  reason: string;
}

/**
 * Matches an establishment to a database MerchantCategory.
 * If confidence is below 0.75, marks needsReview = true.
 */
export async function matchEstablishmentCategory(
  input: EstablishmentInput
): Promise<EstablishmentMatchResult> {
  // 1. Query the category inference engine (FastAPI / ML Sidecar)
  const inference = await inferStoreCategory(input.name, input.googleTypes);

  // 2. Check if inference succeeded with a category match
  if (!inference.available || !("categoryId" in inference)) {
    const rawConf = "confidence" in inference ? inference.confidence : 0.0;
    return {
      storeName: input.name,
      categoryId: null,
      categoryName: null,
      confidence: rawConf,
      needsReview: true,
      reason: `Category inference unavailable or too low confidence (${rawConf.toFixed(2)}); requires staff verification`,
    };
  }

  const rawConfidence = inference.confidence;
  const matchedCategoryId = inference.categoryId;
  const matchedCategoryName = inference.categoryName;

  // 3. Strict confidence check: below 0.75 requires manual review
  const needsReview = rawConfidence < MIN_AUTO_ACCEPT_CONFIDENCE;

  const reason = needsReview
    ? `Confidence ${rawConfidence.toFixed(2)} is below ${MIN_AUTO_ACCEPT_CONFIDENCE.toFixed(2)} threshold; flagged for staff confirmation`
    : `High confidence (${rawConfidence.toFixed(2)}) auto-matched to category "${matchedCategoryName}"`;

  return {
    storeName: input.name,
    categoryId: matchedCategoryId,
    categoryName: matchedCategoryName,
    confidence: rawConfidence,
    needsReview,
    reason,
  };
}
