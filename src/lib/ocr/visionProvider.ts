import { GOOGLE_VISION_API_KEY } from "../../config/env.js";
import { logger } from "../logger.js";
import type { OcrProvider, OcrResult } from "./types.js";

const ENDPOINT = "https://vision.googleapis.com/v1/images:annotate";

// Generous enough for a 400 KB receipt over a Tacurong mobile connection without
// letting a hung upstream stall the rider's confirm screen. Measured round trips
// on real receipts were 0.5–1.1 s.
const REQUEST_TIMEOUT_MS = 15000;

/**
 * Google Cloud Vision, used for photographed store receipts.
 *
 * DOCUMENT_TEXT_DETECTION rather than TEXT_DETECTION: the former is tuned for
 * dense printed text and the latter for signage. On thermal receipts the
 * difference is substantial, and it reads a receipt photographed sideways
 * without any rotation hint — two of the three test samples were 90° off.
 */
export class CloudVisionProvider implements OcrProvider {
  readonly name = "CLOUD_VISION" as const;

  isConfigured(): boolean {
    return Boolean(GOOGLE_VISION_API_KEY);
  }

  async read(imageBase64: string): Promise<OcrResult | null> {
    if (!this.isConfigured()) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${ENDPOINT}?key=${GOOGLE_VISION_API_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          requests: [
            {
              image: { content: imageBase64 },
              features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
              // Receipts here are English with Filipino product names; the hint
              // keeps Vision from guessing a script it will not find.
              imageContext: { languageHints: ["en"] },
            },
          ],
        }),
      });

      const body: any = await response.json().catch(() => null);

      if (!response.ok) {
        // A transport or auth fault: the provider itself is unhealthy, so throw
        // and let the breaker count it.
        const message = body?.error?.message ?? `HTTP ${response.status}`;
        throw new Error(`Cloud Vision request failed: ${message}`);
      }

      const result = body?.responses?.[0];

      // Per-image errors sit inside a 200 response. Vision refusing to fetch one
      // image says nothing about the service being up.
      if (result?.error) {
        logger.info(`Cloud Vision could not process this image: ${result.error.message}`);
        return null;
      }

      const text: string = result?.fullTextAnnotation?.text ?? "";
      // Empty is a legitimate answer — an unreadable or blank photo. Null tells
      // the caller "nothing to read" without implicating the engine.
      if (!text.trim()) return null;

      return {
        text,
        engine: this.name,
        // Vision reports confidence per page rather than per document; the first
        // page is representative for a single-page receipt.
        confidence: result?.fullTextAnnotation?.pages?.[0]?.confidence ?? null,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
