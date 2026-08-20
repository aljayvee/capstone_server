import { errandRepository, dispatchLogRepository } from "../repositories/errandRepository.js";
import { pinpointRepository, type PinpointInput } from "../repositories/pinpointRepository.js";
import { pabiliDetailRepository, type PabiliDetailInput } from "../repositories/pabiliDetailRepository.js";
import { rateConfigRepository } from "../repositories/rateConfigRepository.js";
import { customerTransactionRepository } from "../repositories/customerTransactionRepository.js";
import { userRepository } from "../repositories/userRepository.js";
import { paymentSelectionRepository } from "../repositories/paymentSelectionRepository.js";
import { ServiceError } from "./ServiceError.js";
import { eventPublisher } from "../lib/eventPublisher.js";
import * as notificationService from "./notificationService.js";
import { normalizeStatus, assertValidTransition, type ErrandStatusValue } from "./patterns/errandStateMachine.js";
import { defaultPricingStrategy } from "./patterns/pricingStrategy.js";
import { totalRouteDistanceKm, haversineDistanceKm } from "../lib/geo.js";
import * as routingService from "./routingService.js";
import * as etaService from "./etaService.js";
import * as riderPresenceStore from "../lib/riderPresenceStore.js";
import * as riderPositionStore from "../lib/riderPositionStore.js";
import * as routingProvider from "../lib/routing/resilientRoutingService.js";
import { isWithinServiceArea } from "../lib/serviceArea.js";
import { POSITION_FRESHNESS_MS } from "./etaService.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";

type NamedPerson = { firstName: string; lastName: string } | null | undefined;
type CustomerRelation =
  | { information: { firstName: string; lastName: string; phone: string } | null }
  | null
  | undefined;

function withPersonName<T extends NamedPerson>(person: T) {
  if (!person) return person;
  return { ...person, name: `${person.firstName} ${person.lastName}`.trim() };
}

// Flattens the CustomerAccount.information relation (split across two tables) back
// into a flat { firstName, lastName, phone, name } shape, so the HTTP response
// contract the web dashboard already consumes is unchanged.
function withCustomerName(customer: CustomerRelation) {
  if (!customer?.information) return null;
  const { firstName, lastName, phone } = customer.information;
  return { firstName, lastName, phone, name: `${firstName} ${lastName}`.trim() };
}

// Injects a computed `name` into an errand's customer/rider/dispatcher relations
export function attachErrandNames<
  T extends {
    customer?: CustomerRelation;
    rider?: NamedPerson;
    dispatchLogs?: Array<{ dispatcher?: NamedPerson } & Record<string, unknown>>;
  }
>(errand: T) {
  return {
    ...errand,
    customer: withCustomerName(errand.customer),
    rider: withPersonName(errand.rider),
    dispatchLogs: errand.dispatchLogs?.map((log) => ({
      ...log,
      dispatcher: withPersonName(log.dispatcher),
    })),
  };
}

export async function listErrands(requestingUser?: { id: number; role: string }) {
  const errands =
    requestingUser?.role === "DISPATCHER"
      ? await errandRepository.findManyForDispatcher(requestingUser.id)
      : await errandRepository.findMany();
  return errands.map(attachErrandNames);
}

export async function getErrandById(id: string) {
  const errand = await errandRepository.findById(id);
  return errand ? attachErrandNames(errand) : null;
}

export async function verifyDispatcherAccess(errandId: string, callerId: number, callerRole: string) {
  if (callerRole === "OWNER" || callerRole === "ADMIN") return;
  if (callerRole === "DISPATCHER") {
    const errand = await errandRepository.findById(errandId);
    if (!errand) throw new ServiceError(404, "Errand not found");
    const latestLog = errand.dispatchLogs?.[0];
    const isAvailable = String(errand.status).toUpperCase() === "AVAILABLE";
    if (!isAvailable && latestLog && latestLog.dispatcherId !== callerId) {
      const claimant = latestLog.dispatcher
        ? `${latestLog.dispatcher.firstName} ${latestLog.dispatcher.lastName}`.trim()
        : "another dispatcher";
      throw new ServiceError(403, `Access denied: This errand is currently assigned to ${claimant}.`);
    }
  }
}

export async function listErrandsForCustomer(customerId: number) {
  const errands = await errandRepository.findByCustomerId(customerId);
  return errands.map(attachErrandNames);
}

export async function listErrandsForRider(riderId: number) {
  const errands = await errandRepository.findByRiderId(riderId);
  return errands.map(attachErrandNames);
}

export interface CreateErrandInput {
  customerId?: string | number;
  category?: string;
  description?: string;
  pickupAddress?: string;
  deliveryAddress?: string;
  deliveryLatitude?: number | string;
  deliveryLongitude?: number | string;
  estimatedCost?: number | string;
  tip?: number | string;
  paymentMethod?: string;
  storeCount?: number;
  pabiliItems?: Array<{
    itemName?: string;
    name?: string;
    storeCategory?: string;
    quantity?: number;
    unitPrice?: number;
    estimatedSubtotal?: number;
  }>;
}

export async function createErrand(fallbackCustomerId: number, input: CreateErrandInput) {
  const {
    customerId,
    category = "Pabili",
    description = "",
    pickupAddress = "Store",
    deliveryAddress = "Customer Address",
    estimatedCost = 0,
    tip = 0,
    pabiliItems = [],
  } = input;

  const finalCustomerId = customerId ? parseInt(String(customerId), 10) : fallbackCustomerId;
  const parsedEstimatedCost = parseFloat(String(estimatedCost));
  const parsedTip = parseFloat(String(tip));

  // Fees are always server-computed from RateConfig — a client-supplied
  // deliveryFee/totalCost is never honored (previously it was, but the only
  // real caller, ErrandFormScreen.tsx, only ever sent placeholder 80/80
  // values, which meant RateConfig never actually affected a real errand's
  // price). Distance and non-COD fee aren't knowable yet at creation — they
  // start at 0/COD and get recomputed once they are (see recalculateFee).
  // Falls back to the previous hardcoded 80/80 if no RateConfig row exists yet.
  // storeCount is an explicit client input (selectedCats.length in
  // ErrandItemsScreen.tsx) — independent of pabiliItems.length, which is now
  // the real item list a customer typed and has nothing to do with how many
  // stores the rider must visit. Falls back to pabiliItems.length only for
  // backward compatibility with any caller that doesn't send it.
  const storeCount = input.storeCount && input.storeCount > 0 ? Math.round(input.storeCount) : (pabiliItems || []).length;
  const rateConfig = await rateConfigRepository.findFirst();
  const breakdown = rateConfig
    ? defaultPricingStrategy.calculate(
        { estimatedCost: parsedEstimatedCost, tip: parsedTip, storeCount, distanceKm: 0, isCod: true },
        rateConfig
      )
    : { deliveryFee: 80, totalCost: parsedEstimatedCost + 80 + parsedTip };
  const deliveryFee = breakdown.deliveryFee;
  const totalCost = breakdown.totalCost;

  const newErrand = await errandRepository.create({
    category,
    description,
    pickupAddress,
    deliveryAddress,
    deliveryLatitude: input.deliveryLatitude !== undefined ? parseFloat(String(input.deliveryLatitude)) : null,
    deliveryLongitude: input.deliveryLongitude !== undefined ? parseFloat(String(input.deliveryLongitude)) : null,
    estimatedCost: parsedEstimatedCost,
    deliveryFee,
    tip: parsedTip,
    totalCost,
    status: "AVAILABLE",
    customerId: finalCustomerId,
    storeCount,
    pabiliDetails: {
      create: (pabiliItems || []).map((item) => ({
        itemName: item.itemName || item.name || "Item",
        storeCategory: item.storeCategory || null,
        quantity: parseInt(String(item.quantity || 1), 10),
        unitPrice: parseFloat(String(item.unitPrice || 0)),
        estimatedSubtotal: parseFloat(String(item.estimatedSubtotal || 0)),
      })),
    },
    // Immutable audit-trail mirror of what the customer originally submitted —
    // never touched again after creation (see errandService.updateItems, which
    // only ever edits pabiliDetails, the working copy).
    pabiliItemRequests: {
      create: (pabiliItems || []).map((item) => ({
        itemName: item.itemName || item.name || "Item",
        storeCategory: item.storeCategory || null,
        quantity: parseInt(String(item.quantity || 1), 10),
      })),
    },
  });

  await customerTransactionRepository.create(finalCustomerId, newErrand.id, totalCost, input.paymentMethod || "COD");

  const errandWithNames = attachErrandNames(newErrand);
  eventPublisher.emit("order:new", errandWithNames);
  return errandWithNames;
}

// Idempotent: always recomputes the full total from whatever's currently
// known rather than applying an incremental delta — the facts that feed
// pricing (store count, confirmed payment mode, real distance) each become
// known at a different point after creation (see the three call sites:
// createErrand doesn't call this — there's nothing to recompute relative to
// yet — confirmPaymentSelection and savePinpoints do), so recomputing from
// scratch each time avoids the drift/double-counting risk of layering deltas.
// Notifies the customer only when the recompute actually changes totalCost
// from what they already saw.
// A backfilled timestamp is trusted only as far as it is plausible: never in
// the future, and never used at all if absent. A device with a badly wrong clock
// should not be able to rewrite an errand's history.
function clampOccurredAt(occurredAt?: Date): Date {
  const now = new Date();
  if (!occurredAt) return now;
  return occurredAt.getTime() > now.getTime() ? now : occurredAt;
}

export async function recalculateFee(errandId: string) {
  const errand = await errandRepository.findById(errandId);
  if (!errand) {
    throw new ServiceError(404, "Errand not found");
  }

  const rateConfig = await rateConfigRepository.findFirst();
  if (!rateConfig) {
    return attachErrandNames(errand);
  }

  // Derive store count from persisted storeCount or the actual pinned stores count
  // (whichever is greater) so multi-store fees from rate_configs are accurately applied.
  const storeCount = Math.max(errand.storeCount, (errand.pinpoints || []).length, 1);
  const destination =
    errand.deliveryLatitude != null && errand.deliveryLongitude != null
      ? { latitude: errand.deliveryLatitude, longitude: errand.deliveryLongitude }
      : null;

  // Road-network distance, not straight-line.
  //
  // This used to be a haversine sum, while the customer's map displayed the real
  // road route from an entirely different code path — so the fare was computed
  // from a distance shorter than the route they could watch on their own screen.
  // routingService measures the actual drivable route and only falls back to a
  // detour-scaled estimate if every routing engine is unreachable (and flags it
  // as degraded when it does). This is also what docs/errand_pricing_formula.md
  // section 4.1 required all along.
  const stops = errand.pinpoints.map((p) => ({ latitude: p.latitude, longitude: p.longitude }));
  const routed = await routingService.routeDistanceKm(stops, destination);
  const distanceKm = routed?.distanceKm ?? totalRouteDistanceKm(stops, destination);

  const selection = await paymentSelectionRepository.findByErrandId(errandId);
  const isCod = !selection || selection.paymentMode.name === "Cash on Delivery";

  const breakdown = defaultPricingStrategy.calculate(
    { estimatedCost: errand.estimatedCost, tip: errand.tip, storeCount, distanceKm, isCod },
    rateConfig
  );

  // Short-circuit only when there is genuinely nothing new to write. The fare
  // can legitimately be unchanged while the route data is being recorded for the
  // first time (or by a different engine), and that still needs persisting —
  // the customer's map and the dispatcher's ETA both read it.
  const routeUnchanged =
    errand.routeDistanceMeters === (routed?.result.distanceMeters ?? null) &&
    errand.routeProvider === (routed?.result.provider ?? null);
  if (breakdown.totalCost === errand.totalCost && routeUnchanged) {
    return attachErrandNames(errand);
  }

  const updatedErrand = await errandRepository.update(errandId, {
    deliveryFee: breakdown.deliveryFee,
    totalCost: breakdown.totalCost,
    // Persist what the fare was actually billed on. Previously distance was
    // computed here and thrown away, leaving no record of why a customer was
    // charged what they were charged (and leaving the schema gap flagged in
    // docs/errand_pricing_formula.md section 4.3 open).
    distanceKm,
    routeDistanceMeters: routed?.result.distanceMeters ?? null,
    routeDurationSeconds: routed?.result.durationSeconds ?? null,
    routeGeometry: routed?.result.encodedGeometry ?? null,
    routeProvider: routed?.result.provider ?? null,
    routedAt: routed ? new Date() : null,
  });

  // Keep customer transaction amount in sync with the live errand total
  await customerTransactionRepository.updateAmountByErrandId(errandId, breakdown.totalCost);

  const errandWithNames = attachErrandNames(updatedErrand);
  eventPublisher.emit("order:updated", errandWithNames);
  void notificationService.notifyFeeUpdated(errand.customerId, errandId, breakdown.totalCost);
  return errandWithNames;
}

export async function claimErrand(errandId: string, dispatcherId: number) {
  const errand = await errandRepository.findByIdWithDispatchLogs(errandId);
  if (!errand) {
    throw new ServiceError(404, "Errand not found");
  }

  if (errand.dispatchLogs.length > 0) {
    const existingLog = await dispatchLogRepository.findLatestByErrandId(errandId);

    // If already claimed by the SAME logged-in dispatcher, return success
    if (existingLog && existingLog.dispatcherId === dispatcherId) {
      const updatedErrand = await errandRepository.findById(errandId);
      return updatedErrand ? attachErrandNames(updatedErrand) : updatedErrand;
    }

    const claimantName = existingLog
      ? `${existingLog.dispatcher.firstName} ${existingLog.dispatcher.lastName}`.trim()
      : "another dispatcher";
    throw new ServiceError(409, `This order was already accepted by ${claimantName}`);
  }

  // Atomic guard: only proceeds if the errand is still AVAILABLE right now, closing
  // the race window between the read above and this write (two dispatchers claiming
  // the same errand at the same instant).
  const { count } = await errandRepository.claimIfAvailable(errandId);
  if (count === 0) {
    throw new ServiceError(409, "This order was already accepted by another dispatcher");
  }

  await dispatchLogRepository.create(errandId, dispatcherId);

  const updatedErrand = await errandRepository.findById(errandId);
  const errandWithNames = updatedErrand ? attachErrandNames(updatedErrand) : updatedErrand;
  eventPublisher.emit("order:claimed", errandWithNames);
  return errandWithNames;
}

export async function assignRider(
  errandId: string,
  riderId?: number,
  excludedRiderIds: number[] = []
) {
  const errand = await errandRepository.findById(errandId);
  if (!errand) {
    throw new ServiceError(404, "Errand not found");
  }

  let finalRiderId: number | null = riderId ?? null;

  // Automated "Assign Rider Now" algorithm when riderId is not explicitly provided
  if (!finalRiderId) {
    // 1. Repeat-customer priority (capped at 3 active/queued per customer).
    //
    // Collapsed from an N+1: this previously ran a count query and a user lookup
    // inside the candidate loop, so a customer with several active errands cost
    // a query per candidate on every assignment.
    const activeCustomerErrands = await prisma.errand.groupBy({
      by: ["riderId"],
      where: {
        customerId: errand.customerId,
        id: { not: errandId },
        status: { in: ["ASSIGNED", "IN_TRANSIT", "PENDING"] },
        riderId: { not: null },
      },
      _count: { _all: true },
    });

    const candidateIds = activeCustomerErrands
      .map((row) => row.riderId)
      .filter((id): id is number => id !== null && !excludedRiderIds.includes(id));

    if (candidateIds.length > 0) {
      const countByRider = new Map(
        activeCustomerErrands
          .filter((row) => row.riderId !== null)
          .map((row) => [row.riderId as number, row._count._all])
      );

      const activeRiders = await prisma.user.findMany({
        where: { id: { in: candidateIds }, role: "RIDER", status: "Active" },
        select: { id: true },
      });

      const repeatRider = activeRiders.find(
        (rider) => (countByRider.get(rider.id) ?? 0) < 3 && riderPresenceStore.isOnline(rider.id)
      );
      if (repeatRider) finalRiderId = repeatRider.id;
    }

    // 2. Proximity fallback: nearest eligible rider by real road travel time.
    //
    // This previously sorted candidates against `defaultRiderCoords`, a
    // hardcoded three-entry table keyed by database ids 3/4/5 — so "nearest
    // rider" was fiction for any other rider, and two riders outside the table
    // compared against two different constants and sorted by a fixed result.
    // Real positions now come from the breadcrumb store, and ranking is by
    // travel time on the road network rather than straight-line distance: a
    // rider 500 m away across the river is not the nearest rider.
    if (!finalRiderId) {
      const store1 = errand.pinpoints && errand.pinpoints.length > 0 ? errand.pinpoints[0] : null;
      const targetPoint = store1
        ? { latitude: Number(store1.latitude), longitude: Number(store1.longitude) }
        : errand.deliveryLatitude != null && errand.deliveryLongitude != null
          ? { latitude: errand.deliveryLatitude, longitude: errand.deliveryLongitude }
          : null;

      if (!targetPoint) {
        throw new ServiceError(
          409,
          "Cannot auto-assign a rider before store pinpoints or a delivery location are set."
        );
      }

      const allRiders = await prisma.user.findMany({
        where: { role: "RIDER", status: "Active" },
        include: {
          errandsAsRider: { where: { status: { in: ["ASSIGNED", "IN_TRANSIT"] } } },
        },
      });

      // `status: "Active"` is the admin account flag, not presence. The old code
      // filtered on it alone while telling the dispatcher that offline riders
      // had been excluded — they had not. isOnline() is the real signal.
      const eligibleRiders = allRiders.filter(
        (r) =>
          !excludedRiderIds.includes(r.id) &&
          r.errandsAsRider.length < 3 &&
          riderPresenceStore.isOnline(r.id)
      );

      if (eligibleRiders.length === 0) {
        throw new ServiceError(
          404,
          "No available riders. All riders are offline, at capacity (3 tasks), or have declined."
        );
      }

      // Only riders whose last known position is recent enough to mean anything,
      // using the same 60s threshold the dashboard uses to paint a rider as
      // "signal lost" — so the map and dispatch can never disagree about who is
      // reachable. Riders outside the service area are excluded too: the routing
      // graph has no roads for them and any travel time would be invented.
      const located = eligibleRiders
        .map((rider) => ({
          rider,
          position: riderPositionStore.getFresh(rider.id, POSITION_FRESHNESS_MS),
        }))
        .filter(
          (entry): entry is { rider: (typeof eligibleRiders)[number]; position: NonNullable<ReturnType<typeof riderPositionStore.getFresh>> } =>
            entry.position !== undefined && isWithinServiceArea(entry.position.point)
        );

      if (located.length === 0) {
        // No usable positions: fall back to the least-loaded rider rather than
        // failing the dispatch, but say so plainly instead of pretending a
        // proximity decision was made.
        const leastLoaded = [...eligibleRiders].sort(
          (a, b) => a.errandsAsRider.length - b.errandsAsRider.length
        )[0];
        logger.info(
          `Assigning errand ${errandId} to rider ${leastLoaded.id} by load — no rider had a GPS position fresher than ${POSITION_FRESHNESS_MS}ms.`
        );
        finalRiderId = leastLoaded.id;
      } else {
        // One matrix call ranks every candidate at once.
        const matrix = await routingProvider.matrix(
          located.map((entry) => entry.position.point),
          [targetPoint]
        );

        if (matrix) {
          let best = 0;
          for (let i = 1; i < located.length; i++) {
            if ((matrix.durationsSeconds[i]?.[0] ?? Infinity) < (matrix.durationsSeconds[best]?.[0] ?? Infinity)) {
              best = i;
            }
          }
          finalRiderId = located[best].rider.id;
        } else {
          // Routing unavailable entirely — straight-line is a poor proxy but a
          // real position beats no decision at all.
          located.sort(
            (a, b) =>
              haversineDistanceKm(a.position.point, targetPoint) -
              haversineDistanceKm(b.position.point, targetPoint)
          );
          finalRiderId = located[0].rider.id;
        }
      }
    }
  }

  const rider = await userRepository.findById(finalRiderId);
  if (!rider || rider.role !== "RIDER") {
    throw new ServiceError(400, "Selected user is not a valid rider.");
  }

  assertValidTransition(errand.status as unknown as ErrandStatusValue, "ASSIGNED");

  const updatedErrand = await errandRepository.update(errandId, {
    riderId: finalRiderId,
    status: "ASSIGNED",
    assignedAt: new Date(),
  });

  const errandWithNames = attachErrandNames(updatedErrand);
  eventPublisher.emit("order:updated", errandWithNames);
  eventPublisher.emit("order:assigned", {
    errandId: updatedErrand.id,
    riderId: finalRiderId,
    riderName: `${rider.firstName} ${rider.lastName}`.trim(),
  });

  // Persists a Notification row and sends push notification
  void notificationService.notifyRiderAssigned(rider, updatedErrand.id, updatedErrand.pickupAddress);

  // A rider is now attached, so the customer can be given a real ETA.
  etaService.recomputeInBackground(errandId, { force: true });

  return errandWithNames;
}

// Rider declines or times out (45s): un-assigns the rider, updates customer tracking
// with smooth status ("Finding the best rider for your delivery..."), and silently
// re-routes to the next nearest eligible rider.
export async function declineErrand(errandId: string, riderId: number, reason?: string) {
  const errand = await errandRepository.findStatusAndRiderById(errandId);
  if (!errand) {
    throw new ServiceError(404, "Errand not found");
  }

  if (errand.riderId !== riderId) {
    throw new ServiceError(403, "Access denied: You can only decline errands assigned to you.");
  }

  assertValidTransition(errand.status as unknown as ErrandStatusValue, "PENDING");

  const updatedErrand = await errandRepository.update(errandId, {
    riderId: null,
    status: "PENDING",
  });

  const errandWithNames = attachErrandNames(updatedErrand);
  eventPublisher.emit("order:updated", errandWithNames);
  eventPublisher.emit("errand:re_routing", {
    errandId,
    previousRiderId: riderId,
    statusText: "Finding the best rider for your delivery...",
  });

  // Attempt silent auto-reassignment to next nearest eligible rider
  try {
    const reassigned = await assignRider(errandId, undefined, [riderId]);
    return reassigned;
  } catch (_reRouteErr) {
    // Alert dispatcher only if all eligible riders decline or are out of radius
    eventPublisher.emit("errand:all_riders_declined", {
      errandId,
      reason: reason || "All eligible riders declined or timed out",
    });
    return errandWithNames;
  }
}

export async function confirmOrder(errandId: string, customerId: number) {
  const errand = await errandRepository.findById(errandId);
  if (!errand) {
    throw new ServiceError(404, "Errand not found");
  }

  const errandWithNames = attachErrandNames(errand);
  eventPublisher.emit("order:confirmed", { errandId, customerId, confirmedAt: new Date() });
  eventPublisher.emit("order:updated", errandWithNames);
  return errandWithNames;
}


// Dispatcher sets/replaces the store pinpoints (waypoints) a rider must follow for
// this errand. Persisted as structured data (not just an ephemeral chat message) so
// both the rider's live map and any GIS routing have a single source of truth.
export async function savePinpoints(errandId: string, pins: PinpointInput[]) {
  const errand = await errandRepository.findByIdBasic(errandId);
  if (!errand) {
    throw new ServiceError(404, "Errand not found");
  }

  await pinpointRepository.replaceForErrand(errandId, pins);
  if (pins.length > 0) {
    await errandRepository.update(errandId, {
      storeCount: Math.max(pins.length, errand.storeCount, 1),
    });
  }

  // Pinpoints are the first source of real distance data — recompute now
  // that they're known (see recalculateFee). This also emits order:updated
  // and notifies the customer if the fee actually changed; emit again below
  // unconditionally so the dispatcher's map view still picks up the new pins
  // on the common case where the fee doesn't happen to change.
  const errandWithNames = await recalculateFee(errandId);
  eventPublisher.emit("order:updated", errandWithNames);
  return errandWithNames;
}

// Dispatcher corrects the working copy of the customer's requested items
// (PabiliDetail) after creation — e.g. fixing a typo'd item name or a
// quantity the customer clarified over chat. Deliberately does NOT call
// recalculateFee: storeCount was fixed at creation from the category
// selection and is unrelated to item-name/quantity edits. The customer's
// original ask stays untouched in PabiliItemRequest for audit purposes.
export async function updateItems(errandId: string, items: PabiliDetailInput[]) {
  const errand = await errandRepository.findByIdBasic(errandId);
  if (!errand) {
    throw new ServiceError(404, "Errand not found");
  }

  await pabiliDetailRepository.replaceForErrand(errandId, items);

  const updatedErrand = await errandRepository.findById(errandId);
  const errandWithNames = attachErrandNames(updatedErrand!);
  eventPublisher.emit("order:updated", errandWithNames);
  return errandWithNames;
}

// Dispatcher-side gate for the chat-embedded payment-selection flow — the
// customer's POST /errands/:id/payment-selection is rejected until this runs
// (see paymentSelectionService.confirmPaymentSelection's guard). Idempotent:
// enabling an already-enabled errand is a harmless no-op, not an error.
export async function enablePayment(errandId: string, dispatcherId: number) {
  const existing = await errandRepository.findByIdBasic(errandId);
  if (!existing) {
    throw new ServiceError(404, "Errand not found");
  }

  const updatedErrand = existing.paymentEnabledAt
    ? await errandRepository.findById(errandId)
    : await errandRepository.update(errandId, {
        paymentEnabledAt: new Date(),
        paymentEnabledByDispatcherId: dispatcherId,
      });

  const errandWithNames = attachErrandNames(updatedErrand!);
  eventPublisher.emit("order:updated", errandWithNames);
  return errandWithNames;
}

// Rider marks that they've bought everything on the errand's item list —
// customer-facing progress-stepper gate (see itemsPurchasedAt on the Errand
// model). Idempotent, same shape as enablePayment: re-marking an
// already-purchased errand is a harmless no-op, not an error.
export async function markItemsPurchased(
  errandId: string,
  riderId: number,
  receiptTotal?: number,
  occurredAt?: Date
) {
  const existing = await errandRepository.findByIdBasic(errandId);
  if (!existing) {
    throw new ServiceError(404, "Errand not found");
  }

  if (existing.riderId !== riderId) {
    throw new ServiceError(403, "Access denied: You can only update errands assigned to you.");
  }

  const updateData: any = { itemsPurchasedAt: clampOccurredAt(occurredAt) };
  if (receiptTotal !== undefined && receiptTotal > 0) {
    updateData.estimatedCost = receiptTotal;
  }

  await errandRepository.update(errandId, updateData);

  // Recalculate fees with the verified receipt subtotal to accurately apply groceryFee from rate_configs
  const errandWithNames = await recalculateFee(errandId);
  eventPublisher.emit("order:updated", errandWithNames);
  return errandWithNames;
}

// Rider accepts an errand the dispatcher assigned to them. Semantically distinct
// endpoint (rather than the generic status-update one) so the client has a single
// obvious "Accept Job" call — internally it's exactly the ASSIGNED -> IN_TRANSIT
// transition already defined in the state machine, restricted to the assigned rider.
// occurredAt lets a rider report when they actually accepted, not when their
// phone regained signal to say so. Same queue-then-flush pattern the
// connectivity-incident endpoint already uses (see connectivityIncidentService).
export async function acceptErrand(errandId: string, riderId: number, occurredAt?: Date) {
  const errand = await errandRepository.findStatusAndRiderById(errandId);
  if (!errand) {
    throw new ServiceError(404, "Errand not found");
  }

  if (errand.riderId !== riderId) {
    throw new ServiceError(403, "Access denied: You can only accept errands assigned to you.");
  }

  assertValidTransition(errand.status as unknown as ErrandStatusValue, "IN_TRANSIT");

  const updatedErrand = await errandRepository.update(errandId, {
    status: "IN_TRANSIT",
    acceptedAt: clampOccurredAt(occurredAt),
  });

  const errandWithNames = attachErrandNames(updatedErrand);
  eventPublisher.emit("order:updated", errandWithNames);
  // The rider is now en route, so an ETA becomes meaningful for the first time.
  etaService.recomputeInBackground(errandId, { force: true });
  return errandWithNames;
}

export async function updateStatus(
  errandId: string,
  rawStatus: string,
  caller: { id: number; role: string },
  occurredAt?: Date
) {
  const normalized = normalizeStatus(rawStatus);

  const errand = await errandRepository.findStatusAndRiderById(errandId);
  if (!errand) {
    throw new ServiceError(404, "Errand not found");
  }

  // RIDER can only update status of errands assigned to them
  if (caller.role === "RIDER" && errand.riderId !== caller.id) {
    throw new ServiceError(403, "Access denied: You can only update status for errands assigned to you.");
  }

  assertValidTransition(errand.status as unknown as ErrandStatusValue, normalized);

  // Stamp the terminal transitions. Delivery duration used to be derived from
  // `updatedAt - createdAt`, which silently became wrong the moment anything
  // touched the row after delivery (a rating, a settlement).
  const at = clampOccurredAt(occurredAt);
  const updateData: Record<string, unknown> = { status: normalized };
  if (normalized === "IN_TRANSIT") updateData.acceptedAt = at;
  if (normalized === "DELIVERED") updateData.deliveredAt = at;
  if (normalized === "COMPLETED") updateData.completedAt = at;

  const updatedErrand = await errandRepository.update(errandId, updateData);

  const errandWithNames = attachErrandNames(updatedErrand);
  eventPublisher.emit("order:updated", errandWithNames);
  return errandWithNames;
}
