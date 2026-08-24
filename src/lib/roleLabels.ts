// How stored role values are worded for a human.
//
// The stored value stays OWNER — it is what the RoleType enum, every existing
// row, the JWT payload and the dashboard's /owner route already carry, so
// renaming it would be a data migration rather than a copy change. Only the
// words people read say "Admin". Mirrored in the web dashboard at
// src/constants/userRoles.ts.
const ROLE_LABELS: Record<string, string> = {
  OWNER: "Admin",
  DISPATCHER: "Dispatcher",
  RIDER: "Rider",
  CUSTOMER: "Customer",
};

export function roleLabel(role: string): string {
  const key = String(role || "").toUpperCase();
  return ROLE_LABELS[key] || role;
}
