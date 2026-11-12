import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";

/**
 * This API's own address as the phone reached it, for image addresses handed
 * out inside JSON (store photos, customer photos). HTTPS anywhere but a local
 * machine: Android refuses a plain-HTTP image.
 */
export function publicOrigin(req: Request): string | null {
  const host = req.headers?.host;
  if (!host) return null;
  const local = /^(localhost|127\.|10\.|192\.168\.)/.test(host);
  const forwarded = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
  const proto = local ? forwarded || req.protocol || "http" : "https";
  return `${proto}://${host}`;
}

const originStore = new AsyncLocalStorage<string | null>();

/**
 * Remembers the request's public origin for everything that runs on its
 * behalf, so code deep in a service (flattenCustomerAccount) can build an
 * absolute image address without every caller passing `req` down.
 */
export function rememberPublicOrigin(req: Request, _res: Response, next: NextFunction): void {
  originStore.run(publicOrigin(req), next);
}

/** The current request's public origin, or null outside a request (sockets, jobs, tests). */
export function currentPublicOrigin(): string | null {
  return originStore.getStore() ?? null;
}

/** Runs `fn` as if a request had arrived at `origin`. For tests. */
export function withPublicOrigin<T>(origin: string | null, fn: () => T): T {
  return originStore.run(origin, fn);
}
