import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A shop's own photo for the Home tab (2026-10-08): the server asks Google for
 * the image address with its key, remembers it for six hours, and never
 * hands Google anything but a well-formed photo name.
 */

vi.mock("../src/config/env.js", async (original) => ({
  ...(await original<typeof import("../src/config/env.js")>()),
  GOOGLE_PLACES_API_KEY: "test-places-key",
}));

import { clearPhotoAddresses, resolvePhotoUri, resolvePhotoUris } from "../src/lib/places/placePhotos.js";

const NAME = "places/ChIJabc123/photos/AWU5eFjxyz";
const google = vi.fn();

beforeEach(() => {
  clearPhotoAddresses();
  google.mockReset();
  vi.stubGlobal("fetch", google);
});
afterEach(() => vi.unstubAllGlobals());

const answers = (status: number, body: unknown) =>
  google.mockResolvedValueOnce({ ok: status < 400, status, json: async () => body });

describe("a shop photo's image address", () => {
  it("is asked of Google with the server's key, at card size, without following the redirect", async () => {
    answers(200, { photoUri: "https://lh3.googleusercontent.com/p/abc=w480" });
    expect(await resolvePhotoUri(NAME)).toBe("https://lh3.googleusercontent.com/p/abc=w480");
    const [url, init] = google.mock.calls[0];
    expect(url).toBe(`https://places.googleapis.com/v1/${NAME}/media?maxWidthPx=480&skipHttpRedirect=true`);
    expect(init.headers).toEqual({ "X-Goog-Api-Key": "test-places-key" });
  });

  it("is remembered for six hours, so nearby customers do not each pay for it", async () => {
    answers(200, { photoUri: "https://lh3.googleusercontent.com/p/abc=w480" });
    const t0 = Date.now();
    await resolvePhotoUri(NAME, t0);
    await resolvePhotoUri(NAME, t0 + 5 * 60 * 60 * 1000);
    expect(google).toHaveBeenCalledTimes(1);

    answers(200, { photoUri: "https://lh3.googleusercontent.com/p/abc=w480&v=2" });
    expect(await resolvePhotoUri(NAME, t0 + 6 * 60 * 60 * 1000 + 60 * 1000)).toContain("v=2");
    expect(google).toHaveBeenCalledTimes(2);
  });

  it("is null when Google refuses or has no such photo, so the card falls back", async () => {
    answers(404, { error: { status: "NOT_FOUND" } });
    expect(await resolvePhotoUri(NAME)).toBeNull();
    google.mockRejectedValueOnce(new Error("network down"));
    expect(await resolvePhotoUri(NAME)).toBeNull();
  });

  it("is never a non-https address, whatever comes back", async () => {
    answers(200, { photoUri: "javascript:alert(1)" });
    expect(await resolvePhotoUri(NAME)).toBeNull();
  });

  it("is never asked for anything but a place photo's name", async () => {
    for (const bad of ["places/abc/photos/../../x", "https://evil.example/x", "places/abc", ""]) {
      expect(await resolvePhotoUri(bad)).toBeNull();
    }
    expect(google).not.toHaveBeenCalled();
  });
});

describe("a list's photo addresses", () => {
  it("come back in order, null where a shop has no photo", async () => {
    answers(200, { photoUri: "https://lh3.googleusercontent.com/p/one" });
    answers(200, { photoUri: "https://lh3.googleusercontent.com/p/two" });
    const uris = await resolvePhotoUris(["places/a/photos/one", null, "places/b/photos/two"]);
    expect(uris[1]).toBeNull();
    expect(uris.filter(Boolean)).toHaveLength(2);
  });

  it("never hold the list up past the budget", async () => {
    google.mockImplementationOnce(() => new Promise(() => {}));
    const started = Date.now();
    expect(await resolvePhotoUris(["places/a/photos/slow"], 30)).toEqual([null]);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
