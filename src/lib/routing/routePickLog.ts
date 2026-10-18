import { prisma } from "../prisma.js";
import { logger } from "../logger.js";
import type { MapProvider, RouteSelection } from "./bestRoute.js";
import { manilaDay } from "./mapAssignment.js";

/**
 * Who named the map a rider's line was drawn on:
 *  - "assigned": the server, by rider and day (mapAssignment.ts);
 *  - "app": the rider's app, which already shows a map and keeps it;
 *  - "winner": nobody (assignment off), so the winning path's own map.
 */
export type MapSource = "assigned" | "app" | "winner";

export interface RoutePickInput {
  riderId: number;
  mapSource: MapSource;
  mapAsked: MapProvider | null;
  selection: RouteSelection;
  now?: number;
}

/**
 * Records one rider route decision in route_picks, without holding up the
 * route. A failed write is logged, not thrown: the rider's directions matter
 * more than the statistic. The write starts inside an async function so even
 * a synchronous throw (no client, no model) arrives as a logged rejection.
 */
export function recordRoutePick(input: RoutePickInput): void {
  const { riderId, mapSource, mapAsked, selection } = input;
  const now = input.now ?? Date.now();
  const osrm = selection.candidates.find((candidate) => candidate.provider === "osrm");
  const google = selection.candidates.find((candidate) => candidate.provider === "google");

  void (async () => {
    await prisma.routePick.create({
      data: {
        riderId,
        day: manilaDay(now),
        mapSource,
        mapAsked,
        chosen: selection.chosen,
        drawnWith: selection.drawnWith,
        osrmDurationSeconds: osrm ? Math.round(osrm.durationSeconds) : null,
        osrmDistanceMeters: osrm ? Math.round(osrm.distanceMeters) : null,
        googleDurationSeconds: google ? Math.round(google.durationSeconds) : null,
        googleDistanceMeters: google ? Math.round(google.distanceMeters) : null,
        createdAt: new Date(now),
      },
    });
  })().catch((error: unknown) => {
    logger.warn(`Route pick for rider ${riderId} not recorded: ${error instanceof Error ? error.message : String(error)}`);
  });
}
