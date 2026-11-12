-- =========================================================================
-- Performance Optimization: Errand Items & Proof Images Relation Indexes
-- Solves slow financial report queries, N+1 relation scans, and proof writes
-- =========================================================================

-- 1. PabiliDetail errandId Index (eliminates full table scans when fetching order items)
CREATE INDEX `pabili_details_tbl_errandId_idx` ON `pabili_details_tbl`(`errandId`);

-- 2. PabiliItemRequest errandId Index (eliminates full table scans on customer items)
CREATE INDEX `pabili_item_requests_tbl_errandId_idx` ON `pabili_item_requests_tbl`(`errandId`);

-- 3. ErrandProofImage composite errandId + kind index (optimizes receipt lookups)
CREATE INDEX `errand_proof_images_errandId_kind_idx` ON `errand_proof_images`(`errandId`, `kind`);
