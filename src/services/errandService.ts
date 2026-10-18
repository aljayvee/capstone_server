import { errandRepository, dispatchLogRepository } from "../repositories/errandRepository.js";
import { pinpointRepository, type PinpointInput } from "../repositories/pinpointRepository.js";
import { pabiliItemRepository } from "../repositories/pabiliItemRepository.js";
import { pabiliDetailRepository, type PabiliDetailInput } from "../repositories/pabiliDetailRepository.js";
import { forgetMemoryCache } from "./itemPlacementService.js";
import { forgetStorePredictionMemory } from "./storePredictionService.js";
import { warmItemCategories } from "../lib/category/categoryServiceClient.js";
import { buildCreatedItemRows } from "./patterns/pabiliItemRows.js";
import { formatItemLabel } from "./patterns/itemLabel.js";
import { ITEM_SIZE_STORAGE } from "../config/env.js";
import { checkStoreLocation } from "./storeLocationGuard.js";
import { pricingStoreCount, distinctStopCount } from "./patterns/pricingStoreCount.js";
import { smoothPath } from "../lib/routing/smoothPath.js";
import { fareAfterAgreement } from "./patterns/agreedFare.js";
import { GEOFENCE_RADIUS_METERS } from "./geofenceService.js";
import { decodePolyline, encodePolyline } from "../lib/routing/polyline.js";
import { rateConfigRepository } from "../repositories/rateConfigRepository.js";
import { customerTransactionRepository } from "../repositories/customerTransactionRepository.js";
import { syncTransactionStatusQuietly } from "./transactionStatusService.js";
import { userRepository } from "../repositories/userRepository.js";
import { customerRepository } from "../repositories/customerRepository.js";
import { errandDeclineRepository } from "../repositories/errandDeclineRepository.js";
import { PRESET_DECLINE_REASONS } from "../validators/errandDeclineValidators.js";
import { paymentSelectionRepository } from "../repositories/paymentSelectionRepository.js";
import { ServiceError } from "./ServiceError.js";
import { eventPublisher } from "../lib/eventPublisher.js";
import { grantCustomerChat, setChatDispatcher } from "../lib/chatAccess.js";
import { grantRiderWatch, isWatchable, scheduleRiderWatchReconcile } from "../lib/riderWatch.js";
import * as notificationService from "./notificationService.js";
import { notificationRepository } from "../repositories/notificationRepository.js";
import { notificationFactory } from "./patterns/notificationFactory.js";
import { normalizeStatus, assertValidTransition, type ErrandStatusValue } from "./patterns/errandStateMachine.js";
import { defaultPricingStrategy } from "./patterns/pricingStrategy.js";
import { totalRouteDistanceKm, haversineDistanceKm } from "../lib/geo.js";
import * as routingService from "./routingService.js";
import * as etaService from "./etaService.js";
import * as riderPresenceStore from "../lib/riderPresenceStore.js";
import * as riderPositionStore from "../lib/riderPositionStore.js";
import * as riderBeaconService from "./riderBeaconService.js";
import { describeReason, STATUS_LABEL } from "../lib/riderAvailability.js";
import * as routingProvider from "../lib/routing/resilientRoutingService.js";
import { isWithinServiceArea, isWithinServiceBuffer, isServiceAreaConfigured } from "../lib/serviceArea.js";
import { POSITION_FRESHNESS_MS } from "./etaService.js";
import * as commissionService from "./commissionService.js";
// Namespace import, deliberately: errandPaymentService calls back into
// recalculateFee, so the two form a cycle. Both sides only reach across inside
// function bodies, never at module top level, which is the same shape
// proofImageService already uses.
import * as errandPaymentService from "./errandPaymentService.js";
import { buildFeeBreakdown, type CustomerFeeBreakdown, type PricedErrand } from "./patterns/feeBreakdown.js";
import { modesForCategoryNames, resolveCategoryModes } from "./patterns/categoryFeeModes.js";
import type { HandlingFeeMode } from "./patterns/pricingStrategy.js";
import { resolveHandlingEvidence } from "./patterns/handlingEvidence.js";
import { isCodSelection, hasPaymentLedger, paymentMethodChangeOf, PAYMENT_MODE_COD } from "./patterns/paymentModes.js";
import { summarisePaymentPlan } from "./patterns/paymentLedger.js";
import { buildRiderEarnings, type EarningErrand } from "./patterns/riderEarnings.js";
import { whereRiderBecomesFree, dispatchCostSeconds } from "./patterns/dispatchCost.js";
import type { GeoPoint } from "../lib/geo.js";
import { logger } from "../lib/logger.js";
import { sendPushNotification } from "../lib/pushNotifications.js";
import * as deliveryReminders from "./deliveryReminderService.js";
import { prisma } from "../lib/prisma.js";
import type { Prisma } from "@prisma/client";

/**
 * How many accepted errands one rider may carry at once.
 *
 * This was the bare literal `3`, written twice inside assignRider and a third
 * time inside the sentence shown to a dispatcher when nobody was eligible — so
 * the cap could be changed in one place and silently disagree with itself in
 * the other two. The rider app now draws one fee capsule per errand up to this
 * number, which makes it a contract rather than an internal heuristic.
 */

/**
 * An errand's news, sent to the people on it: staff (both role rooms), its
 * customer and its rider. These events went to every connected client until
 * 2026-10-07, so every customer's phone heard every other customer's errand
 * and opened its chat. `errand` picks the audience; `payload` defaults to it.
 */
function publishToErrand(
  event: string,
  errand: { id: string; customerId?: number | null; riderId?: number | null; status?: string | null } | null | undefined,
  payload: unknown = errand
): void {
  if (!errand) return;
  const emit = () =>
    eventPublisher.emitToErrandParties(
      errand.id,
      { riderId: errand.riderId ?? null, customerId: errand.customerId ?? null },
      event,
      payload
    );
  // Who may read which rider's live position follows every errand change
  // (lib/riderWatch.ts). A rider now on this errand is granted first, so the
  // customer's map, which opens on this event, is never refused.
  scheduleRiderWatchReconcile();
  const watch = {
    id: errand.id,
    customerId: errand.customerId ?? null,
    riderId: errand.riderId ?? null,
    status: errand.status ?? null,
  };
  if (isWatchable(watch)) void grantRiderWatch(watch).finally(emit);
  else emit();
}

export const MAX_ACTIVE_ERRANDS_PER_RIDER = 3;

/** A stop as errandRepository loads it, with just enough of its category. */
type PinpointWithCategory = {
  category?: { geofenceRadiusMeters: number; name: string } | null;
};

type NamedPerson = { firstName: string; lastName: string } | null | undefined;
type CustomerRelation =
  | {
      information: {
        firstName: string;
        lastName: string;
        phone: string;
        phoneVerified?: boolean;
        phoneVerifiedAt?: Date | null;
      } | null;
    }
  | null
  | undefined;

function withPersonName<T extends NamedPerson>(person: T) {
  if (!person) return person;
  return { ...person, name: `${person.firstName} ${person.lastName}`.trim() };
}

function personFullName(person: NamedPerson): string | null {
  return person ? `${person.firstName} ${person.lastName}`.trim() || null : null;
}

// Flattens the CustomerAccount.information relation (split across two tables) back
// into a flat { firstName, lastName, phone, phoneVerified, phoneVerifiedAt, name } shape,
// so the HTTP response contract the web dashboard already consumes is preserved and enhanced.
function withCustomerName(customer: CustomerRelation) {
  if (!customer?.information) return null;
  const { firstName, lastName, phone, phoneVerified, phoneVerifiedAt } = customer.information;
  return {
    firstName,
    lastName,
    phone,
    phoneVerified: Boolean(phoneVerified),
    phoneVerifiedAt: phoneVerifiedAt ?? null,
    name: `${firstName} ${lastName}`.trim(),
  };
}

// Injects a computed `name` into an errand's customer/rider/dispatcher relations,
// and the fee breakdown every client renders.
//
// The breakdown is attached here rather than in each controller because this is
// the one function every errand response already passes through — which makes it
// the only place that can guarantee the customer, the dispatcher and the rider
// are shown the same figures. The raw fee columns stay on the payload too, so
// existing consumers are unaffected.
/**
 * The payment plan for one errand, where it has one.
 *
 * Derived rather than fetched: the ledger rows ride along on ERRAND_INCLUDE, so
 * this stays synchronous and attachErrandNames — which every errand response
 * already passes through — can attach it without becoming async.
 *
 * Null unless the errand is actually on the downpayment plan. Every COD errand
 * gets null, and a client that sees null behaves exactly as it did before any of
 * this existed.
 */
function derivePaymentPlan(errand: unknown) {
  const row = errand as {
    estimatedCost?: number;
    totalCost?: number;
    status?: string;
    overageEscalatedAt?: Date | null;
    overageResolvedAt?: Date | null;
    halfPaymentRequestedAt?: Date | null;
    payments?: Array<{ kind: string; amount: number }>;
    paymentSelection?: { paymentMode: { name: string } } | null;
  };

  if (!hasPaymentLedger(row.paymentSelection) || typeof row.totalCost !== "number") {
    return null;
  }

  const summary = summarisePaymentPlan({
    grandTotal: row.totalCost,
    entries: (row.payments ?? []) as Array<{ kind: never; amount: number }>,
    cancelled: row.status === "CANCELLED",
  });

  return {
    ...summary,
    hasLedger: true,
    goodsTotal: row.estimatedCost ?? 0,
    // The 50% downpayment's "asked for" stamp. Always null on errands since
    // 2026-10-08; installed apps still read it, and null keeps their
    // half-payment screens closed.
    halfPaymentRequestedAt: null,
  };
}

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
  const confirmedMode = (errand as unknown as { paymentSelection?: { paymentMode?: { name?: string } } | null })
    .paymentSelection?.paymentMode?.name;

  return {
    ...errand,
    // Flat copies of the rider's and dispatcher's names and the confirmed
    // payment mode (2026-10-10). The customer app's errand details screen and
    // chat pop-up read only these, the shape its errand list
    // (/customers/:id/transactions) sends, so a pull-to-refresh onto this
    // response showed an assigned rider as "Assigning" and a chosen GCash as
    // "Pending Selection". Installed apps need a new build to read the
    // relations instead; this fixes them now. Each is set only when its source
    // is in the payload, so a slim projection never claims "nobody", and
    // paymentMethod only once confirmed, so a socket update merged into the
    // app's list cannot blank the method the list already had.
    ...("rider" in errand ? { riderName: personFullName(errand.rider) } : {}),
    ...(Array.isArray(errand.dispatchLogs)
      ? { dispatcherName: personFullName(errand.dispatchLogs[0]?.dispatcher) }
      : {}),
    ...(confirmedMode ? { paymentMethod: confirmedMode } : {}),
    // A GCash/PayMaya or bank customer who paid the rider cash instead:
    // { from, to }, or null. Only when both modes are in the payload, so a slim
    // projection merged into a client's copy never erases a change it showed.
    ...("paymentMode" in errand && "paymentSelection" in errand
      ? { paymentMethodChange: paymentMethodChangeOf(errand as Parameters<typeof paymentMethodChangeOf>[0]) }
      : {}),
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
            // The category's NAME, flattened the same way and for the same
            // reason as the radius. The rider app shows it under the store so a
            // rider walking into a mall knows whether they are shopping for
            // groceries or collecting a bill. Null for a stop pinned off the
            // catalogue, which renders as no line rather than as "Other".
            storeCategory: stop.category?.name ?? null,
          })),
        }
      : {}),
    dispatchLogs: errand.dispatchLogs?.map((log) => ({
      ...log,
      dispatcher: withPersonName(log.dispatcher),
    })),
    // Where this errand's money stands, on the same terms as feeBreakdown: one
    // server-derived shape, so the customer's balance, the dispatcher's panel
    // and the rider's cash step cannot disagree about what is owed.
    //
    // Null for every COD errand, which is almost all of them — a client seeing
    // null behaves exactly as it did before this existed.
    paymentPlan: derivePaymentPlan(errand),
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
  deliveryStreetName?: string | null;
  deliveryLandmark?: string | null;
  deliveryNotes?: string | null;
  estimatedCost?: number | string;
  tip?: number | string;
  paymentMethod?: string;
  storeCount?: number;
  pabiliItems?: Array<{
    itemName?: string;
    name?: string;
    storeCategory?: string;
    quantity?: number;
    size?: string | null;
    notes?: string | null;
    unitPrice?: number;
    estimatedSubtotal?: number;
    /** Which of `stores` the item is bought at. */
    storeIndex?: number;
  }>;
  /** Stores the customer picked in the app's "Location" step, in visit order. */
  stores?: CustomerStoreInput[];
}

export interface CustomerStoreInput {
  name: string;
  latitude: number;
  longitude: number;
  placeId?: string | null;
  categoryId?: number | null;
}

interface CustomerPin {
  storeName: string;
  latitude: number;
  longitude: number;
  placeId: string | null;
  categoryId: number | null;
  categoryName: string | null;
}

/** The pin validator's limit (validators/pinpointValidators.ts), so a later dispatcher save accepts it as is. */
const PIN_NAME_MAX = 60;

/**
 * The stores a customer picked, made ready to be the errand's first pins.
 *
 * Every store passes the same location guard as a dispatcher's pin, before
 * anything is written: a store the rider cannot reach refuses the order rather
 * than leaving it half made. A Location Stores pick keeps its row and that
 * row's category; any other category is kept only if it is active, the same
 * trust as Merchant mode, where the customer names categories directly.
 */
async function resolveCustomerStores(stores: CustomerStoreInput[]): Promise<CustomerPin[]> {
  for (const store of stores) {
    const verdict = await checkStoreLocation({ latitude: store.latitude, longitude: store.longitude });
    if (verdict.status === "blocked") {
      throw new ServiceError(422, `${store.name}: ${verdict.message}`);
    }
  }

  const active = await prisma.merchantCategory.findMany({
    where: { status: "Active" },
    select: { id: true, name: true },
  });
  const categoryById = new Map(active.map((c) => [c.id, c]));

  return Promise.all(
    stores.map(async (store) => {
      const place = store.placeId
        ? await prisma.verifiedPlace.findFirst({
            where: { id: store.placeId, isActive: true },
            select: { id: true, categoryId: true },
          })
        : null;
      const category =
        (place ? categoryById.get(place.categoryId) : undefined) ??
        (store.categoryId != null ? categoryById.get(store.categoryId) : undefined) ??
        null;
      return {
        storeName: store.name.trim().slice(0, PIN_NAME_MAX).trim(),
        latitude: store.latitude,
        longitude: store.longitude,
        placeId: place?.id ?? null,
        categoryId: category?.id ?? null,
        categoryName: category?.name ?? null,
      };
    })
  );
}

/**
 * The dispatcher's own filing for an item bought at stop `index`: "Store 2 -
 * Mercury Drug | Pharmacy". itemStopAssignment files it under that stop by
 * number, which holds even when two picked stores share a category.
 */
export function customerStoreFiling(pins: CustomerPin[], index: number | undefined, fallback: string | null): string | null {
  const pin = index === undefined ? undefined : pins[index];
  if (!pin) return fallback;
  const category = pin.categoryName ?? fallback;
  return `Store ${index! + 1} - ${pin.storeName}${category ? ` | ${category}` : ""}`.slice(0, 191);
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

  if (
    input.deliveryLatitude !== undefined &&
    input.deliveryLongitude !== undefined &&
    isServiceAreaConfigured()
  ) {
    const dLat = parseFloat(String(input.deliveryLatitude));
    const dLng = parseFloat(String(input.deliveryLongitude));
    if (!Number.isNaN(dLat) && !Number.isNaN(dLng)) {
      if (!isWithinServiceBuffer({ latitude: dLat, longitude: dLng }, 0.1)) {
        throw new ServiceError(
          422,
          "Delivery address is outside Tacurong City service area. SUGO Express currently operates exclusively within Tacurong City."
        );
      }
    }
  }

  const finalCustomerId = customerId ? parseInt(String(customerId), 10) : fallbackCustomerId;
  const parsedEstimatedCost = parseFloat(String(estimatedCost));
  const parsedTip = parseFloat(String(tip));
  const itemRows = buildCreatedItemRows(pabiliItems || [], ITEM_SIZE_STORAGE);

  // Stores the customer picked themselves become the errand's first pins, so
  // they arrive pinned in the dispatcher's Stage 1. Resolved before anything is
  // written (see resolveCustomerStores).
  const customerPins = input.stores?.length ? await resolveCustomerStores(input.stores) : [];
  // The working copy is filed under those stops by number. The customer's own
  // request keeps the plain category name: the handling fee is decided from it
  // (categoryFeeModes.ts), so it matches the quote the customer agreed to.
  const detailRows =
    customerPins.length > 0
      ? itemRows.map((row, i) => ({
          ...row,
          storeCategory: customerStoreFiling(customerPins, pabiliItems[i]?.storeIndex, row.storeCategory),
        }))
      : itemRows;

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
    customerPins.length > 0
      ? customerPins.length
      : input.storeCount && input.storeCount > 0
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
    // A snapshot of the saved location's door details, never a reference to it.
    deliveryStreetName: input.deliveryStreetName?.trim() || null,
    deliveryLandmark: input.deliveryLandmark?.trim() || null,
    deliveryNotes: input.deliveryNotes?.trim() || null,
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
    // Size goes in its own column or folded into the name, per
    // ITEM_SIZE_STORAGE (see patterns/pabiliItemRows.ts).
    pabiliDetails: {
      create: detailRows,
    },
    // In the same write as the errand, so an order never exists without the
    // stores its customer picked. sequence is 0-based, as replaceForErrand writes it.
    ...(customerPins.length > 0
      ? {
          pinpoints: {
            create: customerPins.map((pin, index) => ({
              sequence: index,
              storeName: pin.storeName,
              latitude: pin.latitude,
              longitude: pin.longitude,
              categoryId: pin.categoryId,
              placeId: pin.placeId,
            })),
          },
        }
      : {}),
    // Immutable audit-trail mirror of what the customer originally submitted —
    // never touched again after creation (see errandService.updateItems, which
    // only ever edits pabiliDetails, the working copy).
    pabiliItemRequests: {
      create: itemRows.map(({ itemName, size, notes, storeCategory, quantity }) => ({
        itemName,
        size,
        notes,
        storeCategory,
        quantity,
      })),
    },
  });

  await customerTransactionRepository.create(finalCustomerId, newErrand.id, totalCost, input.paymentMethod || "PENDING");
  // Before the reply, so the customer's chat opens the moment the app shows it.
  await grantCustomerChat(newErrand.id, finalCustomerId);

  let created = newErrand;
  if (customerPins.length > 0) {
    // File each item under its stop now, as savePinpoints does once a dispatcher
    // pins. Not fatal: an unfiled item shows the rider a general list, and the
    // dispatcher's Continue in Stage 1 files it again.
    try {
      await pabiliItemRepository.attachToPinpoints(newErrand.id);
      created = (await errandRepository.findById(newErrand.id)) ?? newErrand;
    } catch (error) {
      logger.warn(`Errand ${newErrand.id}: could not file items under the customer's stores:`, error);
    }
    // The picked stores join the directory the store predictor learns from.
    forgetStorePredictionMemory();
  }

  const errandWithNames = attachErrandNames(created);
  publishToErrand("order:new", errandWithNames);
  // Gemma's answers for unfamiliar items take seconds; asked now, they are
  // cached before a dispatcher opens the order. Never awaited.
  warmItemCategories((pabiliItems || []).map((item) => item.itemName || item.name || ""));
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

type PricingErrand = NonNullable<Awaited<ReturnType<typeof errandRepository.findById>>>;
type PricingRateConfig = NonNullable<Awaited<ReturnType<typeof rateConfigRepository.findFirst>>>;
type PricingStop = { latitude: number; longitude: number; placeId?: string | null };

/**
 * The price of this errand with these stops, computed and not saved.
 *
 * The one calculation behind both recalculateFee, which writes it and tells the
 * customer when their total moved, and quotePinpoints, which only shows the
 * dispatcher what the stops they are placing will cost. Kept as one function so
 * the preview can never disagree with the fee the save then charges.
 */
async function priceForStops(
  errand: PricingErrand,
  rateConfig: PricingRateConfig,
  pins: PricingStop[],
  categoryModes: HandlingFeeMode[]
) {
  // The larger of what the customer committed to and how many stops are
  // actually pinned — see pricingStoreCount for the trade-off this accepts.
  const storeCount = pricingStoreCount({
    storeCount: errand.storeCount,
    // DISTINCT stops, not row count. The same shop pinned twice is one stop of
    // rider time, and billing it as two added a multi-store fee to a fare the
    // customer had already agreed to.
    pinnedStops: distinctStopCount(pins),
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
  const stops = pins.map((p) => ({ latitude: p.latitude, longitude: p.longitude }));
  const routed = await routingService.routeDistanceKm(stops, destination);
  const distanceKm = routed?.distanceKm ?? totalRouteDistanceKm(stops, destination);

  const selection = await paymentSelectionRepository.findByErrandId(errand.id);
  // A transfer customer who paid cash at the door is priced as cash from then
  // on (paymentSelectionService.switchToCashOnDelivery), so no later reprice
  // puts the non-COD fee back.
  const isCod = isCodSelection(selection) || errand.paymentMode?.name === PAYMENT_MODE_COD;

  // How good the basket figure is, and what the customer already agreed to pay
  // for handling it. The ceiling is null until they confirm the breakdown (see
  // confirmOrder), which is the same as the behaviour that came before.
  const handlingEvidence = await resolveHandlingEvidence(errand.id);

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
      quotedHandlingCeiling: errand.quotedHandlingFee,
      handlingEvidence,
    },
    rateConfig
  );

  // The fare stops moving once the customer has agreed to it.
  //
  // This function re-measures the road on every call, and markItemsPurchased
  // calls it when the rider uploads a receipt. Distance is billed in whole
  // started kilometres, so it is a step function: the same leg measuring 2716 m
  // on Google and 2756 m on OSRM can land either side of a kilometre boundary
  // and move the fare ₱10 with nobody deciding it. That is how a customer quoted
  // ₱90 came to be charged ₱80, 35 seconds after a re-measurement.
  //
  // The item money is NOT frozen with it. A receipt that beats the estimate is
  // the customer's to pay and checkReceiptOverage's to stop; what they agreed
  // was the FARE, and that is the only thing held here.
  const fare = fareAfterAgreement({
    agreedFare: errand.quotedDeliveryFee,
    livePrice: { deliveryFee: breakdown.deliveryFee, totalCost: breakdown.totalCost },
    estimatedCost: errand.estimatedCost,
    tip: errand.tip,
  });

  const fareIsAgreed = fare.frozen;
  const effectiveDeliveryFee = fare.deliveryFee;
  const effectiveTotalCost = fare.totalCost;

  // Components are kept as stamped rather than recomputed, because they are the
  // account of the agreed fare — a freshly derived set would explain a bill the
  // customer was never charged, and the four are documented to sum to it.
  const components = fareIsAgreed
    ? {
        multiStoreFee: errand.multiStoreFee,
        groceryFee: errand.groceryFee,
        nonCodFee: errand.nonCodFee,
        distanceFee: errand.distanceFee,
        handlingFeeDecision: errand.handlingFeeDecision as Prisma.InputJsonValue,
      }
    : {
        multiStoreFee: breakdown.multiStoreFee,
        groceryFee: breakdown.groceryFee,
        nonCodFee: breakdown.nonCodFee,
        distanceFee: breakdown.distanceFee,
        handlingFeeDecision: breakdown.handlingDecision as unknown as Prisma.InputJsonValue,
      };

  return { routed, distanceKm, fareIsAgreed, effectiveDeliveryFee, effectiveTotalCost, components };
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

  // Prefers the pinned stops' categories over the customer's original picks —
  // once a dispatcher has chosen actual stores, those are what the rider visits.
  const categoryModes = await resolveCategoryModes(errandId);
  const { routed, distanceKm, effectiveDeliveryFee, effectiveTotalCost, components } =
    await priceForStops(errand, rateConfig, errand.pinpoints, categoryModes);

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
  if (effectiveTotalCost === errand.totalCost && routeUnchanged && breakdownRecorded) {
    return attachErrandNames(errand);
  }

  const updatedErrand = await errandRepository.update(errandId, {
    deliveryFee: effectiveDeliveryFee,
    totalCost: effectiveTotalCost,

    // The components behind deliveryFee. StandardPricingStrategy has always
    // returned these and this function has always discarded them, which left the
    // customer a total with no explanation — and led CheckoutScreen to compute
    // its own from a hardcoded distance. Persisted now so every surface reads one
    // set of numbers instead of deriving its own.
    //
    // estimatedCost is deliberately absent: it is the customer's item money, not
    // a fee, and it must never be folded into one.
    //
    // Held at their stamped values once the fare is agreed — see above.
    ...components,
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
  await customerTransactionRepository.updateAmountByErrandId(errandId, effectiveTotalCost);

  const errandWithNames = attachErrandNames(updatedErrand);
  publishToErrand("order:updated", errandWithNames);
  void notificationService.notifyFeeUpdated(errand.customerId, errandId, effectiveTotalCost);
  return errandWithNames;
}

/**
 * What these stops would cost, before they are saved.
 *
 * Step 3 of the dispatcher console calls this as pins are placed, so the fee is
 * on screen the moment the stores are, instead of only after "send the stores
 * to the customer". Nothing is written and nobody is notified: saving the
 * stops (savePinpoints) still does both, once, with the same calculation.
 *
 * A stop the router cannot reach is refused exactly as savePinpoints refuses it,
 * so the preview never prices a set of stops that could not then be saved.
 */
export async function quotePinpoints(errandId: string, pins: PinpointInput[]) {
  const errand = await errandRepository.findById(errandId);
  if (!errand) {
    throw new ServiceError(404, "Errand not found");
  }
  const rateConfig = await rateConfigRepository.findFirst();
  if (!rateConfig) {
    throw new ServiceError(503, "Pricing is not configured yet.");
  }

  for (const pin of pins) {
    const verdict = await checkStoreLocation({ latitude: pin.latitude, longitude: pin.longitude });
    if (verdict.status === "blocked") {
      throw new ServiceError(422, `${pin.storeName ? `${pin.storeName}: ` : ""}${verdict.message}`);
    }
  }

  const categoryModes = await resolveCategoryModes(
    errandId,
    pins.map((p) => p.categoryId ?? null)
  );
  const priced = await priceForStops(errand, rateConfig, pins, categoryModes);

  return {
    deliveryFee: priced.effectiveDeliveryFee,
    totalCost: priced.effectiveTotalCost,
    distanceFee: priced.components.distanceFee,
    multiStoreFee: priced.components.multiStoreFee,
    groceryFee: priced.components.groceryFee,
    nonCodFee: priced.components.nonCodFee,
    distanceKm: Math.round(priced.distanceKm * 100) / 100,
    // No routing engine answered: the distance is a straight-line estimate.
    estimated: !priced.routed,
    // The customer has agreed a fare, so these stops do not change it.
    fareAgreed: priced.fareIsAgreed,
    stops: distinctStopCount(pins),
  };
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
  // Awaited: the portal writes the chat's meta node right after this returns.
  await setChatDispatcher(errandId, dispatcherId);

  const updatedErrand = await errandRepository.findById(errandId);
  const errandWithNames = updatedErrand ? attachErrandNames(updatedErrand) : updatedErrand;
  publishToErrand("order:claimed", errandWithNames);

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

/**
 * The dispatcher has checked the order with the customer and is taking it on.
 *
 * Separate from claiming because opening a queued request now claims it — one
 * dispatcher in a customer's chat at a time — which leaves a window where an
 * errand is claimed but the items have not been verified. Steps 1-4 stay shut
 * until this stamps `verifiedAt`.
 *
 * Only the claiming dispatcher may verify: the claim is what makes them the
 * person the customer has been talking to.
 */
export async function verifyErrand(errandId: string, dispatcherId: number) {
  const log = await dispatchLogRepository.findLatestByErrandId(errandId);
  if (!log) {
    throw new ServiceError(409, "This order has not been opened for review yet.");
  }
  if (log.dispatcherId !== dispatcherId) {
    const claimant = `${log.dispatcher.firstName} ${log.dispatcher.lastName}`.trim();
    throw new ServiceError(403, `Access denied: this order is being reviewed by ${claimant}.`);
  }

  // Idempotent — updateMany with `verifiedAt: null` matches nothing the second
  // time, so a double-click cannot move the moment the customer was told.
  await dispatchLogRepository.markVerified(errandId, dispatcherId);

  const updated = await errandRepository.findById(errandId);
  const errandWithNames = updated ? attachErrandNames(updated) : updated;
  publishToErrand("order:updated", errandWithNames);
  return errandWithNames;
}

/**
 * Puts a request the dispatcher opened but did not take back into the queue.
 *
 * The counterpart to opening-as-claiming: without it, a dispatcher who looks at
 * a request and decides it is not theirs to handle would strand it, since
 * nothing else clears a dispatch log.
 *
 * Refuses once the order has been verified. After that the customer has been
 * told who their dispatcher is and work has begun — abandoning it silently would
 * leave them talking to nobody. Cancelling is the honest exit at that point, and
 * that is what declining already does.
 */
export async function releaseErrand(errandId: string, dispatcherId: number) {
  const errand = await errandRepository.findByIdBasic(errandId);
  if (!errand) {
    throw new ServiceError(404, "Errand not found");
  }
  if (errand.riderId !== null) {
    throw new ServiceError(409, "A rider is already assigned to this order.");
  }

  const log = await dispatchLogRepository.findLatestByErrandId(errandId);
  if (!log) {
    throw new ServiceError(409, "This order is already in the queue.");
  }
  if (log.dispatcherId !== dispatcherId) {
    const claimant = `${log.dispatcher.firstName} ${log.dispatcher.lastName}`.trim();
    throw new ServiceError(403, `Access denied: this order is being reviewed by ${claimant}.`);
  }
  if (log.verifiedAt !== null) {
    throw new ServiceError(
      409,
      "This order has already been accepted. Decline it instead so the customer is told why."
    );
  }

  const { count } = await dispatchLogRepository.deleteUnverifiedForErrand(errandId, dispatcherId);
  if (count === 0) {
    throw new ServiceError(409, "This order is no longer yours to return.");
  }
  // Back in the queue: the chat is nobody's until the next claim.
  await setChatDispatcher(errandId, null);

  // Back to AVAILABLE so the queue shows it again. Done after the log delete so
  // a failure here cannot leave an unclaimed errand hidden from every dispatcher.
  await errandRepository.update(errandId, { status: "AVAILABLE" });

  const updated = await errandRepository.findById(errandId);
  const errandWithNames = updated ? attachErrandNames(updated) : updated;
  publishToErrand("order:updated", errandWithNames);
  return errandWithNames;
}

/**
 * Shift handover / logout cleanup:
 * Automatically releases all claimed but unverified/unassigned orders for a dispatcher
 * back to AVAILABLE status so the next on-duty dispatcher can claim and review them.
 */
export async function releaseAllUnverifiedForDispatcher(dispatcherId: number): Promise<number> {
  const unverifiedLogs = await dispatchLogRepository.findUnverifiedByDispatcherId(dispatcherId);
  let releasedCount = 0;
  for (const log of unverifiedLogs) {
    if (log.errand && log.errand.status === "PENDING" && log.errand.riderId === null) {
      try {
        await dispatchLogRepository.deleteUnverifiedForErrand(log.errandId, dispatcherId);
        await setChatDispatcher(log.errandId, null);
        await errandRepository.update(log.errandId, { status: "AVAILABLE" });
        const updated = await errandRepository.findById(log.errandId);
        const errandWithNames = updated ? attachErrandNames(updated) : updated;
        publishToErrand("order:updated", errandWithNames);
        if (errandWithNames) {
          eventPublisher.emitToRole("DISPATCHER", "order:new", errandWithNames);
        }
        releasedCount++;
      } catch (err) {
        logger.warn(`Failed to release errand ${log.errandId} on dispatcher ${dispatcherId} logout:`, err);
      }
    }
  }
  return releasedCount;
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

  // An ORDERED list, not a single choice.
  //
  // The claim below can fail because a concurrent dispatch took the rider's last
  // slot. Ranking produces a queue so that loses one candidate rather than the
  // whole dispatch — the second-best rider is already known and does not need the
  // matrix call to be run again.
  //
  // A dispatcher naming a rider explicitly gets a list of exactly one: their
  // choice is a decision, not a suggestion, and silently substituting someone
  // else would be worse than telling them the rider is full.
  const candidates: number[] = riderId ? [riderId] : [];

  // Automated "Assign Rider Now" algorithm when riderId is not explicitly provided
  if (candidates.length === 0) {
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

      // Beacon-derived, not socket-derived. isOnline() asked whether a WebSocket
      // was currently attached, which Android's battery optimiser severs on a
      // locked screen — so a rider sitting outside a store was excluded from
      // their own repeat customer's errand while perfectly able to take it.
      const repeatAvailability = await riderBeaconService.availabilityForRiders(
        activeRiders.map((r) => r.id)
      );
      const repeatRider = activeRiders.find(
        (rider) =>
          (countByRider.get(rider.id) ?? 0) < MAX_ACTIVE_ERRANDS_PER_RIDER &&
          repeatAvailability.get(rider.id)?.dispatchable === true
      );
      // Preferred, not exclusive: proximity ranking still runs below and fills in
      // behind them, so a repeat rider who turns out to be full falls through to
      // the ordinary nearest-rider queue instead of failing the dispatch.
      if (repeatRider) candidates.push(repeatRider.id);
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
    {
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

      // `status: "Active"` is the admin account flag, not presence.
      //
      // Presence now comes from the rider's own beacon rather than from a live
      // socket. Two failures go away at once: a rider whose socket Doze killed
      // is no longer excluded while sitting on their motorcycle waiting, and a
      // rider whose socket is alive but whose location task has died is no longer
      // included while being impossible to locate. `dispatchable` also folds in
      // the permissions an offer actually depends on — there is no point sending
      // a 45-second countdown to a handset that cannot raise a notification.
      const availability = await riderBeaconService.availabilityForRiders(
        allRiders.map((r) => r.id)
      );
      const eligibleRiders = allRiders.filter(
        (r) =>
          !excludedRiderIds.includes(r.id) &&
          r.errandsAsRider.length < MAX_ACTIVE_ERRANDS_PER_RIDER &&
          availability.get(r.id)?.dispatchable === true
      );

      if (eligibleRiders.length === 0 && candidates.length === 0) {
        // Say WHICH reason, per rider.
        //
        // This used to read "All riders are offline, at capacity, or have
        // declined" no matter what was actually wrong, so a dispatcher staring
        // at a roster of riders they could see were online had nothing to act
        // on. The three real causes look nothing alike: a rider who has not
        // beaconed needs their app opened, one missing a permission needs a
        // setting changed, and one at capacity needs nothing at all.
        const reasons = allRiders
          .filter((r) => !excludedRiderIds.includes(r.id))
          .map((r) => {
            const name = `${r.firstName} ${r.lastName}`.trim() || `Rider ${r.id}`;
            if (r.errandsAsRider.length >= MAX_ACTIVE_ERRANDS_PER_RIDER) {
              return `${name}: already carrying ${r.errandsAsRider.length}`;
            }
            const state = availability.get(r.id);
            if (!state) return `${name}: no presence recorded`;
            // In the three statuses the dispatcher sees on the roster, with the
            // reason in the same words, so the toast and the board agree.
            const label = STATUS_LABEL[state.riderStatus];
            if (state.riderStatus === "AVAILABLE_SIGNAL_LOST") {
              const age =
                state.beaconAgeMs === null
                  ? "never checked in"
                  : `last seen ${Math.max(1, Math.round(state.beaconAgeMs / 60000))} min ago`;
              return `${name}: ${label} (${age})`;
            }
            return `${name}: ${label} (${describeReason(state.riderStatusReason).toLowerCase()})`;
          });

        throw new ServiceError(
          404,
          reasons.length > 0
            ? `No rider can take this errand right now. ${reasons.join("; ")}.`
            : "No riders are set up on this account yet."
        );
      }

      // Only riders whose last known position is recent enough to mean anything,
      // using the same 60s threshold the dashboard uses to paint a rider as
      // "signal lost" — so the map and dispatch can never disagree about who is
      // reachable. Riders outside the service area are excluded too: the routing
      // graph has no roads for them and any travel time would be invented.
      const now = Date.now();
      const located = eligibleRiders
        .map((rider) => {
          const position = riderPositionStore.getFresh(rider.id, POSITION_FRESHNESS_MS);
          // Where they will be when they can START, which for a rider already
          // carrying work is the end of that work, not their current fix.
          const free = whereRiderBecomesFree(
            position ? position.point : null,
            rider.errandsAsRider.map((e) => ({
              etaHighAt: e.etaHighAt,
              deliveryLatitude: e.deliveryLatitude,
              deliveryLongitude: e.deliveryLongitude,
            })),
            now
          );
          return { rider, position, free };
        })
        .filter(
          (entry): entry is typeof entry & { free: { point: GeoPoint } & typeof entry.free } =>
            entry.position !== undefined &&
            entry.free.point !== null &&
            isWithinServiceArea(entry.free.point)
        );

      if (located.length === 0) {
        // No usable positions: fall back to the least-loaded rider rather than
        // failing the dispatch, but say so plainly instead of pretending a
        // proximity decision was made.
        const byLoad = [...eligibleRiders].sort(
          (a, b) => a.errandsAsRider.length - b.errandsAsRider.length
        );
        if (byLoad.length > 0) {
          logger.info(
            `Assigning errand ${errandId} to rider ${byLoad[0].id} by load — no rider had a GPS position fresher than ${POSITION_FRESHNESS_MS}ms.`
          );
        }
        candidates.push(...byLoad.map((r) => r.id));
      } else {
        // One matrix call ranks every candidate at once.
        const matrix = await routingProvider.matrix(
          located.map((entry) => entry.free.point),
          [targetPoint]
        );

        if (matrix) {
          // Sorted rather than reduced to a minimum: the runner-up is the retry
          // candidate if the winner's last slot is taken between here and the write.
          const ranked = located
            .map((entry, i) => ({
              id: entry.rider.id,
              // Travel from where they become free, PLUS the wait until then.
              // Both are seconds, so a rider 3 minutes away who is free now beats
              // one 1 minute away who is 20 minutes from finishing.
              seconds: dispatchCostSeconds(
                matrix.durationsSeconds[i]?.[0] ?? Infinity,
                entry.free.availableInSeconds
              ),
            }))
            .sort((a, b) => a.seconds - b.seconds);
          candidates.push(...ranked.map((r) => r.id));
        } else {
          // Routing unavailable entirely — straight-line is a poor proxy but a
          // real position beats no decision at all.
          // No routing engine: straight-line from the free point, still weighted
          // by the wait. 25 km/h is a deliberately rough city-motorcycle figure —
          // it only has to make distance and time comparable, not be accurate.
          const APPROX_MPS = 25_000 / 3600;
          located.sort(
            (a, b) =>
              dispatchCostSeconds(
                (haversineDistanceKm(a.free.point, targetPoint) * 1000) / APPROX_MPS,
                a.free.availableInSeconds
              ) -
              dispatchCostSeconds(
                (haversineDistanceKm(b.free.point, targetPoint) * 1000) / APPROX_MPS,
                b.free.availableInSeconds
              )
          );
          candidates.push(...located.map((entry) => entry.rider.id));
        }
      }

      // Riders with no usable position still belong at the BACK of the queue, so
      // a dispatch never fails while a willing rider is standing by unranked.
      candidates.push(...eligibleRiders.map((r) => r.id));
    }
  }

  // Deduped, order preserved: proximity and least-loaded can both nominate the
  // same rider, and retrying one who just refused a slot only wastes a round trip.
  const orderedCandidates = [...new Set(candidates)];
  if (orderedCandidates.length === 0) {
    throw new ServiceError(
      404,
      `No available riders. All riders are offline, at capacity (${MAX_ACTIVE_ERRANDS_PER_RIDER} errands), or have declined.`
    );
  }

  assertValidTransition(errand.status as unknown as ErrandStatusValue, "ASSIGNED");

  let finalRiderId: number | null = null;
  let atCapacity = 0;

  for (const candidateId of orderedCandidates) {
    const candidate = await userRepository.findById(candidateId);
    if (!candidate || candidate.role !== "RIDER") {
      // An explicitly named non-rider is the caller's mistake and worth saying so;
      // one that turned up through ranking is just a stale row to skip.
      if (riderId) throw new ServiceError(400, "Selected user is not a valid rider.");
      continue;
    }

    const outcome = await errandRepository.claimForRider(
      errandId,
      candidateId,
      MAX_ACTIVE_ERRANDS_PER_RIDER
    );

    if (outcome === "CLAIMED") {
      finalRiderId = candidateId;
      break;
    }
    if (outcome === "ERRAND_MOVED") {
      // Another dispatcher assigned or cancelled this errand while we ranked.
      // Retrying a different rider would fight them for it, so stop.
      throw new ServiceError(409, "This errand was already assigned by someone else.");
    }
    atCapacity += 1;
    logger.info(
      `Rider ${candidateId} was at capacity when errand ${errandId} tried to claim them — trying the next candidate.`
    );
  }

  if (finalRiderId === null) {
    throw new ServiceError(
      riderId ? 409 : 404,
      riderId
        ? `That rider is already carrying ${MAX_ACTIVE_ERRANDS_PER_RIDER} errands.`
        : `No available riders. ${atCapacity} were at capacity by the time the errand was assigned.`
    );
  }

  const rider = await userRepository.findById(finalRiderId);
  if (!rider) {
    throw new ServiceError(400, "Selected user is not a valid rider.");
  }

  // Re-read rather than reuse the transaction's return: claimForRider writes
  // through updateMany, which cannot carry the relation includes every consumer
  // of this response expects.
  const updatedErrand = await errandRepository.findById(errandId);
  if (!updatedErrand) {
    throw new ServiceError(404, "Errand not found");
  }

  const errandWithNames = attachErrandNames(updatedErrand);
  publishToErrand("order:updated", errandWithNames);
  publishToErrand("order:assigned", errandWithNames, {
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
export async function declineErrand(
  errandId: string,
  riderId: number,
  reason?: string,
  options: { reassign?: boolean } = {}
) {
  const errand = await errandRepository.findStatusAndRiderById(errandId);
  if (!errand) {
    throw new ServiceError(404, "Errand not found");
  }

  if (errand.riderId !== riderId) {
    throw new ServiceError(403, "Access denied: You can only decline errands assigned to you.");
  }

  assertValidTransition(errand.status as unknown as ErrandStatusValue, "PENDING");

  // Conditional, like acceptErrand: only an offer still open and still this
  // rider's is handed back. A decline (or the expiry job) racing an accept used
  // to win, and pulled an errand the rider had just taken.
  const released = await errandRepository.releaseOffer(errandId, riderId);
  if (released === 0) {
    throw new ServiceError(409, "This offer is no longer open. It was accepted, cancelled or has already expired.");
  }
  const updatedErrand = await errandRepository.findById(errandId);
  if (!updatedErrand) {
    throw new ServiceError(404, "Errand not found");
  }

  const errandWithNames = attachErrandNames(updatedErrand);
  publishToErrand("order:updated", errandWithNames);
  publishToErrand("errand:re_routing", errandWithNames, {
    errandId,
    previousRiderId: riderId,
    statusText: "Finding the best rider for your delivery...",
  });

  // Attempt silent auto-reassignment to next nearest eligible rider, unless the
  // caller wants a person to decide (an expired offer too old to send on).
  if (options.reassign !== false) {
    try {
      const reassigned = await assignRider(errandId, undefined, [riderId]);
      return reassigned;
    } catch (_reRouteErr) {
      // Falls through to the dispatcher alert below.
    }
  }
  // Alert dispatcher only if all eligible riders decline or are out of radius
  publishToErrand("errand:all_riders_declined", errandWithNames, {
    errandId,
    reason: reason || "All eligible riders declined or timed out",
  });
  return errandWithNames;
}

/**
 * How long an offer may go unanswered before the server takes it back.
 *
 * The rider app counts 45 seconds from assignedAt (NewTaskCard) and declines on
 * its own when it is open. This catches the rest: a locked phone, a closed app,
 * a dead battery. The errand used to stay ASSIGNED to that rider indefinitely,
 * nobody else could take it, and the customer waited (2026-10-09). The 15
 * seconds past the app's countdown absorb latency and clock drift, so the app,
 * not the server, normally has the last word.
 */
export const OFFER_EXPIRY_MS = 60_000;

/**
 * Past this, an expired offer goes back to the dispatcher instead of straight
 * on to the next rider. An offer that old was made before a server outage or
 * before this job existed, and the customer may well have given up; sending a
 * rider out on it should be a person's decision.
 */
export const OFFER_REASSIGN_WINDOW_MS = 30 * 60_000;

/** Takes back every offer older than OFFER_EXPIRY_MS. Run by jobs/offerExpiry.ts. */
export async function expireStaleOffers(now = new Date()): Promise<number> {
  const stale = await errandRepository.findOffersAssignedBefore(new Date(now.getTime() - OFFER_EXPIRY_MS));
  let expired = 0;
  for (const offer of stale) {
    if (offer.riderId === null) continue;
    const ageMs = now.getTime() - (offer.assignedAt?.getTime() ?? 0);
    try {
      await declineErrand(offer.id, offer.riderId, "Offer expired with no answer from the rider", {
        reassign: ageMs <= OFFER_REASSIGN_WINDOW_MS,
      });
      expired += 1;
    } catch (error) {
      // 409: the rider accepted or declined in the same instant. Their answer stands.
      if (!(error instanceof ServiceError && error.status === 409)) {
        logger.error(`Could not expire the offer on errand ${offer.id}:`, error);
      }
    }
  }
  return expired;
}

export async function confirmOrder(errandId: string, customerId: number) {
  const errand = await errandRepository.findById(errandId);
  if (!errand) {
    throw new ServiceError(404, "Errand not found");
  }
  // Only the errand's own customer can agree to its price. This was missing, so
  // any signed-in account could stamp the quote on someone else's order.
  if (errand.customerId !== customerId) {
    throw new ServiceError(403, "You cannot confirm an order that does not belong to you.");
  }

  // Stamp what the customer is agreeing to, so nothing can quietly bill them
  // more handling fee than this later.
  //
  // markItemsPurchased overwrites estimatedCost with the real receipt total —
  // AFTER the rider has bought the goods, when there is no longer any moment in
  // which to ask for consent. Before this ceiling existed, a ₱1,000 estimate
  // ringing up at ₱1,200 moved the fee from ₱50 to ₱120 with nobody deciding it.
  //
  // Re-stamped on every confirmation, so a dispatcher's item revision that the
  // customer approves legitimately raises the ceiling. It is agreement that
  // moves it, never arithmetic.
  // The whole fare is stamped too, not just the handling component.
  //
  // The ceiling above protected one part of the bill while the rest stayed live,
  // and recalculateFee re-measures the road on every call — so a routing engine
  // answering 40 m differently could still move the fare across a whole-kilometre
  // boundary after the customer had agreed to it. Stamped unconditionally,
  // because a fare exists whether or not a handling fee was ever computed.
  //
  // Re-stamped on every confirmation, exactly like the ceiling: a dispatcher's
  // revision the customer approves legitimately sets a new fare. It is agreement
  // that moves it, never arithmetic.
  const stamp: Prisma.ErrandUpdateInput = { quotedDeliveryFee: errand.deliveryFee };
  if (errand.groceryFee !== null) {
    stamp.quotedHandlingBasket = errand.estimatedCost;
    stamp.quotedHandlingFee = errand.groceryFee;
  }
  // Approving opens the payment choice (2026-10-15): the customer's app goes
  // from Approve straight into choosing how to pay, in a dialog they cannot
  // dismiss. The dispatcher's screen opens payment when it sends the list, but
  // if that call failed the choice would be refused here with no way out, so
  // approval opens it too. Never re-stamped: the first opening is the record.
  if (!errand.paymentEnabledAt) {
    stamp.paymentEnabledAt = new Date();
  }
  const confirmed = await errandRepository.update(errandId, stamp);

  const errandWithNames = attachErrandNames(confirmed);
  publishToErrand("order:confirmed", errandWithNames, { errandId, customerId, confirmedAt: new Date() });
  publishToErrand("order:updated", errandWithNames);
  return errandWithNames;
}


// How far a re-sent pin may sit from the stop it continues. The dispatcher screen
// sends back the coordinates it loaded, so an unchanged stop matches exactly;
// this only absorbs float noise, not a pin dragged to another shop.
const SAME_STOP_METERS = 25;

// Whether an incoming pin is the same stop as an existing one. The catalogue id
// decides when both have one; otherwise the same name at the same spot.
function continuesStop(
  existing: { storeName: string; latitude: number; longitude: number; placeId: string | null },
  pin: PinpointInput
): boolean {
  if (existing.placeId && pin.placeId) return existing.placeId === pin.placeId;
  return (
    existing.storeName.trim().toLowerCase() === pin.storeName.trim().toLowerCase() &&
    haversineDistanceKm(existing, pin) * 1000 <= SAME_STOP_METERS
  );
}

// Dispatcher sets/replaces the store pinpoints (waypoints) a rider must follow for
// this errand. Persisted as structured data (not just an ephemeral chat message) so
// both the rider's live map and any GIS routing have a single source of truth.
export async function savePinpoints(errandId: string, pins: PinpointInput[]) {
  const errand = await errandRepository.findByIdBasic(errandId);
  if (!errand) {
    throw new ServiceError(404, "Errand not found");
  }

  // Any store outside the Tacurong City service area (> 100m buffer) or off
  // the loaded road graph is strictly rejected with HTTP 422.
  for (const pin of pins) {
    const verdict = await checkStoreLocation({ latitude: pin.latitude, longitude: pin.longitude });
    if (verdict.status === "blocked") {
      throw new ServiceError(422, `${pin.storeName ? `${pin.storeName}: ` : ""}${verdict.message}`);
    }
  }

  // A stop the rider has already filed a receipt against is kept, not deleted
  // and recreated. Replace-all used to run unconditionally, so re-pinning
  // mid-errand set every receipt's pinpointId to NULL and deleted the stop's
  // dwell observations (2026-10-09). Such a stop must still be in the new list;
  // a stop with no receipt (a closed store the rider only reached) can go.
  const existingStops = await pinpointRepository.findWithProofCounts(errandId);
  const withReceipts = existingStops.filter((stop) => stop._count.proofImages > 0);
  if (withReceipts.length === 0) {
    await pinpointRepository.replaceForErrand(errandId, pins);
  } else {
    const keepIds: Array<number | null> = pins.map(() => null);
    for (const stop of withReceipts) {
      const index = pins.findIndex((pin, i) => keepIds[i] === null && continuesStop(stop, pin));
      if (index === -1) {
        throw new ServiceError(
          409,
          `${stop.storeName} already has a receipt filed, so it can't be removed or moved. Keep it and change the other stops.`
        );
      }
      keepIds[index] = stop.id;
    }
    await pinpointRepository.replaceForErrandKeeping(errandId, pins, keepIds);
  }
  // New stops join the store directory the pin predictor learns from.
  forgetStorePredictionMemory();

  // Now that stops exist, file each requested item under the one it will be
  // bought at. This is the moment it becomes possible: the customer listed the
  // items at creation, when there were no stops to attach them to.
  //
  // Stops without a receipt are deleted and recreated, so their old pinpointIds
  // are already gone (SET NULL on the FK) — this re-derives the mapping rather
  // than trying to preserve one that no longer refers to anything.
  const attached = await pabiliItemRepository.attachToPinpoints(errandId);
  if (attached > 0) {
    logger.info(`Errand ${errandId}: filed ${attached} item(s) under their store stops.`);
  }

  // storeCount (the COLUMN) is still not raised to pins.length here — it keeps
  // recording how many stores the CUSTOMER chose at checkout, the figure this
  // errand was originally quoted and agreed against, and the audit trail a
  // later dispute gets checked on.
  //
  // The multi-store FEE is a different thing and does now move when the
  // dispatcher pins more stores than that: pricingStoreCount (called from
  // recalculateFee below) computes the billed count from this column plus the
  // live pin count at pricing time, rather than it being persisted back here.

  // Pinpoints are the first source of real distance data — recompute now
  // that they're known (see recalculateFee). This also emits order:updated
  // and notifies the customer if the fee actually changed; emit again below
  // unconditionally so the dispatcher's map view still picks up the new pins
  // on the common case where the fee doesn't happen to change.
  const errandWithNames = await recalculateFee(errandId);
  publishToErrand("order:updated", errandWithNames);
  return errandWithNames;
}

// Dispatcher corrects the working copy of the customer's requested items
// (PabiliDetail) after creation — fixing a typo'd item name, a quantity the
// customer clarified over chat, or moving an item to the store it is actually
// sold at. Re-prices afterwards (2026-10-09): storeCount is unrelated to item
// edits, but the handling fee is not, because its gate counts item units
// (totalItemUnits(pabiliDetails) in priceForStops). The comment here used to
// say no fee depended on items, and the quote card then showed the old fee.
// The customer's original ask stays untouched in PabiliItemRequest for audit.
export async function updateItems(errandId: string, items: PabiliDetailInput[]) {
  const errand = await errandRepository.findByIdBasic(errandId);
  if (!errand) {
    throw new ServiceError(404, "Errand not found");
  }

  const statusUpper = String(errand.status || "").toUpperCase();
  if (
    errand.itemsPurchasedAt != null ||
    ["DELIVERED", "COMPLETED", "CANCELLED", "PASSING BY"].includes(statusUpper)
  ) {
    throw new ServiceError(
      409,
      "Cannot modify items order when the rider is already on the way to the customer."
    );
  }

  await pabiliDetailRepository.replaceForErrand(errandId, items);

  // replaceForErrand deletes and recreates every row, so the new ones carry no
  // stop. Re-file them immediately.
  //
  // This is also the moment the dispatcher's restructuring is first expressible:
  // moving noodles from a fast-food stop to a grocery is recorded in the item's
  // storeCategory, and until this ran the rider went on seeing the customer's
  // original grouping no matter what the dispatcher changed.
  // Every row just written is a dispatcher deciding where an item is bought,
  // which is exactly what the placement suggester learns from. Dropping its
  // cache here is what closes the loop: a dispatcher who files an unfamiliar
  // item now gets that answer back on the very next errand rather than after
  // the cache happens to expire.
  forgetMemoryCache();
  forgetStorePredictionMemory();

  const filed = await pabiliItemRepository.attachToPinpoints(errandId);
  if (filed > 0) {
    logger.info(`Errand ${errandId}: re-filed ${filed} edited item(s) under their store stops.`);
  }

  // Before the re-read below, so the errand returned (and the quote card the
  // dispatcher builds from it) carries the new fee. A fare the customer has
  // already agreed to stays as agreed: recalculateFee holds stamped figures.
  await recalculateFee(errandId);

  const updatedErrand = await errandRepository.findById(errandId);
  const errandWithNames = attachErrandNames(updatedErrand!);
  publishToErrand("order:updated", errandWithNames);
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
  publishToErrand("order:updated", errandWithNames);
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

  // The real total is known for the first time here — and unavoidably after the
  // rider has already paid for the goods. If it beat what the customer agreed
  // to, this is the moment to stop rather than to bill them for a number they
  // never saw. The handling-fee ceiling holds their bill steady meanwhile; this
  // holds the goods.
  if (receiptTotal !== undefined && receiptTotal > 0) {
    await errandPaymentService.checkReceiptOverage(errandId, receiptTotal);
  }

  // Recalculate fees with the verified receipt subtotal to accurately apply groceryFee from rate_configs
  const errandWithNames = await recalculateFee(errandId);
  publishToErrand("order:updated", errandWithNames);

  // Everything is bought and the rider is heading to the customer: the push
  // that reaches them with the app closed. Only the first time, so a retried
  // request (a flushed offline queue) cannot send it twice.
  if (!existing.itemsPurchasedAt) {
    deliveryReminders.inBackground(deliveryReminders.notifyOnTheWay(errandId), "on-the-way push");
  }
  return errandWithNames;
}

const VALID_ITEM_FULFILLMENT_STATUSES = new Set<string>(["PENDING", "PURCHASED", "OUT_OF_STOCK"]);

export async function updateItemFulfillmentStatus(
  errandId: string,
  itemId: number,
  callerId: number,
  callerRole: string,
  fulfillmentStatus: string
) {
  const normalizedStatus = String(fulfillmentStatus || "").trim().toUpperCase();
  if (!VALID_ITEM_FULFILLMENT_STATUSES.has(normalizedStatus)) {
    throw new ServiceError(
      400,
      "Invalid fulfillmentStatus. Must be PENDING, PURCHASED, or OUT_OF_STOCK."
    );
  }
  if (!Number.isInteger(itemId) || itemId <= 0) {
    throw new ServiceError(400, "Invalid itemId.");
  }

  const existing = await errandRepository.findByIdBasic(errandId);
  if (!existing) {
    throw new ServiceError(404, "Errand not found");
  }

  const statusUpper = String(existing.status || "").toUpperCase();
  if (
    existing.itemsPurchasedAt != null ||
    ["DELIVERED", "COMPLETED", "CANCELLED", "PASSING BY"].includes(statusUpper)
  ) {
    throw new ServiceError(
      409,
      "Cannot modify items order when the rider is already on the way to the customer."
    );
  }

  const roleUpper = String(callerRole || "").toUpperCase();
  const isStaff = roleUpper === "OWNER" || roleUpper === "DISPATCHER" || roleUpper === "ADMIN";
  if (!isStaff && existing.riderId !== callerId) {
    throw new ServiceError(
      403,
      "Access denied: You can only update items for errands assigned to you."
    );
  }

  const itemRow = await prisma.pabiliDetail.findFirst({
    where: { id: itemId, errandId },
  });
  if (!itemRow) {
    throw new ServiceError(404, "Errand item not found");
  }

  // Once the rider checks an item (PURCHASED or OUT_OF_STOCK), it cannot be
  // unchecked or rechecked by the rider until the item is modified by the dispatcher.
  if (!isStaff && itemRow.fulfillmentStatus && itemRow.fulfillmentStatus !== "PENDING") {
    throw new ServiceError(
      409,
      "This item is already checked and locked. It can only be checked again if modified by the dispatcher."
    );
  }

  const updatedItem = await prisma.pabiliDetail.update({
    where: { id: itemRow.id },
    data: { fulfillmentStatus: normalizedStatus },
  });

  const errandWithNames = await getErrandById(errandId);
  if (errandWithNames) {
    publishToErrand("order:updated", errandWithNames);

    if (normalizedStatus === "OUT_OF_STOCK") {
      const pinpoint = (errandWithNames.pinpoints ?? []).find(
        (p: any) => p.id === itemRow.pinpointId
      );
      const storeName = pinpoint?.storeName ?? itemRow.storeCategory?.split("|")[0]?.trim() ?? undefined;
      // Everything below is read by a person, so it carries the size too.
      const itemLabel = formatItemLabel(itemRow.itemName, itemRow.size);

      const oosNotification = notificationFactory.itemOutOfStock(itemLabel, storeName);
      const latestLog = errandWithNames.dispatchLogs?.[0];
      if (latestLog?.dispatcherId) {
        void notificationRepository.create({
          userId: latestLog.dispatcherId,
          ...oosNotification,
        });
      }
      eventPublisher.emitToRole("DISPATCHER", "errand:item_out_of_stock", {
        errandId,
        itemId: itemRow.id,
        itemName: itemLabel,
        storeName,
      });
      eventPublisher.emitToRole("OWNER", "errand:item_out_of_stock", {
        errandId,
        itemId: itemRow.id,
        itemName: itemLabel,
        storeName,
      });

      eventPublisher.emitToErrandParties(
        errandId,
        { riderId: errandWithNames?.riderId ?? existing.riderId, customerId: errandWithNames?.customerId ?? existing.customerId },
        "errand:substitute_pending",
        {
          errandId,
          itemId: itemRow.id,
          itemName: itemLabel,
          storeName,
        }
      );
    }
  }

  return { item: updatedItem, errand: errandWithNames };
}

export async function declineItemSubstitute(
  errandId: string,
  itemId: number,
  callerId: number,
  callerRole: string
) {
  const existing = await errandRepository.findByIdBasic(errandId);
  if (!existing) {
    throw new ServiceError(404, "Errand not found");
  }

  const roleUpper = String(callerRole || "").toUpperCase();
  const isStaff = roleUpper === "OWNER" || roleUpper === "DISPATCHER" || roleUpper === "ADMIN";
  if (!isStaff) {
    throw new ServiceError(403, "Access denied: Only dispatchers or owners can decline item substitutes.");
  }

  const itemRow = await prisma.pabiliDetail.findFirst({
    where: { id: itemId, errandId },
  });
  if (!itemRow) {
    throw new ServiceError(404, "Errand item not found");
  }

  eventPublisher.emitToErrandParties(
    errandId,
    { riderId: existing.riderId, customerId: existing.customerId },
    "errand:substitute_declined",
    {
      errandId,
      itemId: itemRow.id,
      itemName: formatItemLabel(itemRow.itemName, itemRow.size),
    }
  );

  const errandWithNames = await getErrandById(errandId);
  return { success: true, item: itemRow, errand: errandWithNames };
}

export async function suggestSubstitutesForItem(errandId: string, itemId: number) {
  const errand = await getErrandById(errandId);
  if (!errand) {
    throw new ServiceError(404, "Errand not found");
  }
  const itemRow = (errand.pabiliDetails ?? []).find((i: any) => Number(i.id) === Number(itemId));
  if (!itemRow) {
    throw new ServiceError(404, "Errand item not found");
  }

  const rawCat = String(itemRow.storeCategory || "");
  const parts = rawCat.split("|").map((s) => s.trim());
  const storeName = parts.length > 1 ? parts[0] : (errand.pinpoints?.[0]?.storeName ?? "store");
  const storeCategory = parts.length > 1 ? parts[1] : (parts[0] || "General");
  const customerName =
    errand.customer?.firstName ||
    errand.customer?.name?.split(" ")[0] ||
    "Ma'am/Sir";

  // The size is what makes "a different pack size" mean something.
  const itemLabel = formatItemLabel(itemRow.itemName, itemRow.size);

  const { suggestItemSubstitutes } = await import("../lib/category/categoryServiceClient.js");
  const aiResult = await suggestItemSubstitutes({
    itemName: itemLabel,
    storeName,
    storeCategory,
    customerName,
  });

  if (aiResult && aiResult.substitutes.length > 0) {
    return aiResult;
  }

  const fallbackSubs = [
    `Alternative brand for ${itemLabel}`,
    `Different pack size of ${itemLabel}`,
  ];
  return {
    substitutes: fallbackSubs,
    chatMessage: `Hello ${customerName}, out of stock po ang ${itemLabel} sa ${storeName}. Okay lang po ba na palitan ng ${fallbackSubs[0]} o ${fallbackSubs[1]}?`,
    source: "catalog" as const,
  };
}

/**
 * Reprices the errand from the receipts filed so far, without saying the
 * shopping is finished.
 *
 * Every confirmed receipt used to go through markItemsPurchased, which also
 * stamps itemsPurchasedAt. On a two-store errand that declared everything
 * bought at the FIRST store: the customer was pushed "Your order is on the way"
 * and shown the delivery map while the rider was still at store one, and a
 * rider app restarted there restored itself onto the delivery leg. Only the
 * rider's own step onto the delivery leg (PATCH /items-purchased) says that now.
 */
export async function applyReceiptTotal(errandId: string, riderId: number, receiptTotal: number) {
  const existing = await errandRepository.findByIdBasic(errandId);
  if (!existing) {
    throw new ServiceError(404, "Errand not found");
  }

  if (existing.riderId !== riderId) {
    throw new ServiceError(403, "Access denied: You can only update errands assigned to you.");
  }

  // Same overage check as markItemsPurchased, and at a better moment: the
  // store that pushes the basket over what the customer agreed to is caught
  // there, before the rider buys at the next one.
  if (receiptTotal > 0) {
    await errandRepository.update(errandId, { estimatedCost: receiptTotal });
    await errandPaymentService.checkReceiptOverage(errandId, receiptTotal);
  }

  const errandWithNames = await recalculateFee(errandId);
  publishToErrand("order:updated", errandWithNames);
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

  // The cap lived only in auto-assign, so it governed who was OFFERED work and
  // nothing at all about who could take it. A dispatcher hand-picking a rider
  // skipped that branch entirely, and accepting never checked, so a rider could
  // end up carrying four. Checked here because this is the one call that turns
  // an offer into a commitment.
  const inFlight = await errandRepository.countInTransitForRider(riderId);
  if (inFlight >= MAX_ACTIVE_ERRANDS_PER_RIDER) {
    throw new ServiceError(
      409,
      `You are already carrying ${MAX_ACTIVE_ERRANDS_PER_RIDER} errands. Finish one before taking another.`
    );
  }

  // Conditional on the offer still being open, so a cancellation or an expiry
  // that lands after the read above is not overwritten (see acceptOffer).
  const accepted = await errandRepository.acceptOffer(errandId, riderId, clampOccurredAt(occurredAt));
  const updatedErrand = await errandRepository.findById(errandId);
  if (!updatedErrand) {
    throw new ServiceError(404, "Errand not found");
  }
  if (accepted === 0) {
    // A retry of an accept that already went through (its response lost on a
    // weak signal) is still a success: same rider, already IN_TRANSIT. The
    // original acceptedAt stands. Anything else means the offer moved.
    const alreadyMine = updatedErrand.riderId === riderId && String(updatedErrand.status) === "IN_TRANSIT";
    if (!alreadyMine) {
      throw new ServiceError(409, "This errand is no longer assigned to you. It was cancelled or offered to another rider.");
    }
    return attachErrandNames(updatedErrand);
  }

  const errandWithNames = attachErrandNames(updatedErrand);
  publishToErrand("order:updated", errandWithNames);
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

  // The goods-release gate.
  //
  // DELIVERED is the moment the items leave the rider's hands, and the only
  // moment the company's exposure becomes unrecoverable. On the downpayment plan
  // that must not happen while the customer's downpayment is unconfirmed, or
  // while a receipt overage they never agreed to is still being sorted out.
  //
  // Sits here rather than in the rider app because a client-side gate is a
  // suggestion. The app has its own copy (errandGate.ts) so the rider sees a
  // reason instead of a bare 409 — but this is the one that decides.
  if (normalized === "DELIVERED") {
    await errandPaymentService.assertGoodsReleasable(errandId);
  }

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
  // The transaction row's status follows the errand's (delivered, completed,
  // cancelled). Same fire-and-forget rule as the commission above.
  syncTransactionStatusQuietly(errandId);

  const errandWithNames = attachErrandNames(updatedErrand);
  publishToErrand("order:updated", errandWithNames);
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
  syncTransactionStatusQuietly(errandId);
  const errandWithNames = attachErrandNames(updated);
  publishToErrand("order:updated", errandWithNames);
  publishToErrand("errand:declined", errandWithNames, { errandId, reason: trimmed, customerId: errand.customerId });

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

// Per-errand cooldown to avoid buzzing customer phones on rapid dispatcher messages
const lastChatNotifyTime = new Map<string, number>();

export async function notifyCustomerChatMessage(
  errandId: string,
  dispatcherId: number,
  text: string,
  senderName?: string
) {
  const errand = await errandRepository.findById(errandId);
  if (!errand) {
    throw new ServiceError(404, "Errand not found");
  }

  // 3-second cooldown per errand to avoid notification spam
  const now = Date.now();
  const lastTime = lastChatNotifyTime.get(errandId) || 0;
  if (now - lastTime < 3000) {
    return { skipped: true, reason: "cooldown" };
  }
  lastChatNotifyTime.set(errandId, now);

  const customer = await customerRepository.findById(errand.customerId);
  if (!customer) {
    return { skipped: true, reason: "no_customer" };
  }

  const name = (senderName || "").trim() || "Dispatcher";
  // Truncate to ~120 characters with ellipsis
  const truncated = text.length > 120 ? `${text.slice(0, 117)}...` : text;

  // 1. Instant Socket.io delivery to active customer session (zero-latency in-app heads-up alert)
  eventPublisher.emitToCustomer(customer.id, "notification:new", {
    type: "CHAT_MESSAGE",
    title: `Message from ${name}`,
    body: truncated,
    errandId,
    createdAt: new Date().toISOString(),
  });

  // 2. Deliver remote Expo FCM push notification for background / locked device
  if (customer.expoPushToken) {
    void sendPushNotification(customer.expoPushToken, {
      title: `Message from ${name}`,
      body: truncated,
      channelId: "chats",
      data: { errandId, type: "CHAT_MESSAGE" },
      urgent: true,
    });
  }

  return { success: true };
}

export async function notifyDispatcherChatMessage(
  errandId: string,
  customerId: number,
  text: string,
  senderName?: string
) {
  const errand = await errandRepository.findById(errandId);
  if (!errand) {
    throw new ServiceError(404, "Errand not found");
  }
  if (errand.customerId !== customerId) {
    throw new ServiceError(403, "You can only send messages about your own errand.");
  }

  // 3-second cooldown per errand to avoid spamming dispatchers on rapid messages
  const now = Date.now();
  const lastTime = lastChatNotifyTime.get(`customer_${errandId}`) || 0;
  if (now - lastTime < 3000) {
    return { skipped: true, reason: "cooldown" };
  }
  lastChatNotifyTime.set(`customer_${errandId}`, now);

  const customer = await customerRepository.findById(customerId);
  const name = (
    senderName ||
    (customer?.information
      ? `${customer.information.firstName} ${customer.information.lastName}`.trim()
      : "") ||
    "Customer"
  ).trim();
  const truncated = text.length > 120 ? `${text.slice(0, 117)}...` : text;

  const existingLog = await dispatchLogRepository.findLatestByErrandId(errandId);
  const dispatcherId = existingLog?.dispatcherId ?? null;

  const record = await notificationService.notifyDispatcherCustomerChat(
    errandId,
    dispatcherId,
    name,
    truncated
  );

  return { success: true, notificationId: record?.id };
}

