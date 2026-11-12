import { io, rooms, canSubscribeToErrand } from "../lib/socket.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import type { GeoPoint } from "../lib/geo.js";
import * as riderPositionStore from "../lib/riderPositionStore.js";
import { TRACKABLE_STATUSES } from "../lib/riderWatch.js";
import { ServiceError } from "./ServiceError.js";
import {
  isFollowing,
  metresBetween,
  rememberRiderRoute,
  riderRouteFor,
  type RiderLiveRoute,
} from "../lib/routing/riderLiveRoute.js";

/**
 * Shares the line a rider is following with the people watching them.
 *
 * Two halves. `recordRiderRoute` runs after every route Sugo Rider is given
 * and keeps it (lib/routing/riderLiveRoute.ts), then tells the watchers a new
 * line exists. `riderRouteForViewer` hands that line to a watcher who asks.
 *
 * The socket message is a notice, not the line: a 45 km route is thousands of
 * points, and every dispatcher would be sent every rider's on each reroute
 * while drawing one rider's at most. A map that wants the line fetches it.
 */

/**
 * A route request that starts this far from where the rider was last seen is
 * not the rider's own ride (nothing in the app asks for one today; this is a
 * guard, not a rule the app relies on).
 */
const ORIGIN_SANITY_METERS = 500;
const ORIGIN_SANITY_MAX_AGE_MS = 2 * 60 * 1000;

/**
 * The line ends at this errand's door when its last point's target is the
 * errand's own delivery pin. Both sides read the same stored coordinates, so
 * the tolerance only has to absorb rounding. It is kept tight on purpose: a
 * neighbour's errand must not be shown a line ending at the house next door.
 */
export const DOOR_MATCH_METERS = 15;

/** What a rider's route request and its answer need to say for the line to be kept. */
export interface RiderRouteRequest {
  origin: GeoPoint;
  destination: GeoPoint;
  /** bestRoute's `keep`: the rider only switched maps. */
  keep?: string;
}

export interface RiderRouteAnswer {
  coordinates: GeoPoint[];
  distanceMeters: number;
  durationSeconds: number;
  provider: string;
  degraded: boolean;
  selection: { drawnWith: string } | null;
}

/** The `rider:route` socket notice. */
export interface RiderRouteNotice {
  riderId: number;
  version: number;
  at: number;
  reroutedAt: number | null;
  /** True when this line replaces one the rider left. */
  rerouted: boolean;
  /** The errands whose door this line ends at. Empty while the rider heads to a store. */
  errandIds: string[];
}

interface DoorErrand {
  id: string;
  customerId: number | null;
  deliveryLatitude: number | null;
  deliveryLongitude: number | null;
}

function endsAtDoor(route: RiderLiveRoute, errand: Pick<DoorErrand, "deliveryLatitude" | "deliveryLongitude">): boolean {
  if (errand.deliveryLatitude == null || errand.deliveryLongitude == null) return false;
  return (
    metresBetween(route.target, { latitude: errand.deliveryLatitude, longitude: errand.deliveryLongitude }) <=
    DOOR_MATCH_METERS
  );
}

const isStaff = (role: string) => role === "OWNER" || role === "DISPATCHER";

/**
 * Keeps the route a rider was just given and tells their watchers.
 *
 * Called without being awaited, after the rider has their answer, and never
 * throws: sharing the line must not be able to fail the route request that
 * carried it.
 */
export async function recordRiderRoute(
  caller: { id: number; role: string } | undefined,
  request: RiderRouteRequest,
  answer: RiderRouteAnswer
): Promise<void> {
  try {
    if (!caller || String(caller.role).toUpperCase() !== "RIDER") return;
    // A straight-line guess is not a line anyone is following.
    if (answer.degraded || answer.coordinates.length < 2) return;

    const riderId = caller.id;
    const seen = riderPositionStore.getFresh(riderId, ORIGIN_SANITY_MAX_AGE_MS);
    if (seen && metresBetween(seen.point, request.origin) > ORIGIN_SANITY_METERS) return;

    const { route, rerouted } = rememberRiderRoute({
      riderId,
      origin: request.origin,
      target: request.destination,
      coordinates: answer.coordinates,
      distanceMeters: answer.distanceMeters,
      durationSeconds: answer.durationSeconds,
      lineEngine: answer.selection?.drawnWith ?? answer.provider,
      sameRoadRedrawn: Boolean(request.keep),
    });

    // Staff are still told when this lookup fails. A customer's map then
    // finds the line on its next safety poll.
    let errands: DoorErrand[] = [];
    try {
      errands = await prisma.errand.findMany({
        where: { riderId, status: { in: [...TRACKABLE_STATUSES] } },
        select: { id: true, customerId: true, deliveryLatitude: true, deliveryLongitude: true },
      });
    } catch (error) {
      logger.warn(`rider:route errand lookup failed for rider ${riderId}:`, error);
    }
    const atDoor = errands.filter((errand) => endsAtDoor(route, errand));

    const notice: RiderRouteNotice = {
      riderId,
      version: route.version,
      at: route.at,
      reroutedAt: route.reroutedAt,
      rerouted,
      errandIds: atDoor.map((errand) => errand.id),
    };
    io.to(rooms.role("DISPATCHER")).to(rooms.role("OWNER")).emit("rider:route", notice);

    // One message per errand, naming that errand alone: two customers at one
    // address must not be handed each other's errand ids. Customer room only,
    // never rooms.user(), whose numbers belong to staff.
    for (const errand of atDoor) {
      let target = io.to(rooms.errand(errand.id));
      if (errand.customerId) target = target.to(rooms.customer(errand.customerId));
      target.emit("rider:route", { ...notice, errandIds: [errand.id] });
    }
  } catch (error) {
    logger.warn(`Could not share rider ${caller?.id}'s route:`, error);
  }
}

export interface RiderRouteReply {
  /** The line, or null when there is none to show (the watcher then draws what it did before). */
  route: RiderLiveRoute | null;
  /** Set instead of resending a line the caller already holds (`since`). */
  unchanged?: true;
}

/**
 * The line a rider is following, for someone allowed to watch them.
 *
 * By errand: its customer, its rider, or staff. A customer is given the line
 * only when it ends at their own door, so they never see the route to a store
 * or to somebody else's address. By rider: staff only, whatever the target.
 *
 * Null when the rider has no line, is no longer on an errand, or has moved
 * well away from the line kept for them.
 */
export async function riderRouteForViewer(
  caller: { id: number; role: string } | undefined,
  query: { errandId?: string; riderId?: number; since?: number }
): Promise<RiderRouteReply> {
  if (!caller) throw new ServiceError(401, "Sign in to view this route.");
  const role = String(caller.role).toUpperCase();

  let riderId: number;
  let doorOf: Pick<DoorErrand, "deliveryLatitude" | "deliveryLongitude"> | null = null;

  if (query.errandId) {
    if (!(await canSubscribeToErrand(query.errandId, caller.id, role))) {
      throw new ServiceError(403, "You cannot view this errand's route.");
    }
    const errand = await prisma.errand.findUnique({
      where: { id: query.errandId },
      select: { riderId: true, status: true, deliveryLatitude: true, deliveryLongitude: true },
    });
    const trackable = (TRACKABLE_STATUSES as readonly string[]).includes(String(errand?.status ?? "").toUpperCase());
    if (!errand?.riderId || !trackable) return { route: null };
    riderId = errand.riderId;
    if (!isStaff(role)) doorOf = errand;
  } else if (query.riderId != null) {
    if (!isStaff(role)) throw new ServiceError(403, "Only staff can view a rider's route.");
    riderId = query.riderId;
    const working = await prisma.errand.count({
      where: { riderId, status: { in: [...TRACKABLE_STATUSES] } },
    });
    if (working === 0) return { route: null };
  } else {
    throw new ServiceError(400, "Name the errand or the rider whose route you want.");
  }

  const route = riderRouteFor(riderId);
  if (!route) return { route: null };
  if (doorOf && !endsAtDoor(route, doorOf)) return { route: null };

  const seen = riderPositionStore.get(riderId);
  if (seen && !isFollowing(route, seen.point)) return { route: null };

  if (query.since != null && query.since === route.version) return { route: null, unchanged: true };
  return { route };
}
