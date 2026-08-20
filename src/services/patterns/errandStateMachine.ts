import { ServiceError } from "../ServiceError.js";

// Canonical errand lifecycle per AGENTS.md's own documented model (Defensive
// Development "State Machine Strictness" + Code Quality "State Pattern" example):
// AVAILABLE -> PENDING -> ASSIGNED -> IN_TRANSIT -> DELIVERED -> COMPLETED / CANCELLED.
// AVAILABLE is the unclaimed-by-any-dispatcher initial state; claiming an errand
// transitions it to PENDING (see errandService.claimErrand).
//
// NOTE: schema.prisma's `ErrandStatus` DB enum currently diverges from this model —
// it has TRAVELING/AT_STORE/PURCHASED/EN_ROUTE/DISPUTED instead of a single
// IN_TRANSIT. Nothing in the frontend (src/, checked via grep) references
// "IN_TRANSIT", so this app-level model is intentionally kept as-is (matching the
// documented design) rather than silently reconciled against the DB enum — that
// reconciliation needs a Prisma migration and is a product decision, left for the
// user to make explicitly rather than changed here.
export const ERRAND_STATUSES = ["AVAILABLE", "PENDING", "ASSIGNED", "IN_TRANSIT", "DELIVERED", "COMPLETED", "CANCELLED"] as const;
export type ErrandStatusValue = (typeof ERRAND_STATUSES)[number];

const TRANSITIONS: Record<ErrandStatusValue, ErrandStatusValue[]> = {
  AVAILABLE: ["PENDING", "CANCELLED"],
  PENDING: ["ASSIGNED", "CANCELLED"],
  // PENDING is reachable from ASSIGNED via the rider-decline path (see
  // errandService.declineErrand) — un-assigns the rider and returns the errand to
  // the dispatcher's queue for reassignment, without losing the dispatcher's claim.
  ASSIGNED: ["IN_TRANSIT", "PENDING", "CANCELLED"],
  IN_TRANSIT: ["DELIVERED", "CANCELLED"],
  DELIVERED: ["COMPLETED"],
  COMPLETED: [],
  CANCELLED: [],
};

// Legacy alias carried over verbatim from the original inline handler.
const STATUS_ALIASES: Record<string, ErrandStatusValue> = {
  "PASSING BY": "CANCELLED",
  "Passing By": "CANCELLED",
};

export function normalizeStatus(raw: string): ErrandStatusValue {
  const candidate = STATUS_ALIASES[raw] ?? raw;
  if (!ERRAND_STATUSES.includes(candidate as ErrandStatusValue)) {
    throw new ServiceError(400, `Invalid status value. Allowed values: ${ERRAND_STATUSES.join(", ")}`);
  }
  return candidate as ErrandStatusValue;
}

// Previously ANY status could jump to ANY other status (a flat allowlist check with
// no transition graph — the exact gap flagged in AGENTS.md server section 6). This
// is the fix: reject illegal jumps (e.g. COMPLETED -> PENDING) with 409.
export function assertValidTransition(current: ErrandStatusValue, target: ErrandStatusValue): void {
  if (current === target) return;
  const allowed = TRANSITIONS[current] || [];
  if (!allowed.includes(target)) {
    throw new ServiceError(409, `Cannot transition errand from ${current} to ${target}.`);
  }
}
