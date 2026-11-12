import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/proofImageService.js', () => ({ assertRidersOwnErrand: vi.fn() }));
vi.mock('../src/repositories/pinpointRepository.js', () => ({ pinpointRepository: { findByErrandId: vi.fn(), markArrived: vi.fn() } }));
vi.mock('../src/lib/eventPublisher.js', () => ({ eventPublisher: { emitToErrandParties: vi.fn() } }));
vi.mock('../src/services/etaService.js', () => ({ recomputeInBackground: vi.fn() }));

import { assertRidersOwnErrand } from '../src/services/proofImageService.js';
import { pinpointRepository } from '../src/repositories/pinpointRepository.js';
import { eventPublisher } from '../src/lib/eventPublisher.js';
import { recomputeInBackground } from '../src/services/etaService.js';
import { markPinpointArrived } from '../src/services/pinpointArrivalService.js';

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(assertRidersOwnErrand).mockResolvedValue({ id: 'errand', riderId: 7, customerId: 8, status: 'IN_TRANSIT' } as any);
  vi.mocked(pinpointRepository.findByErrandId).mockResolvedValue([{ id: 12, arrivedAt: null }] as any);
  vi.mocked(pinpointRepository.markArrived).mockResolvedValue({ count: 1 });
});

describe('fallback store arrival', () => {
  it('checks ownership, records arrival, notifies all parties and refreshes ETA', async () => {
    const result = await markPinpointArrived('errand', 12, 7);
    expect(assertRidersOwnErrand).toHaveBeenCalledWith('errand', 7);
    expect(pinpointRepository.markArrived).toHaveBeenCalledWith(12, expect.any(Date));
    expect(eventPublisher.emitToErrandParties).toHaveBeenCalledWith('errand', expect.objectContaining({ riderId: 7, customerId: 8 }), 'errand:stop_arrived', { errandId: 'errand', pinpointId: 12, kind: 'arrived', at: result.arrivedAt });
    expect(recomputeInBackground).toHaveBeenCalledWith('errand', { force: true });
  });
  it('refuses a pinpoint belonging to another errand', async () => {
    await expect(markPinpointArrived('errand', 99, 7)).rejects.toMatchObject({ status: 404 });
    expect(pinpointRepository.markArrived).not.toHaveBeenCalled();
  });
  it('does not query or write a stop after ownership fails', async () => {
    vi.mocked(assertRidersOwnErrand).mockRejectedValue(new Error('Forbidden'));
    await expect(markPinpointArrived('errand', 12, 99)).rejects.toThrow('Forbidden');
    expect(pinpointRepository.findByErrandId).not.toHaveBeenCalled();
  });
  it('preserves existing arrival and sends no duplicate event', async () => {
    const at = new Date('2026-11-10T01:00:00Z');
    vi.mocked(pinpointRepository.findByErrandId).mockResolvedValue([{ id: 12, arrivedAt: at }] as any);
    expect(await markPinpointArrived('errand', 12, 7)).toEqual({ pinpointId: 12, arrivedAt: at });
    expect(pinpointRepository.markArrived).not.toHaveBeenCalled();
    expect(eventPublisher.emitToErrandParties).not.toHaveBeenCalled();
  });
  it('returns the winning timestamp when a GPS batch races the request', async () => {
    const at = new Date('2026-11-10T01:00:00Z');
    vi.mocked(pinpointRepository.markArrived).mockResolvedValue({ count: 0 });
    vi.mocked(pinpointRepository.findByErrandId).mockResolvedValueOnce([{ id: 12, arrivedAt: null }] as any).mockResolvedValueOnce([{ id: 12, arrivedAt: at }] as any);
    expect(await markPinpointArrived('errand', 12, 7)).toEqual({ pinpointId: 12, arrivedAt: at });
    expect(eventPublisher.emitToErrandParties).not.toHaveBeenCalled();
  });
  it('refuses a new arrival for a completed errand', async () => {
    vi.mocked(assertRidersOwnErrand).mockResolvedValue({ status: 'DELIVERED' } as any);
    await expect(markPinpointArrived('errand', 12, 7)).rejects.toMatchObject({ status: 409 });
    expect(pinpointRepository.markArrived).not.toHaveBeenCalled();
  });
});
