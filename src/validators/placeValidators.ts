import { z } from "zod";

export const placeCreateSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(150, "Name cannot exceed 150 characters"),
  categoryId: z.number().int().positive("Category ID must be a positive integer"),
  address: z.string().min(3, "Address must be at least 3 characters").max(255, "Address cannot exceed 255 characters"),
  barangay: z.string().max(80, "Barangay cannot exceed 80 characters").nullable().optional(),
  latitude: z.number().min(-90).max(90, "Latitude must be between -90 and 90"),
  longitude: z.number().min(-180).max(180, "Longitude must be between -180 and 180"),
  keywords: z.string().nullable().optional(),
  isActive: z.boolean().optional().default(true),
});

export const placeUpdateSchema = placeCreateSchema.partial();
