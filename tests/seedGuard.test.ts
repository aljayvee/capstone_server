import { describe, it, expect } from "vitest";
import { seedRefusal, productionSignals, type SeedTarget } from "../src/lib/seedGuard.js";

// The laptop and the server use the same database address, so these cases
// mirror the two real machines (2026-11-15): only NODE_ENV and the folder differ.
const LOCAL_DB = "mysql://root:x@localhost:3306/errand_system_db";
const laptop: SeedTarget = { shellEnv: {}, fileEnv: { NODE_ENV: "development", DATABASE_URL: LOCAL_DB }, cwd: "C:\\Capstone_Server\\server" };
const server: SeedTarget = { shellEnv: {}, fileEnv: { NODE_ENV: "production", DATABASE_URL: LOCAL_DB }, cwd: "/var/www/server" };

describe("seed guard", () => {
  it("lets every seeder run on a developer machine", () => {
    for (const seed of ["demo", "users", "places", "sysadmin"] as const) expect(seedRefusal(seed, laptop)).toBeNull();
  });

  it("refuses the demo seeder on the production server, with no way around it", () => {
    expect(seedRefusal("demo", server)).toMatch(/must never run on production/);
    expect(seedRefusal("demo", { ...server, shellEnv: { SEED_ALLOW_PRODUCTION: "demo" } })).toMatch(/Refusing/);
  });

  it("is not fooled by NODE_ENV=development typed in front of the command on the server", () => {
    const sneaky = { ...server, shellEnv: { NODE_ENV: "development" } };
    expect(seedRefusal("demo", sneaky)).toMatch(/NODE_ENV=production in \.env/);
  });

  it("still refuses on the server even if .env lost its NODE_ENV, because of the folder", () => {
    const noEnv = { ...server, fileEnv: { DATABASE_URL: LOCAL_DB } };
    expect(productionSignals(noEnv)).toEqual(["running from the deployed checkout (/var/www/server)"]);
    expect(seedRefusal("places", noEnv)).toMatch(/Refusing/);
  });

  it("refuses a laptop pointed at another machine's database", () => {
    const remote = { ...laptop, fileEnv: { NODE_ENV: "development", DATABASE_URL: "mysql://u:p@109.123.239.182:3306/errand_system_db" } };
    expect(seedRefusal("demo", remote)).toMatch(/points at another machine \(109\.123\.239\.182\)/);
  });

  it("allows a named first-time production seed only for that seeder", () => {
    const allowSysadmin = { ...server, shellEnv: { SEED_ALLOW_PRODUCTION: "sysadmin" } };
    expect(seedRefusal("sysadmin", allowSysadmin)).toBeNull();
    expect(seedRefusal("users", allowSysadmin)).toMatch(/SEED_ALLOW_PRODUCTION=users/);
    expect(seedRefusal("places", { ...server, shellEnv: { SEED_ALLOW_PRODUCTION: "yes" } })).toMatch(/Refusing/);
  });

  it("never prints the database password in its reason", () => {
    const remote = { ...laptop, fileEnv: { DATABASE_URL: "mysql://u:s3cretPass@db.example.com:3306/x" } };
    expect(seedRefusal("demo", remote)).not.toContain("s3cretPass");
  });
});
