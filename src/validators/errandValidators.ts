import { z } from "zod";
import { isWithinServiceBuffer, isServiceAreaConfigured, validateIntraZone } from "../lib/serviceArea.js";
import type { GeoPoint } from "../lib/geo.js";
import {
  optionalDetail,
  STREET_NAME_MAX,
  LANDMARK_MAX,
  DELIVERY_NOTES_MAX,
} from "./locationValidators.js";
import { itemSizeSchema, itemNotesSchema } from "./pabiliItemValidators.js";
import { STORE_COUNT_CEILING, storeLimitMessage } from "../lib/storeLimitBounds.js";

// Mirrors the optional/default semantics errandService.createErrand already
// implements inline via destructuring defaults (category, description,
// pickupAddress, deliveryAddress, estimatedCost, tip, pabiliItems all fall
// back when omitted) — this schema only enforces that whatever IS provided
// is well-typed and in range; defaulting stays in the service.
const pabiliItemInputSchema = z.object({
  itemName: z.string().trim().max(120, "Item name must be at most 120 characters.").optional(),
  name: z.string().trim().max(120, "Item name must be at most 120 characters.").optional(),
  storeCategory: z.string().trim().max(100, "Store category must be at most 100 characters.").optional(),
  quantity: z.coerce.number().int().positive("quantity must be a positive integer.").optional(),
  size: itemSizeSchema,
  notes: itemNotesSchema,
  unitPrice: z.coerce.number().nonnegative("unitPrice must be zero or positive.").optional(),
  estimatedSubtotal: z.coerce.number().nonnegative("estimatedSubtotal must be zero or positive.").optional(),
  // Which of `stores` (below) the item is bought at, when the customer picked
  // real stores. storeCategory then carries that store's category name.
  storeIndex: z.coerce.number().int().min(0).max(2).optional(),
});

// A store the customer picked in the app's "Location" step (2026-10-08): a
// Location Stores row (placeId) or a Google establishment (name and position
// only). Becomes a pin in the dispatcher's Stage 1. categoryId is the app's
// answer from the store search; the server keeps it only if it is active.
const customerStoreSchema = z.object({
  name: z.string().trim().min(1, "Store name is required.").max(150, "Store name must be at most 150 characters."),
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
  placeId: z.string().trim().max(36).optional().nullable(),
  categoryId: z.coerce.number().int().positive().optional().nullable(),
});

// Pabili is the only service this system offers. It was previously free text
// that merely *defaulted* to "Pabili", so the scope was enforced by the
// customer app happening to render one button — nothing stopped a crafted
// request storing an errand of any category at all. Narrowing it here backs the
// UI restriction with an actual server-side guarantee, the same way
// userValidators removed "CUSTOMER" from the role enum.
export const ERRAND_CATEGORIES = ["Pabili"] as const;

export const submissionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{20,80}$/, "Invalid submission ID.");

export const createErrandSchema = z
  .object({
    submissionId: submissionIdSchema.optional(),
    customerId: z.coerce.number().int().positive("customerId must be a positive integer.").optional(),
    category: z
      .enum(ERRAND_CATEGORIES, { message: `Category must be one of: ${ERRAND_CATEGORIES.join(", ")}.` })
      .optional(),
    description: z.string().trim().max(500, "Description must be at most 500 characters.").optional(),
    pickupAddress: z
      .string()
      .trim()
      .min(1, "Pickup address is required.")
      .max(300, "Pickup address must be at most 300 characters.")
      .optional(),
    deliveryAddress: z
      .string()
      .trim()
      .min(1, "Delivery address is required.")
      .max(300, "Delivery address must be at most 300 characters.")
      .optional(),
    deliveryLatitude: z.coerce
      .number()
      .min(-90, "Latitude must be a number between -90 and 90.")
      .max(90, "Latitude must be a number between -90 and 90.")
      .optional(),
    deliveryLongitude: z.coerce
      .number()
      .min(-180, "Longitude must be a number between -180 and 180.")
      .max(180, "Longitude must be a number between -180 and 180.")
      .optional(),
    // The door-side details of the saved location the errand is delivered to.
    // Same limits as the saved location itself, so a place that saves can
    // always be ordered to.
    deliveryStreetName: optionalDetail(STREET_NAME_MAX, "Street name"),
    deliveryLandmark: optionalDetail(LANDMARK_MAX, "Landmark"),
    deliveryNotes: optionalDetail(DELIVERY_NOTES_MAX, "Delivery notes"),
    estimatedCost: z.coerce.number().nonnegative("estimatedCost must be zero or positive.").optional(),
    tip: z.coerce.number().nonnegative("tip must be zero or positive.").optional(),
    paymentMethod: z.string().trim().min(1).max(30, "Payment method must be at most 30 characters.").optional(),
    // Number of store categories selected (1 + the rate card's
    // maxAdditionalStores, enforced in errandService) — decoupled from pabiliItems.length,
    // whose size reflects the real item list, not how many stores the rider visits.
    // See errandService.createErrand.
    storeCount: z.coerce.number().int().min(1, "storeCount must be at least 1.").max(STORE_COUNT_CEILING, `storeCount cannot exceed ${STORE_COUNT_CEILING}.`).optional(),
    pabiliItems: z.array(pabiliItemInputSchema).optional(),
    stores: z.array(customerStoreSchema).min(1).max(STORE_COUNT_CEILING, storeLimitMessage(STORE_COUNT_CEILING)).optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.stores) return;
    if (data.storeCount !== undefined && data.storeCount !== data.stores.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["storeCount"],
        message: "storeCount must match the number of stores picked.",
      });
    }
    const seenPlaces = new Set<string>();
    data.stores.forEach((store, index) => {
      // One Location Stores row twice is provably one shop (see pinpointsBodySchema).
      const placeId = store.placeId?.trim();
      if (placeId) {
        if (seenPlaces.has(placeId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["stores", index, "placeId"],
            message: `${store.name} is picked twice.`,
          });
        }
        seenPlaces.add(placeId);
      }
      if (
        isServiceAreaConfigured() &&
        !isWithinServiceBuffer({ latitude: store.latitude, longitude: store.longitude }, 0.1)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["stores", index],
          message: `${store.name} is outside all supported service areas. SUGO Express buys only from stores inside Tacurong City or Banga.`,
        });
      }
    });
    (data.pabiliItems ?? []).forEach((item, index) => {
      if (item.storeIndex !== undefined && item.storeIndex >= data.stores!.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["pabiliItems", index, "storeIndex"],
          message: "An item names a store that was not picked.",
        });
      }
    });
  })
  .refine(
    (data) => {
      if (
        data.deliveryLatitude !== undefined &&
        data.deliveryLongitude !== undefined &&
        isServiceAreaConfigured()
      ) {
        return isWithinServiceBuffer(
          { latitude: Number(data.deliveryLatitude), longitude: Number(data.deliveryLongitude) },
          0.1
        );
      }
      return true;
    },
    {
      message:
        "Delivery address is outside all supported service areas. SUGO Express currently delivers within Tacurong City and Banga.",
      path: ["deliveryAddress"],
    }
  )
  // Dual-zone isolation (2026-11-09): the stores and the drop-off must all be
  // in ONE zone. Each point being in some zone is checked above with its own
  // message; this only refuses an errand that spans Tacurong and Banga.
  .superRefine((data, ctx) => {
    if (!isServiceAreaConfigured()) return;
    const points: GeoPoint[] = [];
    const paths: (string | number)[][] = [];
    if (data.deliveryLatitude !== undefined && data.deliveryLongitude !== undefined) {
      points.push({ latitude: Number(data.deliveryLatitude), longitude: Number(data.deliveryLongitude) });
      paths.push(["deliveryAddress"]);
    }
    (data.stores ?? []).forEach((store, index) => {
      points.push({ latitude: store.latitude, longitude: store.longitude });
      paths.push(["stores", index]);
    });
    if (points.length < 2) return;

    const verdict = validateIntraZone(points, 0.1);
    if (verdict.reason === "CROSS_ZONE") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: paths[verdict.index ?? 0],
        message: verdict.error ?? "Cross-zone delivery is not permitted.",
      });
    }
  });

export type CreateErrandBody = z.infer<typeof createErrandSchema>;

// Everything pricing needs about a draft errand, and nothing else. Distance is
// deliberately absent: it is not the client's to assert, and a quote predates any
// pinned store, so the server treats it as unknown rather than accepting a guess.
export const errandQuoteSchema = z.object({
  estimatedCost: z.coerce.number().nonnegative().optional(),
  tip: z.coerce.number().nonnegative().optional(),
  storeCount: z.coerce.number().int().positive().max(STORE_COUNT_CEILING).optional(),
  isCod: z.coerce.boolean().optional(),
  // Store-category NAMES the customer picked. These decide how the handling fee
  // is charged — a supermarket run and a pharmacy run are not the same job. Only
  // names matching an ACTIVE category count; anything else is ignored and the
  // errand falls back to the default mode.
  storeCategories: z.array(z.string().trim().min(1).max(100)).max(STORE_COUNT_CEILING).optional(),

  // Total units in the basket, which now decides whether a handling fee applies
  // at all. Capped generously: a Pabili basket is a person's shopping, not a
  // wholesale order, and an absurd figure here would only distort the quote.
  itemUnits: z.coerce.number().int().nonnegative().max(500).optional(),
});

export const assignRiderSchema = z.object({
  riderId: z.coerce.number().int().positive("riderId must be a positive integer.").optional(),
});

export type AssignRiderInput = z.infer<typeof assignRiderSchema>;

export const declineErrandSchema = z.object({
  reason: z.string().trim().max(300, "Reason must be at most 300 characters.").optional(),
});

export type DeclineErrandInput = z.infer<typeof declineErrandSchema>;
