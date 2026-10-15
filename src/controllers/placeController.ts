import { Request, Response } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { placeService } from "../services/placeService.js";
import { googlePlaceForDirectory, searchGoogleForDirectory } from "../services/placeDirectoryService.js";
import { GOOGLE_PLACE_ID } from "../lib/places/googlePlacesClient.js";
import {
  googleDirectorySearchSchema,
  placeCreateSchema,
  placeRestoreSchema,
  placePhotoUploadSchema,
  placeUpdateSchema,
} from "../validators/placeValidators.js";

/**
 * A refusal the service explained (err.status set): its words in `error`, which
 * clients read, and in `message`, which this screen's older code reads, with
 * what it is about (`details`: the duplicate, Google's own position).
 */
function sendRefusal(res: Response, err: any): boolean {
  const status = err?.status;
  if (typeof status !== "number" || ((status < 400 || status >= 500) && status !== 503)) return false;
  res.status(err.status).json({ error: err.message, message: err.message, ...(err.details ?? {}) });
  return true;
}

export class PlaceController {
  async getAll(req: Request, res: Response) {
    try {
      const search = typeof req.query.search === "string" ? req.query.search : undefined;
      const categoryId = req.query.categoryId ? Number(req.query.categoryId) : undefined;
      const barangay = typeof req.query.barangay === "string" ? req.query.barangay : undefined;
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      // Retired places (and everything under a retired category) are hidden by
      // default so a dispatcher cannot pin, say, a remittance outlet as a Pabili
      // stop. Only staff managing the catalogue may ask to see them — honouring
      // the flag for any caller would put the retired rows straight back into
      // the store picker the filter exists to keep them out of.
      const role = String((req as AuthenticatedRequest).user?.role ?? "").toUpperCase();
      const maySeeInactive = role === "OWNER" || role === "DISPATCHER";
      const includeInactive = maySeeInactive && req.query.includeInactive === "true";

      const places = await placeService.searchPlaces({
        search,
        categoryId,
        barangay,
        limit,
        includeInactive,
      });
      return res.json(places);
    } catch (err: any) {
      console.error("[PlaceController.getAll] Error:", err);
      return res.status(500).json({ message: "Failed to retrieve verified places", error: err.message });
    }
  }

  // GET /api/places/reverse?lat=&lng=
  //
  // A miss is a 200 with `place: null`, not a 404: "no verified establishment at
  // this pin" is the ordinary answer for most coordinates in the city, and the
  // caller's next move is to fall back to its own geocoder either way.
  async reverse(req: Request, res: Response) {
    try {
      const latitude = Number(req.query.lat);
      const longitude = Number(req.query.lng);

      if (
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        latitude < -90 ||
        latitude > 90 ||
        longitude < -180 ||
        longitude > 180
      ) {
        return res.status(400).json({ message: "lat and lng must be valid coordinates" });
      }

      const match = await placeService.reverseLookup({ latitude, longitude });
      if (!match) {
        return res.json({ place: null });
      }

      return res.json({
        place: {
          id: match.place.id,
          name: match.place.name,
          address: match.place.address,
          barangay: match.place.barangay ?? null,
          latitude: match.place.latitude,
          longitude: match.place.longitude,
        },
        distanceMeters: Math.round(match.distanceMeters),
      });
    } catch (err: any) {
      console.error("[PlaceController.reverse] Error:", err);
      return res.status(500).json({ message: "Failed to resolve place", error: err.message });
    }
  }

  async getById(req: Request, res: Response) {
    try {
      const place = await placeService.getPlaceById(req.params.id);
      if (!place) {
        return res.status(404).json({ message: "Place not found" });
      }
      return res.json(place);
    } catch (err: any) {
      console.error("[PlaceController.getById] Error:", err);
      return res.status(500).json({ message: "Failed to retrieve place", error: err.message });
    }
  }

  async create(req: Request, res: Response) {
    try {
      const parsed = placeCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          message: "Validation failed",
          errors: parsed.error.format(),
        });
      }

      const created = await placeService.createPlace(parsed.data);
      return res.status(201).json(created);
    } catch (err: any) {
      if (sendRefusal(res, err)) return;
      console.error("[PlaceController.create] Error:", err);
      return res.status(500).json({ message: "Failed to create verified place", error: err.message });
    }
  }

  async update(req: Request, res: Response) {
    try {
      const parsed = placeUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          message: "Validation failed",
          errors: parsed.error.format(),
        });
      }

      const updated = await placeService.updatePlace(req.params.id, parsed.data);
      return res.json(updated);
    } catch (err: any) {
      if (sendRefusal(res, err)) return;
      console.error("[PlaceController.update] Error:", err);
      return res.status(500).json({ message: "Failed to update verified place", error: err.message });
    }
  }

  async delete(req: Request, res: Response) {
    try {
      const deleted = await placeService.deletePlace(req.params.id);
      return res.json({ message: "Place deleted successfully", id: deleted.id });
    } catch (err: any) {
      if (err.status === 404) {
        return res.status(404).json({ message: err.message });
      }
      console.error("[PlaceController.delete] Error:", err);
      return res.status(500).json({ message: "Failed to delete verified place", error: err.message });
    }
  }

  // GET /api/places/google?q= or ?categoryId= - Google Maps stores to register (owner).
  async googleSearch(req: Request, res: Response) {
    const parsed = googleDirectorySearchSchema.safeParse(req.query);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid search";
      return res.status(400).json({ error: message, message });
    }
    try {
      return res.json({ results: await searchGoogleForDirectory(parsed.data) });
    } catch (err: any) {
      if (sendRefusal(res, err)) return;
      console.error("[PlaceController.googleSearch] Error:", err);
      return res.status(500).json({ error: "Google Maps could not be searched.", message: "Google Maps could not be searched." });
    }
  }

  // GET /api/places/google/:googlePlaceId - one Google Maps place, to fill the form (owner).
  async googleDetails(req: Request, res: Response) {
    if (!GOOGLE_PLACE_ID.test(req.params.googlePlaceId)) {
      return res.status(400).json({ error: "That is not a Google Maps place.", message: "That is not a Google Maps place." });
    }
    try {
      return res.json(await googlePlaceForDirectory(req.params.googlePlaceId));
    } catch (err: any) {
      if (sendRefusal(res, err)) return;
      console.error("[PlaceController.googleDetails] Error:", err);
      return res.status(500).json({ error: "Google Maps could not be read.", message: "Google Maps could not be read." });
    }
  }

  // POST /api/places/restore - the Archive's Restore selected (owner).
  async restore(req: Request, res: Response) {
    const parsed = placeRestoreSchema.safeParse(req.body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request";
      return res.status(400).json({ error: message, message });
    }
    try {
      return res.json({ results: await placeService.restorePlaces([...new Set(parsed.data.ids)]) });
    } catch (err: any) {
      console.error("[PlaceController.restore] Error:", err);
      return res.status(500).json({ error: "The stores could not be restored.", message: "The stores could not be restored." });
    }
  }

  // GET /api/places/duplicates - active stores that look registered twice.
  async duplicates(_req: Request, res: Response) {
    try {
      return res.json({ groups: await placeService.getDuplicateGroups() });
    } catch (err: any) {
      console.error("[PlaceController.duplicates] Error:", err);
      return res.status(500).json({ error: "Duplicates could not be checked.", message: "Duplicates could not be checked." });
    }
  }

  // GET /api/places/:id/photo - the storefront photo, with no sign-in: the
  // customer app's image loader sends none (it shows these on store cards).
  async getPhoto(req: Request, res: Response) {
    try {
      const photo = await placeService.getPhoto(req.params.id);
      if (!photo) return res.status(404).json({ error: "No photo", message: "No photo" });
      const etag = `W/"place-photo-${req.params.id}-${photo.updatedAt.getTime()}"`;
      // Readable from the portal's own origin too: helmet's default is same-origin.
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.setHeader("ETag", etag);
      // A `?v=` address names one version of the photo for good; a bare one is rechecked daily.
      res.setHeader("Cache-Control", req.query.v ? "public, max-age=31536000, immutable" : "public, max-age=86400");
      if (req.headers["if-none-match"] === etag) return res.status(304).end();
      res.setHeader("Content-Type", photo.mimeType);
      return res.end(Buffer.from(photo.imageData));
    } catch (err: any) {
      console.error("[PlaceController.getPhoto] Error:", err);
      return res.status(500).json({ error: "The photo could not be read.", message: "The photo could not be read." });
    }
  }

  // PUT /api/places/:id/photo - the owner's storefront photo (data URI, 2MB).
  async uploadPhoto(req: Request, res: Response) {
    const parsed = placePhotoUploadSchema.safeParse(req.body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid photo";
      return res.status(400).json({ error: message, message });
    }
    try {
      return res.json(await placeService.setPhoto(req.params.id, parsed.data));
    } catch (err: any) {
      if (sendRefusal(res, err)) return;
      console.error("[PlaceController.uploadPhoto] Error:", err);
      return res.status(500).json({ error: "The photo could not be saved.", message: "The photo could not be saved." });
    }
  }

  // DELETE /api/places/:id/photo
  async deletePhoto(req: Request, res: Response) {
    try {
      await placeService.deletePhoto(req.params.id);
      return res.json({ photoUpdatedAt: null });
    } catch (err: any) {
      if (sendRefusal(res, err)) return;
      console.error("[PlaceController.deletePhoto] Error:", err);
      return res.status(500).json({ error: "The photo could not be removed.", message: "The photo could not be removed." });
    }
  }

  async getCategories(req: Request, res: Response) {
    try {
      const categories = await placeService.getCategories();
      return res.json(categories);
    } catch (err: any) {
      console.error("[PlaceController.getCategories] Error:", err);
      return res.status(500).json({ message: "Failed to retrieve categories", error: err.message });
    }
  }
}

export const placeController = new PlaceController();
