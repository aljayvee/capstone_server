import { IPlaceRepository, placeRepository } from "../repositories/placeRepository.js";
import type { GeoPoint } from "../lib/geo.js";
import { isWithinServiceArea } from "../lib/serviceArea.js";
import { IVerifiedPlace, PlaceCreateInput, PlaceUpdateInput, PlaceSearchFilters } from "../types/place.js";

// How close a pin has to be before we are willing to call it "at" a place.
//
// Measured against the actual catalogue rather than guessed. The downtown rows
// sit 25-110 m apart (Jollibee Main to Greenwich is ~89 m, to Chowking ~95 m,
// Greenwich to Chowking ~62 m), so anything near 150 m would routinely reach a
// second establishment — and, worse, would label a customer's *home* with the
// name of a restaurant down the street. That address then goes to a rider.
//
// 50 m is roughly a building footprint: close enough that a pin dropped inside
// the premises still resolves, tight enough that standing outside on the road
// does not. A miss costs nothing — the caller falls back to a street address.
const REVERSE_LOOKUP_RADIUS_METERS = 50;

export interface ReverseLookupResult {
  place: IVerifiedPlace;
  distanceMeters: number;
}

export class PlaceService {
  constructor(private repo: IPlaceRepository = placeRepository) {}

  // Coordinate -> nearest verified establishment. This is the Tier-1 answer for
  // "what is at this pin": the catalogue holds real Tacurong POIs with names a
  // rider recognises, which is precisely what a device geocoder cannot produce
  // for a coordinate that has no street address of its own.
  async reverseLookup(point: GeoPoint): Promise<ReverseLookupResult | null> {
    // Outside the operating boundary there is nothing in the catalogue worth
    // matching, and any hit would be a stray row rather than a real answer.
    if (!isWithinServiceArea(point)) return null;

    return this.repo.findNearest(point, REVERSE_LOOKUP_RADIUS_METERS);
  }

  async searchPlaces(filters: PlaceSearchFilters = {}): Promise<IVerifiedPlace[]> {
    const places = await this.repo.findAll(filters);

    if (!filters.search || !filters.search.trim()) {
      return places;
    }

    const query = filters.search.trim().toLowerCase();

    // Strategy-based relevance ranking:
    // 1. Exact name match or starts with query (Rank 3)
    // 2. Keyword exact token match (Rank 2)
    // 3. Address or partial keyword match (Rank 1)
    return places.sort((a: IVerifiedPlace, b: IVerifiedPlace) => {
      const aName = a.name.toLowerCase();
      const bName = b.name.toLowerCase();
      const aKey = (a.keywords || "").toLowerCase();
      const bKey = (b.keywords || "").toLowerCase();

      const aScore = aName.startsWith(query) ? 3 : aKey.includes(query) ? 2 : 1;
      const bScore = bName.startsWith(query) ? 3 : bKey.includes(query) ? 2 : 1;

      return bScore - aScore;
    });
  }

  async getPlaceById(id: string): Promise<IVerifiedPlace | null> {
    return this.repo.findById(id);
  }

  async createPlace(input: PlaceCreateInput): Promise<IVerifiedPlace> {
    return this.repo.create(input);
  }

  async updatePlace(id: string, input: PlaceUpdateInput): Promise<IVerifiedPlace> {
    const existing = await this.repo.findById(id);
    if (!existing) {
      const error: any = new Error("Place not found");
      error.status = 404;
      throw error;
    }
    return this.repo.update(id, input);
  }

  async deletePlace(id: string): Promise<IVerifiedPlace> {
    const existing = await this.repo.findById(id);
    if (!existing) {
      const error: any = new Error("Place not found");
      error.status = 404;
      throw error;
    }
    return this.repo.delete(id);
  }

  async getCategories() {
    return this.repo.getCategories();
  }
}

export const placeService = new PlaceService();
