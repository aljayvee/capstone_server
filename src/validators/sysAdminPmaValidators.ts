import { z } from "zod";

const groupName = z.string().trim().min(1, "Give the access group a name.").max(60, "Name cannot exceed 60 characters.");
const groupDescription = z.string().trim().max(255).nullable().optional();
const permissionList = z
  .array(z.string().trim().min(1).max(64))
  .max(64)
  .transform((keys) => Array.from(new Set(keys)));

export const createSysAdminGroupSchema = z
  .object({
    name: groupName,
    description: groupDescription,
    permissions: permissionList,
    stepUpPassword: z.string().optional(),
  })
  .strict();

export const updateSysAdminGroupSchema = z
  .object({
    name: groupName,
    description: groupDescription,
    permissions: permissionList,
    version: z.number().int().positive("Group version is required."),
    stepUpPassword: z.string().optional(),
  })
  .strict();

export const sysAdminGroupIdParamSchema = z.coerce.number().int().positive("Invalid access group ID.");
export const sysAdminAccountIdParamSchema = z.coerce.number().int().positive("Invalid SysAdmin account ID.");

export const updateSysAdminAccountAccessSchema = z
  .object({
    accessGroupId: z.number().int().positive().nullable(),
    overrides: z
      .array(
        z
          .object({
            permissionKey: z.string().trim().min(1).max(64),
            effect: z.enum(["GRANT", "DENY"]),
          })
          .strict()
      )
      .max(64),
    stepUpPassword: z.string().optional(),
  })
  .strict();

export const updateSysAdminAccountStatusSchema = z
  .object({
    status: z.enum(["Active", "Suspended", "Inactive"]),
    reason: z.string().trim().max(300).optional(),
    stepUpPassword: z.string().optional(),
  })
  .strict();

export const listSysAdminPmaAuditQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
