import { CircuitBreaker } from "../routing/circuitBreaker.js";
import { logger } from "../logger.js";
import { CloudVisionProvider } from "./visionProvider.js";
import type { OcrProvider, OcrResult } from "./types.js";

// One provider today. The chain exists anyway because the shape is what makes
// adding a second (or falling back when Vision is down) a configuration change
// rather than a rewrite — the same reasoning as lib/routing/, where it has
// already paid for itself once.
const providers: OcrProvider[] = [new CloudVisionProvider()];

const breakers = new Map<string, CircuitBreaker>(
  providers.map((provider) => [provider.name, new CircuitBreaker(provider.name)])
);

/**
 * Reads text from an image, trying each configured engine in turn.
 *
 * Returns null when no engine could read anything — an unreadable photo, or
 * every engine unavailable. The caller distinguishes those two by checking
 * `configuredEngines()`, because they mean very different things to a rider:
 * one says "retake the photo", the other says "we cannot reach the service".
 */
export async function readText(imageBase64: string): Promise<OcrResult | null> {
  for (const provider of providers) {
    if (!provider.isConfigured()) continue;

    const breaker = breakers.get(provider.name);
    if (breaker && !breaker.canAttempt()) continue;

    try {
      const result = await provider.read(imageBase64);
      // Reaching here proves the engine is reachable and healthy, even when it
      // found no text — so the breaker closes either way.
      breaker?.recordSuccess();
      if (result !== null) return result;
    } catch (error) {
      logger.error(`OCR provider ${provider.name} failed:`, error);
      breaker?.recordFailure();
    }
  }

  return null;
}

/** Exposed for diagnostics and for telling "unreadable" apart from "unavailable". */
export function configuredEngines(): string[] {
  return providers.filter((provider) => provider.isConfigured()).map((provider) => provider.name);
}
