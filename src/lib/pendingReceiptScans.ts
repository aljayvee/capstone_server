import { randomUUID } from "node:crypto";
import type { OcrEngineName } from "./ocr/types.js";

/**
 * Receipt photos that have been read but not yet confirmed.
 *
 * A rider photographs a receipt, the server reads it, and the rider checks the
 * total. Until they press Confirm the photo is not evidence of anything: they
 * may retake it because it was blurred, or because the total came out wrong.
 * Writing it to errand_proof_images at the reading stage left every retake
 * behind as a second copy of the same receipt, so the photo waits here and is
 * written once, when the rider confirms it.
 *
 * In memory on purpose. The backend runs as a single pm2 process, a scan lives
 * for minutes, and losing one to a restart costs the rider one retake, never
 * money: nothing about it has reached the bill yet.
 */

/** Long enough to walk from the counter and type a total; short enough to forget a photo nobody confirms. */
export const PENDING_SCAN_TTL_MS = 15 * 60 * 1000;

/** A safety valve, not a working limit. At ~400 KB a photo this bounds the store near 80 MB. */
export const MAX_PENDING_SCANS = 200;

export interface ReceiptScan {
  errandId: string;
  riderId: number;
  pinpointId: number | null;
  kind: "RECEIPT" | "TRANSFER";
  imageData: string;
  mimeType: string;
  byteSize: number;
  clarityScore: number;
  clarityVerdict: "SHARP" | "ACCEPTABLE";
  engine: OcrEngineName;
  rawText: string;
  confidence: number | null;
  extractedTotal: number | null;
  extractedDate: Date | null;
  status: "OK" | "NEEDS_REVIEW";
}

export interface PendingScan {
  id: string;
  scan: ReceiptScan;
  heldAt: number;
  /**
   * The write in flight or done, resolving to the saved image's id. Kept after
   * it lands so a confirm the rider re-sends (the reply was lost on a weak
   * signal) finds the row it already made instead of making a second one.
   */
  saving?: Promise<number>;
}

const pending = new Map<string, PendingScan>();

function sweep(now: number) {
  for (const [id, entry] of pending) {
    if (now - entry.heldAt > PENDING_SCAN_TTL_MS) pending.delete(id);
  }
}

/** Same rider, same errand, same stop, same kind: a newer photo of it is a retake. */
function sameShot(a: ReceiptScan, b: ReceiptScan) {
  return (
    a.riderId === b.riderId &&
    a.errandId === b.errandId &&
    a.kind === b.kind &&
    a.pinpointId === b.pinpointId
  );
}

/**
 * Holds a read photo until the rider confirms it, returning the id they confirm
 * it by. A newer scan of the same stop replaces an unconfirmed older one: that
 * is what a retake is.
 */
export function holdScan(scan: ReceiptScan, now = Date.now()): string {
  sweep(now);

  for (const [id, entry] of pending) {
    if (!entry.saving && sameShot(entry.scan, scan)) pending.delete(id);
  }

  // Map iteration is insertion order, so the first key is the oldest.
  while (pending.size >= MAX_PENDING_SCANS) {
    const oldest = pending.keys().next().value;
    if (oldest === undefined) break;
    pending.delete(oldest);
  }

  const id = randomUUID();
  pending.set(id, { id, scan, heldAt: now });
  return id;
}

/** The held scan, or null once it has expired or was replaced by a retake. */
export function findScan(id: string, now = Date.now()): PendingScan | null {
  const entry = pending.get(id);
  if (!entry) return null;
  if (now - entry.heldAt > PENDING_SCAN_TTL_MS) {
    pending.delete(id);
    return null;
  }
  return entry;
}

/** Test-only. */
export function __resetPendingScans() {
  pending.clear();
}

/** Test-only. */
export function __pendingScanCount() {
  return pending.size;
}
