import { z } from "zod";

export const reportQuerySchema = z.object({
  period: z.enum(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]).default("DAILY"),
  date: z.coerce.date().optional(),
});

export type ReportQuery = z.infer<typeof reportQuerySchema>;
