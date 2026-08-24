import { asyncHandler } from "../lib/asyncHandler.js";
import { parseOrThrow } from "../validators/validate.js";
import {
  createMerchantCategorySchema,
  updateMerchantCategorySchema,
  storeCategoryImageUploadSchema,
} from "../validators/merchantCategoryValidators.js";
import * as merchantCategoryService from "../services/merchantCategoryService.js";
import { ServiceError } from "../services/ServiceError.js";

export const listMerchantCategories = asyncHandler(async (req, res) => {
  // Active-only by default so the customer's store-category picker can never
  // offer a retired type; the owner portal passes ?includeInactive=true to
  // manage them.
  const includeInactive = req.query.includeInactive === "true";
  const categories = await merchantCategoryService.listMerchantCategories(includeInactive);
  res.json(categories);
});

export const createMerchantCategory = asyncHandler(async (req, res) => {
  const input = parseOrThrow(createMerchantCategorySchema, req.body);
  const category = await merchantCategoryService.createMerchantCategory(input);
  res.status(201).json(category);
});

export const updateMerchantCategory = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const input = parseOrThrow(updateMerchantCategorySchema, req.body);
  const category = await merchantCategoryService.updateMerchantCategory(id, input);
  res.json(category);
});

// --- Hero image (`store_cat_image`) ---------------------------------------

function parseCategoryId(raw: string): number {
  const id = parseInt(raw, 10);
  if (Number.isNaN(id) || id <= 0) {
    throw new ServiceError(400, "Invalid category ID");
  }
  return id;
}

// Any signed-in role may read the image: the CustomerApp Bento grid and the
// dispatcher store picker both render it. Writes stay OWNER-only (see routes).
export const getStoreCategoryImage = asyncHandler(async (req, res) => {
  const categoryId = parseCategoryId(req.params.id);
  const image = await merchantCategoryService.getCategoryImage(categoryId);

  // The payload is immutable for a given `updatedAt`, so let the client skip
  // the transfer entirely on a repeat request. Private, because the endpoint
  // is authenticated and must not be held by a shared proxy.
  const etag = `W/"cat-img-${categoryId}-${image.updatedAt.getTime()}"`;
  if (req.headers["if-none-match"] === etag) {
    return res.status(304).end();
  }
  res.setHeader("ETag", etag);
  res.setHeader("Cache-Control", "private, max-age=300");

  res.json({
    categoryId,
    imageData: image.imageData,
    mimeType: image.mimeType,
    fileSize: image.fileSize,
    fileName: image.fileName,
    updatedAt: image.updatedAt,
  });
});

export const uploadStoreCategoryImage = asyncHandler(async (req, res) => {
  const categoryId = parseCategoryId(req.params.id);
  const input = parseOrThrow(storeCategoryImageUploadSchema, req.body);
  const result = await merchantCategoryService.setCategoryImage(categoryId, input);
  res.json(result);
});

export const deleteStoreCategoryImage = asyncHandler(async (req, res) => {
  const categoryId = parseCategoryId(req.params.id);
  const result = await merchantCategoryService.removeCategoryImage(categoryId);
  res.json(result);
});
