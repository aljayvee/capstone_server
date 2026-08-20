import bcrypt from "bcryptjs";
import type { Prisma } from "@prisma/client";

export interface UserFactoryInput {
  username: string;
  password: string;
  firstName: string;
  middleName?: string;
  lastName: string;
  email?: string;
  phone?: string;
  role?: string;
  status?: string;
}

// Centralizes the hash-password + build-user-object logic for admin-created staff
// accounts (userService.createUser). Customer self-registration uses the separate
// two-table customerFactory.ts (see services/patterns/customerFactory.ts) since
// customers no longer live in this `users` table — this factory only ever builds
// OWNER/DISPATCHER/RIDER rows.
export async function buildUserCreateData(input: UserFactoryInput): Promise<Prisma.UserCreateInput> {
  const passwordHash = await bcrypt.hash(input.password.trim(), 10);
  return {
    username: input.username.trim(),
    passwordHash,
    role: (input.role ? input.role.toUpperCase() : "RIDER") as Prisma.UserCreateInput["role"],
    firstName: input.firstName.trim(),
    middleName: input.middleName ? input.middleName.trim() : "",
    lastName: input.lastName.trim(),
    email: input.email ? input.email.trim().toLowerCase() : "",
    phone: input.phone ? input.phone.trim() : "",
    status: input.status || "Active",
  };
}
