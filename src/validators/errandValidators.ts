import { z } from "zod";

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
  unitPrice: z.coerce.number().nonnegative("unitPrice must be zero or positive.").optional(),
  estimatedSubtotal: z.coerce.number().nonnegative("estimatedSubtotal must be zero or positive.").optional(),
});

// Pabili is the only service this system offers. It was previously free text
// that merely *defaulted* to "Pabili", so the scope was enforced by the
// customer app happening to render one button — nothing stopped a crafted
// request storing an errand of any category at all. Narrowing it here backs the
// UI restriction with an actual server-side guarantee, the same way
// userValidators removed "CUSTOMER" from the role enum.
export const ERRAND_CATEGORIES = ["Pabili"] as const;

export const createErrandSchema = z.object({
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
  estimatedCost: z.coerce.number().nonnegative("estimatedCost must be zero or positive.").optional(),
  tip: z.coerce.number().nonnegative("tip must be zero or positive.").optional(),
  paymentMethod: z.string().trim().min(1).max(30, "Payment method must be at most 30 characters.").optional(),
  // Number of store categories selected (1-3) — decoupled from pabiliItems.length,
  // whose size reflects the real item list, not how many stores the rider visits.
  // See errandService.createErrand.
  storeCount: z.coerce.number().int().min(1, "storeCount must be at least 1.").max(3, "storeCount cannot exceed 3.").optional(),
  pabiliItems: z.array(pabiliItemInputSchema).optional(),
});

export type CreateErrandBody = z.infer<typeof createErrandSchema>;

export const assignRiderSchema = z.object({
  riderId: z.coerce.number().int().positive("riderId must be a positive integer.").optional(),
});

export type AssignRiderInput = z.infer<typeof assignRiderSchema>;

export const declineErrandSchema = z.object({
  reason: z.string().trim().max(300, "Reason must be at most 300 characters.").optional(),
});

export type DeclineErrandInput = z.infer<typeof declineErrandSchema>;
