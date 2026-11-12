import type { Socket } from "socket.io";
import { io } from "./socket.js";
import { logger } from "./logger.js";

/**
 * A one-second heartbeat from the Sugo Rider app, over its existing Socket.IO
 * connection, so a rider losing signal is known in seconds instead of beacons.
 *
 * The HTTP presence beacon (riderBeaconService) stays the authority on WHO a
 * rider is: on duty, permissions, shift. But it runs every 10 s on a delivery
 * and every 30 s idle, and the server only calls a rider lost after 2.5 missed
 * beacons, so a rider whose internet dropped went on looking Available Online
 * to dispatch for 25 to 75 seconds. Beaconing faster over HTTP would push every
 * rider through the API rate limiter once a second. A WebSocket frame costs
 * nothing there and a few dozen bytes on the wire.
 *
 * So this is an accelerator layered over the beacon, never a replacement:
 *
 * - A rider whose heartbeat is flowing counts as heard from just now, even if
 *   an HTTP beacon is late.
 * - A rider whose heartbeat STOPS is signal lost after HEARTBEAT_LOST_AFTER_MS,
 *   and every screen is told at once.
 * - A rider who never heartbeats (an app build without it, or the app closed
 *   and running only its background task) is judged by beacons alone, exactly
 *   as before. So is one who said they were going to the background, where
 *   Android may slow the app's timers and a late heartbeat would be a false
 *   alarm.
 *
 * In-process state, like riderPresenceStore. The API runs as one pm2 process;
 * a second instance would need this in a shared store.
 */

/** How often the app sends a heartbeat while open. Documentation for the client. */
export const HEARTBEAT_INTERVAL_MS = 1000;

/**
 * Silence longer than this and the rider has lost signal.
 *
 * Eight heartbeats (8 seconds). One late frame or brief radio stall (2-4s)
 * is ordinary on 4G mobile data during cell handovers, and treating a brief
 * jitter blip as signal loss caused status flapping between Available Online
 * and Signal Lost. 8 seconds accommodates real-world mobile latency while
 * still alerting dispatchers promptly if the connection is dead.
 */
export const HEARTBEAT_LOST_AFTER_MS = 8000;

/** How often the watchdog looks for silent links. */
const WATCHDOG_TICK_MS = 500;

/** Heartbeats faster than this from one rider are ignored, not processed. */
const MIN_HEARTBEAT_GAP_MS = 250;

interface Link {
  socketId: string;
  lastHeartbeatAt: number;
  /** The app said it went to the background; its heartbeat is not expected. */
  paused: boolean;
  /** The watchdog has already declared this link lost. */
  lost: boolean;
}

const links = new Map<number, Link>();

type LinkListener = (riderId: number, lost: boolean) => void;
const listeners = new Set<LinkListener>();

/** Told whenever a rider's link is lost or comes back. */
export function onLiveLinkChange(listener: LinkListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function announce(riderId: number, lost: boolean): void {
  for (const listener of listeners) {
    try {
      listener(riderId, lost);
    } catch (error) {
      logger.warn("Live link listener failed:", error);
    }
  }
}

export interface LiveLinkState {
  /** Epoch ms of the last heartbeat. */
  lastHeartbeatAt: number;
  /** True once the heartbeat has stopped for longer than the threshold. */
  lost: boolean;
}

/**
 * What the heartbeat says about a rider, or null when it has nothing to say
 * (no link, or the app is in the background). Read by availabilityForRiders.
 */
export function liveLinkOf(riderId: number): LiveLinkState | null {
  const link = links.get(riderId);
  if (!link || link.paused) return null;
  return { lastHeartbeatAt: link.lastHeartbeatAt, lost: link.lost };
}

function heartbeat(riderId: number, socketId: string, now: number): void {
  const link = links.get(riderId);
  if (link && link.socketId === socketId && now - link.lastHeartbeatAt < MIN_HEARTBEAT_GAP_MS) return;

  const wasLost = link?.lost ?? false;
  links.set(riderId, { socketId, lastHeartbeatAt: now, paused: false, lost: false });
  if (wasLost) announce(riderId, false);
}

function markLost(riderId: number, link: Link): void {
  if (link.lost) return;
  link.lost = true;
  announce(riderId, true);
}

let watchdog: ReturnType<typeof setInterval> | null = null;

/** Registered once from index.ts, next to the location channel. */
export function registerRiderLiveLink(): void {
  io.on("connection", (socket: Socket & { data: { riderId?: number; role?: string } }) => {
    const riderId = socket.data.riderId;
    if (riderId === undefined || socket.data.role !== "RIDER") return;

    socket.on("rider:heartbeat", () => heartbeat(riderId, socket.id, Date.now()));

    // The app is going to the background: stop expecting it, rather than read
    // a throttled timer as a dropped connection. The background task's beacons
    // carry the rider from here.
    socket.on("rider:heartbeat_pause", () => {
      const link = links.get(riderId);
      if (link && link.socketId === socket.id) link.paused = true;
    });

    socket.on("disconnect", (reason) => {
      const link = links.get(riderId);
      if (!link || link.socketId !== socket.id) return;
      // The app closed its own socket (signed out, or the app itself was
      // closed): not a lost signal. Beacons decide from here.
      if (reason === "client namespace disconnect" || reason === "server namespace disconnect") {
        links.delete(riderId);
        return;
      }
      // A cell handover or Android suspending the app can close the transport.
      // Keep the last heartbeat and let the watchdog apply the SAME grace
      // period as silence. A reconnect within it must not announce a loss.
    });
  });

  if (!watchdog) {
    watchdog = setInterval(() => {
      const now = Date.now();
      for (const [riderId, link] of links) {
        if (link.paused || link.lost) continue;
        if (now - link.lastHeartbeatAt > HEARTBEAT_LOST_AFTER_MS) markLost(riderId, link);
      }
    }, WATCHDOG_TICK_MS);
    watchdog.unref?.();
  }
}

/** For tests. */
export const __testing = {
  heartbeat,
  pause(riderId: number) {
    const link = links.get(riderId);
    if (link) link.paused = true;
  },
  tick(now: number) {
    for (const [riderId, link] of links) {
      if (link.paused || link.lost) continue;
      if (now - link.lastHeartbeatAt > HEARTBEAT_LOST_AFTER_MS) markLost(riderId, link);
    }
  },
  reset() {
    links.clear();
    listeners.clear();
  },
};
