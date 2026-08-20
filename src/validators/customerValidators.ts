import { z } from "zod";

export const customerProfileUpdateSchema = z.object({
  firstName: z.string().trim().optional(),
  middleName: z.string().trim().optional().nullable(),
  lastName: z.string().trim().optional(),
  email: z.string().trim().email("Please enter a valid email address").optional(),
  phone: z.string().trim().optional(),
  birthdate: z.string().trim().optional().nullable(),
  recaptchaToken: z.string().trim().optional(),
});
export type CustomerProfileUpdateInput = z.infer<typeof customerProfileUpdateSchema>;
