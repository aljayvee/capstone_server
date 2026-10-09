import { z } from "zod";
import { isWithinServiceBuffer, isServiceAreaConfigured } from "../lib/serviceArea.js";
import {
  optionalDetail,
  STREET_NAME_MAX,
  LANDMARK_MAX,
  DELIVERY_NOTES_MAX,
} from "./locationValidators.js";
import { itemSizeSchema, itemNotesSchema } from "./pabiliItemValidators.js";

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

export const createErrandSchema = z
  .object({
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
    // Number of store categories selected (1-3) — decoupled from pabiliItems.length,
    // whose size reflects the real item list, not how many stores the rider visits.
    // See errandService.createErrand.
    storeCount: z.coerce.number().int().min(1, "storeCount must be at least 1.").max(3, "storeCount cannot exceed 3.").optional(),
    pabiliItems: z.array(pabiliItemInputSchema).optional(),
    stores: z.array(customerStoreSchema).min(1).max(3, "An errand can visit up to 3 stores.").optional(),
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
          message: `${store.name} is outside Tacurong City. SUGO Express buys only from stores inside the city.`,
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
        "Delivery address is outside Tacurong City service area. SUGO Express currently operates exclusively within Tacurong City.",
      path: ["deliveryAddress"],
    }
  );

export type CreateErrandBody = z.infer<typeof createErrandSchema>;

// Everything pricing needs about a draft errand, and nothing else. Distance is
// deliberately absent: it is not the client's to assert, and a quote predates any
// pinned store, so the server treats it as unknown rather than accepting a guess.
export const errandQuoteSchema = z.object({
  estimatedCost: z.coerce.number().nonnegative().optional(),
  tip: z.coerce.number().nonnegative().optional(),
  storeCount: z.coerce.number().int().positive().max(3).optional(),
  isCod: z.coerce.boolean().optional(),
  // Store-category NAMES the customer picked. These decide how the handling fee
  // is charged — a supermarket run and a pharmacy run are not the same job. Only
  // names matching an ACTIVE category count; anything else is ignored and the
  // errand falls back to the default mode.
  storeCategories: z.array(z.string().trim().min(1).max(100)).max(3).optional(),

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
