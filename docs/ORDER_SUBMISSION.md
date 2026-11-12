# Reliable customer order submission

## Contract

- `POST /api/errands` accepts optional `submissionId` (20-80 ASCII letters, digits, underscores or hyphens). The updated customer app generates one local Firebase push key per frozen request, prefixed with `submission-`.
- Identity is scoped to the authenticated customer. A caller cannot change ownership using the request body. Owner tooling keeps its existing explicit-customer behavior.
- The unique `(customerId, submissionId)` index arbitrates concurrent requests across processes. The order, original items, customer-selected stops, reference counter and transaction receipt commit together. Repeating the same parsed contents returns the same order; changing the contents returns HTTP 409. Object key order does not affect the request hash; array order does.
- `GET /api/errands/submissions/:submissionId` requires the CUSTOMER role and returns `{ submissionId, status: 'CONFIRMED', errand }` or `{ submissionId, status: 'NOT_FOUND', errand: null }`. It never returns another customer's order. NOT_FOUND is a point-in-time observation; a previous request may still be processing, so creation must still reuse the same identity.
- Legacy callers without an identity remain compatible, and do not gain duplicate protection.

## Customer recovery

The app persists the frozen identity, basket and delivery location before networking and records that a POST might have started before sending it. A shared coordinator survives screen changes. Unconfirmed drafts are locked and exempt from normal draft expiration. Storage failure prevents sending; restoration failure prevents replacing an unreadable pending request.

The native modal blocks taps/back navigation, changes copy after 8 seconds and offers Try again / View my orders after 30 seconds. `EXPO_PUBLIC_ORDER_SUBMISSION_TIMEOUT_MS` configures the wait (10-120 seconds; default 30). Transport requests can finish later without reopening the checkout. Order history retains a pending card and refreshes when a late confirmation arrives. Restart recovery checks status without automatically creating an order.

Every explicit retry first checks status. The client requires the new status contract before creating, so an unsupported server cannot silently ignore the identity. A definite initial 400/422 unlocks the draft; a network failure, 5xx, identity conflict, or rejection after an earlier uncertain POST retains it. Firebase location/receipt writes do not delay confirmation. The submission chat receipt uses one transactional message key per order, so recovery cannot append duplicate receipts.

## Rollout

1. Review pending Prisma migrations, back up the target database, and deploy migrations through the normal Prisma migration workflow. This change adds `20261023140000_add_order_submission_identity`; do not use `db push` for production.
2. Generate Prisma Client, compile and deploy the server. The new schema must exist before the new server reads errands. Verify health and the authenticated status endpoint with a valid unused synthetic identity; it should return NOT_FOUND without creating an order.
3. Release the CustomerApp update only after the server contract is available. Existing installed builds retain their previous submission behavior until updated.
4. Smoke-test throttled networking and lost confirmation in a staging/test account: record one order ID, retry from Review and history, then restart and recover. Confirm one errand, one transaction receipt and one `order:new` event for that identity.

Rollback the app first if needed. Nullable identity columns can remain in place when rolling back server code. Keep them for recovery/audit; do not remove identities from orders that clients may retry.

## Verification limits

Automated suites cover application concurrency/unique-conflict recovery with mocked persistence, ownership, backward compatibility, durable retries, storage failure, navigation guards, timeout copy and late success. Prisma validation and TypeScript compilation validate integration. A live MariaDB migration/concurrency check and native swipe/back smoke test still belong in the staging rollout; unit tests do not replace those checks. No production migration or app publication is performed by these local changes.

## Production rollout: 2026-10-24 (+08)

The additive migration and six affected compiled server modules are deployed. Production dependencies passed Prisma validation/generation and TypeScript checking/build. An isolated MariaDB database using copies of the production table definitions passed the actual migration, concurrent unique-key arbitration (one order and one receipt), transaction rollback, and legacy NULL-identity checks. The temporary database was removed; no synthetic production orders or notifications were created. Production counts remained 574 errands / 574 transaction receipts.

Both localhost and https://api.sugo-express.org passed health (200) and submission lookup checks: unauthenticated 401, dispatcher 403, authenticated customer 200 / NOT_FOUND. PM2 capstone-backend is online. The production composite unique index and completed migration record were verified.

Production previously had no `_prisma_migrations` ledger. Only this migration SQL was applied with `prisma db execute`, then recorded with `prisma migrate resolve --applied 20261023140000_add_order_submission_identity`. Older migration directories have NOT been marked applied. Before using a future blanket `prisma migrate deploy`, audit and baseline the historical schema; otherwise it will attempt to replay those old migrations. Do not substitute `db push --accept-data-loss`.

Private VPS backup: `/root/deploy-backups/order-submission-20261024-01` contains a compressed full database dump, prior runtime/generated client, before-release checksums, the scoped release and verified candidate build. Its `rollback-server.sh` restores only the affected pre-release runtime/source/client files and restarts PM2, leaving additive database columns and identities intact. Reassess app compatibility before rollback.

The customer update was already published before this server rollout: production group `1d249230-4c69-49e6-8dcc-4e9045323365`, runtime `1.2.0`, Android and iOS. Both published launch hashes match the local export, and all 185 mapped application sources per platform match current files. The production channel is active and points to that group. No duplicate OTA was published. Native device slow-network/swipe-back confirmation remains unperformed.
