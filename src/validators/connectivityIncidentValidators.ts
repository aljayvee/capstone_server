import { z } from "zod";

export const openIncidentSchema = z.object({
  errandId: z.string().trim().min(1).optional(),
  // Client-supplied override for when the disconnect actually happened —
  // used when the device only regains enough connectivity to flush the
  // incident well after the fact (see useConnectivity.ts's queue-then-flush
  // design). Omitted, it defaults to "now" (the live, still-connected-enough
  // open path).
  disconnectedAt: z.coerce.date().optional(),
});

export type OpenIncidentInput = z.infer<typeof openIncidentSchema>;
