import { IPlaceRepository, placeRepository } from "../repositories/placeRepository.js";
import { IVerifiedPlace, PlaceCreateInput, PlaceUpdateInput, PlaceSearchFilters } from "../types/place.js";

export class PlaceService {
  constructor(private repo: IPlaceRepository = placeRepository) {}

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
