import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The owner's Location Stores (2026-10-13): every store is a Google Maps place
 * with its pin at Google's position, a store is never registered twice, and the
 * owner's weekly hours decide open or closed.
 */

const google = vi.hoisted(() => ({
  places: new Map<string, { googlePlaceId: string; name: string; latitude: number; longitude: number }>(),
  down: false,
}));
vi.mock("../src/lib/places/googlePlaceConfirm.js", async (original) => {
  const real = await original<typeof import("../src/lib/places/googlePlaceConfirm.js")>();
  return {
    ...real,
    confirmGooglePlace: vi.fn(async (id: string) => {
      if (google.down) throw new real.PlaceConfirmError(503, "Google Maps could not be reached to confirm this store. Try again in a minute.");
      const place = google.places.get(id);
      if (!place) throw new real.PlaceConfirmError(422, "Google Maps has no such place. Search for the store on Google Maps again.");
      return { ...place, address: "", barangay: null, types: [], primaryType: null, businessStatus: "OPERATIONAL", openingPeriods: null };
    }),
  };
});
vi.mock("../src/services/categoryRetrainingService.js", () => ({ triggerCategoryAutoLearning: vi.fn() }));
/** An owner's pin: where the road graph says it is, and what Google Maps lists by that name. */
const ownerPin = vi.hoisted(() => ({
  blocked: null as string | null,
  googleText: [] as Array<{ googlePlaceId: string; name: string; latitude: number; longitude: number }> | null,
}));
vi.mock("../src/services/storeLocationGuard.js", () => ({
  checkStoreLocation: vi.fn(async () =>
    ownerPin.blocked ? { status: "blocked", message: ownerPin.blocked } : { status: "inside", message: "Inside Tacurong." }
  ),
}));
vi.mock("../src/lib/places/googlePlacesClient.js", async (original) => ({
  ...(await original<typeof import("../src/lib/places/googlePlacesClient.js")>()),
  searchPlacesByText: vi.fn(async () => ownerPin.googleText),
}));
vi.mock("../src/lib/serviceArea.js", async (original) => ({
  ...(await original<typeof import("../src/lib/serviceArea.js")>()),
  isServiceAreaConfigured: () => false,
}));

import { PlaceService } from "../src/services/placeService.js";
import { findDuplicate, groupDuplicates } from "../src/lib/places/placeDuplicates.js";
import {
  isOpenByHours,
  nextOpeningNotice,
  parseWeeklyHours,
  weeklyHoursFromGoogle,
  type WeeklyHours,
} from "../src/lib/places/storeHours.js";

// Manila is UTC+8: 2026-10-14 is a Wednesday (day 3).
const manila = (iso: string) => new Date(`${iso}+08:00`);
const week = (open: string, close: string, closedDays: number[] = []): WeeklyHours => ({
  days: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, closed: closedDays.includes(day), open, close })),
});

describe("the owner's weekly hours", () => {
  it("is open inside the day's hours and closed outside them, by Manila's clock", () => {
    const hours = week("07:00", "21:00");
    expect(isOpenByHours(hours, manila("2026-10-14T06:59:00"))).toBe(false);
    expect(isOpenByHours(hours, manila("2026-10-14T07:00:00"))).toBe(true);
    expect(isOpenByHours(hours, manila("2026-10-14T20:59:00"))).toBe(true);
    expect(isOpenByHours(hours, manila("2026-10-14T21:00:00"))).toBe(false);
  });

  it("keeps a late shop open past midnight into the next morning", () => {
    const hours = week("18:00", "02:00");
    expect(isOpenByHours(hours, manila("2026-10-14T23:30:00"))).toBe(true);
    expect(isOpenByHours(hours, manila("2026-10-15T01:30:00"))).toBe(true);
    expect(isOpenByHours(hours, manila("2026-10-15T02:30:00"))).toBe(false);
  });

  it("is open all day from 00:00 to 24:00, and closed all day on a closed day", () => {
    expect(isOpenByHours(week("00:00", "24:00"), manila("2026-10-14T03:00:00"))).toBe(true);
    expect(isOpenByHours(week("07:00", "21:00", [3]), manila("2026-10-14T12:00:00"))).toBe(false);
  });

  it("tells the customer when it opens next: later today, tomorrow, or a named day", () => {
    expect(nextOpeningNotice(week("07:00", "21:00"), manila("2026-10-14T05:00:00"))).toBe("Opens at 7:00 AM");
    expect(nextOpeningNotice(week("07:30", "21:00"), manila("2026-10-14T22:00:00"))).toBe("Opens tomorrow at 7:30 AM");
    // Closed Thursday and Friday: from Wednesday night, Saturday.
    expect(nextOpeningNotice(week("08:00", "17:00", [4, 5]), manila("2026-10-14T18:00:00"))).toBe("Opens Saturday at 8:00 AM");
    expect(nextOpeningNotice(week("08:00", "17:00", [0, 1, 2, 3, 4, 5, 6]), manila("2026-10-14T18:00:00"))).toBe(
      "Temporarily Unavailable"
    );
  });

  it("reads back only a well-formed week", () => {
    expect(parseWeeklyHours(null)).toBeNull();
    expect(parseWeeklyHours({ days: [{ day: 9, closed: false, open: "07:00", close: "21:00" }] })).toBeNull();
    expect(parseWeeklyHours(week("07:00", "21:00"))?.days).toHaveLength(7);
  });

  it("turns Google's periods into a week, a lunch break into one window", () => {
    const hours = weeklyHoursFromGoogle([
      { open: { day: 1, hour: 8, minute: 0 }, close: { day: 1, hour: 12, minute: 0 } },
      { open: { day: 1, hour: 13, minute: 0 }, close: { day: 1, hour: 20, minute: 30 } },
      { open: { day: 5, hour: 18, minute: 0 }, close: { day: 6, hour: 2, minute: 0 } },
    ])!;
    expect(hours.days[1]).toEqual({ day: 1, closed: false, open: "08:00", close: "20:30" });
    expect(hours.days[5]).toEqual({ day: 5, closed: false, open: "18:00", close: "02:00" });
    expect(hours.days[0].closed).toBe(true);
    // One period with no close: open all the time.
    expect(weeklyHoursFromGoogle([{ open: { day: 0, hour: 0, minute: 0 } }])!.days[3]).toEqual({
      day: 3,
      closed: false,
      open: "00:00",
      close: "24:00",
    });
  });
});

const row = (id: string, name: string, latitude: number, extra: object = {}) => ({
  id,
  name,
  latitude,
  longitude: 124.67,
  googlePlaceId: null as string | null,
  isActive: true,
  category: null,
  ...extra,
});

describe("one store registered twice", () => {
  it("is the same Google Maps place, the same name anywhere, or a related name a few metres away", () => {
    const rows = [
      row("a", "Jollibee Tacurong Center (Main)", 6.6873, { googlePlaceId: "ChIJjollibee1" }),
      row("b", "Mercury Drug", 6.69),
      row("c", "Cebuana Lhuillier", 6.6874),
    ];
    expect(findDuplicate({ name: "Another name", latitude: 6.6, longitude: 124.6, googlePlaceId: "ChIJjollibee1" }, rows)?.reason).toBe(
      "google_place"
    );
    expect(findDuplicate({ name: "Mercury Drug, Tacurong", latitude: 6.6, longitude: 124.6 }, rows)?.reason).toBe("name");
    expect(findDuplicate({ name: "Jollibee", latitude: 6.68731, longitude: 124.67 }, rows)?.reason).toBe("nearby");
    // A different shop next door is not a duplicate.
    expect(findDuplicate({ name: "Chowking", latitude: 6.68731, longitude: 124.67 }, rows)).toBeNull();
  });

  it("groups the directory's existing duplicates", () => {
    const groups = groupDuplicates([row("a", "Jollibee", 6.6873), row("b", "Mercury Drug", 6.69), row("c", "Jollibee Tacurong", 6.6873)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].rows.map((r) => r.id)).toEqual(["a", "c"]);
  });
});

function fakeRepo(rows: ReturnType<typeof row>[]) {
  return {
    findAll: vi.fn(),
    findById: vi.fn(async (id: string) => {
      const found = rows.find((r) => r.id === id);
      return found ? { ...found, categoryId: 1, address: "", createdAt: new Date(), updatedAt: new Date() } : null;
    }),
    findNearest: vi.fn(),
    create: vi.fn(async (data: object) => ({ id: "new", ...data })),
    update: vi.fn(async (id: string, data: object) => ({ id, ...data })),
    delete: vi.fn(),
    getCategories: vi.fn(),
    findAllForDuplicates: vi.fn(async () => rows),
    findOwnerExtras: vi.fn(),
    getPhoto: vi.fn(),
    setPhoto: vi.fn(async () => new Date("2026-10-13T00:00:00Z")),
    deletePhoto: vi.fn(),
  };
}

const newStore = {
  name: "Mercury Drug - Tacurong Alunan Highway",
  categoryId: 3,
  address: "Alunan Hwy, Poblacion",
  latitude: 6.68963,
  longitude: 124.67858,
  isActive: true,
  googlePlaceId: "ChIJmercury01",
};

describe("registering a Location Store", () => {
  beforeEach(() => {
    google.down = false;
    google.places.clear();
    google.places.set("ChIJmercury01", { googlePlaceId: "ChIJmercury01", name: "Mercury Drug", latitude: 6.68963, longitude: 124.67858 });
  });

  const refusal = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error: any) {
      return { status: error.status, message: error.message as string, details: error.details };
    }
    throw new Error("expected a refusal");
  };

  it("refuses a store not found on Google Maps first", async () => {
    const service = new PlaceService(fakeRepo([]) as any);
    const { googlePlaceId: _none, ...typedIn } = newStore;
    expect((await refusal(service.createPlace(typedIn))).status).toBe(422);
    expect((await refusal(service.createPlace({ ...newStore, googlePlaceId: "ChIJnowhere00" }))).status).toBe(422);
  });

  it("refuses a pin more than 100 m from where Google Maps puts the store", async () => {
    const service = new PlaceService(fakeRepo([]) as any);
    const result = await refusal(service.createPlace({ ...newStore, latitude: 6.6915 }));
    expect(result.status).toBe(422);
    expect(result.message).toMatch(/m from where Google Maps puts Mercury Drug/);
    expect(result.details).toMatchObject({ googleLatitude: 6.68963 });
  });

  it("says when Google Maps cannot be asked, rather than saving an unconfirmed store", async () => {
    google.down = true;
    const repo = fakeRepo([]);
    expect((await refusal(new PlaceService(repo as any).createPlace(newStore))).status).toBe(503);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it("registers a confirmed store, without the confirmation flag in the row", async () => {
    const repo = fakeRepo([]);
    await new PlaceService(repo as any).createPlace({ ...newStore, latitude: 6.6900, confirmDuplicate: true });
    expect(repo.create).toHaveBeenCalledWith(expect.not.objectContaining({ confirmDuplicate: true }));
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ googlePlaceId: "ChIJmercury01" }));
  });

  it("always refuses the same Google Maps place twice, even when confirmed", async () => {
    const repo = fakeRepo([row("old", "Mercury Drug Alunan", 6.68963, { googlePlaceId: "ChIJmercury01" })]);
    const result = await refusal(new PlaceService(repo as any).createPlace({ ...newStore, confirmDuplicate: true }));
    expect(result.status).toBe(409);
    expect(result.details).toMatchObject({ duplicateOf: { id: "old" }, canConfirm: false });
  });

  it("holds a same-name store until the owner confirms it is another branch", async () => {
    const repo = fakeRepo([row("old", "Mercury Drug - Tacurong Alunan Highway", 6.65)]);
    const service = new PlaceService(repo as any);
    const result = await refusal(service.createPlace(newStore));
    expect(result.status).toBe(409);
    expect(result.details).toMatchObject({ canConfirm: true, reason: "name" });
    await service.createPlace({ ...newStore, confirmDuplicate: true });
    expect(repo.create).toHaveBeenCalledTimes(1);
  });
});

describe("editing a Location Store", () => {
  beforeEach(() => {
    google.places.set("ChIJmercury01", { googlePlaceId: "ChIJmercury01", name: "Mercury Drug", latitude: 6.68963, longitude: 124.67858 });
  });

  it("asks a store from before Google linking to be linked before it stays in circulation", async () => {
    const repo = fakeRepo([row("legacy", "Watsons", 6.6698)]);
    const service = new PlaceService(repo as any);
    await expect(service.updatePlace("legacy", { keywords: "watsons" })).rejects.toMatchObject({ status: 422 });
    // Retiring it needs no link.
    await service.updatePlace("legacy", { isActive: false });
    expect(repo.update).toHaveBeenCalledWith("legacy", { isActive: false });
  });

  it("saves new hours on a store with a retired look-alike, though the form sends its pin back rounded", async () => {
    // FitMart Tacurong, 2026-10-13: the rounding read as a move, and the move
    // ran the duplicate check against the retired "Tacurong Fitmart".
    const repo = fakeRepo([
      row("fit", "FitMart Tacurong", 6.687712345, { googlePlaceId: "ChIJfitmart01" }),
      row("old", "Tacurong Fitmart", 6.6859, { isActive: false }),
    ]);
    const hours = week("08:00", "21:00");
    await new PlaceService(repo as any).updatePlace("fit", {
      latitude: Number((6.687712345).toFixed(6)),
      longitude: 124.67,
      openingHours: hours,
    });
    expect(repo.update).toHaveBeenCalledWith("fit", expect.objectContaining({ openingHours: hours }));
  });

  it("still refuses a renamed store that clashes with an active one", async () => {
    const repo = fakeRepo([
      row("fit", "FitMart Tacurong", 6.6877, { googlePlaceId: "ChIJfitmart01" }),
      row("mercury", "Mercury Drug", 6.69),
    ]);
    await expect(new PlaceService(repo as any).updatePlace("fit", { name: "Mercury Drug" })).rejects.toMatchObject({
      status: 409,
    });
  });

  it("checks a new link against Google Maps and the directory", async () => {
    const repo = fakeRepo([row("legacy", "Mercury Drug", 6.68963)]);
    const service = new PlaceService(repo as any);
    await service.updatePlace("legacy", { googlePlaceId: "ChIJmercury01", latitude: 6.68963, longitude: 124.67858 });
    expect(repo.update).toHaveBeenCalledWith("legacy", expect.objectContaining({ googlePlaceId: "ChIJmercury01" }));
  });
});

describe("the storefront photo", () => {
  it("keeps a real JPEG and refuses bytes that are not the image they claim", async () => {
    const repo = fakeRepo([row("p1", "Mercury Drug", 6.69)]);
    const service = new PlaceService(repo as any);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString("base64");
    await service.setPhoto("p1", { imageData: `data:image/jpeg;base64,${jpeg}`, mimeType: "image/jpeg" });
    expect(repo.setPhoto).toHaveBeenCalledWith("p1", expect.objectContaining({ mimeType: "image/jpeg", fileSize: 7 }));
    await expect(
      service.setPhoto("p1", { imageData: `data:image/png;base64,${jpeg}`, mimeType: "image/png" })
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe("a store Google Maps does not list, pinned by the owner (2026-10-13)", () => {
  const arabian = {
    name: "Arabian Spice Restaurant",
    categoryId: 2,
    address: "Lapu-Lapu St, Poblacion",
    latitude: 6.68575,
    longitude: 124.67119,
    isActive: true,
    ownerPinned: true,
  };
  beforeEach(() => {
    ownerPin.blocked = null;
    ownerPin.googleText = [];
  });

  it("is registered from the owner's pin, marked as theirs", async () => {
    const repo = fakeRepo([]);
    await new PlaceService(repo as any).createPlace(arabian);
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ ownerPinned: true, latitude: 6.68575 }));
  });

  it("is refused where no rider can reach it", async () => {
    ownerPin.blocked = "This spot is not near any road on the map, so no rider route can be planned there. Check the pin.";
    const repo = fakeRepo([]);
    await expect(new PlaceService(repo as any).createPlace(arabian)).rejects.toMatchObject({ status: 422 });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it("points the owner to Google Maps when it lists the store by the pin, until they confirm it is another", async () => {
    ownerPin.googleText = [{ googlePlaceId: "ChIJarabian01", name: "Arabian Spice Restaurant", latitude: 6.6858, longitude: 124.6712 }];
    const repo = fakeRepo([]);
    const service = new PlaceService(repo as any);
    await expect(service.createPlace(arabian)).rejects.toMatchObject({
      status: 409,
      details: { reason: "on_google", googleMatch: { googlePlaceId: "ChIJarabian01" } },
    });
    await service.createPlace({ ...arabian, confirmDuplicate: true });
    expect(repo.create).toHaveBeenCalledTimes(1);
  });

  it("saves an owner's pin when Google cannot be asked: the owner's word stands", async () => {
    ownerPin.googleText = null;
    const repo = fakeRepo([]);
    await new PlaceService(repo as any).createPlace(arabian);
    expect(repo.create).toHaveBeenCalledTimes(1);
  });

  it("is still refused with neither a Google Maps place nor the owner's pin", async () => {
    const { ownerPinned: _no, ...typed } = arabian;
    await expect(new PlaceService(fakeRepo([]) as any).createPlace(typed)).rejects.toMatchObject({ status: 422 });
  });

  it("lets an unlinked store from before stay in circulation once the owner pins it, and keeps it pinned on later edits", async () => {
    const repo = fakeRepo([row("legacy", "Arabian Spice Restaurant", 6.68575)]);
    const service = new PlaceService(repo as any);
    await service.updatePlace("legacy", { ownerPinned: true, latitude: 6.68575, longitude: 124.67 });
    expect(repo.update).toHaveBeenCalledWith("legacy", expect.objectContaining({ ownerPinned: true }));
  });

  it("stops being the owner's pin once linked to a Google Maps place", async () => {
    google.places.set("ChIJarabian01", { googlePlaceId: "ChIJarabian01", name: "Arabian Spice", latitude: 6.68575, longitude: 124.67 });
    const repo = fakeRepo([row("p", "Arabian Spice Restaurant", 6.68575, { ownerPinned: true })]);
    await new PlaceService(repo as any).updatePlace("p", { googlePlaceId: "ChIJarabian01" });
    expect(repo.update).toHaveBeenCalledWith("p", expect.objectContaining({ googlePlaceId: "ChIJarabian01", ownerPinned: false }));
  });
});

describe("restoring a retired store from the Archive (2026-10-13)", () => {
  beforeEach(() => {
    ownerPin.googleText = [];
  });
  const retired = (id: string, name: string, extra: object = {}) => row(id, name, 6.6728, { isActive: false, ...extra });

  it("brings back an unlinked store with Restore, linked to Google Maps on the way when Google has it", async () => {
    ownerPin.googleText = [{ googlePlaceId: "ChIJrobinsons1", name: "Robinsons Supermarket Tacurong", latitude: 6.6741, longitude: 124.67 }];
    const repo = fakeRepo([retired("rob", "Robinsons Supermarket Tacurong")]);
    await new PlaceService(repo as any).updatePlace("rob", { isActive: true });
    expect(repo.update).toHaveBeenCalledWith("rob", {
      isActive: true,
      googlePlaceId: "ChIJrobinsons1",
      latitude: 6.6741,
      longitude: 124.67,
    });
  });

  it("brings it back unlinked when Google Maps does not have it, for the owner to link or pin", async () => {
    const repo = fakeRepo([retired("tiangge", "Tiangge by: B.Cafe Tacurong")]);
    const result = await new PlaceService(repo as any).restorePlace("tiangge");
    expect(repo.update).toHaveBeenCalledWith("tiangge", { isActive: true });
    expect(result.linked).toBe(false);
  });

  it("does not link it to a Google Maps place another store already is", async () => {
    ownerPin.googleText = [{ googlePlaceId: "ChIJjb1", name: "Jollibee", latitude: 6.6873, longitude: 124.67 }];
    const repo = fakeRepo([
      row("jb", "Jollibee", 6.6873, { googlePlaceId: "ChIJjb1" }),
      retired("main", "Jollibee Tacurong Center (Main)"),
    ]);
    const result = await new PlaceService(repo as any).restorePlace("main");
    expect(repo.update).toHaveBeenCalledWith("main", { isActive: true });
    expect(result.linked).toBe(false);
  });

  it("restores several at once, saying which came back linked", async () => {
    ownerPin.googleText = null; // Google down: everyone still comes back
    const repo = fakeRepo([
      retired("a", "Watsons Pharmacy Tacurong"),
      retired("b", "Mercury Drug", { googlePlaceId: "ChIJm1" }),
      row("c", "Already Active", 6.69),
    ]);
    const results = await new PlaceService(repo as any).restorePlaces(["a", "b", "c", "missing"]);
    expect(results.map((r) => [r.id, r.restored, r.linked, Boolean(r.error)])).toEqual([
      ["a", true, false, false],
      ["b", true, true, false],
      ["c", false, false, false],
      ["missing", false, false, true],
    ]);
  });
});
