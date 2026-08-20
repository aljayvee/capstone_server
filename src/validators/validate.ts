import type { ZodSchema } from "zod";
import { ServiceError } from "../services/ServiceError.js";

// Shared entry point for every zod schema in validators/ — throws a ServiceError(400,...)
// that the errorHandler middleware turns into the response, so controllers stay one-liners.
export function parseOrThrow<T>(schema: ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ServiceError(400, result.error.issues[0]?.message || "Invalid request body");
  }
  return result.data;
}
