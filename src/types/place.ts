export interface IVerifiedPlace {
  id: string;
  name: string;
  categoryId: number;
  category?: {
    id: number;
    name: string;
    description?: string | null;
  };
  address: string;
  barangay?: string | null;
  latitude: number;
  longitude: number;
  keywords?: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface PlaceCreateInput {
  name: string;
  categoryId: number;
  address: string;
  barangay?: string | null;
  latitude: number;
  longitude: number;
  keywords?: string | null;
  isActive?: boolean;
}

export interface PlaceUpdateInput {
  name?: string;
  categoryId?: number;
  address?: string;
  barangay?: string | null;
  latitude?: number;
  longitude?: number;
  keywords?: string | null;
  isActive?: boolean;
}

export interface PlaceSearchFilters {
  search?: string;
  categoryId?: number;
  barangay?: string;
  limit?: number;
  // Opt-in only, for the owner's places directory where inactive rows must stay
  // manageable. Every customer- and dispatcher-facing search leaves this unset
  // so retired places (and everything under a retired category) stay out of the
  // Pabili flow — see the Bills & Payment Centers retirement in seedPlaces.ts.
  includeInactive?: boolean;
}
