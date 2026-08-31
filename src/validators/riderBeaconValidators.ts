import { z } from "zod";

// Same skew allowance the breadcrumb batch uses: a fix stamped in the future is
// a wrong device clock, not a fast rider.
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * The rider's low-rate presence beacon.
 *
 * Deliberately NOT tied to an errand. That is the whole point: the breadcrumb
 * endpoint refuses any errand that is not ASSIGNED or IN_TRANSIT, so an idle
 * rider had no way to tell the backend where they were, and dispatch could not
 * rank a fleet that had not already been dispatched to.
 *
 * Position is optional. A rider who has revoked location can still beacon, and
 * that beacon is worth having — it is how the dispatcher sees "on duty but not
 * locatable" instead of an unexplained absence.
 */
export const riderBeaconSchema = z.object({
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
  accuracyMeters: z.number().nonnegative().max(10000).nullish(),
  headingDeg: z.number().min(-1).max(360).nullish(),
  recordedAt: z.coerce
    .date()
    .refine((value) => value.getTime() <= Date.now() + MAX_CLOCK_SKEW_MS, {
      message: "recordedAt cannot be in the future.",
    })
    .nullish(),

  onDuty: z.boolean(),
  // Granted AND the task reported alive. The permission alone is not evidence
  // the OS let the task keep running.
  backgroundLocation: z.boolean().default(false),
  notifications: z.boolean().default(false),
  exactAlarms: z.boolean().default(false),
  // The cadence the device is currently using. Bounded so a bad client cannot
  // widen its own staleness window and appear reachable indefinitely.
  beaconIntervalMs: z.number().int().min(1000).max(120000).optional(),
  connectivity: z.enum(["wifi", "cellular", "none"]).nullish(),

  /**
   * Set by the device's ACTION_SHUTDOWN receiver on its way down.
   *
   * The only thing that distinguishes a powered-off handset from one in a dead
   * zone — both are silence from here. Best-effort by nature: a battery pull or
   * a force-stop sends nothing, which is why absence alone only ever yields a
   * PRESUMED offline.
   */
  shuttingDown: z.boolean().default(false),
});

export type RiderBeaconInput = z.infer<typeof riderBeaconSchema>;
