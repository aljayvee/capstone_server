import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import http from "http";
import type { AddressInfo } from "net";

/**
 * Customer photos go out as signed links instead of inline base64. The photo
 * rode inside every profile, login and refresh response, up to 740 KB each
 * (2026-11-04), which is a 10+ second login on a slow mobile connection.
 */

const { findPhoto, findCustomer } = vi.hoisted(() => ({ findPhoto: vi.fn(), findCustomer: vi.fn() }));

vi.mock("../src/lib/prisma.js", () => ({ prisma: {} }));
vi.mock("../src/repositories/customerPhotoRepository.js", () => ({
  customerPhotoRepository: { findByCustomerId: findPhoto, upsert: vi.fn(), deleteByCustomerId: vi.fn() },
}));
vi.mock("../src/repositories/customerRepository.js", () => ({ customerRepository: { findById: findCustomer } }));

import { customerPhotoUrl, decodeStoredPhoto, isValidCustomerPhotoSignature } from "../src/lib/customerPhotoLink.js";
import { currentPublicOrigin, rememberPublicOrigin, withPublicOrigin } from "../src/lib/publicOrigin.js";
import { flattenCustomerAccount } from "../src/services/patterns/customerFactory.js";
import { getCustomerPhoto } from "../src/controllers/customerController.js";

const ORIGIN = "https://api.sugo-express.org";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
const DATA_URI = `data:image/jpeg;base64,${JPEG.toString("base64")}`;
const PHOTO_AT = new Date("2026-10-06T08:00:00Z");
const INFO_AT = new Date("2026-10-01T08:00:00Z");

function account(overrides: { avatar?: string | null; profilePhoto?: object | null } = {}) {
  return {
    id: 7,
    username: "maria",
    email: "maria@example.com",
    status: "Active",
    passwordHash: "hash",
    createdAt: INFO_AT,
    updatedAt: INFO_AT,
    information: {
      firstName: "Maria",
      middleName: null,
      lastName: "Santos",
      phone: "+639171234567",
      avatar: overrides.avatar === undefined ? DATA_URI : overrides.avatar,
      updatedAt: INFO_AT,
    },
    profilePhoto:
      overrides.profilePhoto === undefined
        ? { mimeType: "image/jpeg", fileSize: JPEG.length, fileName: null, updatedAt: PHOTO_AT }
        : overrides.profilePhoto,
  };
}

describe("signed customer photo links", () => {
  it("verifies only the id and version it was made for", () => {
    const sig = new URL(customerPhotoUrl(ORIGIN, 7, 123)).searchParams.get("sig");
    expect(isValidCustomerPhotoSignature(7, 123, sig)).toBe(true);
    expect(isValidCustomerPhotoSignature(8, 123, sig)).toBe(false);
    expect(isValidCustomerPhotoSignature(7, 124, sig)).toBe(false);
    expect(isValidCustomerPhotoSignature(7, 123, `${sig}x`)).toBe(false);
    expect(isValidCustomerPhotoSignature(7, 123, undefined)).toBe(false);
    expect(isValidCustomerPhotoSignature(7, 123, ["a"])).toBe(false);
  });

  it("decodes a data URI or raw base64", () => {
    expect(decodeStoredPhoto(DATA_URI, "image/png")).toEqual({ body: JPEG, mimeType: "image/jpeg" });
    expect(decodeStoredPhoto(JPEG.toString("base64"), "image/png")).toEqual({ body: JPEG, mimeType: "image/png" });
    expect(decodeStoredPhoto("", "image/png")).toBeNull();
  });
});

describe("flattenCustomerAccount avatar", () => {
  it("is a signed link to the uploaded photo inside a request", () => {
    const avatar = withPublicOrigin(ORIGIN, () => flattenCustomerAccount(account()).avatar);
    expect(avatar).toBe(customerPhotoUrl(ORIGIN, 7, PHOTO_AT.getTime()));
  });

  it("links a legacy inline avatar that has no photo row", () => {
    const avatar = withPublicOrigin(ORIGIN, () => flattenCustomerAccount(account({ profilePhoto: null })).avatar);
    expect(avatar).toBe(customerPhotoUrl(ORIGIN, 7, INFO_AT.getTime()));
  });

  it("passes a Google photo address and a missing photo through", () => {
    const google = "https://lh3.googleusercontent.com/a/photo";
    expect(withPublicOrigin(ORIGIN, () => flattenCustomerAccount(account({ profilePhoto: null, avatar: google })).avatar)).toBe(google);
    expect(withPublicOrigin(ORIGIN, () => flattenCustomerAccount(account({ profilePhoto: null, avatar: null })).avatar)).toBeNull();
  });

  it("stays inline outside a request, as before", () => {
    expect(flattenCustomerAccount(account()).avatar).toBe(DATA_URI);
    const withBytes = account({ profilePhoto: { photoData: "data:image/png;base64,AAAA", mimeType: "image/png", fileSize: 3, updatedAt: PHOTO_AT } });
    expect(flattenCustomerAccount(withBytes).avatar).toBe("data:image/png;base64,AAAA");
  });
});

describe("rememberPublicOrigin", () => {
  it("survives awaits inside the handler", async () => {
    const app = express();
    app.use(rememberPublicOrigin);
    app.get("/", async (_req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      res.json({ origin: currentPublicOrigin() });
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    // fetch drops a custom Host header, so the proxied case goes through http.get.
    const viaProxy = () =>
      new Promise<{ origin: string }>((resolve, reject) => {
        http
          .get({ host: "127.0.0.1", port, path: "/", headers: { Host: "api.sugo-express.org" } }, (res) => {
            let body = "";
            res.on("data", (chunk) => (body += chunk)).on("end", () => resolve(JSON.parse(body)));
          })
          .on("error", reject);
      });
    try {
      expect((await viaProxy()).origin).toBe(ORIGIN);
      const local = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.json());
      expect(local.origin).toBe(`http://127.0.0.1:${port}`);
    } finally {
      server.close();
    }
    expect(currentPublicOrigin()).toBeNull();
  });
});

describe("GET /api/customers/:id/photo", () => {
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.get("/api/customers/:id/photo", getCustomerPhoto);
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    findPhoto.mockReset();
    findCustomer.mockReset();
    findPhoto.mockResolvedValue({ photoData: DATA_URI, mimeType: "image/jpeg", updatedAt: PHOTO_AT });
  });

  const link = (id = 7, version = PHOTO_AT.getTime()) => customerPhotoUrl(base, id, version);

  it("serves the photo's bytes, cacheable for good", async () => {
    const res = await fetch(link());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(JPEG);
  });

  it("answers a repeat with 304 without reading the photo", async () => {
    const etag = (await fetch(link())).headers.get("etag")!;
    findPhoto.mockClear();
    const res = await fetch(link(), { headers: { "If-None-Match": etag } });
    expect(res.status).toBe(304);
    expect(findPhoto).not.toHaveBeenCalled();
  });

  it("refuses a forged, borrowed or malformed link with the same 404", async () => {
    const forged = link().replace(/sig=[^&]+/, "sig=AAAAAAAAAAAAAAAAAAAAAA");
    const borrowed = link().replace("/customers/7/", "/customers/8/");
    for (const url of [forged, borrowed, `${base}/api/customers/7/photo`, `${base}/api/customers/abc/photo?v=1&sig=x`]) {
      const res = await fetch(url);
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control") ?? "").not.toContain("immutable");
    }
    expect(findPhoto).not.toHaveBeenCalled();
  });

  it("stops serving a replaced photo's old link", async () => {
    const res = await fetch(link(7, PHOTO_AT.getTime() - 1000));
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control") ?? "").not.toContain("immutable");
  });

  it("serves a legacy inline avatar when there is no photo row", async () => {
    findPhoto.mockResolvedValue(null);
    findCustomer.mockResolvedValue({ information: { avatar: DATA_URI, updatedAt: INFO_AT } });
    const res = await fetch(link(7, INFO_AT.getTime()));
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(JPEG);
  });
});
