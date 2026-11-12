import { createHash } from "node:crypto";
import { ServiceError } from "../ServiceError.js";

// Object key order is transport detail; item/store array order is meaningful.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

export function submissionHash(input: object): string {
  const { submissionId: _id, customerId: _customer, ...contents } = input as Record<string, unknown>;
  return createHash("sha256").update(JSON.stringify(canonical(contents))).digest("hex");
}

export function assertSubmissionContents(storedHash: string | null, hash: string): void {
  if (storedHash !== hash) {
    throw new ServiceError(409, "This submission ID belongs to a different order. Check your existing order before making changes.");
  }
}
