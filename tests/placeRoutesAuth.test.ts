import { describe, expect, it, vi } from "vitest";

// Stubbed so importing the router pulls neither a live Prisma client nor
// express-rate-limit's MemoryStore, whose cleanup interval keeps the event loop
// alive and hangs the run. Only the middleware wiring is under test here; the
// stubs stand in at the same positions in each chain, so the structural
// assertions below still describe the real router.
vi.mock("../src/lib/prisma.js", () => ({ prisma: {} }));
vi.mock("../src/middleware/rateLimiters.js", () => ({
  readLimiter: function readLimiterStub(_req: unknown, _res: unknown, next: () => void) { next(); },
  userApiLimiter: function userApiLimiterStub(_req: unknown, _res: unknown, next: () => void) { next(); },
}));

import placeRoutes from "../src/routes/placeRoutes.js";

// Introspects the actual Express router rather than reading the source, so the
// guarantee holds against the real middleware chain. The verified-places
// catalogue feeds route distance, fare and ETA, so an unauthenticated write
// path here is a data-integrity problem, not only an access-control one.
interface Layer {
  route?: { path: string; methods: Record<string, boolean>; stack: { name: string }[] };
}

const stack = () => (placeRoutes as unknown as { stack: Layer[] }).stack;

function chainFor(method: string, path: string): string[] {
  const layer = stack().find((e) => e.route?.path === path && e.route?.methods[method]);
  if (!layer?.route) throw new Error(`No ${method.toUpperCase()} ${path} route registered`);
  return layer.route.stack.map((handler) => handler.name || "(anonymous)");
}

const READS: [string, string][] = [["get", "/"], ["get", "/:id"], ["get", "/categories"]];
const WRITES: [string, string][] = [["post", "/"], ["put", "/:id"], ["delete", "/:id"]];

describe("place routes authorization", () => {
  it.each([...READS, ...WRITES])("authenticates %s %s first", (method, path) => {
    // Position matters: a guard after the controller would never run.
    expect(chainFor(method, path)[0]).toBe("authenticateToken");
  });

  it.each(WRITES)("adds a role guard to %s %s", (method, path) => {
    // requireRole and the limiters are anonymous closures, so the role guard is
    // asserted structurally: writes carry exactly one handler more than reads.
    expect(chainFor(method, path)).toHaveLength(4);
  });

  it.each(READS)("leaves %s %s open to any signed-in role", (method, path) => {
    // The dispatcher console searches this catalogue while claiming an errand,
    // so reads must not be owner-only.
    expect(chainFor(method, path)).toHaveLength(3);
  });

  it("registers every route behind authentication", () => {
    const routed = stack().filter((entry) => entry.route);
    expect(routed).toHaveLength(6);
    for (const entry of routed) {
      expect(entry.route!.stack.map((h) => h.name)).toContain("authenticateToken");
    }
  });

  it("mounts nothing at router level that could be mistaken for a guard", () => {
    // The previous version called router.use(placeLimiter) with no auth, which
    // made the file look protected at a glance. That pattern must stay gone.
    expect(stack().filter((entry) => !entry.route)).toHaveLength(0);
  });
});
