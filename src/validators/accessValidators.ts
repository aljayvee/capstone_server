import { z } from "zod";

// Shapes only. Which keys belong to which role is checked against the catalog
// in accessService, so a key added to lib/permissions.ts needs no change here.
const permissionKey = z.string().trim().min(1).max(64);

const groupName = z
  .string()
  .trim()
  .min(1, "Give the group a name.")
  .max(60, "Keep the group name to 60 characters.");

const groupDescription = z.string().trim().max(255, "Keep the description to 255 characters.");

export const createAccessGroupSchema = z.object({
  name: groupName,
  description: z.union([groupDescription, z.literal("")]).optional(),
  scope: z.enum(["OWNER", "DISPATCHER"]),
  permissions: z.array(permissionKey).max(100),
});
export type CreateAccessGroupInput = z.infer<typeof createAccessGroupSchema>;

export const updateAccessGroupSchema = z.object({
  name: groupName.optional(),
  description: z.union([groupDescription, z.literal(""), z.null()]).optional(),
  permissions: z.array(permissionKey).max(100).optional(),
  version: z.number().int().positive("A version number is required to save changes."),
});
export type UpdateAccessGroupInput = z.infer<typeof updateAccessGroupSchema>;

export const accountAccessSchema = z.object({
  /** Null puts the account back in the built-in Full access group. */
  accessGroupId: z.number().int().positive().nullable(),
  overrides: z
    .array(z.object({ permissionKey, effect: z.enum(["GRANT", "DENY"]) }))
    .max(100),
});
export type AccountAccessInput = z.infer<typeof accountAccessSchema>;
