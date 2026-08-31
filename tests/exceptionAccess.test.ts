import { describe, expect, it, vi } from "vitest";

/**
 * Who may reach the exception surfaces, and who may clear one.
 *
 * The queue aggregates evidence across every customer's errands — receipts,
 * declared totals, cash variances — so an unguarded read here leaks far more
 * than any single errand endpoint does. Asserted against the real routers rather
 * than the source, so the guarantee survives someone reordering a chain.
 */

// Stubbed so importing a router pulls neither a live Prisma client nor
// express-rate-limit's MemoryStore, whose cleanup interval keeps the event loop
// alive and hangs the run. The stubs sit at the same positions in each chain, so
// the structural assertions still describe the real router.
vi.mock("../src/lib/prisma.js", () => ({ prisma: {} }));
vi.mock("../src/middleware/rateLimiters.js", () => {
  // Declared inside the factory: vi.mock is hoisted above every top-level
  // binding, so a helper defined outside is not yet initialised when this runs.
  const pass = (_q: unknown, _s: unknown, next: () => void) => next();
  return {
    loginLimiter: pass,
    readLimiter: pass,
    userApiLimiter: pass,
    verificationLimiter: pass,
    passwordResetLimiter: pass,
    trackingLimiter: pass,
  };
});

import errandRoutes from "../src/routes/errandRoutes.js";
import reportRoutes from "../src/routes/reportRoutes.js";
import { requireRole } from "../src/middleware/auth.js";

interface Layer {
  route?: { path: string; methods: Record<string, boolean>; stack: { name: string }[] };
}

const layers = (router: unknown) => (router as { stack: Layer[] }).stack;

function positionOf(router: unknown, method: string, path: string): number {
  const i = layers(router).findIndex((e) => e.route?.path === path && e.route?.methods[method]);
  if (i < 0) throw new Error(`No ${method.toUpperCase()} ${path} route registered`);
  return i;
}

function chainFor(router: unknown, method: string, path: string): string[] {
  const layer = layers(router)[positionOf(router, method, path)];
  return layer.route!.stack.map((h) => h.name || "(anonymous)");
}

describe("reaching the exception surfaces", () => {
  it("authenticates the dispatcher queue before anything else runs", () => {
    // Position matters: a guard placed after the controller never runs.
    expect(chainFor(errandRoutes, "get", "/exceptions")[0]).toBe("authenticateToken");
  });

  it("authenticates the resolve endpoint first too", () => {
    expect(chainFor(errandRoutes, "post", "/:id/exceptions/resolve")[0]).toBe("authenticateToken");
  });

  it("guards the queue with a role check, not authentication alone", () => {
    // requireRole and the limiters are anonymous closures, so the guard is
    // asserted by shape: auth + role + limiter + controller.
    expect(chainFor(errandRoutes, "get", "/exceptions")).toHaveLength(4);
  });

  it("guards the owner's period report the same way", () => {
    expect(chainFor(reportRoutes, "get", "/exceptions")[0]).toBe("authenticateToken");
    expect(chainFor(reportRoutes, "get", "/exceptions")).toHaveLength(4);
  });

  it("declares /exceptions before /:id so the queue is not read as an errand id", () => {
    // Express matches in declaration order. Registered the other way round,
    // GET /errands/exceptions resolves as errand id "exceptions" — a 404 that
    // looks like an empty queue, which is the worst possible failure for a
    // control whose whole job is to not be silently empty.
    expect(positionOf(errandRoutes, "get", "/exceptions")).toBeLessThan(
      positionOf(errandRoutes, "get", "/:id")
    );
  });
});

describe("who may clear an exception", () => {
  const run = (role: string | undefined, allowed: string[]) => {
    const res: any = {
      statusCode: 200,
      body: null as any,
      status(code: number) { this.statusCode = code; return this; },
      json(payload: unknown) { this.body = payload; return this; },
    };
    let passed = false;
    requireRole(allowed)(
      { user: role ? { id: 1, role } : undefined } as any,
      res,
      () => { passed = true; }
    );
    return { passed, status: res.statusCode };
  };

  const STAFF = ["OWNER", "DISPATCHER"];

  it("lets a dispatcher through", () => {
    expect(run("DISPATCHER", STAFF).passed).toBe(true);
  });

  it("lets an owner through, including onto what a dispatcher already closed", () => {
    // resolveException appends a row rather than replacing one, so an owner
    // reviewing a closed exception is an ordinary authorised write.
    expect(run("OWNER", STAFF).passed).toBe(true);
  });

  it("refuses a rider", () => {
    const { passed, status } = run("RIDER", STAFF);
    expect(passed).toBe(false);
    expect(status).toBe(403);
  });

  it("refuses a customer", () => {
    const { passed, status } = run("CUSTOMER", STAFF);
    expect(passed).toBe(false);
    expect(status).toBe(403);
  });

  it("refuses a caller carrying no role at all", () => {
    // Deny by default. An unrecognised or absent role must fail closed — the
    // opposite arrangement is how an allow-list quietly becomes a formality.
    const { passed, status } = run(undefined, STAFF);
    expect(passed).toBe(false);
    expect(status).toBe(401);
  });

  it("refuses a role invented later that nobody added to the list", () => {
    expect(run("AUDITOR", STAFF).passed).toBe(false);
  });

  it("keeps the owner's period report to the owner", () => {
    // Dispatch works today's queue; the period report is the owner's oversight
    // of dispatch, and a dispatcher reading their own oversight report defeats
    // the separation the report exists for.
    expect(run("DISPATCHER", ["OWNER"]).passed).toBe(false);
    expect(run("OWNER", ["OWNER"]).passed).toBe(true);
  });
});
