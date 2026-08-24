import { errandRepository, dispatchLogRepository } from "../repositories/errandRepository.js";
import { pinpointRepository, type PinpointInput } from "../repositories/pinpointRepository.js";
import { pabiliItemRepository } from "../repositories/pabiliItemRepository.js";
import { pabiliDetailRepository, type PabiliDetailInput } from "../repositories/pabiliDetailRepository.js";
import { pricingStoreCount } from "./patterns/pricingStoreCount.js";
import { smoothPath } from "../lib/routing/smoothPath.js";
import { GEOFENCE_RADIUS_METERS } from "./geofenceService.js";
import { decodePolyline, encodePolyline } from "../lib/routing/polyline.js";
import { rateConfigRepository } from "../repositories/rateConfigRepository.js";
import { customerTransactionRepository } from "../repositories/customerTransactionRepository.js";
import { userRepository } from "../repositories/userRepository.js";
import { customerRepository } from "../repositories/customerRepository.js";
import { errandDeclineRepository } from "../repositories/errandDeclineRepository.js";
import { PRESET_DECLINE_REASONS } from "../validators/errandDeclineValidators.js";
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
import * as commissionService from "./commissionService.js";
import { buildFeeBreakdown, type CustomerFeeBreakdown, type PricedErrand } from "./patterns/feeBreakdown.js";
import { modesForCategoryNames, resolveCategoryModes } from "./patterns/categoryFeeModes.js";
import { buildRiderEarnings, type EarningErrand } from "./patterns/riderEarnings.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";

/** A stop as errandRepository loads it, with just enough of its category. */
type PinpointWithCategory = { category?: { geofenceRadiusMeters: number } | null };

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

// Injects a computed `name` into an errand's customer/rider/dispatcher relations,
// and the fee breakdown every client renders.
//
// The breakdown is attached here rather than in each controller because this is
// the one function every errand response already passes through — which makes it
// the only place that can guarantee the customer, the dispatcher and the rider
// are shown the same figures. The raw fee columns stay on the payload too, so
// existing consumers are unaffected.
export function attachErrandNames<
  T extends {
    customer?: CustomerRelation;
    rider?: NamedPerson;
    dispatchLogs?: Array<{ dispatcher?: NamedPerson } & Record<string, unknown>>;
  }
>(errand: T) {
  // Pinpoints are not part of PricedErrand — they are not a price, they are how
  // many stops exist — but the breakdown needs the count to explain an absent
  // multi-store surcharge. Read separately rather than widening PricedErrand,
  // which every caller would then have to satisfy.
  const priced = errand as unknown as Partial<PricedErrand>;
  const stops = (errand as unknown as { pinpoints?: PinpointWithCategory[] }).pinpoints;

  return {
    ...errand,
    customer: withCustomerName(errand.customer),
    rider: withPersonName(errand.rider),
    // Each stop's own arrival radius, flattened from its category so every
    // client gets one number to draw a circle with and to test a fix against.
    // Stops pinned outside the catalogue carry the geofence's own default.
    ...(Array.isArray(stops)
      ? {
          pinpoints: stops.map((stop) => ({
            ...stop,
            geofenceRadiusMeters:
              stop.category?.geofenceRadiusMeters ?? GEOFENCE_RADIUS_METERS,
          })),
        }
      : {}),
    dispatchLogs: errand.dispatchLogs?.map((log) => ({
      ...log,
      dispatcher: withPersonName(log.dispatcher),
    })),
    // Only for payloads that actually carry pricing — some callers pass slim
    // projections, and inventing a zeroed breakdown for those would be worse
    // than omitting it.
    feeBreakdown:
      typeof priced.deliveryFee === "number"
        ? buildFeeBreakdown({
            deliveryFee: priced.deliveryFee,
            estimatedCost: priced.estimatedCost ?? 0,
            tip: priced.tip ?? 0,
            multiStoreFee: priced.multiStoreFee ?? null,
            groceryFee: priced.groceryFee ?? null,
            nonCodFee: priced.nonCodFee ?? null,
            distanceFee: priced.distanceFee ?? null,
            feeCalculatedAt: priced.feeCalculatedAt ?? null,
            routedAt: priced.routedAt ?? null,
            storeCount: priced.storeCount ?? null,
            pinnedStops: Array.isArray(stops) ? stops.length : null,
          })
        : null,
    // What the RIDER takes home, as distinct from what the customer pays. The
    // rider app used to derive this itself by reading deliveryFee, which is the
    // gross fee — so it promised riders the company's share as well as their own.
    riderEarnings:
      typeof priced.deliveryFee === "number"
        ? buildRiderEarnings({
            deliveryFee: priced.deliveryFee,
            tip: priced.tip ?? 0,
            estimatedCost: priced.estimatedCost ?? 0,
            commission: (errand as unknown as EarningErrand).commission ?? null,
          })
        : null,
  };
}

/**
 * Prices a draft errand before it exists.
 *
 * The customer's checkout screen needs a figure to show at the moment of
 * deciding, but there is no errand row yet to read one from. It used to solve
 * that by reimplementing the pricing formula client-side — on a hardcoded 2.5 km,
 * missing two fee components, and calling the grocery fee "commission" — so the
 * number a customer agreed to could not match what the server went on to bill.
 *
 * This runs the same StandardPricingStrategy against the same RateConfig the
 * server uses everywhere else. distanceKm is 0 because no store has been pinned
 * yet and the distance is genuinely unknown; the returned breakdown is therefore
 * marked not-final, and the client must present it as an estimate rather than
 * inventing a plausible-looking distance to fill the gap.
 */
export async function quoteErrand(input: {
  estimatedCost?: number;
  tip?: number;
  storeCount?: number;
  isCod?: boolean;
  storeCategories?: string[];
  /**
   * Total units in the basket. Sent by the client because the handling fee now
   * turns on size as well as value, and a quote that ignored it would differ
   * from the figure the customer is finally billed on a large cheap order.
   */
  itemUnits?: number;
}): Promise<CustomerFeeBreakdown> {
  const estimatedCost = Math.max(0, Number(input.estimatedCost) || 0);
  const tip = Math.max(0, Number(input.tip) || 0);
  const storeCount = Math.max(1, Math.round(Number(input.storeCount) || 1));
  const isCod = input.isCod !== false;

  const rateConfig = await rateConfigRepository.findFirst();
  if (!rateConfig) {
    throw new ServiceError(503, "Pricing is not configured yet. Please try again shortly.");
  }

  // The categories the customer picked decide how the handling fee is charged.
  // Nothing selected yet resolves to an empty list, which the strategy reads as
  // THRESHOLD — the behaviour that predates per-category modes.
  const categoryModes = await modesForCategoryNames(input.storeCategories ?? []);

  const breakdown = defaultPricingStrategy.calculate(
    {
      estimatedCost,
      itemUnits: Math.max(0, Math.round(Number(input.itemUnits) || 0)),
      tip,
      storeCount,
      distanceKm: 0,
      isCod,
      categoryModes,
    },
    rateConfig
  );

  return buildFeeBreakdown({
    deliveryFee: breakdown.deliveryFee,
    estimatedCost,
    tip,
    multiStoreFee: breakdown.multiStoreFee,
    groceryFee: breakdown.groceryFee,
    nonCodFee: breakdown.nonCodFee,
    distanceFee: breakdown.distanceFee,
    feeCalculatedAt: new Date(),
    // Never final: a quote by definition predates the routed distance.
    routedAt: null,
  });
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
  // ErrandItemsScreen.tsx) — independent of pabiliItems.length, which is the
  // real item list a customer typed and has nothing to do with how many stores
  // the rider must visit.
  //
  // The fallback for a caller that omits it counts DISTINCT store categories
  // among the items, not the items themselves. Falling back to the item count
  // charged a multi-store fee per item: a single-category order of burgers and
  // noodles was priced as a two-store run before anyone had pinned anything.
  const storeCount =
    input.storeCount && input.storeCount > 0
      ? Math.round(input.storeCount)
      : distinctStoreCategories(pabiliItems);
  const rateConfig = await rateConfigRepository.findFirst();

  // Same categories the quote was priced against, so the errand a customer
  // creates matches the figure they just agreed to. Recomputed properly once the
  // dispatcher pins real stores (see recalculateFee).
  const categoryModes = await modesForCategoryNames(
    (pabiliItems || []).map((item) => item.storeCategory).filter((c): c is string => Boolean(c))
  );

  const breakdown = rateConfig
    ? defaultPricingStrategy.calculate(
        {
          estimatedCost: parsedEstimatedCost,
          itemUnits: totalItemUnits(pabiliItems),
          tip: parsedTip,
          storeCount,
          distanceKm: 0,
          isCod: true,
          categoryModes,
        },
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
    // Record the components from the very first pricing pass, so an errand has an
    // explainable fee before a dispatcher ever touches it. distanceFee is
    // legitimately 0 here — nothing has been pinned yet, so no distance is known.
    ...("multiStoreFee" in breakdown
      ? {
          multiStoreFee: breakdown.multiStoreFee,
          groceryFee: breakdown.groceryFee,
          nonCodFee: breakdown.nonCodFee,
          distanceFee: breakdown.distanceFee,
          feeCalculatedAt: new Date(),
        }
      : {}),
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

  // What the customer committed to, never raised by the dispatcher's pins —
  // see pricingStoreCount for why.
  const storeCount = pricingStoreCount({
    storeCount: errand.storeCount,
    pinnedStops: (errand.pinpoints || []).length,
  });
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

  // Prefers the pinned stops' categories over the customer's original picks —
  // once a dispatcher has chosen actual stores, those are what the rider visits.
  const categoryModes = await resolveCategoryModes(errandId);

  const breakdown = defaultPricingStrategy.calculate(
    {
      estimatedCost: errand.estimatedCost,
      // The working list, not the customer's original: a dispatcher who adds or
      // removes items changes how much handling the errand actually is.
      itemUnits: totalItemUnits(errand.pabiliDetails ?? errand.pabiliItemRequests),
      tip: errand.tip,
      storeCount,
      distanceKm,
      isCod,
      categoryModes,
    },
    rateConfig
  );

  // Short-circuit only when there is genuinely nothing new to write. The fare
  // can legitimately be unchanged while the route data is being recorded for the
  // first time (or by a different engine), and that still needs persisting —
  // the customer's map and the dispatcher's ETA both read it.
  const routeUnchanged =
    errand.routeDistanceMeters === (routed?.result.distanceMeters ?? null) &&
    errand.routeProvider === (routed?.result.provider ?? null);
  // A breakdown recorded for the first time is a change worth writing even when
  // the total happens to match — otherwise an errand priced before the component
  // columns existed would never acquire one.
  const breakdownRecorded = errand.feeCalculatedAt !== null;
  if (breakdown.totalCost === errand.totalCost && routeUnchanged && breakdownRecorded) {
    return attachErrandNames(errand);
  }

  const updatedErrand = await errandRepository.update(errandId, {
    deliveryFee: breakdown.deliveryFee,
    totalCost: breakdown.totalCost,

    // The components behind deliveryFee. StandardPricingStrategy has always
    // returned these and this function has always discarded them, which left the
    // customer a total with no explanation — and led CheckoutScreen to compute
    // its own from a hardcoded distance. Persisted now so every surface reads one
    // set of numbers instead of deriving its own.
    //
    // estimatedCost is deliberately absent: it is the customer's item money, not
    // a fee, and it must never be folded into one.
    multiStoreFee: breakdown.multiStoreFee,
    groceryFee: breakdown.groceryFee,
    nonCodFee: breakdown.nonCodFee,
    distanceFee: breakdown.distanceFee,
    feeCalculatedAt: new Date(),
    // Persist what the fare was actually billed on. Previously distance was
    // computed here and thrown away, leaving no record of why a customer was
    // charged what they were charged (and leaving the schema gap flagged in
    // docs/errand_pricing_formula.md section 4.3 open).
    distanceKm,
    routeDistanceMeters: routed?.result.distanceMeters ?? null,
    routeDurationSeconds: routed?.result.durationSeconds ?? null,
    // Rounded before it is stored, because this is the line the dispatcher's
    // fleet map decodes and draws — nothing measures it. The distance above is
    // the engine's own figure and is untouched.
    routeGeometry: smoothEncodedGeometry(routed?.result.encodedGeometry ?? null),
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

  // Tell the customer a person has picked this up.
  //
  // The socket event above only reaches a customer whose app is open and
  // connected — which, while waiting, is exactly who they are least likely to
  // be. Persisting a notification and firing a push covers the other cases, and
  // is fire-and-forget so a notification problem can never fail the dispatcher's
  // accept.
  void (async () => {
    try {
      const dispatcher = await userRepository.findById(dispatcherId);
      const customer = await customerRepository.findById(errand.customerId);
      if (!customer) return;

      const dispatcherName = dispatcher
        ? `${dispatcher.firstName} ${dispatcher.lastName}`.trim() || "Your dispatcher"
        : "Your dispatcher";

      const storeSummary = (updatedErrand?.pinpoints || [])
        .map((p: { storeName?: string | null }) => p.storeName)
        .filter(Boolean)
        .join(" & ");

      await notificationService.notifyErrandAccepted(
        { id: customer.id, expoPushToken: customer.expoPushToken },
        errandId,
        dispatcherName,
        storeSummary
      );
    } catch (err) {
      logger.error(`Failed to notify customer of errand acceptance (${errandId}):`, err);
    }
  })();

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

  // Now that stops exist, file each requested item under the one it will be
  // bought at. This is the moment it becomes possible: the customer listed the
  // items at creation, when there were no stops to attach them to.
  //
  // replaceForErrand deletes and recreates the stops, so the old pinpointIds are
  // already gone (SET NULL on the FK) — this re-derives the mapping rather than
  // trying to preserve one that no longer refers to anything.
  const attached = await pabiliItemRepository.attachToPinpoints(errandId);
  if (attached > 0) {
    logger.info(`Errand ${errandId}: filed ${attached} item(s) under their store stops.`);
  }

  // storeCount deliberately NOT raised to pins.length here.
  //
  // It records how many stores the CUSTOMER chose, which is what they were
  // quoted and agreed to. Pinning three shops to fulfil a one-category order is
  // a dispatcher's fulfilment decision, and ratcheting this up billed the
  // customer a multi-store fee for it. The pins still change the route, so the
  // distance fee moves; the multi-store fee does not.

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
// (PabiliDetail) after creation — fixing a typo'd item name, a quantity the
// customer clarified over chat, or moving an item to the store it is actually
// sold at. Deliberately does NOT call recalculateFee: storeCount records the
// customer's own category selection and is unrelated to item edits. The
// customer's original ask stays untouched in PabiliItemRequest for audit.
export async function updateItems(errandId: string, items: PabiliDetailInput[]) {
  const errand = await errandRepository.findByIdBasic(errandId);
  if (!errand) {
    throw new ServiceError(404, "Errand not found");
  }

  await pabiliDetailRepository.replaceForErrand(errandId, items);

  // replaceForErrand deletes and recreates every row, so the new ones carry no
  // stop. Re-file them immediately.
  //
  // This is also the moment the dispatcher's restructuring is first expressible:
  // moving noodles from a fast-food stop to a grocery is recorded in the item's
  // storeCategory, and until this ran the rider went on seeing the customer's
  // original grouping no matter what the dispatcher changed.
  const filed = await pabiliItemRepository.attachToPinpoints(errandId);
  if (filed > 0) {
    logger.info(`Errand ${errandId}: re-filed ${filed} edited item(s) under their store stops.`);
  }

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
/**
 * How many distinct stores a typed item list implies.
 *
 * Only used when a client omits storeCount. Items with no category at all still
 * have to be bought somewhere, so an empty list floors at one store rather than
 * pricing as zero.
 */
function distinctStoreCategories(items: { storeCategory?: string | null }[] | undefined): number {
  const categories = new Set(
    (items ?? [])
      .map((i) => i.storeCategory?.trim().toLowerCase())
      .filter((c): c is string => Boolean(c))
  );
  return Math.max(1, categories.size);
}

/**
 * Rounds the corners of a stored route line.
 *
 * Errand.routeGeometry exists to be drawn on the dispatcher's fleet map and is
 * read by nothing else, so smoothing it here keeps that map consistent with the
 * customer's and the rider's without a second code path.
 *
 * Any failure returns the original: a route that draws with hard corners is a
 * great deal better than an errand that fails to save.
 */
function smoothEncodedGeometry(encoded: string | null): string | null {
  if (!encoded) return null;
  try {
    const smoothed = smoothPath(decodePolyline(encoded));
    return smoothed.length > 0 ? encodePolyline(smoothed) : encoded;
  } catch {
    return encoded;
  }
}

/**
 * Total units on a shopping list — quantities added up, so "Coke x6" is six.
 *
 * This is what decides whether an errand is big enough to carry a handling fee,
 * so it counts what the rider carries and queues with rather than how many
 * distinct things they have to find. A missing or nonsensical quantity counts
 * as one item, never zero: an item on the list is at least one thing to buy.
 */
function totalItemUnits(items: { quantity?: number | null }[] | undefined): number {
  return (items ?? []).reduce((sum, item) => {
    const quantity = Number(item.quantity);
    return sum + (Number.isFinite(quantity) && quantity > 0 ? Math.round(quantity) : 1);
  }, 0);
}

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

  // Snapshot the payout once the work is done. Recorded on both terminal
  // transitions because the fee can still move between them — a receipt total
  // arriving after DELIVERED changes estimatedCost and reprices — and the
  // repository upserts, so the later transition simply supersedes the earlier
  // figure rather than colliding with it.
  //
  // Fire-and-forget: a rider must never see their delivery fail to register
  // because a bookkeeping row could not be written.
  if (normalized === "DELIVERED" || normalized === "COMPLETED") {
    void commissionService.recordCommission(errandId).catch((error) => {
      logger.error(`Could not record commission for errand ${errandId}:`, error);
    });
  }

  const errandWithNames = attachErrandNames(updatedErrand);
  eventPublisher.emit("order:updated", errandWithNames);
  return errandWithNames;
}

/**
 * A dispatcher turning a request down during review, with the reason recorded.
 *
 * Distinct from `declineErrand`, which is a RIDER declining an assignment and
 * only bounces the errand back to the pool. This one ends the errand, and the
 * reason is the whole point: the console has always collected one and always
 * discarded it, leaving the customer with a cancelled request and no
 * explanation.
 */
export async function declineErrandReview(
  errandId: string,
  dispatcherId: number,
  reason: string
) {
  const errand = await errandRepository.findById(errandId);
  if (!errand) {
    throw new ServiceError(404, "Errand not found");
  }

  const finished = ["DELIVERED", "COMPLETED", "CANCELLED"];
  if (finished.includes(String(errand.status).toUpperCase())) {
    throw new ServiceError(409, `This errand is already ${String(errand.status).toLowerCase()}.`);
  }

  const trimmed = reason.trim();
  const isCustom = !PRESET_DECLINE_REASONS.includes(trimmed as (typeof PRESET_DECLINE_REASONS)[number]);

  // The reason is written BEFORE the status changes. If the status write
  // succeeded and this failed, the errand would be cancelled with no record —
  // exactly the state this feature exists to eliminate.
  await errandDeclineRepository.create({ errandId, dispatcherId, reason: trimmed, isCustom });

  const updated = await errandRepository.update(errandId, { status: "CANCELLED" });
  const errandWithNames = attachErrandNames(updated);
  eventPublisher.emit("order:updated", errandWithNames);
  eventPublisher.emit("errand:declined", { errandId, reason: trimmed, customerId: errand.customerId });

  void (async () => {
    try {
      const customer = await customerRepository.findById(errand.customerId);
      if (!customer) return;
      await notificationService.notifyErrandDeclined(
        { id: customer.id, expoPushToken: customer.expoPushToken },
        errandId,
        trimmed
      );
    } catch (err) {
      logger.error(`Failed to notify customer of decline (${errandId}):`, err);
    }
  })();

  return { errand: errandWithNames, reason: trimmed, isCustom };
}

/** The recorded reasons for an errand, newest first. */
export function getDeclineReasons(errandId: string) {
  return errandDeclineRepository.findByErrandId(errandId);
}
