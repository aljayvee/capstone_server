import type { RouteSelection } from "./bestRoute.js";

/**
 * Which engine's route each rider is following, as last decided for them.
 *
 * The customer's Track map must show the same map and the same line as the
 * rider's (server-decided, see bestRoute.ts). Asking the comparison again for
 * the customer could come out the other way on a near tie, or once the ETAs
 * drift, and then the two apps would disagree. So the rider's verdict is kept
 * here when their app asks for a route, and the customer's request for that
 * rider's errand reuses it instead of deciding afresh.
 *
 * In memory: it only needs to outlive the minutes between the rider's route
 * requests. After a server restart the next rider request writes it again, and
 * until then the customer's request simply decides for itself.
 */

/** A verdict older than this is not trusted: the rider has since moved on. */
export const RIDER_CHOICE_MAX_AGE_MS = 10 * 60 * 1000;

interface RiderChoice {
  chosen: RouteSelection["chosen"];
  drawnWith: RouteSelection["drawnWith"];
  at: number;
}

const choices = new Map<number, RiderChoice>();

export function rememberRiderChoice(riderId: number, selection: RouteSelection, now: number = Date.now()): void {
  choices.set(riderId, { chosen: selection.chosen, drawnWith: selection.drawnWith, at: now });
}

export function riderChoiceFor(riderId: number, now: number = Date.now()): RiderChoice | null {
  const choice = choices.get(riderId);
  if (!choice) return null;
  if (now - choice.at > RIDER_CHOICE_MAX_AGE_MS) {
    choices.delete(riderId);
    return null;
  }
  return choice;
}

/** Test seam. */
export function __resetRiderChoices(): void {
  choices.clear();
}
