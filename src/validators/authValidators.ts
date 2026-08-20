import { z } from "zod";

const nonEmptyTrimmed = (label: string) => z.string().trim().min(1, `${label} must be a non-empty string`);

export const loginSchema = z.object({
  username: nonEmptyTrimmed("Username"),
  password: nonEmptyTrimmed("Password"),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const customerRegisterSchema = z.object({
  username: nonEmptyTrimmed("Username"),
  password: z.string().trim().min(6, "Password must be at least 6 characters long"),
  email: nonEmptyTrimmed("Email"),
  firstName: nonEmptyTrimmed("First name"),
  middleName: z.string().trim().optional().default(""),
  lastName: nonEmptyTrimmed("Last name"),
  birthdate: z.string().trim().optional(),
  phone: z.string().trim().optional().default(""),
  emailVerified: z.boolean().optional(),
});
export type CustomerRegisterInput = z.infer<typeof customerRegisterSchema>;
