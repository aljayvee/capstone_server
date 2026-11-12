-- ==========================================
-- Tier 1: Performance Composite B+Tree Indexes
-- Blueprint: database_optimization_and_indexing_blueprint.md
-- ==========================================

-- 1. Errand Model Composite Indexes
CREATE INDEX `errands_status_createdAt_idx` ON `errands`(`status`, `createdAt`);
CREATE INDEX `errands_status_assignedAt_idx` ON `errands`(`status`, `assignedAt`);
CREATE INDEX `errands_status_riderId_idx` ON `errands`(`status`, `riderId`);
CREATE INDEX `errands_riderId_status_idx` ON `errands`(`riderId`, `status`);
CREATE INDEX `errands_customerId_createdAt_idx` ON `errands`(`customerId`, `createdAt`);
CREATE INDEX `errands_createdAt_idx` ON `errands`(`createdAt`);

-- 2. User Model Composite Index
CREATE INDEX `users_role_status_idx` ON `users`(`role`, `status`);

-- 3. CustomerTransaction Model Composite Indexes
CREATE INDEX `customer_transactions_customerId_createdAt_idx` ON `customer_transactions`(`customerId`, `createdAt`);
CREATE INDEX `customer_transactions_createdAt_idx` ON `customer_transactions`(`createdAt`);

-- 4. DispatchLog Model Composite Indexes
CREATE INDEX `dispatch_logs_errandId_dispatchedAt_idx` ON `dispatch_logs`(`errandId`, `dispatchedAt`);
CREATE INDEX `dispatch_logs_dispatcherId_errandId_idx` ON `dispatch_logs`(`dispatcherId`, `errandId`);

-- 5. ErrandPinpoint Covering Sequence Index (replaces single errandId index)
CREATE INDEX `errand_pinpoints_tbl_errandId_sequence_idx` ON `errand_pinpoints_tbl`(`errandId`, `sequence`);
DROP INDEX `errand_pinpoints_tbl_errandId_idx` ON `errand_pinpoints_tbl`;

-- 6. RiderCommission Composite Date-Range Index (replaces single riderId index)
CREATE INDEX `rider_commissions_riderId_computedAt_idx` ON `rider_commissions`(`riderId`, `computedAt`);
DROP INDEX `rider_commissions_riderId_idx` ON `rider_commissions`;
