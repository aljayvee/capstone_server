import { assertRidersOwnErrand } from './proofImageService.js';
import { pinpointRepository } from '../repositories/pinpointRepository.js';
import { eventPublisher } from '../lib/eventPublisher.js';
import { recomputeInBackground } from './etaService.js';
import { ServiceError } from './ServiceError.js';

export async function markPinpointArrived(errandId: string, pinpointId: number, riderId: number) {
  const errand = await assertRidersOwnErrand(errandId, riderId);
  const stops = await pinpointRepository.findByErrandId(errandId);
  const stop = stops.find((pin) => pin.id === pinpointId);
  if (!stop) throw new ServiceError(404, 'Store pinpoint not found for this errand.');
  if (stop.arrivedAt) return { pinpointId, arrivedAt: stop.arrivedAt };
  if (errand.status !== 'IN_TRANSIT') {
    throw new ServiceError(409, 'Arrival can only be recorded for an errand in transit.');
  }
  const at = new Date();
  const changed = await pinpointRepository.markArrived(pinpointId, at);
  if ((changed?.count ?? 0) > 0) {
    eventPublisher.emitToErrandParties(errandId, errand, 'errand:stop_arrived', {
      errandId, pinpointId, kind: 'arrived', at,
    });
    recomputeInBackground(errandId, { force: true });
    return { pinpointId, arrivedAt: at };
  }
  // Another request or GPS ingest won the race: return its original stamp.
  const persisted = (await pinpointRepository.findByErrandId(errandId)).find((pin) => pin.id === pinpointId);
  if (!persisted?.arrivedAt) throw new ServiceError(409, 'Store pinpoint changed. Refresh the errand.');
  return { pinpointId, arrivedAt: persisted.arrivedAt };
}
