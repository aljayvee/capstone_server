import { z } from "zod";

const coordinateSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

export const directionsSchema = z.object({
  origin: coordinateSchema,
  destination: coordinateSchema,
  waypoints: z.array(coordinateSchema).optional(),
});
export type DirectionsInput = z.infer<typeof directionsSchema>;
