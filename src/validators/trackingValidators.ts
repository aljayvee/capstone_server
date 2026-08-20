import { z } from "zod";

// A device can buffer a long stretch of GPS through a signal blackout, so
// batches are expected to be large — but not unbounded.
export const MAX_TRACK_BATCH_POINTS = 200;

// Device clocks drift and can be set wrong outright. A fix stamped in the
// future is rejected outright; a small tolerance covers ordinary skew.
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

const trackPointSchema = z.object({
  // Device-generated UUID, paired with a unique index server-side so a retried
  // flush cannot duplicate the trail.
  clientPointId: z.string().trim().min(8).max(36),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  // Beyond this the fix carries no useful information about where the rider is.
  accuracyMeters: z.number().nonnegative().max(10000).nullish(),
  speedMps: z.number().min(-1).max(200).nullish(),
  headingDeg: z.number().min(-1).max(360).nullish(),
  recordedAt: z.coerce
    .date()
    .refine((value) => value.getTime() <= Date.now() + MAX_CLOCK_SKEW_MS, {
      message: "recordedAt cannot be in the future.",
    }),
  wasOffline: z.boolean().optional().default(false),
});

export const trackBatchSchema = z.object({
  points: z
    .array(trackPointSchema)
    .min(1, "At least one point is required.")
    .max(MAX_TRACK_BATCH_POINTS, `At most ${MAX_TRACK_BATCH_POINTS} points per batch.`),
});

export type TrackPointInput = z.infer<typeof trackPointSchema>;
export type TrackBatchInput = z.infer<typeof trackBatchSchema>;

// Optional backfilled timestamp on lifecycle actions performed while offline.
// Mirrors the existing connectivity-incident pattern, where the client reports
// when something actually happened rather than when it managed to say so.
export const occurredAtSchema = z.coerce
  .date()
  .refine((value) => value.getTime() <= Date.now() + MAX_CLOCK_SKEW_MS, {
    message: "occurredAt cannot be in the future.",
  })
  .optional();
