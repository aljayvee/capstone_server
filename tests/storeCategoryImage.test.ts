import { describe, expect, it, vi } from "vitest";

// Same stubs as placeRoutesAuth.test.ts: importing the router must pull neither
// a live Prisma client nor express-rate-limit's MemoryStore, whose cleanup
// interval keeps the event loop alive and hangs the run. The stubs sit at the
// same positions in each chain, so the structural assertions still describe the
// real router.
vi.mock("../src/lib/prisma.js", () => ({ prisma: {} }));
vi.mock("../src/middleware/rateLimiters.js", () => ({
  readLimiter: function readLimiterStub(_req: unknown, _res: unknown, next: () => void) { next(); },
  userApiLimiter: function userApiLimiterStub(_req: unknown, _res: unknown, next: () => void) { next(); },
}));

import merchantCategoryRoutes from "../src/routes/merchantCategoryRoutes.js";
import { storeCategoryImageUploadSchema } from "../src/validators/merchantCategoryValidators.js";

interface Layer {
  route?: { path: string; methods: Record<string, boolean>; stack: { name: string }[] };
}

const stack = () => (merchantCategoryRoutes as unknown as { stack: Layer[] }).stack;

function chainFor(method: string, path: string): string[] {
  const layer = stack().find((e) => e.route?.path === path && e.route?.methods[method]);
  if (!layer?.route) throw new Error(`No ${method.toUpperCase()} ${path} route registered`);
  return layer.route.stack.map((handler) => handler.name || "(anonymous)");
}

describe("store category image route authorization", () => {
  const ALL: [string, string][] = [
    ["get", "/"],
    ["post", "/"],
    ["put", "/:id"],
    ["get", "/:id/image"],
    ["put", "/:id/image"],
    ["delete", "/:id/image"],
  ];

  it.each(ALL)("authenticates %s %s first", (method, path) => {
    // Position matters: a guard registered after the controller never runs.
    expect(chainFor(method, path)[0]).toBe("authenticateToken");
  });

  it("leaves the image read open to any signed-in role", () => {
    // The CustomerApp Bento grid and the dispatcher store picker both render
    // this image, so an OWNER-only read would blank the customer's home screen.
    // Reads carry three handlers (auth, limiter, controller); a role guard
    // would make four.
    expect(chainFor("get", "/:id/image")).toHaveLength(3);
  });

  it.each([["put"], ["delete"]])("keeps %s /:id/image owner-only", (method) => {
    // requireRole is an anonymous closure, so it is asserted structurally: a
    // guarded write carries exactly one handler more than an open read.
    expect(chainFor(method, "/:id/image")).toHaveLength(4);
  });

  it("registers every route behind authentication", () => {
    const routed = stack().filter((entry) => entry.route);
    expect(routed).toHaveLength(6);
    for (const entry of routed) {
      expect(entry.route!.stack.map((h) => h.name)).toContain("authenticateToken");
    }
  });
});

describe("storeCategoryImageUploadSchema", () => {
  // 1x1 PNG. Small enough that size limits never interfere with format tests.
  const PNG =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  const valid = { imageData: PNG, mimeType: "image/png", fileSize: 71, fileName: "storefront.png" };

  it("accepts a well-formed data URI upload", () => {
    expect(storeCategoryImageUploadSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts an upload with no file name", () => {
    const { fileName: _omitted, ...withoutName } = valid;
    expect(storeCategoryImageUploadSchema.safeParse(withoutName).success).toBe(true);
  });

  it.each(["image/gif", "image/svg+xml", "application/pdf", "text/html"])(
    "rejects %s",
    (mimeType) => {
      // SVG in particular: it is a script-execution vector, and this payload is
      // rendered by every customer device that opens the app.
      expect(storeCategoryImageUploadSchema.safeParse({ ...valid, mimeType }).success).toBe(false);
    }
  );

  it("rejects a payload that is not a data URI", () => {
    // A bare URL would make the column a pointer to somewhere the server does
    // not control, which is not what `store_cat_image` stores.
    const result = storeCategoryImageUploadSchema.safeParse({
      ...valid,
      imageData: "https://images.example.com/storefront.jpg",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a declared size over the 2MB cap", () => {
    expect(
      storeCategoryImageUploadSchema.safeParse({ ...valid, fileSize: 3 * 1024 * 1024 }).success
    ).toBe(false);
  });

  it("rejects an oversized payload even when fileSize understates it", () => {
    // The length check exists precisely because `fileSize` is client-supplied
    // and a caller can simply lie about it.
    const huge = `data:image/png;base64,${"A".repeat(3 * 1024 * 1024)}`;
    expect(
      storeCategoryImageUploadSchema.safeParse({ ...valid, imageData: huge, fileSize: 10 }).success
    ).toBe(false);
  });

  it("rejects a zero or negative file size", () => {
    expect(storeCategoryImageUploadSchema.safeParse({ ...valid, fileSize: 0 }).success).toBe(false);
    expect(storeCategoryImageUploadSchema.safeParse({ ...valid, fileSize: -1 }).success).toBe(false);
  });

  it("rejects an empty payload", () => {
    expect(storeCategoryImageUploadSchema.safeParse({ ...valid, imageData: "" }).success).toBe(false);
  });
});
