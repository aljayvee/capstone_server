import { z } from "zod";

// The presets the dispatcher console offers. Kept here rather than only in the
// UI so the server can tell a chosen reason from a typed one without trusting a
// flag the client sends — a client that lies about `isCustom` would corrupt the
// only signal that tells an owner the preset list has gone stale.
export const PRESET_DECLINE_REASONS = [
  "Store is closed or unavailable",
  "Items requested are out of stock",
  "Delivery address is outside our service area",
  "No riders available for this request",
  "Request is unclear or incomplete",
  "Other operational reason",
] as const;

export const declineErrandReviewSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(3, "Please give the customer a reason of at least 3 characters.")
    .max(255, "Reason must be at most 255 characters."),
});

export type DeclineErrandReviewInput = z.infer<typeof declineErrandReviewSchema>;
