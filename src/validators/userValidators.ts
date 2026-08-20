import { z } from "zod";

const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]+$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = ["OWNER", "DISPATCHER", "RIDER", "owner", "dispatcher", "rider"] as const;

const optionalEmail = z
  .string()
  .trim()
  .optional()
  .refine((v) => !v || EMAIL_PATTERN.test(v), "Invalid email address format.");

export const createUserSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3, "Username is required and must be at least 3 characters long.")
    .regex(USERNAME_PATTERN, "Username can only contain letters, numbers, underscores, dots, and dashes."),
  password: z.string().min(6, "Password is required and must be at least 6 characters long."),
  firstName: z.string().trim().min(1, "First Name is required."),
  middleName: z.string().trim().optional().default(""),
  lastName: z.string().trim().min(1, "Last Name is required."),
  email: optionalEmail,
  phone: z.string().trim().optional().default(""),
  role: z.enum(ROLES).optional(),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3, "Username must be at least 3 characters long.")
    .regex(USERNAME_PATTERN, "Username can only contain letters, numbers, underscores, dots, and dashes.")
    .optional(),
  password: z.union([z.string().min(6, "Password must be at least 6 characters long if provided."), z.literal("")]).optional(),
  firstName: z.string().trim().min(1, "First Name cannot be empty.").optional(),
  middleName: z.string().trim().optional(),
  lastName: z.string().trim().min(1, "Last Name cannot be empty.").optional(),
  email: optionalEmail,
  phone: z.string().trim().optional(),
  status: z.enum(["Active", "Inactive", "active", "inactive"]).optional(),
  role: z.enum(ROLES).optional(),
  version: z.number().int().positive("A version number is required to save changes."),
});
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const profileUpdateSchema = z.object({
  firstName: z.string().trim().optional(),
  lastName: z.string().trim().optional(),
  email: z.string().trim().optional(),
  phone: z.string().trim().optional(),
});
export type ProfileUpdateInput = z.infer<typeof profileUpdateSchema>;
