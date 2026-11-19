/**
 * Catalog Controller.
 * Handles item autocomplete, store menu queries, and establishment location matching.
 */

import { asyncHandler } from "../lib/asyncHandler.js";
import * as catalogSuggestionService from "../services/catalogSuggestionService.js";
import * as establishmentMatcherService from "../services/establishmentMatcherService.js";

export const searchItems = asyncHandler(async (req, res) => {
  const query = String(req.query.q ?? "");
  const placeId = req.query.placeId ? String(req.query.placeId) : undefined;
  const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 10;

  const suggestions = await catalogSuggestionService.searchCatalogItems(query, {
    placeId,
    limit,
  });

  res.json({ suggestions });
});

export const getPlaceItems = asyncHandler(async (req, res) => {
  const placeId = String(req.params.placeId);
  const items = await catalogSuggestionService.listItemsForPlace(placeId);
  res.json({ items });
});

export const catalogueItem = asyncHandler(async (req, res) => {
  try {
    const { item, created } = await catalogSuggestionService.catalogueItem(req.body ?? {});
    res.status(created ? 201 : 200).json({ item, created });
  } catch (error) {
    if (error instanceof catalogSuggestionService.CatalogInputError) {
      return res.status(400).json({ error: error.message });
    }
    throw error;
  }
});

export const retireItem = asyncHandler(async (req, res) => {
  const found = await catalogSuggestionService.retireCatalogItem(Number(req.params.id));
  if (!found) return res.status(404).json({ error: "Catalog item not found" });
  res.json({ success: true });
});

export const matchEstablishment = asyncHandler(async (req, res) => {
  const { name, address, barangay, latitude, longitude, googleTypes } = req.body ?? {};

  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "Store name is required" });
  }

  const result = await establishmentMatcherService.matchEstablishmentCategory({
    name,
    address: String(address || ""),
    barangay: barangay ? String(barangay) : null,
    latitude: Number(latitude) || 6.69,
    longitude: Number(longitude) || 124.67,
    googleTypes: Array.isArray(googleTypes) ? googleTypes : undefined,
  });

  res.json(result);
});
