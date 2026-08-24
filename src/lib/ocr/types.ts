export type OcrEngineName = "CLOUD_VISION" | "MLKIT";

export interface OcrResult {
  /** Everything the engine recognised, newline-separated in reading order. */
  text: string;
  engine: OcrEngineName;
  /** Engine-reported confidence where available. Vision does not always give one. */
  confidence: number | null;
}

/**
 * One adapter per OCR engine, following the same contract as the routing
 * providers in lib/routing/.
 *
 * The null-versus-throw distinction is the important part, and it is the same
 * one the routing chain rests on:
 *
 *   throw -> the engine is unhealthy (network down, key rejected, quota spent).
 *            Counts against the circuit breaker.
 *   null  -> the engine worked perfectly and there was simply nothing to read.
 *            A photo of a thumb over the lens is not an outage.
 *
 * Conflating them would let a rider's bad photo trip the breaker and disable OCR
 * for everyone for a minute — exactly the failure the routing comment warns
 * about with an unmapped car park.
 */
export interface OcrProvider {
  readonly name: OcrEngineName;
  /** False when the adapter lacks what it needs (no API key) and must be skipped. */
  isConfigured(): boolean;
  /** @param imageBase64 raw base64, no data-URI prefix. */
  read(imageBase64: string): Promise<OcrResult | null>;
}
