import { z } from "zod";

const coordinateSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

export const directionsSchema = z.object({
  origin: coordinateSchema,
  destination: coordinateSchema,
  waypoints: z.array(coordinateSchema).optional(),
  // Which provider's roads the caller's map shows. Optional and additive:
  // older clients send nothing and get the configured chain.
  provider: z.enum(["osrm", "google"]).optional(),
  // "fastest": ask both engines and take the lower ETA (the shorter road on a
  // near tie), drawn on `provider`'s roads, or on the winner's own roads when
  // no provider is sent (the caller then shows the winner's map). Sugo Rider only.
  choose: z.enum(["fastest"]).optional(),
  // With "fastest": the engine whose path already won. Sent when the rider
  // only switched maps, so the same road is redrawn, not chosen again.
  keep: z.enum(["osrm", "google"]).optional(),
  // The errand a customer is tracking: with "fastest", its rider's own
  // verdict (engine and map) is reused, so both apps show the same route.
  errandId: z.string().trim().min(1).max(64).optional(),
  // Sugo Rider's own fix at `origin`: direction of travel, ground speed and
  // the phone's accuracy figure. Together they let the route start on the
  // road the rider is riding (routingService.originHintFor). Optional and
  // additive: older clients send none of them.
  originHeading: z.number().min(0).max(360).optional(),
  originSpeedMps: z.number().min(0).max(100).optional(),
  originAccuracyMeters: z.number().min(0).max(10_000).optional(),
});
export type DirectionsInput = z.infer<typeof directionsSchema>;

// GET /routing/rider-route: the line a rider is following, by the errand being
// tracked (its customer, its rider, staff) or by rider (staff only). `since` is
// the version the caller already holds, so an unchanged line is not sent again.
export const riderRouteQuerySchema = z
  .object({
    errandId: z.string().trim().min(1).max(64).optional(),
    riderId: z.coerce.number().int().positive().optional(),
    since: z.coerce.number().int().nonnegative().optional(),
  })
  .refine((query) => query.errandId != null || query.riderId != null, {
    message: "Name the errand or the rider whose route you want.",
  });
export type RiderRouteQuery = z.infer<typeof riderRouteQuerySchema>;
