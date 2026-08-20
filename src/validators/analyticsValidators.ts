import { z } from "zod";

export const dashboardQuerySchema = z.object({
  frequency: z.enum(["TODAY", "WEEK", "MONTH", "YEAR"]).default("TODAY"),
});

export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;
