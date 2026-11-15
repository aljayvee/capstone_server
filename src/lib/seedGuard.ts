/**
 * seedGuard.ts
 *
 * Stops a seeder from writing to the production database.
 *
 * On 2026-10-16 the demo seeder (prisma/seed.ts) was run against production and
 * left 500 fake errands, 68 accounts with default passwords and 120,911 rows in
 * all; they were removed by hand on 2026-11-15. A note saying "never do that"
 * did not stop it, so every seeder now asks this module first.
 *
 * Production cannot be recognised by the database address: the server and a
 * developer laptop both use localhost/errand_system_db. It is recognised by:
 * - NODE_ENV=production, read from the shell AND from .env, so prefixing the
 *   command with NODE_ENV=development on the server does not get past it;
 * - running from the deployed checkout (/var/www/...);
 * - a DATABASE_URL that points away from this machine (a seeder run on a
 *   laptop against a remote database).
 *
 * Known gap: a laptop with an SSH tunnel to the production database looks
 * local to this check. The seed passwords (seedPassword.ts) are the second
 * barrier there.
 */

import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

/** Seeders that may run on production when the operator names them explicitly. */
export type GuardedSeed = "demo" | "users" | "places" | "sysadmin";
const OVERRIDABLE: ReadonlySet<GuardedSeed> = new Set(["users", "places", "sysadmin"]);
export const OVERRIDE_VAR = "SEED_ALLOW_PRODUCTION";
const DEPLOYED_ROOT = "/var/www/";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export interface SeedTarget {
  shellEnv: Record<string, string | undefined>;
  fileEnv: Record<string, string | undefined>;
  cwd: string;
}

/** Why this run looks like production. Empty: it does not. */
export function productionSignals(target: SeedTarget): string[] {
  const signals: string[] = [];
  if (target.shellEnv.NODE_ENV === "production") signals.push("NODE_ENV=production in the shell");
  if (target.fileEnv.NODE_ENV === "production") signals.push("NODE_ENV=production in .env");
  if (target.cwd.replace(/\\/g, "/").startsWith(DEPLOYED_ROOT)) signals.push(`running from the deployed checkout (${target.cwd})`);

  const url = target.shellEnv.DATABASE_URL || target.fileEnv.DATABASE_URL;
  if (url) {
    let host: string | null = null;
    try {
      host = new URL(url).hostname;
    } catch {
      signals.push("DATABASE_URL could not be read");
    }
    if (host !== null && !LOOPBACK.has(host)) signals.push(`DATABASE_URL points at another machine (${host})`);
  }
  return signals;
}

/** Null when the seed may run; otherwise the reason it may not. Pure, for tests. */
export function seedRefusal(seed: GuardedSeed, target: SeedTarget): string | null {
  const signals = productionSignals(target);
  if (signals.length === 0) return null;
  const override = target.shellEnv[OVERRIDE_VAR];
  if (override === seed && OVERRIDABLE.has(seed)) return null;
  const how = OVERRIDABLE.has(seed)
    ? ` If this really is a first-time production setup, run it again with ${OVERRIDE_VAR}=${seed}.`
    : " The demo seeder creates fake errands and accounts and must never run on production.";
  return `Refusing to run the "${seed}" seeder: this looks like production (${signals.join("; ")}).${how}`;
}

function readEnvFile(cwd: string): Record<string, string> {
  const file = path.join(cwd, ".env");
  try {
    return fs.existsSync(file) ? dotenv.parse(fs.readFileSync(file, "utf8")) : {};
  } catch {
    return {};
  }
}

/** Call first in every seeder, before any query. Exits the process on refusal. */
export function guardSeed(seed: GuardedSeed): void {
  const cwd = process.cwd();
  const refusal = seedRefusal(seed, { shellEnv: process.env, fileEnv: readEnvFile(cwd), cwd });
  if (refusal) {
    console.error(`\n${refusal}\n`);
    process.exit(1);
  }
}
