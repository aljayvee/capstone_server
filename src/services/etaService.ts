import { eventPublisher } from "../lib/eventPublisher.js";
import { logger } from "../lib/logger.js";
import * as riderPositionStore from "../lib/riderPositionStore.js";
import { errandRepository } from "../repositories/errandRepository.js";
import { pinpointRepository } from "../repositories/pinpointRepository.js";
import { defaultEtaStrategy, type EtaStopInput } from "./patterns/etaStrategy.js";

// A position older than this is not evidence of where a rider is now. Kept
// identical to the web dashboard's SIGNAL_LOST_THRESHOLD_MS so a rider painted
// red as "no signal" and a rider excluded from ETA/dispatch are always the same
// set — the two views cannot disagree.
export const POSITION_FRESHNESS_MS = 60 * 1000;

// The ETA is worth recomputing when the rider has actually made progress, not
// on every breadcrumb: recomputing per fix would mean a routing call every few
// seconds per active errand for a number that barely moves.
const MIN_RECOMPUTE_INTERVAL_MS = 60 * 1000;

const ETA_ELIGIBLE_STATUSES = new Set(["ASSIGNED", "IN_TRANSIT"]);

// Fallback dwell for a stop whose store type is unknown (a dispatcher dropped a
// pin on the map rather than picking a catalogued place). Deliberately generic
// and wide rather than optimistic.
const UNKNOWN_CATEGORY_DWELL_P50 = 600;
const UNKNOWN_CATEGORY_DWELL_P80 = 1200;

export async function recomputeForErrand(errandId: string, options: { force?: boolean } = {}) {
  const errand = await errandRepository.findById(errandId);
  if (!errand) return null;
  if (!ETA_ELIGIBLE_STATUSES.has(errand.status)) return null;
  if (errand.deliveryLatitude == null || errand.deliveryLongitude == null) return null;

  if (!options.force && errand.etaComputedAt) {
    const sinceLast = Date.now() - errand.etaComputedAt.getTime();
    if (sinceLast < MIN_RECOMPUTE_INTERVAL_MS) return null;
  }

  const pinpoints = await pinpointRepository.findByErrandIdWithCategory(errandId);
  const stops: EtaStopInput[] = pinpoints.map((pin) => ({
    pinpointId: pin.id,
    point: { latitude: pin.latitude, longitude: pin.longitude },
    arrivedAt: pin.arrivedAt,
    departedAt: pin.departedAt,
    dwellP50Seconds: pin.category?.dwellP50Seconds ?? UNKNOWN_CATEGORY_DWELL_P50,
    dwellP80Seconds: pin.category?.dwellP80Seconds ?? UNKNOWN_CATEGORY_DWELL_P80,
    // No category means no learned data by definition, which correctly widens
    // the upper bound via the strategy's low-confidence padding.
    dwellSampleCount: pin.category?.dwellSampleCount ?? 0,
  }));

  const position = errand.riderId
    ? riderPositionStore.getFresh(errand.riderId, POSITION_FRESHNESS_MS)
    : undefined;

  const result = await defaultEtaStrategy.compute({
    origin: position?.point ?? null,
    stops,
    destination: { latitude: errand.deliveryLatitude, longitude: errand.deliveryLongitude },
    now: new Date(),
  });

  if (!result) return null;

  const updated = await errandRepository.update(errandId, {
    etaLowAt: result.etaLowAt,
    etaHighAt: result.etaHighAt,
    etaComputedAt: new Date(),
    etaIsDegraded: result.degraded,
  });

  // Scoped to the parties who should see it — never the global broadcast the
  // legacy events use (see lib/eventPublisher.ts).
  eventPublisher.emitToErrand(errandId, "errand:eta_updated", {
    errandId,
    etaLowAt: result.etaLowAt,
    etaHighAt: result.etaHighAt,
    travelSeconds: result.travelSeconds,
    dwellLowSeconds: result.dwellLowSeconds,
    dwellHighSeconds: result.dwellHighSeconds,
    remainingStopCount: result.remainingStopCount,
    degraded: result.degraded,
  });

  return { errand: updated, eta: result };
}

// Fire-and-forget wrapper for call sites that must not be slowed down or failed
// by ETA work (breadcrumb ingest, status changes).
export function recomputeInBackground(errandId: string, options: { force?: boolean } = {}): void {
  void recomputeForErrand(errandId, options).catch((error) => {
    logger.error(`ETA recompute failed for errand ${errandId}:`, error);
  });
}

// A rider who has been inside a stop's geofence longer than that store type's
// P80 is not lost — on a pabili they are almost certainly still in a queue. The
// ETA alone cannot express that: it just keeps sliding, which reads to the
// customer as a broken promise. This turns it into an explicit, explained state.
export async function detectStalledStop(errandId: string) {
  const pinpoints = await pinpointRepository.findByErrandIdWithCategory(errandId);
  const now = Date.now();

  for (const pin of pinpoints) {
    if (!pin.arrivedAt || pin.departedAt) continue;

    const threshold = pin.category?.dwellP80Seconds ?? UNKNOWN_CATEGORY_DWELL_P80;
    const elapsedSeconds = (now - pin.arrivedAt.getTime()) / 1000;
    if (elapsedSeconds <= threshold) continue;

    eventPublisher.emitToErrand(errandId, "errand:stop_delayed", {
      errandId,
      pinpointId: pin.id,
      storeName: pin.storeName,
      categoryName: pin.category?.name ?? null,
      elapsedSeconds: Math.round(elapsedSeconds),
      typicalSeconds: threshold,
    });
    return { pinpointId: pin.id, storeName: pin.storeName, elapsedSeconds: Math.round(elapsedSeconds) };
  }

  return null;
}
