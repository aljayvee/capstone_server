import type { Socket } from "socket.io";
import { io, rooms, canSubscribeToErrand } from "./socket.js";
import * as riderPositionStore from "./riderPositionStore.js";
import { prisma } from "./prisma.js";
import { logger } from "./logger.js";
import { recomputeFromLivePosition } from "../services/etaService.js";
import * as deliveryReminders from "../services/deliveryReminderService.js";
import { TRACKABLE_STATUSES } from "./riderWatch.js";

/**
 * The Socket.IO half of live rider tracking.
 *
 * Until now every pin on the owner, dispatcher and customer maps came from
 * Firebase RTDB alone. The server was already receiving the same rider's
 * position three ways (presence beacons, breadcrumb uploads, and now a live
 * socket stream) and told nobody. This pushes each of those out as a
 * `rider:location` event, so a map has two independent feeds and draws
 * whichever fix is newer. When one path is slow or refused, the other still
 * moves the pin.
 *
 * ## Built for slow connections
 *
 * - **Volatile emits.** A viewer whose connection cannot keep up has position
 *   events dropped instead of queued. A backlog of stale positions replayed in
 *   a burst is worse than useless on a live map; the next fix supersedes them.
 * - **Throttled per rider, trailing edge kept.** At most one event per rider
 *   per BROADCAST_MIN_INTERVAL_MS. The newest fix in a burst is held and sent
 *   when the window closes, so the last position is never the one that is lost.
 * - **Out-of-order fixes are dropped.** A flushed offline backlog must not drag
 *   a pin back to where the rider was ten minutes ago.
 * - **Snapshots on (re)connect.** A client that just reconnected asks for the
 *   latest known positions in one round trip (`fleet:snapshot` for staff,
 *   `rider:last_location` for a customer) instead of waiting out each rider's
 *   next fix with an empty map.
 *
 * Wired from index.ts rather than imported by socket.ts, which would make the
 * circular import socket.ts has deliberately avoided (see the note there).
 */

export type RiderLocationSource = "socket" | "beacon" | "track";

export interface RiderLocationEvent {
  riderId: number;
  latitude: number;
  longitude: number;
  heading: number | null;
  accuracyMeters: number | null;
  speedMps: number | null;
  /** Device clock at the fix, epoch ms. The same basis RTDB's `updatedAt` uses. */
  recordedAt: number;
  source: RiderLocationSource;
}

export interface RiderFix {
  latitude: number;
  longitude: number;
  headingDeg?: number | null;
  accuracyMeters?: number | null;
  speedMps?: number | null;
  recordedAt: number;
}

/** One event per rider per second at most. The rider app samples every ~2 s. */
const BROADCAST_MIN_INTERVAL_MS = 1000;

/** How long a rider's active-errand lookup is reused before asking the DB again. */
const ACTIVE_ERRANDS_TTL_MS = 15_000;

/** Positions older than this are not offered to a reconnecting map. */
const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * How far a device clock may disagree with the server before its timestamp is
 * replaced. A phone set an hour fast would otherwise win every freshness
 * comparison on the viewer's side, forever.
 */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Statuses in which the customer is entitled to watch the rider approach. */
// ASSIGNED and IN_TRANSIT. The same list decides who may read the rider in
// Firebase, so it is imported from riderWatch.ts rather than repeated.

interface ThrottleState {
  lastSentAt: number;
  lastRecordedAt: number;
  pending: RiderLocationEvent | null;
  timer: ReturnType<typeof setTimeout> | null;
}

const throttles = new Map<number, ThrottleState>();

interface ActiveErrand {
  id: string;
  customerId: number | null;
  // For the delivery run's "almost there" push (deliveryReminderService).
  status?: string | null;
  itemsPurchasedAt?: Date | null;
  deliveryLatitude?: number | null;
  deliveryLongitude?: number | null;
}

const activeErrandCache = new Map<number, { at: number; errands: ActiveErrand[] }>();

async function activeErrandsFor(riderId: number): Promise<ActiveErrand[]> {
  const cached = activeErrandCache.get(riderId);
  if (cached && Date.now() - cached.at < ACTIVE_ERRANDS_TTL_MS) return cached.errands;

  const errands = await prisma.errand.findMany({
    where: { riderId, status: { in: [...TRACKABLE_STATUSES] } },
    select: {
      id: true,
      customerId: true,
      status: true,
      itemsPurchasedAt: true,
      deliveryLatitude: true,
      deliveryLongitude: true,
    },
  });
  activeErrandCache.set(riderId, { at: Date.now(), errands });
  return errands;
}

/**
 * Forgets a rider's cached errand list, so a new assignment starts reaching its
 * customer at once rather than after the cache expires. Safe to call anywhere.
 */
export function invalidateActiveErrands(riderId: number): void {
  activeErrandCache.delete(riderId);
}

async function send(event: RiderLocationEvent): Promise<void> {
  // Staff always. Their maps show the whole fleet.
  let target = io.volatile.to(rooms.role("DISPATCHER")).to(rooms.role("OWNER"));

  // A customer only for as long as this rider is working their errand. The
  // lookup is done at send time, never cached in a room membership, so a
  // reassigned rider stops being visible to the previous customer immediately.
  try {
    for (const errand of await activeErrandsFor(event.riderId)) {
      // Keeps the customer's arrival window moving with the rider. Throttled
      // inside to once a minute per errand.
      recomputeFromLivePosition(errand.id);
      // "Almost there", from the live position rather than waiting for a
      // breadcrumb upload. Cheap until the rider is within 500 m.
      deliveryReminders.inBackground(deliveryReminders.onRiderPosition(errand, event), "arrival push");
      target = target.to(rooms.errand(errand.id));
      // Customer room only, never rooms.user(): customer and staff ids share
      // one numeric space (see eventPublisher.emitToErrandParties).
      if (errand.customerId) target = target.to(rooms.customer(errand.customerId));
    }
  } catch (error) {
    // Staff still get the fix. A customer map falls back to RTDB for a beat.
    logger.warn(`rider:location errand lookup failed for rider ${event.riderId}:`, error);
  }

  target.emit("rider:location", event);
}

/**
 * Sends one event to the customer of every errand this rider is working, and
 * to no one else. How the customer app hears that its rider lost signal the
 * moment dispatch does, rather than after its own 60-second freshness window.
 */
export async function emitToRiderCustomers(riderId: number, event: string, payload: unknown): Promise<void> {
  try {
    for (const errand of await activeErrandsFor(riderId)) {
      // Customer room only; never rooms.user(), which shares ids with staff.
      if (errand.customerId) io.to(rooms.customer(errand.customerId)).emit(event, payload);
    }
  } catch (error) {
    logger.warn(`Could not tell rider ${riderId}'s customers about ${event}:`, error);
  }
}

function normaliseRecordedAt(recordedAt: number, now: number): number {
  if (!Number.isFinite(recordedAt)) return now;
  return Math.abs(recordedAt - now) > MAX_CLOCK_SKEW_MS ? now : recordedAt;
}

/**
 * Publishes one fix. Non-blocking and never throws: tracking telemetry must not
 * be able to fail the beacon or upload that carried it.
 */
export function broadcastRiderLocation(riderId: number, fix: RiderFix, source: RiderLocationSource): void {
  try {
    if (!Number.isFinite(fix.latitude) || !Number.isFinite(fix.longitude)) return;

    const now = Date.now();
    const event: RiderLocationEvent = {
      riderId,
      latitude: fix.latitude,
      longitude: fix.longitude,
      heading: Number.isFinite(fix.headingDeg) ? (fix.headingDeg as number) : null,
      accuracyMeters: Number.isFinite(fix.accuracyMeters) ? (fix.accuracyMeters as number) : null,
      speedMps: Number.isFinite(fix.speedMps) ? (fix.speedMps as number) : null,
      recordedAt: normaliseRecordedAt(fix.recordedAt, now),
      source,
    };

    let state = throttles.get(riderId);
    if (!state) {
      state = { lastSentAt: 0, lastRecordedAt: 0, pending: null, timer: null };
      throttles.set(riderId, state);
    }

    const newestKnown = Math.max(state.lastRecordedAt, state.pending?.recordedAt ?? 0);
    if (event.recordedAt <= newestKnown) return;

    const wait = state.lastSentAt + BROADCAST_MIN_INTERVAL_MS - now;
    if (wait <= 0 && !state.timer) {
      state.lastSentAt = now;
      state.lastRecordedAt = event.recordedAt;
      void send(event);
      return;
    }

    // Inside the window: keep only the newest, and flush it when it closes.
    state.pending = event;
    if (!state.timer) {
      const current = state;
      current.timer = setTimeout(() => {
        current.timer = null;
        const pending = current.pending;
        current.pending = null;
        if (!pending) return;
        current.lastSentAt = Date.now();
        current.lastRecordedAt = pending.recordedAt;
        void send(pending);
      }, Math.max(wait, 0));
    }
  } catch (error) {
    logger.warn(`broadcastRiderLocation failed for rider ${riderId}:`, error);
  }
}

function toEvent(riderId: number, position: riderPositionStore.RiderPosition): RiderLocationEvent {
  return {
    riderId,
    latitude: position.point.latitude,
    longitude: position.point.longitude,
    heading: position.headingDeg,
    accuracyMeters: position.accuracyMeters,
    speedMps: null,
    recordedAt: position.recordedAt,
    source: "beacon",
  };
}

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

type Ack = (result: unknown) => void;

type AuthenticatedSocket = Socket & { data: { userId?: number; role?: string; riderId?: number } };

/**
 * Registers the three socket messages this channel owns. Called once from
 * index.ts; Socket.IO allows any number of `connection` listeners.
 */
export function registerRiderLocationChannel(): void {
  io.on("connection", (socket: AuthenticatedSocket) => {
    const { userId, role, riderId } = socket.data;

    // Inbound live stream from the rider app, sent next to its RTDB write.
    // Identity comes from the verified JWT, never from the payload, so a rider
    // can only ever move their own pin.
    socket.on("rider:location", (payload: unknown) => {
      if (riderId === undefined || role !== "RIDER") return;
      const p = payload as Record<string, unknown> | null;
      if (!p || !isNumber(p.latitude) || !isNumber(p.longitude)) return;
      if (Math.abs(p.latitude) > 90 || Math.abs(p.longitude) > 180) return;

      const recordedAt = normaliseRecordedAt(isNumber(p.recordedAt) ? p.recordedAt : Date.now(), Date.now());
      const fix: RiderFix = {
        latitude: p.latitude,
        longitude: p.longitude,
        headingDeg: isNumber(p.heading) ? p.heading : null,
        accuracyMeters: isNumber(p.accuracyMeters) ? p.accuracyMeters : null,
        speedMps: isNumber(p.speedMps) ? p.speedMps : null,
        recordedAt,
      };

      // Also freshens the cache dispatch ranking and the ETA engine read.
      riderPositionStore.record(riderId, {
        point: { latitude: fix.latitude, longitude: fix.longitude },
        recordedAt,
        accuracyMeters: fix.accuracyMeters ?? null,
        headingDeg: fix.headingDeg ?? null,
      });
      broadcastRiderLocation(riderId, fix, "socket");
    });

    // Staff map (re)connecting: every known position in one reply.
    socket.on("fleet:snapshot", (ack?: Ack) => {
      if (typeof ack !== "function") return;
      const normalizedRole = String(role || "").toUpperCase();
      if (userId === undefined || (normalizedRole !== "OWNER" && normalizedRole !== "DISPATCHER")) {
        ack({ ok: false, error: "Not authorized" });
        return;
      }
      ack({
        ok: true,
        riders: riderPositionStore
          .snapshot(SNAPSHOT_MAX_AGE_MS)
          .map(({ riderId: id, ...position }) => toEvent(id, position)),
      });
    });

    // Customer map (re)connecting: this errand's rider, if the caller may see it.
    socket.on("rider:last_location", async (errandId: unknown, ack?: Ack) => {
      if (typeof ack !== "function") return;
      if (typeof errandId !== "string" || !errandId) {
        ack({ ok: false, error: "errandId must be a string" });
        return;
      }
      try {
        if (!(await canSubscribeToErrand(errandId, userId, role))) {
          ack({ ok: false, error: "Not authorized for this errand" });
          return;
        }
        const errand = await prisma.errand.findUnique({
          where: { id: errandId },
          select: { riderId: true, status: true },
        });
        const trackable = errand?.status === "ASSIGNED" || errand?.status === "IN_TRANSIT";
        const position = errand?.riderId && trackable ? riderPositionStore.get(errand.riderId) : undefined;
        ack({ ok: true, location: position && errand?.riderId ? toEvent(errand.riderId, position) : null });
      } catch (error) {
        logger.error(`rider:last_location failed for ${errandId}:`, error);
        ack({ ok: false, error: "Lookup failed" });
      }
    });
  });
}
