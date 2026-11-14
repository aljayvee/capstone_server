/**
 * readiness.ts
 *
 * Readiness check for outside uptime monitors (GET /api/health/ready).
 *
 * /api/health only proves the Node process answers, and the deploy scripts
 * rely on it staying that way. This check also proves the database answers,
 * so a monitor sees the outage customers see: the API up, every order failing.
 *
 * The endpoint is public, so the response names only which check failed and
 * how ("timeout" or "unreachable"). The driver's own message goes to the log.
 */

import { prisma } from "./prisma.js";
import { logger } from "./logger.js";

export const DB_READY_TIMEOUT_MS = 2000;

export interface ReadinessResult {
  status: "ready" | "not_ready";
  checks: {
    database: {
      ok: boolean;
      latencyMs: number;
      error?: "timeout" | "unreachable";
    };
  };
  timestamp: string;
}

class ReadinessTimeout extends Error {}

/**
 * Never throws: every failure becomes `status: "not_ready"`, so the route can
 * always answer, and a hung database answers within `timeoutMs` instead of
 * holding the monitor's request open until it gives up on its own.
 */
export async function checkReadiness(
  pingDatabase: () => Promise<unknown> = () => prisma.$queryRaw`SELECT 1`,
  timeoutMs: number = DB_READY_TIMEOUT_MS,
): Promise<ReadinessResult> {
  const startedAt = Date.now();
  let timer: NodeJS.Timeout | undefined;

  const database: ReadinessResult["checks"]["database"] = { ok: false, latencyMs: 0 };

  try {
    await Promise.race([
      pingDatabase(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ReadinessTimeout()), timeoutMs);
      }),
    ]);
    database.ok = true;
  } catch (err: unknown) {
    database.error = err instanceof ReadinessTimeout ? "timeout" : "unreachable";
    logger.warn(
      `[Readiness] Database check failed (${database.error}):`,
      err instanceof ReadinessTimeout ? `no answer within ${timeoutMs} ms` : err,
    );
  } finally {
    if (timer) clearTimeout(timer);
    database.latencyMs = Date.now() - startedAt;
  }

  return {
    status: database.ok ? "ready" : "not_ready",
    checks: { database },
    timestamp: new Date().toISOString(),
  };
}
