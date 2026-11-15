import { z } from "zod";

export const acceptRiderTermsSchema = z.object({
  version: z
    .string()
    .trim()
    .min(1, "Terms version is required.")
    .max(32, "Terms version is too long.")
    .regex(/^[A-Za-z0-9._-]+$/, "Invalid Terms version format."),
});

export type AcceptRiderTermsInput = z.infer<typeof acceptRiderTermsSchema>;
