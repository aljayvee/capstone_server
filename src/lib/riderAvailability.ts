/**
 * Whether a rider can be given work, and if not, why not.
 *
 * Dispatch used to answer this with `riderPresenceStore.isOnline()` — a live
 * Socket.IO connection and nothing else. That failed in both directions. A rider
 * parked outside a store with their screen locked had their socket killed by
 * Android's battery optimiser and was dropped from the eligible pool, producing
 * "no available riders" while they sat waiting. And a rider whose socket was
 * alive but whose location task had been killed looked perfectly dispatchable
 * while being impossible to locate or route.
 *
 * Presence is therefore derived from a low-rate beacon the device sends off the
 * back of its foreground location service, which survives Doze, rather than from
 * a socket, which does not. The socket keeps the one job it is genuinely good
 * at: pushing an offer instantly to a rider who happens to be awake.
 *
 * Pure and side-effect free so the thresholds can be tested without a database,
 * a clock, or a device.
 */

/**
 * How many beacons a rider may miss before they are treated as out of contact.
 *
 * A THRESHOLD SHORTER THAN THE BEACON INTERVAL IS A CONTRADICTION, and this was
 * one: the spec's "no internet within 10 seconds" was written as a flat 10s while
 * an idle device beacons every 30s. A rider working perfectly was therefore
 * signal-lost for twenty seconds out of every thirty, and auto-assign answered
 * "no available riders" roughly two thirds of the time.
 *
 * The spec's intent was that losing signal is noticed quickly, and it still is —
 * but "quickly" has to be counted in beacons, not in seconds, because a beacon
 * is the only evidence that ever arrives. Two and a half of them tolerates one
 * dropped request plus jitter without tolerating a genuine outage: 25s for a
 * rider on an errand (10s cadence), 75s for an idle one (30s cadence).
 */
export const MISSED_BEACONS_BEFORE_SIGNAL_LOST = 2.5;

/**
 * Fallback cadence for a device that does not report its own.
 *
 * The idle interval, deliberately: assuming the slower of the two is the safe
 * direction to be wrong in. Assuming the fast one would mark every idle rider
 * lost, which is the bug this constant exists to prevent.
 */
export const DEFAULT_BEACON_INTERVAL_MS = 30 * 1000;

/** The window a rider has to be heard from, given the cadence they are using. */
export function signalLostAfterMs(beaconIntervalMs: number | null | undefined): number {
  const interval =
    typeof beaconIntervalMs === "number" && beaconIntervalMs > 0
      ? beaconIntervalMs
      : DEFAULT_BEACON_INTERVAL_MS;
  return Math.round(interval * MISSED_BEACONS_BEFORE_SIGNAL_LOST);
}

/**
 * No beacon for this long and the rider is presumed gone.
 *
 * Presumed, not observed. A powered-off handset and one in a cellular dead zone
 * send identically nothing, so this threshold cannot tell them apart — only the
 * device's own shutdown beacon can, and that is best-effort (a battery pull or a
 * force-stop sends nothing at all). Any operations screen showing this state must
 * say "presumed", because labelling an inference as an observation is how a
 * dispatcher ends up certain about something the server merely guessed.
 */
export const OFFLINE_AFTER_MS = 5 * 60 * 1000;

export type RiderAvailability =
  /** Ready for work. The only state that receives new offers. */
  | "AVAILABLE"
  /** Out of contact but still holding whatever they had. Takes no new work. */
  | "SIGNAL_LOST"
  /** Gone: said so on shutdown, or silent past the grace window. */
  | "OFFLINE"
  /**
   * In contact and on duty, but missing a permission an offer depends on.
   *
   * A fifth state beyond the four in the spec, and deliberately so: the spec
   * defines Available as requiring background location, notifications and exact
   * alarms, which leaves "reachable but not equipped" with nowhere to go. Folding
   * it into SIGNAL_LOST would put a permissions problem on the dispatcher's
   * screen wearing the label of a connectivity problem, and send someone to
   * debug the network while the rider's notifications sit switched off.
   */
  | "NEEDS_PERMISSIONS"
  /** Signed in, duty toggle off. Their choice, not a fault. */
  | "OFF_DUTY"
  /** No session at all. */
  | "LOGGED_OUT";

/**
 * Why a rider who is otherwise present still cannot be given work.
 *
 * Kept separate from the state because these are all fixable by the rider, and a
 * dispatcher looking at a full roster needs to see WHICH permission is missing to
 * tell them what to turn on.
 */
export type Impediment =
  | "background_location"
  | "notifications"
  | "exact_alarms";

export interface PresenceSnapshot {
  /** An open login session exists. */
  hasSession: boolean;
  /** The rider's own on/off duty toggle. */
  onDuty: boolean;
  /** ACCESS_BACKGROUND_LOCATION granted AND the location task reported alive. */
  backgroundLocation: boolean;
  /** Notifications permitted — otherwise an offer arrives silently, or not at all. */
  notifications: boolean;
  /** Exact alarms permitted, which is what drives the 45-second offer countdown. */
  exactAlarms: boolean;
  /** Epoch ms of the most recent beacon, or null if none has ever arrived. */
  lastBeaconAt: number | null;
  /**
   * The interval the device says it is beaconing at, in ms.
   *
   * Reported rather than assumed, because only the device knows whether it is
   * idle or on an errand, and the two cadences differ threefold. Optional so a
   * build that predates the field still resolves, at the idle default.
   */
  beaconIntervalMs?: number | null;
  /** Epoch ms of an explicit shutdown beacon, if the device managed to send one. */
  shutdownAt: number | null;
}

export interface AvailabilityResult {
  state: RiderAvailability;
  /** True only for AVAILABLE. The single question dispatch asks. */
  dispatchable: boolean;
  /** Present when the state is AVAILABLE-but-for these. Empty otherwise. */
  impediments: Impediment[];
  /** Age of the last beacon in ms, or null when none has arrived. */
  beaconAgeMs: number | null;
  /** True when OFFLINE was inferred from silence rather than reported. */
  presumed: boolean;
}

export function availabilityOf(
  snapshot: PresenceSnapshot,
  now: number = Date.now()
): AvailabilityResult {
  const beaconAgeMs =
    snapshot.lastBeaconAt === null ? null : Math.max(0, now - snapshot.lastBeaconAt);

  const base = {
    impediments: [] as Impediment[],
    beaconAgeMs,
    presumed: false,
  };

  // Session and duty come first because they are the rider's own decisions, and
  // reporting a signed-out rider as "signal lost" would send someone chasing a
  // connectivity problem that does not exist.
  if (!snapshot.hasSession) {
    return { ...base, state: "LOGGED_OUT", dispatchable: false };
  }
  if (!snapshot.onDuty) {
    return { ...base, state: "OFF_DUTY", dispatchable: false };
  }

  // Reported, not inferred: the device said it was going down.
  if (snapshot.shutdownAt !== null) {
    return { ...base, state: "OFFLINE", dispatchable: false };
  }

  if (beaconAgeMs === null || beaconAgeMs > OFFLINE_AFTER_MS) {
    return { ...base, state: "OFFLINE", dispatchable: false, presumed: true };
  }

  if (beaconAgeMs > signalLostAfterMs(snapshot.beaconIntervalMs)) {
    return { ...base, state: "SIGNAL_LOST", dispatchable: false };
  }

  // In contact. What remains is whether an offer could actually be delivered and
  // acted on — a rider who cannot be interrupted cannot answer a 45-second offer,
  // and offering to them only burns the countdown before it is re-dispatched.
  const impediments: Impediment[] = [];
  if (!snapshot.backgroundLocation) impediments.push("background_location");
  if (!snapshot.notifications) impediments.push("notifications");
  if (!snapshot.exactAlarms) impediments.push("exact_alarms");

  if (impediments.length > 0) {
    return { ...base, impediments, state: "NEEDS_PERMISSIONS", dispatchable: false };
  }

  return { ...base, state: "AVAILABLE", dispatchable: true };
}
