import type { WeeklyHours } from "../lib/places/storeHours.js";

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
  /** The Google Maps place this store is (2026-10-13). Null for rows registered before then. */
  googlePlaceId?: string | null;
  /** A store Google Maps does not list, pinned on the map by the owner (placeService.checkOwnerPin). */
  ownerPinned?: boolean;
  /** The owner's weekly hours (lib/places/storeHours.ts WeeklyHours), as stored. */
  openingHours?: unknown;
  /** When the owner's storefront photo last changed; null when there is none. */
  photoUpdatedAt?: Date | null;
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
  /** Required for a new store: the Google Maps place it is (placeService.createPlace)... */
  googlePlaceId?: string | null;
  /** ...or true: Google Maps does not list it, and the owner pinned it on the map. */
  ownerPinned?: boolean;
  openingHours?: WeeklyHours | null;
  /** The owner confirmed a store that looks like one already registered is another branch. */
  confirmDuplicate?: boolean;
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
  googlePlaceId?: string | null;
  ownerPinned?: boolean;
  openingHours?: WeeklyHours | null;
  confirmDuplicate?: boolean;
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
