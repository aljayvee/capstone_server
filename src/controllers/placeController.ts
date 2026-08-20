import { Request, Response } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { placeService } from "../services/placeService.js";
import { placeCreateSchema, placeUpdateSchema } from "../validators/placeValidators.js";

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
      if (err.status === 404) {
        return res.status(404).json({ message: err.message });
      }
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
