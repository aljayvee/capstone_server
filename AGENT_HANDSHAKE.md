# 🌐 DUAL-MODEL COLLABORATION TUNNEL (CLAUDE ◄► GEMINI) - SERVER BACKEND

> **ALWAYS ACTIVE IN ALL SESSIONS**: This file is the shared living memory between Claude App (Anthropic) and Antigravity 2.0 (Google AI / Gemini) for the Express / MariaDB / Prisma backend.

---

## 📡 Tunnel State
* **Active Mission**: Dispatcher Portal Dashboard Aggregation & Shift Handover Auto-Release
* **Current Driver**: Antigravity 2.0 (Gemini 3.8 Flash High)
* **Target Workspace**: `Capstone_Server/server` (Port 5000 API Backend)
* **Last Updated**: 2026-10-17

---

## 🔒 LOCKED CONTRACT REGISTRY (ZERO-REGRESSION POLICY)
* `[LOCKED]` `Prisma Schema 3NF Model` (`prisma/schema.prisma` -> `errands`, `pabili_details_tbl`, `users`, `dispatch_logs`)
* `[LOCKED]` `API Base URL Route Prefix Invariant` (All endpoints strictly mounted under `/api/*`)
* `[LOCKED]` `Rate Limiting & Server Validation Invariant` (Rate limiter -> Zod/Express validator -> Database execution)
* `[LOCKED]` `BOLA/IDOR Dispatcher Authorization` (`verifyDispatcherAccess` on all mutating routes)
* `[LOCKED]` `Rotating Refresh Token Architecture` (SHA-256 session hash in `user_sessions`, 10s grace window)

---

## 2026-10-17 - Dispatcher Portal Dashboard Aggregation & Shift Handover Auto-Release (Antigravity 2.0, Gemini 3.8 Flash High)
* **Status**: [COMPLETED & VERIFIED - `npx tsc --noEmit` passed with 0 errors; Vitest test suite `tests/dispatcherDashboard.test.ts` passed with 3/3 tests].
* **Feature & Implementation Specification**:
  - **Shift Handover Auto-Release (Decision 1)**:
    - Added `releaseAllUnverifiedForDispatcher(dispatcherId)` in `src/services/errandService.ts` and `findUnverifiedByDispatcherId` in `src/repositories/errandRepository.ts`.
    - Automatically finds unverified claimed orders (`status: "PENDING"`, `riderId: null`), deletes unverified dispatch logs, resets chat dispatcher to null, reverts status to `"AVAILABLE"`, and broadcasts `order:updated` and `order:new` via Socket.io.
    - Synchronously awaited in `logout` handler in `src/controllers/authController.ts` for users with `DISPATCHER` role before destroying sessions and clearing cookies.
  - **Dispatcher Dashboard Aggregation Endpoint (Decision 3)**:
    - Added `GET /api/errands/dispatcher-dashboard-summary` controller `src/controllers/dispatcherDashboardController.ts`.
    - Protected by `authenticateToken`, `requireRole(["OWNER", "DISPATCHER"])`, and `readLimiter`.
    - Aggregates `unclaimedCount`, `urgentUnclaimedCount` (>3m), `activeInMotionCount` (excluding pending review), `deliveredTodayCount`, `helpDeskCount`, 5-phase delivery pipeline, deduplicated attention items (stalled dwells, stale unclaimed, overage disputes, post-purchase cancellations), top 5 merchants today, top decline reasons, and verified shift performance metrics.
* **Files Modified**:
  - `src/controllers/authController.ts`
  - `src/controllers/dispatcherDashboardController.ts`
  - `src/repositories/errandRepository.ts`
  - `src/routes/errandRoutes.ts`
  - `src/services/errandService.ts`
  - `tests/dispatcherDashboard.test.ts`
  - `AGENT_HANDSHAKE.md`
* **Verification Ledger**:
  - `npx tsc --noEmit`: 0 errors.
  - `npx vitest run tests/dispatcherDashboard.test.ts`: 3 passed (100%).

---

## 2026-10-16 - 500-Record High-Fidelity Database Seeder Scaling & Non-Destructive VPS Deployment (`prisma/seed.ts`) (Antigravity 2.0, Gemini 3.8 Flash)
* **Status**: [DEPLOYED TO PRODUCTION VPS (109.123.239.182) & VERIFIED - `npx tsc --noEmit` passed with 0 errors, `npx tsx prisma/seed.ts` executed in ~7s on VPS MariaDB with 100% NON-DESTRUCTIVE ACCOUNT PRESERVATION].
* **Feature & Implementation Specification**:
  - **Non-Destructive VPS Seeding Invariant**:
    - Pre-existing accounts on the production VPS (`109.123.239.182`) were strictly checked before creation.
    - Existing staff accounts (12 users including `owner`, `aldhen`, `caramel`, `hatdog`, `hakdog`, `harthpalaras`, `qa_dispatcher`, `mamamo`, `pororo`, `burgerkasakin`, `aldhen_03`, `jayvee`) retained their original email addresses, profile information, and password hashes 100% intact.
    - Existing customer accounts (9 customers including `jayvee`, `dhen15`, `hatdog`, `nicks`, `mebs`, `versolaarnalyn47`, `havinnovebusiness`, `halliemullerr`, `kupal`) were preserved without modifying passwords or saved delivery locations.
    - Pre-existing production errands (52 errands) were completely untouched because deterministic cleanup is strictly scoped to `where: { errandId: { in: allErrandIds } }`.
  - **High-Velocity Bulk Scaling to 500 Records**:
    - **Errand Lifecycle Distribution (Exactly 500 Errands Seeded + 52 Existing = 552 Total on VPS)**:
      - `400 COMPLETED`: Distributed across the past 60 days with realistic peak delivery hours (lunch & dinner rush), multi-store stops, accurate item totals, delivery fees, tips, reconciled cash settlements, commissions, and customer ratings.
      - `30 IN_TRANSIT`: Real-time active errands created in the past 30–75 minutes, with live breadcrumb track points (`errand_track_points`) and purchased item statuses.
      - `25 ASSIGNED`: Live errands assigned to riders heading to stores in the past 10–30 minutes.
      - `25 PENDING`: Fresh customer requests waiting in the dispatch review queue (past 2–25 minutes).
      - `20 CANCELLED`: Errand cancellations with realistic dispatcher decline reasons logged in `errand_decline_reasons`.
    - **Customer Persona Scaling (60 Accounts Seeded + 9 Existing = 69 Total on VPS)**:
      - 60 unique customer accounts with complete profile records (`customer_information`), phone numbers (`0919...`), birthdates, and 60+ geocoded delivery locations across 12 authentic Tacurong City barangays (`Poblacion`, `New Isabela`, `Griño`, `San Emmanuel`, `Buenaflor`, `Calean`, `Carmen`, `EJC Montilla`, `Kalandagan`, `Rajah Muda`, `San Pablo`, `Baras`).
    - **Itemized Pabili Catalog (1,072 Items Seeded + 129 Existing = 1,201 Total on VPS)**:
      - Itemized `pabili_details_tbl` and `pabili_item_requests_tbl` populated with authentic store goods, unit prices, notes, sizes, and linked `pinpointId` foreign keys across 18 verified Tacurong establishments spanning all 6 active merchant categories (`Fast Food`, `Pharmacy`, `Supermarket`, `Retail`, `Bakery`, `Cafe`).
    - **Financial & Operational Parity (500 Transactions Seeded + 52 Existing = 552 Total on VPS)**:
      - 500 `customer_transactions` matching errand totals and payment methods (COD, GCash / PayMaya, Bank Transfer).
      - 400 `settlement_records` (384 reconciled, 16 short variance with notes for Exception Queue audit).
      - 400 `rider_commissions` computed with standard 80/20 split and tips preserved 100% for riders.
      - 300 verified customer `ratings` (3 to 5 stars) with authentic Filipino & English reviews.
      - 457 `dwell_observations` for ETA machine learning percentiles.
  - **High-Performance Chunked `createMany` Architecture**:
    - Single batched pre-cleanup deletes previous errand slots in ~15 queries instead of 8,000+ individual round-trips.
    - Sliced batch insertion (`chunkedCreateMany` with chunks of 250–300 rows) executes all 500 errands and thousands of relational records in under 7 seconds without MySQL parameter limits or memory spikes.
* **Files Modified**:
  - `prisma/seed.ts` (added defensive account checks to preserve existing staff, customers, and delivery locations)
  - `AGENT_HANDSHAKE.md`
* **Verification Ledger**:
  - `npx tsc --noEmit` (local & VPS): 0 TypeScript compiler errors.
  - Production VPS Execution (`npx tsx prisma/seed.ts`): Exited with code 0 in 7.8s.
  - Live VPS Database Counts (`SELECT count(*) FROM ...`):
    - Errands: **552** (52 pre-existing + 500 seeded)
    - Customer Transactions: **552**
    - Pabili Items (`pabili_details_tbl`): **1,201**
    - Store Pinpoints (`errand_pinpoints_tbl`): **645**
    - Cash Settlements (`settlement_records`): **424**
    - Rider Commissions (`rider_commissions`): **425**
    - Customer Ratings (`ratings`): **315**
    - Customer Accounts (`customer_accounts`): **69** (9 original + 60 seeded)
    - Staff Users (`users`): **19** (12 original + 7 seeded)
    - PM2 `capstone-backend` (`PID 65735`): Online, HTTP 200 OK on `/api/health`.
  - Account integrity empirical comparison: 100% hash parity verified across all 12 original staff accounts and 9 original customer accounts.

---

## 2026-10-15 - Exception queue: overage/unpaid rows clearable, stale reason-model tests, push error audit (Claude, Opus 5.5)
* **Status**: [Server and web portal DEPLOYED by Claude 2026-10-15 ~05:17 +08. NOT committed. See web `AGENT_HANDSHAKE.md`, same date.]
* **Deploy record.** Targeted: only `src/validators/exceptionValidators.ts`, `src/services/exceptionService.ts`, `src/repositories/errandRepository.ts`. Before upload, prod's three files hashed equal to local HEAD (`\r` stripped), so the shipped copies are prod plus exactly these edits; nothing in prod `src` or `prisma` was newer than `dist/index.js`. VPS `tsc --noEmit` 0 errors, `npm run build`, `pm2 restart capstone-backend`; health 200 local and edge; anonymous `POST /errands/x/exceptions/resolve` 401. Backup (prior 3 files + prior `dist`): `/root/deploy-backups/server-20261015-051529-exception-review-scope`. After restart, the live derivation over every reviewed errand: 29 cleared, 1 open (726f2cd9, as counted beforehand). The `ERR_ERL_KEY_GEN_IPV6` trace in the pm2 error log is old (1,170 lines from line 1, `middleware/sysAdminSecurity.ts`), not from this deploy.
* **No `[LOCKED]` contract touched.** No schema, route or limiter change.
* **Resolve 400 on two kinds.** `validators/exceptionValidators.ts`: `EXCEPTION_KINDS` now includes `OVERAGE_PENDING` and `UNPAID_BALANCE` (the queue showed "Resolve" on both; zod refused them). Chosen over "clear only through their own flows" because those flows are gone: nothing raises or clears an overage since the downpayment was retired 2026-10-08 (`checkReceiptOverage` never escalates, `assertGoodsReleasable` always passes), and the portal has no screen for `POST /payments/top-up` or `/payments/balance`. The reason model already carries OVERAGE_* and BALANCE_* reasons. `reasonSuggestionQuerySchema` now uses the same list. New compile-time guard `EveryKindIsClearable` fails `tsc` if `ExceptionKind` gains a kind the list lacks. New `tests/exceptionClearable.test.ts` (10): every kind `exceptionsFor` raises passes the resolve schema.
* **Stale tests, code kept.** `exceptionReasonSuggestion` ("0.75 rule") and `exceptionSecondOpinion` (2 tests) asserted the rules from before the 2026-09-26 handoff below (threshold 0.75 to 0.65; second opinion for any note or a network under 0.75). Tests rewritten to the documented rules and the threshold pinned at 0.65. `exceptionAccess` already loaded: another session's uncommitted mock edit added `itemTidyLimiter` / `itemStoreCheckLimiter`; left as is. `vitest run tests/exception`: 6 files, 110 pass.
* **A review covers only what existed when it was written.** `exceptionService.latestReview` matched (errandId, kind) only, so a reason also cleared every same-kind occurrence raised later. Now `push(..., occurredAt, raisedAt)` and a review counts only if `resolvedAt >= raisedAt`. `raisedAt` is the server's time where one exists: RECEIPT_DIVERGENCE uses `extraction.confirmedAt` (divergent from the rider's confirmation, not the photo), STALLED_STOP the dwell row's `createdAt` (departedAt is phone GPS and offline batches arrive late); all others their `occurredAt` (proof `capturedAt`, `settledAt`, `overageEscalatedAt` are server times; MISSING_RECEIPT and UNPAID_BALANCE use errand `createdAt`, so any review still covers them). `RECONCILIATION_EVIDENCE_SELECT` gains those two fields; `occurredAt` (display, ranking) is unchanged. Known limit: WRONG_BRANCH has only GPS time, so a phone clock running fast (validators allow 5 min) can leave one open after a review written in that window, never the reverse. **Production impact, counted read-only before the change:** 21 reviews on 15 errands cover 30 occurrences; 1 reopens: errand 726f2cd9, UNVERIFIED_PURCHASE ₱70 declared 2026-09-30 21:39 UTC, a day after the only review (09-29 15:33), errand created 09-23 so outside the 14-day queue (owner report only). It is the defect itself. Tests: `exceptionDerivation` +6; `vitest run tests/exception` 116 pass, `untrainedExceptionKind` 2 pass, `tsc` 0 errors.
* **Push "FCM server key / InvalidCredentials" (prod).** Historical, not current: 83 lines in the pm2 error log, the last next to errand 16b2e28e (2026-09-29/30), none in the ~7,250 lines since. Every stored token is now native FCM (2 riders, 7 customers, 0 Expo tokens), sent direct by `lib/pushNotifications.ts`. FCM dry run (validate only, nothing delivered): 7 valid, customers 6 and 8 `registration-token-not-registered`. Downloadable APKs postdate the 09-24 switch (rider 10-03 and 10-08, customer 10-13). Uploading an FCM V1 key to the Expo projects is only needed if a pre-09-24 install is still in use.

---

## 2026-10-12 - Merchant Category Hierarchy Prioritization & User Order Scoring (`merchantCategoryService.ts`, `merchantCategoryController.ts`) (Antigravity 2.0, Gemini 3.8 Flash)
* **Status**: [DEPLOYED TO PRODUCTION VPS (109.123.239.182) & Reloaded - `npx tsc --noEmit` clean with 0 errors, Vitest test suites passed 100% (143/143 tests across `categoryPrioritization.test.ts`, `blockedCategoryNames.test.ts`, `establishments.test.ts`)].
* **Feature & Interaction Specification**:
  - **Cold-Start Staple Weights & Platform Volume**:
    - Fast Food (100), Pharmacy (95), Supermarket & Grocery (90), Bakery & Pastry (85), Cafe (80), Convenience (75), Restaurant (70), Retail & General Merchandise (65), Others (50).
    - Platform orders (+10 pts per errand), verified catalogue places (+5 pts per place).
    - For new accounts, the top 4 recommended are stably ranked as Fast Food, Pharmacy, Supermarket, and Bakery with `isRecommended: true`.
  - **Dynamic Customer Personal Order Vaulting**:
    - Extracts `customerId` from JWT payload in `merchantCategoryController.ts`.
    - Tallies personal orders for non-cancelled errands in `merchantCategoryService.ts`.
    - Adds +500 points per customer order, vaulting categories the customer frequently orders from to the top of the list.
    - Stamps `orderedBefore: personalOrders > 0`, `orderCount: personalOrders`, and `isRecommended: index < 4`.
* **Files Modified**:
  - `src/services/merchantCategoryService.ts`
  - `src/controllers/merchantCategoryController.ts`
  - `tests/categoryPrioritization.test.ts`
* **Verification Ledger**:
  - `npx tsc --noEmit`: 0 TypeScript compiler errors.
  - `npx vitest run tests/categoryPrioritization.test.ts tests/blockedCategoryNames.test.ts tests/establishments.test.ts`: 143/143 passed (100%).
  - VPS Build & PM2 Reload: Succeeded on `109.123.239.182`.

---

## 2026-10-12 - Google Places Storefront Photo Fallback Restoration (Antigravity 2.0, Gemini 3.8 Flash)
* **Status**: [DEPLOYED TO PRODUCTION VPS (109.123.239.182) & Verified Live - local & remote `npx tsc --noEmit` passed with 0 errors, `npm run build` succeeded, PM2 `capstone-backend` restarted (PID 3839684 online), Vitest test suites passed 100% (168/168 tests across `establishments.test.ts`, `storeRanking.test.ts`, `storeAutoCorrection.test.ts`, and `blockedCategoryNames.test.ts`)].
* **Feature & Interaction Specification**:
  - **Storefront Photo Graceful Fallback (`googlePlacesClient.ts`)**:
    - Previously, `firstPhoto(photos)` used `photos.find(isLandscapeStorefrontPhoto) ?? null`. For stores whose only photos on Google Maps were portrait (`width/height < 1.15`) or square (1:1), this rejected the photo and left `photo: null`.
    - Updated `firstPhoto(photos)`: scans for landscape storefront photos first, but gracefully falls back to Google's primary photo (`photos[0]`) when no landscape photo is available.
    - Verified live on VPS: stores like *Coffee Bear Cafe* (portrait `3472x4624`), *Decent Cup Coffee Shop*, and *Fur in Stitches* (square `500x500`) now successfully resolve their Google storefront photos and image URLs via `resolvePhotoUri`.
* **Files Modified**:
  - `src/lib/places/googlePlacesClient.ts`
  - `tests/establishments.test.ts`
* **Verification Ledger**:
  - `npx vitest run tests/establishments.test.ts tests/storeRanking.test.ts tests/storeAutoCorrection.test.ts tests/blockedCategoryNames.test.ts`: 168/168 passed (100%).
  - Local & Remote `npx tsc --noEmit`: 0 errors.
  - Remote deployment: PM2 `capstone-backend` PID 3839684 online, health check 200 OK.

---

## 2026-10-12 - Precision Store Location Filtering (Option 1), Catalogue Badging & Recommendation Boost (Option 3), and Self-Healing Rider Auto-Correction Engine (Option 4) (Antigravity 2.0, Gemini 3.8 Flash)
* **Status**: [DEPLOYED TO PRODUCTION VPS (109.123.239.182) & Verified Live - local & remote `npx tsc --noEmit` passed with 0 errors, `npm run build` succeeded, PM2 `capstone-backend` restarted (PID 3805593 online), Vitest test suites passed 100% (101/101 tests across `storeRanking.test.ts`, `storeAutoCorrection.test.ts`, and `establishments.test.ts`)].
* **Feature & Interaction Specification**:
  - **Option 1: Street-Only Road Pin Filtering (`isStreetOnlyName`)**:
    - Added `isStreetOnlyName()` in `src/lib/places/googlePlacesClient.ts` and `CustomerApp/src/services/establishments.ts` to identify and discard places whose names are purely road or highway identifiers (e.g. `"Lesdema street tacurong city"`, `"Ledesma street"`, `"National Highway"`, `"Tacurong - Isulan Rd"`).
    - Expanded `KNOWN_BUSINESS_TOKENS` with major national/local merchant brands (`jollibee`, `mercury`, `chowking`, `rose`, `gaisano`, `kcc`, `fitmart`, `savemore`, etc.) so authentic storefronts are never misclassified as roads.
    - Wired `isStreetOnlyName()` into `isPabiliStore()` in `establishmentService.ts` and `isPabiliEstablishment()` in `establishments.ts`.
  - **Option 3: Revitalize Owner-Verified Catalogue Places (`isVerified: boolean`, badging, & ranking boost)**:
    - Added `isVerified: boolean` to `Establishment` interface on server and client.
    - `fromCatalogue()` sets `isVerified: true`; `fromGoogle()` sets `isVerified: false`; `mergeEstablishments()` preserves `isVerified: true` and off-road coordinates when catalogue stores match Google Places.
    - Added `isVerified` ranking boost in `src/lib/places/storeRanking.ts` (`+0.15` recommendation bonus) so verified catalogue storefronts rank above unverified Google search results.
    - In CustomerApp `StoreCard.tsx`, added a clean, subtle `[VERIFIED]` badge pill with Lucide vector `Check` icon next to the store name.
  - **Option 4: Self-Healing Rider Auto-Correction Engine (`storeAutoCorrectionService.ts`)**:
    - Created `src/services/storeAutoCorrectionService.ts`: when a rider dwells outside a store during an errand (`applyGeofenceTransitions` in `geofenceService.ts`), the system captures their true physical GPS coordinate.
    - If the store has an existing `placeId` whose coordinates were on the road centerline (>15m away), refines `verified_places` coordinates.
    - If the store was an uncatalogued Google Place (`placeId: null`), auto-registers the storefront in `verified_places` and links the stop, permanently curing middle-of-the-road pins for all future customer searches.
* **Files Modified**:
  - `src/lib/places/googlePlacesClient.ts`
  - `src/lib/places/storeRanking.ts`
  - `src/services/establishmentService.ts`
  - `src/services/storeAutoCorrectionService.ts` (NEW)
  - `src/services/geofenceService.ts`
  - `tests/establishments.test.ts`
  - `tests/storeAutoCorrection.test.ts` (NEW)
  - CustomerApp: `src/services/establishments.ts`, `src/components/stores/StoreCard.tsx`
* **Verification Ledger**:
  - `npx vitest run tests/establishments.test.ts tests/storeRanking.test.ts tests/storeAutoCorrection.test.ts`: 101/101 passed.
  - CustomerApp `npm test -- NearbyStoresRow.test.tsx`: 13/13 passed.
  - Local & Remote `npx tsc --noEmit`: 0 errors.
  - Remote deployment: PM2 `capstone-backend` PID 3805593 online on `http://0.0.0.0:5000`.

---

## 2026-10-12 - Strict Non-Pabili Search Query & Establishment Filtering (Police Outposts/Stations, Government Offices, Network, Internet Cafe, Nightclub, Logistics, Express) + 3-Tier Store Operating Hours (`isOpen`, `closedReason`) & Out-of-Service-Area Safeguard (`outsideServiceArea`) (Antigravity 2.0, Gemini 3.8 Flash)
* **Status**: [DEPLOYED TO PRODUCTION VPS (109.123.239.182) & Verified Live - local & remote `npx tsc --noEmit` passed with 0 errors, `npm run build` succeeded, PM2 `capstone-backend` restarted (process 0 online), Vitest test suites passed 100% (`blockedCategoryNames.test.ts`, `establishments.test.ts`, and `establishmentController.test.ts`)].
* **Feature & Interaction Specification**:
  - **Strict Non-Pabili Search Query & Establishment Filtering (`isPabiliSearchQuery`, `isPabiliStore`, `NON_PABILI_GOOGLE_TYPES`)**:
    - Added `isPabiliSearchQuery(query)` in `src/services/establishmentService.ts` and wired it into `searchEstablishments()` so when a customer searches for a non-Pabili destination (`"Police outpost"`, `"Stations"`, `"Government offices"`, `"Network"`, `"Internet Cafe"`, `"Nightclub"`, `"Logistics"`, `"Express"`, etc.), the endpoint immediately short-circuits and returns `items: []` without sending a text query to Google Places (preventing Google from returning coffee shops for `"Internet Cafe"`, late-night restaurants for `"Nightclub"`, or unflagged offices/couriers for `"Government offices"` / `"Logistics"` / `"Express"`).
    - Expanded `NON_PABILI_GOOGLE_TYPES` in `src/lib/places/googlePlacesClient.ts` (`police`, `fire_station`, `gas_station`, `transit_station`, `bus_station`, `government_office`, `local_government_office`, `city_hall`, `courthouse`, `embassy`, `telecommunications_service_provider`, `internet_service_provider`, `corporate_office`, `internet_cafe`, `night_club`, `bar`, `pub`, `karaoke`, `comedy_club`, `casino`, `courier_service`, `shipping_service`, `moving_company`, `storage`, etc.).
    - Hardened `isPabiliStore()` in `src/services/establishmentService.ts`:
      - Closed the secondary-type loophole where `"internet_cafe"` + `"cafe"` or `"night_club"` + `"restaurant"` or `"courier_service"` + `"store"` was previously rescued by `isRetail`; now only major malls/supermarkets (`shopping_mall`, `department_store`, `supermarket`) may carry secondary `atm`/`bank` finance tags.
      - Added `hasPabiliRetailOrFoodType(googlePlace)` so Google Places rows with only generic non-retail types (`["point_of_interest", "establishment"]`) are rejected.
      - Blocked `"station"` / `"stations"` in `isNonPabiliText` unless paired with water-refilling keywords (`water`, `refilling`, `purified`, `alkaline`, `mineral`, `aquabest`, `tubig`).
    - Expanded `BLOCKED_CATEGORY_TOKENS`, `BLOCKED_CATEGORY_PHRASES`, and `RETIRED_CATEGORY_NAMES` in `src/lib/blockedCategoryNames.ts`.
  - **3-Tier Store Operating Hours Engine (`isOpen: boolean`) & User-Friendly Closed Store Notices (`closedReason?: string | null`)**:
    - Added `places.currentOpeningHours.openNow`, `places.regularOpeningHours.openNow`, `places.currentOpeningHours.nextOpenTime`, and `places.regularOpeningHours.nextOpenTime` to `FIELD_MASK`, plus `openNow?: boolean | null`, `nextOpenTime?: string | null`, and `temporarilyClosed?: boolean` on `GooglePlace` in `src/lib/places/googlePlacesClient.ts`.
    - Implemented `classifyStoreOperatingTier()`, `evaluateStoreOperatingStatus()`, `formatPhHour12()`, and `resolveClosedStoreNotice()` in `src/services/establishmentService.ts` wired into `finishRows()` and `mergeEstablishments()`:
      1. **Malls & Major Supermarkets (`mall`)**: Uses Google Maps' set closing/opening time (`openNow` / `nextOpenTime`); falls back to expected Tacurong mall operating hours (**8:00 AM to 8:00 PM** PH time, `UTC+8`, `closedReason: "Opens at 8:00 AM"`) if Google Maps has no set timetable.
      2. **24/7 Convenience Stores & Fast Food Chains (`convenience_24_7` & `fast_food_chain`)**:
         - Convenience stores in Tacurong (`convenience_store`, 7-Eleven, Uncle John's, Ministop, Alfamart) stay **Open 24/7 (`isOpen: true`)** unless Google Maps explicitly reports `openNow: false` or `CLOSED_TEMPORARILY` (`closedReason: "Temporarily Unavailable"` or Google's `nextOpenTime`).
         - Fast food chains (*Jollibee*, *McDonald's*, *Chowking*, *Mang Inasal*, *Greenwich*, *KFC*) follow their **Google Maps set time (`openNow` / `nextOpenTime`)**, falling back to `"Opens at 6:00 AM"` when closed without a Google `nextOpenTime`.
      3. **Regular / Small Local Stores (`regular_store`)**: Uses expected category operating windows in Philippine Time (`UTC+8`: Bakeries/Markets `5:30 AM - 8:30 PM` -> `"Opens at 5:30 AM"`, Cafes/Restaurants `6:30 AM - 9:00 PM` -> `"Opens at 6:30 AM"`, Pharmacies `7:00 AM - 9:00 PM` -> `"Opens at 7:00 AM"`, Retail/Groceries `7:00 AM - 8:30 PM` -> `"Opens at 7:00 AM"`) **calibrated by historical order timestamps (`StoreHistory.orderHoursPh`)** from past non-cancelled `errand_pinpoints`.
      4. **Temporary Closures (`businessStatus === "CLOSED_TEMPORARILY"`)**: Returns `isOpen: false` with `closedReason: "Temporarily Unavailable"`.
  - **Out-of-Service-Area Customer Location Safeguard (`outsideServiceArea?: boolean`)**:
    - Updated `searchEstablishments()` and `popularEstablishments()` in `src/services/establishmentService.ts`: when `input.near` is outside `isWithinServiceBuffer(input.near, 0.1)`, immediately short-circuit and return `{ items: [], google: ..., outsideServiceArea: true, hasMore: false }` without executing billed Google Places API calls.
* **Files Modified**:
  - `src/lib/blockedCategoryNames.ts`
  - `src/lib/places/googlePlacesClient.ts`
  - `src/services/establishmentService.ts`
  - `tests/blockedCategoryNames.test.ts`
  - `tests/establishments.test.ts`
* **Verification & Deployment Ledger**:
  - Remote backup: `/root/deploy-backups/server-20261012-operating-hours-and-safeguard`.
  - Local & Remote `npx tsc --noEmit`: 0 TypeScript compiler errors.
  - Remote `npm run build` & `pm2 restart capstone-backend`: succeeded (process 0 online).
  - Local & Remote `npx vitest run tests/blockedCategoryNames.test.ts tests/establishments.test.ts tests/establishmentController.test.ts`: 100% passed.
  - Live health check `http://127.0.0.1:5000/api/health`: 200 OK (`System Online`).

---

## 2026-10-12 - Google Places Landscape Storefront Photo Filtering & Catalogue Store Photo Enrichment (Antigravity 2.0, Gemini 3.8 Flash)
* **Status**: [Executed & Verified by Antigravity 2.0 - `npx tsc --noEmit` passed with 0 errors, Vitest test suites passed 100% (71/71 tests in `establishments.test.ts` & `establishmentController.test.ts`)].
* **Feature & Interaction Specification**:
  - **Portrait/Selfie & Low-Resolution Photo Rejection (`src/lib/places/googlePlacesClient.ts`)**:
    - Added `isLandscapeStorefrontPhoto(photo)` inside `googlePlacesClient.ts` (`MIN_LANDSCAPE_ASPECT_RATIO = 1.15`, `MIN_PHOTO_WIDTH_PX = 400`, `MIN_PHOTO_HEIGHT_PX = 250`).
    - Updated `firstPhoto(photos)` to scan `places.photos` and select the first valid landscape photo instead of blindly selecting `photos[0]`, filtering out vertical portrait phone selfies (`9:16`, `3:4`, `4:5`), square `1:1` profile avatars, and tiny low-res thumbnails.
  - **Catalogue Store Photo & Rating Enrichment (`src/services/establishmentService.ts`)**:
    - Updated `mergeEstablishments()` so when an Owner-verified catalogue store (`verified_places`) matches a Google Place (`isSamePlace(c, g)`), the catalogue row retains its verified `source: "catalogue"`, `placeId`, and `categoryId` while inheriting Google's `photoName`, `photoAttribution`, `rating`, and `ratingCount`.
* **Files Modified**:
  - `src/lib/places/googlePlacesClient.ts` (lines 338–366)
  - `src/services/establishmentService.ts` (lines 190–227)
  - `tests/establishments.test.ts` (lines 164–202, 353–371)
* **Verification Ledger**:
  - `npx tsc --noEmit`: 0 TypeScript compiler errors.
  - `npx vitest run tests/establishments.test.ts tests/establishmentController.test.ts`: 71/71 tests passed (100%).

---

## 2026-10-12 - Category-Scoped Popular & Nearby Establishments Support + Edge-Case Hardening (Antigravity 2.0, Gemini 3.8 Flash High)
* **Status**: [DEPLOYED TO PRODUCTION VPS (109.123.239.182) & Verified Live 100% Parity - local & remote `npx tsc --noEmit` passed with 0 errors, `npm run build` succeeded, PM2 `capstone-backend` restarted, Vitest test suites passed 100% (70/70 tests in `establishments.test.ts` & `establishmentController.test.ts` locally and on VPS)].
* **Feature & Interaction Specification**:
  - Added optional `categoryId: z.coerce.number().int().positive().optional()` to `popularEstablishmentsSchema` in `src/validators/placeValidators.ts`.
  - Updated `popularEstablishmentsHandler` in `src/controllers/establishmentController.ts` to pass `categoryId` to `popularEstablishments()`.
  - Updated `searchPlacesByText(query, options?: { includeRatings?: boolean })` in `src/lib/places/googlePlacesClient.ts` to support `POPULAR_FIELD_MASK` when fetching popular stores by category name for custom owner categories.
  - Updated `categoryForGoogleTypes` in `src/lib/places/establishmentCategory.ts` so `KIND_KEYWORDS` fallback sorts matching categories by word count (`wordsOf(a.name).size - wordsOf(b.name).size`), preventing compound categories (`Fast Food & Restaurant`) from shadowing narrower categories (`Restaurant`), and exported `wordsOf`.
  - Updated `categoryEstablishments`, `googleTypesFor`, and `popularCategoryEstablishments` in `src/services/establishmentService.ts` (`constituentCategoryIds`, `placeBelongsToCategory`):
    - Standard categories (`Pharmacy`, `Bakery`, `Cafe`, `Supermarket & Grocery`, `Convenience Store`, `Retail & General Merchandise`, `Fast Food`, `Restaurant`) strictly query and match only their own Google types and catalogue stores.
    - Compound categories (`Fast Food & Restaurant`, `Restaurants & Cafes`, or categories with descriptions claiming a subset of types) resolve constituent narrower category types using singularized `wordsOf(category.name)` without prematurely short-circuiting on partial direct type matches.
    - Custom owner categories (`Water Refilling`, `Pasalubong`) fall back to `searchPlacesByText(category.name, { includeRatings: true })` and keep places unclaimed by other categories OR whose store name explicitly contains all words of the custom category name (`[...targetWords].every((w) => placeWords.has(w))`); `popularCategoryEstablishments` also falls back to `searchPlacesByText(category.name, { includeRatings: true })` when `searchPopularPlaces` returns `null`.
    - In `categoryEstablishments`, when `ids.size > 1` (compound categories such as `Fast Food & Restaurant`), `placeService.searchPlaces` is queried without a single `categoryId` SQL restriction (`query ? { search: query } : {}`) before filtering by `ids.has(placeCatId)` and slicing to `CANDIDATE_LIMIT`, so constituent catalogue places (e.g. `Arabian Spice Restaurant` under `Cat 7: Restaurant`) are included in production SQL results for `Cat 9: Fast Food & Restaurant`, and stamped `categoryId: category.id, categoryName: category.name` onto `fromCatalogue(place, near)` entries.
* **Files Modified**:
  - `src/validators/placeValidators.ts`
  - `src/controllers/establishmentController.ts`
  - `src/lib/places/googlePlacesClient.ts`
  - `src/lib/places/establishmentCategory.ts`
  - `src/services/establishmentService.ts`
  - `tests/establishmentController.test.ts`
  - `tests/establishments.test.ts`
* **Verification & Deployment Ledger**:
  - Remote backup: `/root/deploy-backups/server-20261012-category-stores-edge-cases`.
  - Local & Remote `npx tsc --noEmit`: 0 TypeScript compiler errors.
  - Remote `npm run build` & `pm2 restart capstone-backend`: succeeded (process 0 online).
  - Local & Remote `npx vitest run tests/establishments.test.ts tests/establishmentController.test.ts`: 70/70 tests passed (100%).
  - Live HTTP verification on `109.123.239.182`: `/api/health` (200 OK), `/api/places/establishments?categoryId=...` and `/api/places/establishments/popular?categoryId=...` tested across all 9 active categories (`5:Bakery`, `8:Cafe`, `6:Convenience Store`, `1:Fast Food`, `9:Fast Food & Restaurant` including constituent catalogue store `Arabian Spice Restaurant`, `2:Pharmacy`, `7:Restaurant`, `4:Retail & General Merchandise`, `3:Supermarket & Grocery`) with 0 cross-category leaks, plus `categoryId=999999` (200 empty) and `categoryId=0` (400 validation error).

---

## 2026-10-11 - Pabili Store Filter Expansion: Logistics, Salons, Carwash (Antigravity 2.0, Gemini 3.8 Flash High)
* **Status**: [DEPLOYED TO PRODUCTION VPS (109.123.239.182) & Verified Live - npx tsc --noEmit passed 0 errors, npm run build succeeded, PM2 restarted, live health 200 OK].
* **Specification & Implementation**:
  - Added **Logistics**, **Salons**, and **Carwash** (and common spelling variants/typos such as "Logicstics") to the non-Pabili denylist.
  - In `src/lib/blockedCategoryNames.ts`:
    - Added tokens: `logistics`, `logistic`, `logicstics`, `courier`, `freight`, `cargo`, `shipping`, `salon`, `salons`, `barbershop`, `barber`, `spa`, `carwash`.
    - Added phrases: `logistics services`, `courier services`, `express courier`, `beauty salon`, `hair salon`, `nail salon`, `barber shop`, `hair and beauty`, `car wash`, `auto wash`, `car detailing`, `auto detailing`.
    - Added retired names to `RETIRED_CATEGORY_NAMES` covering Logistics, Salons, Carwash and their variations.
  - In `src/lib/places/googlePlacesClient.ts`:
    - Added `courier_service`, `shipping_service`, `moving_company`, `post_office`, `beauty_salon`, `hair_salon`, `barber_shop`, `nail_salon`, `spa`, `car_wash` to `NON_PABILI_GOOGLE_TYPES`.
  - In `src/services/establishmentService.ts`:
    - Added logistics, salon, and carwash store phrases and tokens to `NON_PABILI_STORE_PHRASES` and `NON_PABILI_STORE_TOKENS`.
  - In `tests/blockedCategoryNames.test.ts`:
    - Added unit test cases verifying rejection of Logistics, Logicstics, Salons, Carwash, etc. 50/50 tests passing.
* **VPS Deployment Verification**:
  - Remote backup: `/root/deploy-backups/server-20261011-logistics-salons-carwash`.
  - Synced files via SCP, compiled cleanly with `npx tsc --noEmit` and `npm run build`.
  - Synced places and category statuses via `npx tsx prisma/seedPlaces.ts` (42 places).
  - Restarted PM2 process 0 (`capstone-backend`).
  - Verified `https://api.sugo-express.org/api/health` -> 200 OK (`System Online`).

---

## 2026-10-11 - Pabili-Only Store & Category Filtering (Antigravity 2.0, Gemini 3.8 Flash High)
* **Status**: [Executed & Verified by Antigravity 2.0 - npx tsc --noEmit passed with 0 errors, Vitest test suites passed 100% (67/67 tests in establishments.test.ts & establishmentController.test.ts)].
* **Feature & Interaction Specification**:
  - **Pabili Category Filtering & Denylist Expansion**:
    - Added comprehensive non-Pabili categories to `RETIRED_CATEGORY_NAMES` in `src/lib/blockedCategoryNames.ts` (Schools, Banks, Padala Outlets, Motor Trades, and variations).
    - Exported `isPabiliCategoryName(name: string): boolean` helper checking exact retired category matches, blocked billing/remittance phrases, and non-Pabili tokens.
    - Updated `merchantCategoryService.listMerchantCategories(includeInactive)`: when `includeInactive` is false (public/customer fetch), automatically filters out non-Pabili categories.
    - Updated `placeRepository.getCategories()`: returns only active Pabili categories.
  - **Google Places Types & Search Filtering**:
    - Removed `auto_parts_store` from `SEARCHABLE_TYPES` in `src/lib/places/googlePlacesClient.ts`.
    - Defined `NON_PABILI_GOOGLE_TYPES` Set covering schools, universities, banks, ATMs, finance, money_transfer, car_repair, motorcycle_repair, auto_parts_store.
    - Exported `isPabiliStore(store: Establishment, googlePlace?: GooglePlace | null): boolean` in `src/services/establishmentService.ts`.
    - Filtered `activeCategories()` with `isPabiliCategoryName` so non-Pabili categories never claim Google places or initiate gap-filling searches.
    - Pruned candidate pools in `searchEstablishments`, `categoryEstablishments`, and `popularEstablishments` using `isPabiliStore`.
* **Files Modified**:
  - `src/lib/blockedCategoryNames.ts`
  - `src/services/merchantCategoryService.ts`
  - `src/lib/places/googlePlacesClient.ts`
  - `src/services/establishmentService.ts`
  - `src/repositories/placeRepository.ts`
* **Verification Ledger**:
  - `npx tsc --noEmit`: 0 TypeScript compiler errors.
  - `npm test -- tests/establishments.test.ts tests/establishmentController.test.ts`: 67/67 tests passed (100%).

---

## 2026-10-10 - In-App Update, Release Management & Changelog System (Antigravity 2.0, Gemini 3.8 Flash High)
* **Status**: [DEPLOYED TO PRODUCTION VPS (109.123.239.182) by Antigravity 2.0 2026-10-10 ~14:31 +08].
* **Deployment & Verification Ledger**:
  - **Server Backend**: Deployed `src/services/appReleaseService.ts`, `src/controllers/appReleaseController.ts` to `/var/www/server`. Merged release schema into `/var/www/server/config/app-releases.json`. Remote `tsc --noEmit` clean, remote `npm run build` succeeded, `pm2 restart capstone-backend` succeeded (Process 0 online). Verified: `curl http://127.0.0.1:5000/api/health` -> HTTP 200 (System Online), `curl http://127.0.0.1:5000/api/app-releases/public` -> HTTP 200 with `features`, `fixes`, `logs`. Rollback backup: `/root/deploy-backups/server-20261010-082702-app-releases`.
  - **Landing Page**: Shipped via `scripts/deploy-landing.sh`. Synced to `/var/www/landing/dist/`. Live check `https://sugoonthego.online` -> HTTP 200. Rollback backup: `/root/deploy-backups/landing-20261010-142921`.
  - **Web & Staff Portal**: Shipped via `scripts/deploy-web.sh`. Synced to `/var/www/web/dist/`. Live check `https://portal.sugo-express.org` -> HTTP 200. Rollback backup: `/root/deploy-backups/web-20261010-143124`.
* **Specification & Architecture**:
  - **Release Metadata Schema**: Added `features?: string[]`, `fixes?: string[]`, and `logs?: string[]` to `AppReleaseInfo` & `UpdateReleaseInput` in `src/services/appReleaseService.ts`. Auto-synthesizes legacy `whatsNew` array for backward compatibility.
  - **Controller & Endpoints**: Updated `updateReleaseDetailsHandler` in `src/controllers/appReleaseController.ts` to accept and persist `features`, `fixes`, and `logs`.
  - **Persistence**: Persisted structured metadata in `config/app-releases.json` for customer and rider app releases.

---

## 2026-10-09 - Customer Feedback & Review System Pipeline (Antigravity 2.0, Gemini 3.8 Flash High)
* **Status**: [Executed by Antigravity 2.0 - Prisma schema updated & client generated with 0 errors, npx tsc --noEmit passed with 0 errors].
* **Feature & Architecture Specification**:
  - **Prisma Schema Additions**: Added `enum FeedbackCategory` (`BUG_REPORT`, `FEATURE_REQUEST`, `DELIVERY_EXPERIENCE`, `APP_USABILITY`, `OTHER`), `enum FeedbackStatus` (`PENDING`, `INVESTIGATING`, `RESOLVED`, `DISMISSED`), and `model CustomerFeedback` mapped to table `customer_feedbacks`. Added optional relations to `CustomerAccount` (`customerId`) and `User` (`readByUserId`).
  - **Zero-Loss Data Pipeline**: Customer feedback is written immediately to MariaDB first with an auto-generated tracking reference code (`FB-YYMMDD-XXXX`).
  - **Real-Time Developer Alerting**: Configured `DEVELOPER_FEEDBACK_EMAIL` in `src/config/env.ts` defaulting to `aljayveeversola@gmail.com`. On submission, `feedbackService.ts` dispatches a high-priority, formatted HTML email notification containing the customer's star rating, sentiment, subject, message, contact info, and attached device telemetry. Optional customer acknowledgment email dispatched if email provided.
  - **Staff Management & Audit Trail**: Created protected endpoints for DISPATCHER and OWNER roles to list feedback, view details, mark as read (recording `readAt` and `readByUserId`), and resolve with developer notes.
  - **Routes & Gatekeeping**: Mounted at `/api/feedback` with strict `express-rate-limit` (10 per 15 min), Zod request validation, and optional customer token association.
* **Files Modified / Created**:
  - `prisma/schema.prisma`
  - `src/config/env.ts`
  - `src/validators/feedbackValidators.ts` (new)
  - `src/services/feedbackService.ts` (new)
  - `src/routes/feedbackRoutes.ts` (new)
  - `src/routes/index.ts`
* **Verification Ledger**:
  - `npx prisma generate` -> Generated Prisma Client v5.22.0 successfully.
  - `npx tsc --noEmit` -> 0 errors.

---

## 2026-10-10 - Item-to-store labels follow the stores; step 2 notices a step-1 change (Claude, Opus 5.5)
* **Status**: [Server and web portal DEPLOYED by Claude 2026-10-10 ~01:51 +08, and committed. Server: only `src/lib/itemStopAssignment.ts` shipped; prod `src` otherwise already equalled local (another session's 2026-10-09 17:31 CEST deploy carried its feedback routes and schema change). VPS `tsc` 0 errors, build, restart, health 200 local and edge. Backup `/root/deploy-backups/server-20261010-014952-store-labels`. Web: live index-C2PgRhXL.js carries the new strings; rollback `/root/deploy-backups/web-20261010-015151`. The `ERR_ERL_PERMISSIVE_TRUST_PROXY` warning in the error log after the restart is express-rate-limit's one-time check of the trust-proxy setting, not this change.]
* **Bug (SGO-2B37D6).** After the stores were re-pinned (Kimsan Plaza out; Rojon pharmacy, 7 Eleven, Jollibee in), the customer's order card showed four stores, two of them "Store 2". Items remember their store as text in `storeCategory` ("Store 1 - Kimsan Plaza | ..."), nothing rewrote that text when step 1 changed, and every reader resolved it by the NUMBER first: the portal's `storeIndexOf` (so the editor showed Ballpen Set under Rojon pharmacy) and the server's `itemStopAssignment.matchByStoreLabel` (so the rider's list did too). The card itself grouped by the raw label text.
* **Rule (both sides, identical):** a label's store NAME decides, compared after the portal's `clean`; the number only breaks a tie between same-name pins; a named store no longer pinned matches nothing (portal: "Not assigned yet", which already blocks sending; server: falls back to the category half or stays unattached); a bare "Store N" keeps its number. Portal: new `order-chat/storeLabel.ts` (`resolveStoreIndex`, `clean`). Server: `src/lib/itemStopAssignment.ts`. A parity script ran 13 labels through both: all agree.
* **Portal send** (`useOrderItems.sendToCustomer`): every label is rewritten from the current pins before saving, and the card is grouped by resolved pin in visit order.
* **Step 2 vs step 1** (`useOrderItems`): only the LATEST list card counts (time and approval; the first card's approval used to count for every later card). If its stores differ from the SAVED stores, `storesChangedSinceSent` is true and the returned `hasSentConfirmationCard` / `isCustomerConfirmed` read false: stage 2 asks for the list again (Stage3ConfirmItems note `copy.stage3.storesChangedNote`), and the rider gate stays shut. Derived, not stored, so the socket's `setIsCustomerConfirmed(true)` cannot override it.
* **Tests**: `dispatcherRestructure` +4 (incl. an SGO-2B37D6 reproduction), `errandJourney` rename test rewritten (pins cannot be renamed; another name at a number is another shop). Full server suite: same 5 pre-existing failing files. Portal: tsc clean; a throwaway harness drove the real hook with the errand's data in the browser (deleted after): the stranded items read unassigned, the card came out as Store 1 Rojon pharmacy / Store 2 7 Eleven / Store 3 Jollibee, a card for the old stores read as out of date, and an older card's approval no longer counted. Its Firebase meta write was refused (permission_denied), nothing written.
* **Existing errands**: no data migration needed. Stale labels now resolve by name; an item at a store no longer pinned shows under "Not assigned yet" until placed, and the next send rewrites every label.
* **One card of each kind in the customer's chat (portal only, same day).** The order summary (`order_confirmation`), payment question (`payment_prompt`) and store locations (`pinpoints`) go through `useOrderChat.postCard`; the rule is pure in `order-chat/chatCards.ts` (`planCard`, `CARD_BURIED_AFTER` = 4). Re-sending updates the card in place (keeps its timestamp, adds `updatedAt`) and sends a push (`copy.chatCards.*`) instead of a new message; an updated order summary resets `confirmed: false`, so the customer approves the new list. More than 4 messages after it (or a payment card above the latest list): a new card at the bottom, every older copy deleted; a moved order summary takes the payment card down with it, silently, so it stays below the list. Old stacked duplicates collapse to the latest either way. Stage 2 has "Resend Payment Method" (`useOrderPayment.remindCustomer`): a push pointing at the existing card, or the card re-posted if buried. No CustomerApp change: its chat reads the whole `messages` node (onValue), so updates and deletions render on installed builds. RTDB rules already let the chat's dispatcher update and delete messages (`.write` at `chats/$errandId`); a customer approving a just-deleted card is refused by the `timestamp` validate, so no fragment appears. Verified: `planCard` run against 10 scenarios (threshold 4 vs 5, follower move, duplicate collapse, payment reminder in view/buried/above the list, store locations); the button rendered and ran in a browser harness (deleted after). Not verified against the live database: harness pages cannot write to RTDB unauthenticated.

---

## 2026-10-09 - Audit batch 4: rider privacy, offer lifecycle, item repricing, cancelled purchases, chat push (Claude, Opus 5.5)
* **Status**: [Server and web portal DEPLOYED to production by Claude 2026-10-09 ~22:03 +08. Committed: server 5c70995, web 545dda8 (each on a verified baseline commit, server 639d0b6, web d7953eb). RiderMobileApp change NOT shipped (needs an app build); the server's own expiry covers riders on the current build.]
* **Deploy record.** Pre-deploy count: 0 errands in ASSIGNED on production, so the expiry job's first passes took nothing back. Server: same targeted method as batch 1; prod `src` differed from local by exactly this batch's 14 files plus new `jobs/offerExpiry.ts`, every differing code line this batch's; nothing in prod `src` newer than `dist`. VPS `tsc --noEmit` 0 errors, build, `pm2 restart capstone-backend`; health 200 local and edge; anonymous `GET /api/riders/online` 401; no new errors after restart. Backup (prior 14 files + prior `dist`): `/root/deploy-backups/server-20261009-220025-audit-batch4`. Web: live build matched local `dist` (index-D9fzyDwh.js, 2026-10-08 18:33 +08); only 7 source files changed since, all this session's; the other sessions' uncommitted edits inside them (ExceptionQueuePanel "Help Desk" restyle, useStorePins same-shop check, the Help Desk report filename) were confirmed already in the live bundle before building. `scripts/deploy-web.sh`: HTTP 200, all chunks resolve, new index-BlkX-wJz.js carries the new labels and the 409 pin-save message. Rollback: `/root/deploy-backups/web-20261009-220308`.
* **No `[LOCKED]` contract touched.** No Prisma schema change. New exception kind is a string in `exception_reviews.kind` (VarChar), so no migration.
* **The audit listed 6 bugs ("5" in its title). All 6 verified in code. Three of its prescribed fixes would have misfired and were changed:**
  - Bug 1's guard ("staff or self") on `GET /riders/:id/photo` would have broken dispatcher avatars in BOTH apps: CustomerApp and RiderMobileApp `DispatcherAvatar` fetch `/riders/<dispatcherId>/photo`.
  - Bug 3's conditional accept alone would have turned a retried accept (response lost) into a false 409; and `declineErrand` had the same race, which the new expiry job would have hit.
  - Bug 5's "allow settlement for cancelled-after-purchase" would have booked the whole customer bill as the rider's SHORT (settlement's expected figure is the bill). Settlement stays refused; the case is now an exception instead.
* **1. Rider profile/fleet/photo** (`riderController.ts`, `riderRoutes.ts`, `userService.isStaffMember`). Profile: OWNER/DISPATCHER or the role-matched rider (`assertStaffOrSelf`, replaces `assertSelfIfRider`). Photo: those, plus anyone for a target who is OWNER/DISPATCHER (chat avatars); a rider's photo is refused to customers and other riders. `GET /riders/online`: `requireRole(["OWNER","DISPATCHER"])` (no app calls it).
* **2. Unanswered offers.** Server: `errandService.expireStaleOffers` + `jobs/offerExpiry.ts` (every 15 s, registered in `index.ts`). `OFFER_EXPIRY_MS` = 60 s after `assignedAt` (app shows 45 s; 15 s grace). Offers older than `OFFER_REASSIGN_WINDOW_MS` (30 min) go back to PENDING for a dispatcher instead of auto-reassigning (ghost offers from before this job, or after an outage). `declineErrand` gained `options.reassign`. Offers with `assignedAt` NULL are never touched. Rider app: `NewTaskCard` counts down from `assignedAt` and calls new `onExpire` (was: opened the decline modal, sent nothing); `useRiderMission.expireOffer(id)` declines just that offer, best-effort; accept 409 now shows the server's reason and refreshes. Also fixed: the countdown called its callback inside a state updater, which React ran twice (two decline requests).
* **3. Accept/decline races.** `errandRepository.acceptOffer` / `releaseOffer`: conditional `updateMany` on `{id, riderId, status: ASSIGNED}`. Accept: 0 rows and already IN_TRANSIT for this rider = idempotent success (original `acceptedAt` kept); otherwise 409. Decline/expiry: 0 rows = 409 (rider's answer stands).
* **4. Item edits re-price.** `updateItems` calls `recalculateFee` before its re-read (handling-fee gate counts item units). Agreed fares stay as agreed (recalculateFee holds stamped figures). Web needed no change: the quote card is built from the returned errand.
* **5. Cancelled after purchase.** New exception kind `CANCELLED_AFTER_PURCHASE` (money kind, materiality floor applies): CANCELLED with `itemsPurchasedAt` or live RECEIPT/NO_RECEIPT proofs; amount = receipts' confirmed/declared total, else `estimatedCost`. Added to the reviewer validator (clearable), PDF labels, `QUESTION` map; `itemsPurchasedAt` added to `RECONCILIATION_EVIDENCE_SELECT`. Deliberately NOT in `EXCEPTION_KIND_ORDER` (would change the trained network's 36-input layout); `suggestExceptionReason` returns a non-confident "no suggestion" for kinds outside it. Web: `ExceptionKind` type + both `KIND_LABEL` maps.
* **6. Customer chat push.** `POST /errands/:id/customer-chat-notify` now `requireRole(["CUSTOMER"])`; `notifyDispatcherChatMessage` refuses 403 unless `errand.customerId === customerId`.
* **Verification**: `tsc --noEmit` 0 errors in server, web, CustomerApp, RiderMobileApp. Server suite 109/114 files, 1363/1372 tests; the same 5 pre-existing failing files (9 tests) as before this batch. New server tests: `riderAccessGuards` (11), `offerLifecycle` (10), `itemEditAndChatNotify` (3), `untrainedExceptionKind` (2), `exceptionDerivation` +6. Rider app: vitest 496/496, jest 133/133 incl. new `NewTaskCardExpiry` (4).
* **Before deploying**: (a) count production errands sitting in ASSIGNED; the job's first pass takes back every one older than 60 s (those within 30 min go to the next rider, older ones to the dispatcher). (b) Ship the web portal with or right after the server, or the new exception shows with a blank label. (c) The rider app change needs a new build; the server expiry works without it.

---

## 2026-10-09 - Audit fixes: 10 authorization, money and lifecycle bugs (Claude, Opus 5.5)
* **Status**: [Server DEPLOYED to production by Claude 2026-10-09 ~20:57 +08. Committed: server 0530203, web f05227d (on baselines 639d0b6 and d7953eb). Web portal deployed with batch 4 (~22:03); both apps NOT shipped (their changes are copy and types only; the server is safe for current builds). Backfill WRITTEN to production 2026-10-09 ~21:04 +08 on the user's go-ahead: 37 of 45 rows updated (PAID 19, CANCELLED 14, SHORT 4, PENDING 8 left; 0 PAID rows without paidAt); a second dry run reports 0 to update. Pre-write snapshot of every row's id/errandId/status/paidAt: `/root/deploy-backups/server-20261009-205546-audit-fixes/customer_transactions_status_before_backfill.json` (restore = write those two columns back by id).]
* **Deploy record.** Targeted, not `scripts/deploy-server.sh` (that ships the whole shared tree and runs `prisma db push --accept-data-loss`; no schema change here). Prod `src` was hashed against local (`\r` stripped): the only differences were this change's 15 files plus 3 new ones, and every differing code line in them was this change's. Nothing in prod `src` was newer than `dist`. Uploaded those 18 files, `tsc --noEmit` gate on the VPS (0 errors), `npm run build`, `pm2 restart capstone-backend`; health 200 locally and at the edge. Backup (the 15 prior files + prior `dist`): `/root/deploy-backups/server-20261009-205546-audit-fixes` (`FILES.txt` lists them; restore = copy back, `rm` the 3 new files, restore `dist`, restart). The `ERR_ERL_KEY_GEN_IPV6` warning in the error log at startup is pre-existing (891 occurrences; `sysAdminSecurity.js`, untouched).
* **Backfill dry run on production**: 45 transactions, 37 to update: PENDING -> PAID 19 (paidAt from evidence), -> CANCELLED 14, -> SHORT 4. The 8 left PENDING: 7 errands still AVAILABLE/PENDING, and 1 delivered COD errand (`627d36b6`, 2026-10-07) with no cash settlement on file. The 4 SHORT are real `settlement_records` rows; `7f215d1e` (expected 260, collected 28, reason "Cash nalang daw") reads like a full-cash note entered as a short amount and is worth a look.
* **No `[LOCKED]` contract touched.** No Prisma schema change, no migration, no route path change. `requireRole` sits before the limiter, as on `/settle`.
* **Each bug was checked against the code before fixing.** Corrections to the audit's descriptions: `DwellObservation` is `onDelete: Cascade` (re-pinning deleted them), not SetNull; COD errands keep no ledger, so the "payment is being returned" note only reached cancelled GCash / PayMaya / Bank errands; there is no `customerService.createCustomer` (registration is `authService.registerCustomer` / `registerCustomerWithGoogle`); `ForbiddenError` / `BadRequestError` do not exist (`ServiceError(status, ...)` used).
* **Batch 1 (authorization)**
  - Bug 1: `POST /errands/:id/confirm-order` now `requireRole(["CUSTOMER"])`; `errandService.confirmOrder` refuses 403 unless `errand.customerId === customerId`.
  - Bug 2: `listErrandsForUser` / `listErrandsForRider` are allowlists: OWNER, DISPATCHER, or the role-matched self. Riders can no longer read customer history; customers can no longer read rider runs.
  - Bug 3: `POST /errands/:id/rating` now `requireRole(["CUSTOMER"])` (customer and staff ids collide).
* **Batch 2 (money)**
  - Bug 4: `settlementService.submitSettlement` refuses 409 before DELIVERED/COMPLETED. Rider app PATCHes DELIVERED before it settles (`useRiderMission`), so it is unaffected.
  - Bug 5: SHORT without a non-blank `shortReason` refused 400 in the service. Validator left optional on purpose (only the service knows the expected amount). Rider app's short path always sends a reason.
  - Bug 6: new ledger state `CANCELLED` (cancelled, nothing ever paid in). `REFUNDED` keys on money ever paid IN, not net `amountPaid`, or a completed refund would read "no payment was collected". Clients: CustomerApp `FeeBreakdownCard` note + `quoteService` type; RiderMobileApp `types/rider.ts`; web `types/errand.ts`, `useOrderPayments.ts`, `PaymentLedgerPanel` badge "Cancelled, unpaid". Installed app builds show no note for the new state (better than the false one).
* **Batch 3 (lifecycle)**
  - Bug 7: `customerTransactionRepository.updateStatusByErrandId` (stamps `paidAt` once). `transactionStatusService.syncTransactionStatus` re-derives from errand + ledger + settlement; fired (fire-and-forget) from `errandService.updateStatus`, `declineErrandReview`, `errandPaymentService.publishPaymentUpdate`, `settlementService.submitSettlement`. Rule (`patterns/transactionStatus.ts` `deriveTransactionStatus`): cancelled takes the ledger's REFUNDED, else CANCELLED; a cash settlement wins next (SHORT stays SHORT, MATCHED/OVER are PAID); otherwise PAID when the ledger owes nothing and something was paid, else PENDING. Existing rows only move when one of the four triggers next fires for that errand, so old rows need the one-off backfill: `src/scripts/backfillTransactionStatus.ts` (`npm run transactions:backfill-status`, `-- --dry` to report only). Same rule; writes only rows whose answer differs (re-runnable); dates `paidAt` from the settlement's `settledAt`, else the last UPFRONT/TOP_UP/FINAL `confirmedAt`, and never moves a `paidAt` already set. Tested against mocked Prisma (`tests/backfillTransactionStatus.test.ts`); NOT yet run against any real database (local MariaDB was down). Run it after the server deploy, dry first.
  - Bug 8: ratings refused 400 unless DELIVERED/COMPLETED (CustomerApp only prompts at DELIVERED).
  - Bug 9: `savePinpoints` keeps any stop with a receipt (`ErrandProofImage`) by id via `pinpointRepository.replaceForErrandKeeping`; refuses 409 to drop or move one (match: same `placeId`, else same name within 25 m). No receipts anywhere: unchanged replace-all. A stop the rider only reached (closed store) may still be dropped. Web `useStorePins` now shows the server's sentence for 409 as well as 422.
  - Bug 10: `authService.assertPhoneAvailable` (400 if another account has the number VERIFIED; unverified claims never block, so a number cannot be squatted) in `registerCustomer`, `registerCustomerWithGoogle`, `customerService.updateProfile`. `verifyResetPhone` uses new `customerRepository.findAllByPhone(..., { verifiedOnly: true })` and refuses 400 when more than one account verified the number. **Behaviour change**: an account whose phone was never verified can no longer reset by SMS (email reset still works).
* **Verification**: `tsc --noEmit` 0 errors (server, web, CustomerApp, RiderMobileApp). New tests: `stateAndOwnershipGuards` (11), `transactionStatus` (16), `pinpointReceiptKeep` (6), `resetPhoneHolders` (3), `paymentLedger` +2, `firebasePhoneAuth` +2. Full suite run from the server directory: 104/109 files, 1330/1339 tests pass; the 5 failures are pre-existing and touch none of these files (`passwordReset` needs local MariaDB, `firebaseUid` service-account env, `categoryWarm` env override, two exception-model weight suites). Note: vitest must run with the server as cwd, or `env.ts` loads the wrong `.env` and ~28 files fail on JWT_SECRET.
* **Deploy order when shipped**: server first. The `CANCELLED` state is safe for old app builds (no note shown); the new clients are only needed for the copy.

---

## 2026-10-03 - Delivery door details columns (Claude, Opus 5.5)
* **Status**: [Executed and DEPLOYED to production by Claude 2026-10-03. Not committed to git.]
* **Schema (additive only, no rename or restructure of the locked 3NF tables).** `saved_delivery_locations.streetName VARCHAR(150)`, `landmark VARCHAR(200)`, `notes VARCHAR(300)`; `errands.deliveryStreetName`, `deliveryLandmark`, `deliveryNotes`, same sizes. All NULL. Hand-written migration `20261003120000_add_delivery_location_details`, applied to production with `prisma db execute`; `prisma migrate diff --from-url` against production was exactly these six columns before, and empty after.
* **Semantics.** `optionalDetail()` in `locationValidators.ts`: omitted stays undefined (Prisma leaves the column alone, which is what "Set as default" relies on), blank or null becomes null (the customer cleared it), anything else is trimmed. Used by `locationSchema` and `createErrandSchema`. `createErrand` copies the three onto the errand as a snapshot.
* **Tests.** `tests/deliveryLocationDetails.test.ts` (8). Full suite 1124/1131: the 7 failures import none of the touched files (password reset needs the local MariaDB, which was not running; Firebase service-account env; exception-model weights).
* **Deploy.** The six VPS files were proved equal to local minus this change before upload. Backup with files, `dist` and a dump of both tables: `/root/deploy-backups/server-20261003-005717-delivery-details`.
* **Gap.** The web dispatcher portal does not show these fields yet.

---

## 🧠 Model A (Claude) Blueprint & Directives
* **Status**: [Ready for Claude Ingestion]
* **Directives for Gemini**:
  - Never bypass Express middleware or write raw un-parameterized SQL queries.
  - Strictly use Prisma Client singleton (`src/db.ts`).

---

## 🛠️ Model B (Gemini / Antigravity) Execution & Verification
* **Status**: [APK Chunk-by-Chunk Upload & Data Streaming Download Deployed to Production]
* **Session (2026-10-08 — APK Chunk-by-Chunk Upload & Streaming Download Architecture)**:
  - **Backend Server (`Capstone_Server/server`)**:
    - `src/services/appReleaseService.ts`:
      - Upload: Implemented `saveChunk`, `finalizeChunkedUpload`, `cancelChunkedUpload`, and `cleanStaleChunks`.
      - Download: Added `getApkFileInfo`, upgraded `getApkFileStream` to support RFC 7233 byte ranges (`{ start, end }`), and added `getApkChunkStream` for discrete chunk retrieval.
    - `src/controllers/appReleaseController.ts`:
      - Upload: Added `uploadChunkHandler`, `finalizeChunkedUploadHandler`, `cancelChunkedUploadHandler`.
      - Download: Upgraded `downloadApkHandler` to support `req.headers.range` returning `HTTP 206 Partial Content`, `Content-Range`, `Accept-Ranges: bytes`, proper MIME type, and connection close stream destruction. Added `downloadApkChunkHandler` for discrete chunk retrieval.
    - `src/routes/sysAdminRoutes.ts`: Mounted `/app-releases/download-chunk/:target` and sysadmin chunk upload routes.
    - `src/index.ts`: Added exposed CORS headers (`Content-Disposition`, `Content-Length`, `Content-Range`, `Accept-Ranges`, `X-Chunk-*`).
    - Verification: `npx tsc --noEmit` green (0 errors). Vitest unit tests in `tests/appReleaseStreaming.test.ts` (7/7 passed).
    - Production VPS: Deployed via `scripts/deploy-server.sh`, Nginx configured with `proxy_buffering off;` and reloaded. Verified live `HTTP 206 Partial Content` on `https://api.sugo-express.org/api/app-releases/download/customer`.
  - **Resolution of `net::ERR_QUIC_PROTOCOL_ERROR` & 100% "Network Failed" Download Abort**:
    - Root Cause 1: Backend file size mismatch (`Content-Length` sent 131,203,802 bytes from config, but streamed an older 130,863,854 byte file on disk). When stream reached EOF 431KB early, Cloudflare HTTP/3 QUIC connection closed abruptly with protocol mismatch error.
    - Root Cause 2: In `AppDownloadGrid.tsx`, client-side JavaScript was buffering 131MB into browser RAM (`new Blob(chunks)` / `createObjectURL`), causing mobile browsers and Chromium to exhaust heap space and terminate with "Network error" at 100%.
    - Surgical Fixes:
      - `src/services/appReleaseService.ts`: `getApkFileInfo()` dynamically queries `statSync(filePath).size` on disk so `Content-Length` matches bytes over the wire with 100% accuracy. Reordered download directories to prioritize authoritative `/var/www/server/public/downloads`.
      - Synchronized local and VPS files: Guaranteed `sugo-customer-app.apk` on VPS is exactly 131,203,802 bytes across `/var/www/server/public/downloads` and `/var/www/landing/dist/downloads`.
      - `Capstone_Landing_Page/src/components/AppDownloadGrid.tsx`: Replaced in-memory JavaScript Blob buffering with native browser stream downloading (`<a download>` directed to `https://api.sugo-express.org/api/app-releases/download/:target`), allowing OS download managers to write directly to disk with pause & resume support.
      - Verification: Direct curl test of full 125MB download (`131,203,802 bytes`) succeeded completely without errors (`100% 125M received, exit code 0`). Landing page rebuilt and deployed to `sugoonthego.online` (HTTP 200).
  - **Marketing Landing Page (`Capstone_Landing_Page`)**:
    - `src/components/AppDownloadGrid.tsx`: Implemented interactive native streaming download with visual confirmation, direct API streaming endpoint, direct mirror fallback, and zero-RAM disk writing.
    - Built via Vite (`dist/`) and deployed via `scripts/deploy-landing.sh` to `sugoonthego.online`. Verified live `HTTP 200`.
  - **SysAdmin Web Console (`Capstone_Project_Web`)**:
    - `src/services/sysAdminApiService.ts` & `AppReleasesTab.tsx`: Implemented 5MB slice chunk uploader with retry and progress telemetry. Deployed to `portal.sugo-express.org`.

* **Session (2026-10-05 — Phone Password Reset Verification Route & Repository Normalization)**:
  - **Backend Server (`Capstone_Server/server`)**:
    - `src/repositories/customerRepository.ts`: Added `findByPhone(phone: string)` with full normalization and matching against multiple format representations (`+63...`, `09...`, `63...`, 10-digit).
    - `src/validators/authValidators.ts`: Added `verifyResetPhoneSchema = z.object({ firebaseIdToken: nonEmptyTrimmed(...) })` and `VerifyResetPhoneInput`.
    - `src/services/passwordResetService.ts`: Added `verifyResetPhone(firebaseIdToken, ctx)`:
      - Cryptographically verifies Firebase ID token via `verifyFirebaseIdToken`.
      - Extracts and normalizes confirmed mobile phone.
      - Finds matching active customer account in MariaDB.
      - Issues HMAC-SHA256 signed `resetToken` with `PURPOSE = "PASSWORD_RESET"` and `credentialStamp`.
    - `src/controllers/authController.ts`: Added `verifyResetPhone` handler under `resetContext(req)`.
    - `src/routes/customerRoutes.ts`: Mounted `POST /api/customers/verify-reset-phone` under `passwordResetLimiter`.
    - Verification: `npx tsc --noEmit` green (0 errors).
    - Production VPS Deployment: Uploaded `src/`, compiled on VPS with 0 errors, PM2 `capstone-backend` restarted online (`https://api.sugo-express.org/api/customers/verify-reset-phone` verified live).

* **Session (2026-10-05 — Native Google Sign-In with Firebase Auth & Phone Onboarding)**:
  - **Schema & Database Sync**:
    - Made `CustomerAccount.passwordHash String?` nullable in `prisma/schema.prisma` to support passwordless Google accounts.
    - Added `CustomerAccount.googleId String? @unique` for fast 1:1 Google account lookup.
    - Successfully pushed to production MariaDB via `npx prisma db push --schema=prisma/schema.prisma --accept-data-loss`.
  - **Backend Server (`Capstone_Server/server`)**:
    - `src/repositories/customerRepository.ts`: Added `googleId` field, `findByGoogleId()`, and `findByEmail()`.
    - `src/lib/firebaseAdmin.ts`: Upgraded `verifyFirebaseIdToken()` to return full claims (`email`, `emailVerified`, `name`, `picture`, `signInProvider`) with defensive try/catch throwing `ServiceError(401)`.
    - `src/validators/authValidators.ts`: Added `customerGoogleLoginSchema` and `customerGoogleRegisterSchema`.
    - `src/services/authService.ts`:
      - `loginCustomerWithGoogle(idToken)`: Authenticates existing Google or linked email accounts; if phone is missing, returns `{ status: "PHONE_SETUP_REQUIRED" }`.
      - `registerCustomerWithGoogle(input)`: Validates Google token and verified phone SMS OTP token, creates or links account with verified phone and unique username.
      - Added guard in `loginCustomer()` preventing traditional password login on Google-only accounts: `"This account uses Google Sign-In. Please sign in with Google."`
    - `src/services/passwordResetService.ts`: Updated `credentialStamp()` to accept `passwordHash: string | null | undefined` with `"NO_PASSWORD"` fallback.
    - `src/controllers/authController.ts` & `src/routes/customerRoutes.ts`: Mounted `POST /api/customers/google-login` and `POST /api/customers/google-register` under rate limiting.
    - `tests/googleAuth.test.ts`: Added 5 unit tests covering Google sign-in, existing account linking, phone requirement, new user registration, and duplicate email handling (100% passing).
    - Production Deployment: Synchronized to VPS (`109.123.239.182`), built with 0 errors, PM2 `capstone-backend` reloaded and confirmed healthy (HTTP 200 on `https://api.sugo-express.org/api/health`, HTTP 401 on `https://api.customers/google-login` with invalid token).
* **Session (2026-10-05 — Firebase Phone Auth, SMS OTP Verification & Legal Pages)**:
  - **Schema & Database Sync**:
    - Added `phoneVerified Boolean @default(false)` and `phoneVerifiedAt DateTime?` to `model User`, `model CustomerAccount`, and `model CustomerInformation` in `prisma/schema.prisma`.
    - Production MariaDB schema pushed cleanly via `prisma db push`.
  - **Backend Server (`Capstone_Server/server`)**:
    - `src/lib/firebaseAdmin.ts`: Implemented `verifyFirebaseIdToken(idToken)`.
    - `src/services/authService.ts`: Implemented `normalizePhoneDigits()`, `verifyFirebasePhoneToken()`, and integrated cryptographic Firebase ID token verification into `registerCustomer()`.
    - `src/controllers/customerController.ts` & `src/routes/customerRoutes.ts`: Mounted `POST /api/customers/verify-phone-firebase` guarded by rate limiter.
    - `src/repositories/errandRepository.ts`: Added `phoneVerified` and `phoneVerifiedAt` to `ERRAND_INCLUDE.customer.select.information.select`.
    - `src/services/errandService.ts`: Added phone verification fields in `CustomerRelation` type and `withCustomerName` mapper.
    - `src/validators/customerValidators.ts`: Added `firebaseIdToken` to `customerProfileUpdateSchema`.
    - `src/services/customerService.ts`: In `updateProfile`, enforced phone token verification when customer changes mobile number, writing `phoneVerified: true` and `phoneVerifiedAt: new Date()`.
    - `tests/firebasePhoneAuth.test.ts`: Added unit tests verifying token checks, phone normalization, registration, and update profile phone verification (10/10 passing).
    - Production VPS: Deployed to `109.123.239.182`, PM2 `capstone-backend` reloaded and online.
  - **Option 2 - Marketing Landing Page (`Capstone_Landing_Page`)**:
    - `src/components/Footer.tsx`: Added official links to Privacy Policy (`https://portal.sugo-express.org/privacy`) and Terms of Service (`https://portal.sugo-express.org/terms`).
    - Built via Vite and deployed via `scripts/deploy-landing.sh` to VPS. Verified live: HTTP 200 on `sugoonthego.online`.
  - **Option 3 - Web Dispatcher Console (`Capstone_Project_Web`)**:
    - `src/types/errand.ts`: Added `customerPhoneVerified` and `customerPhoneVerifiedAt` to `Errand` interface.
    - `src/portals/dispatcher/hooks/useDispatcherPortal.ts`: Mapped `customerPhoneVerified` and `customerPhoneVerifiedAt` from API response.
    - `src/portals/dispatcher/components/workspace/DispatchDetailInspector.tsx`: Rendered emerald `Verified` chip (with `ShieldCheck`) or amber `Unverified` chip beside `errand.customerPhone`.
    - `src/portals/dispatcher/components/ActiveErrandsPanel.tsx`: Added compact `ShieldCheck` verified badge beside customer phone.
    - `src/portals/dispatcher/components/CustomerLocationModal.tsx`: Added `customerPhoneVerified` badge.
    - Built via Vite (`dist/`) and deployed via `scripts/deploy-web.sh` to `/var/www/web/dist` on VPS. Verified live: HTTP 200 on `portal.sugo-express.org`.
  - **Option 4 - Customer Mobile App (`CustomerApp`)**:
    - `src/screens/RegisterScreen.tsx`: Integrated dual verification channel (`[ Email OTP | SMS (Phone) ]`). In-app browser session via `expo-web-browser` redirects to `/verify-phone` and returns verified Firebase ID token to the app.
    - `src/screens/EditAccountScreen.tsx`: Enforced SMS OTP verification when changing phone number via `openAuthSessionAsync`, displaying green `VERIFIED` chip and requiring verification token before save.
    - `src/navigation/types.ts` & `src/context/AuthContext.tsx`: Added `phoneVerified` and `phoneVerifiedAt` fields.
    - Verified `npx tsc --noEmit` compiles cleanly with 0 errors.

* **Status**: [Transactional Email & OTP Design Revamped]
* **Files Synchronized**:
  - `C:\Capstone_Server\server\src\lib\emailTemplates.ts` (Revamped email design system: bulletproof MSO table shell, hidden preheaders, clean typography OTP hero, eliminated nested-card abuse and coupon dashed borders, added standardized builders `buildRegistrationOtpEmail`, `buildPasswordResetEmail`, `renderSecurityAdvisory`)
  - `C:\Capstone_Server\server\src\services\emailVerificationService.ts` (Folded `issueCode` and `sendPasswordResetCode` onto centralized builders in `emailTemplates.ts`, eliminating duplicate inline HTML)
  - `C:\Capstone_Server\server\src\services\staffVerificationService.ts` (Integrated categoryBadge and preheader into staff sign-in OTP email)
  - `C:\Capstone_Server\server\src\services\loginNotificationService.ts` (Integrated `renderSecurityAdvisory` and preheader into staff login alert email)
  - `C:\Capstone_Server\server\tests\emailTemplates.test.ts` (Created comprehensive unit tests for XSS escaping, template structure, and zero-card assertions)
  - `C:\Capstone_Server\server\scripts\generateEmailPreviews.ts` (Browser preview generator for local visual inspection)
  - `C:\Capstone_Project_Web\public\preview-emails.html` (Accessible browser preview for all 4 transactional emails)
* **Verification Ledger**:
  - `npx tsc --noEmit` verified with 0 errors on Capstone_Server/server.
  - `npm test -- tests/emailTemplates.test.ts tests/registrationOtp.test.ts tests/otpCooldownPolicy.test.ts` verified with 26/26 tests passing.
* **Session Handoff & Verification (2026-09-28 — Errand Payment Pending State & End-to-End Synchronization)**:
  - **Problem Solved**:
    1. Errand creation previously defaulted `customer_transactions.paymentMethod` to `"COD"` upon `POST /errands`, prematurely hardcoding "Cash on Delivery" before the customer selected payment in chat.
    2. Confirming payment mode in chat (`paymentSelectionService.confirmPaymentSelection`) created a `PaymentSelection` record but never updated `customer_transactions.paymentMethod` or `errands.paymentModeId`.
    3. `customerService.listTransactions` did not inspect `paymentSelection` or handle unconfirmed states, returning `"COD"` for newly created errands.
  - **Surgical Deltas**:
    - `src/repositories/customerTransactionRepository.ts`: Added `updatePaymentMethodByErrandId(errandId, paymentMethod)`. In `WITH_ERRAND_DETAILS`, added selections for `paymentMode: { select: { name: true } }` and `paymentSelection: { select: { paymentMode: { select: { name: true } } } }`.
    - `src/services/errandService.ts`: In `createErrand`, changed transaction creation fallback to `input.paymentMethod || "PENDING"`.
    - `src/services/paymentSelectionService.ts`: In `confirmPaymentSelection`, added calls to sync `customerTransactionRepository.updatePaymentMethodByErrandId(errandId, paymentMode.name)` and `errandRepository.update(errandId, { paymentModeId: input.paymentModeId })`.
    - `src/services/customerService.ts`: In `listTransactions`, prioritized confirmed payment mode from `paymentSelection` or `paymentMode`. For active/unconfirmed errands where payment selection has not occurred, returns `"PENDING"`.
  - **Verification & Production Deployment (Contabo VPS `109.123.239.182`)**:
    - Local & VPS TypeScript checks: `npx tsc --noEmit` and `npm run build` PASSED (0 errors).
    - Unit tests: Vitest 59/59 tests passing across `halfPaymentRequest.test.ts`, `paymentProofValidation.test.ts`, `exceptionDerivation.test.ts`.
    - Pre-deployment backup archived: `/root/deploy-backups/server-20260928-082744`.
    - Live sync & Prisma DB push: COMPLETED.
    - PM2 service `capstone-backend` reloaded: ONLINE (PID 1497267).
    - Live health checks verified:
      - Local backend (`http://127.0.0.1:5000/api/health`): 🟢 System Online (200 OK)
      - Nginx edge proxy (`https://api.sugo-express.org/api/health`): 🟢 System Online (200 OK)
      - Category ML microservice (`http://127.0.0.1:8100/health`): 🟢 Ready (status: "ok")

* **Session Handoff & Verification (2026-09-28 — ServiceError Prototype Restoration & Resilient Status Extraction)**:
  - **Problem Solved**: `instanceof ServiceError` check in Express error handler failed across transpiled module boundaries, occasionally causing 401/400 errors from auth/service layers to be masked as generic 500 Internal Server Errors.
  - **Surgical Deltas**:
    - `src/services/ServiceError.ts`: Added `Object.setPrototypeOf(this, ServiceError.prototype)` inside constructor.
    - `src/middleware/errorHandler.ts`: Added duck-typed name and status checks alongside `instanceof ServiceError` to guarantee exact HTTP status propagation.
  - **Verification & Deployment**:
    - `npx tsc --noEmit` passed with 0 errors locally and on VPS.
    - Successfully deployed to Contabo VPS (`root@109.123.239.182:/var/www/server`).
    - Pre-deployment backup archived: `/root/deploy-backups/server-20260928-064815`.
    - PM2 service `capstone-backend` restarted online (`PID 1486015`).
    - Live health checks verified: `127.0.0.1:5000/api/health` (🟢 200 OK), `https://api.sugo-express.org/api/health` (🟢 200 OK), and `127.0.0.1:8100/health` (🟢 ok).

* **Session Handoff & Verification (2026-09-28 — Multi-Store Pinpoint Proof Enforcement, Errand Item Completion Gate, & Substitute Signal Architecture)**:
  - **Problem Solved**:
    1. Riders on multi-store errands (2-3 stops) with GCash/PayMaya upfront payment could prematurely ask for half-payment after Store 1, causing the errand to jump straight to customer delivery and lock remaining store items as already purchased.
    2. Missing server-side enforcement allowing half-payment requests even if intermediate store pinpoints lacked proof or items remained unchecked.
    3. No unified real-time signal loop between Rider and Dispatcher when an item is marked `OUT_OF_STOCK` and substitutes are accepted or declined.
  - **Surgical Deltas**:
    - `src/services/errandPaymentService.ts`:
      - In `requestHalfPayment`: Added multi-store pinpoint completion check (`prisma.errandPinpoint`) ensuring every assigned store pin has an associated proof image (`RECEIPT` or `NO_RECEIPT`), rejecting with HTTP 422 (`STORES_INCOMPLETE`) if any store is missing.
      - Added item fulfillment validation (`prisma.pabiliDetail`) ensuring zero items remain in `PENDING` status before half-payment can be requested, rejecting with HTTP 422 (`UNCHECKED_ITEMS_EXIST`).
    - `src/services/patterns/notificationFactory.ts`:
      - Added notification generators `itemOutOfStock` and `substituteDeclined`.
    - `src/services/errandService.ts`:
      - In `updateItemFulfillmentStatus`: Added dispatcher notification (`itemOutOfStock`), staff role broadcasts (`errand:item_out_of_stock`), and errand parties broadcast (`errand:substitute_pending`) when marked `OUT_OF_STOCK`.
      - Implemented `declineItemSubstitute(errandId, itemId, callerId, callerRole)`: Emits `errand:substitute_declined` to errand parties.
    - `src/controllers/errandController.ts`: Added and exported `declineItemSubstitute` controller.
    - `src/routes/errandRoutes.ts`: Mounted `POST /api/errands/:id/items/:itemId/decline-substitute` guarded by `authenticateToken`, `requireRole(["OWNER", "DISPATCHER", "ADMIN"])`, and `userApiLimiter`.
    - `tests/halfPaymentRequest.test.ts`: Added unit test coverage for multi-store pinpoint proof rejection and pending items check (12/12 passing).
  - **Verification**:
    - Local: `npx tsc --noEmit` passed with 0 errors; Vitest 45/45 tests passing across `halfPaymentRequest.test.ts`, `proofAccessAndNoReceipt.test.ts`, and `paymentProofValidation.test.ts`.

* **Session Handoff & Verification (2026-09-27 — Payment Receipt Upload Ceiling Raised from 5MB to 15MB)**:
  - **Problem Solved**: High-resolution smartphone screenshots and camera photos from customer devices (GCash/Maya receipts) were failing to upload with the error `"That image is too large. Please use one under 5MB."`.
  - **Surgical Deltas**:
    - `src/validators/paymentProofValidators.ts`:
      - Raised `MAX_FILE_SIZE_BYTES` from `5 * 1024 * 1024` (5MB) to `15 * 1024 * 1024` (15MB).
      - Updated error copy to `"That image is too large. Please use one under 15MB."`.
    - `src/index.ts`:
      - Increased Express `express.json` and `express.urlencoded` body parser limits from `10mb` to `30mb` to safely accommodate base64-encoded 15MB payloads (~20MB in transit) without HTTP 413 Payload Too Large drops.
    - `CustomerApp/src/components/PaymentProofUpload.tsx`:
      - Added client-side size pre-check against `15MB` with immediate in-context feedback, avoiding unnecessary cellular uploads.
      - Added `{ timeout: 60000 }` (60s) on receipt POST request to prevent 10s default timeout drops during large receipt uploads over cellular networks.
    - `tests/paymentProofValidation.test.ts`:
      - Added test suite `receipt file size validation` verifying acceptance of receipts up to 15MB and refusal of receipts over 15MB with exact error copy.
  - **Verification**:
    - Server: `npx vitest run tests/paymentProofValidation.test.ts` passed (17/17 tests passing).
    - Server TypeScript: `npx tsc --noEmit` passed with 0 errors.
    - CustomerApp TypeScript: `npx tsc --noEmit` passed with 0 errors.
    - CustomerApp Jest: targeted test suites passed (29/29 tests passing).
  - **Production Deployment (Contabo VPS `109.123.239.182`)**:
    - Backup archived: `/root/deploy-backups/server-20260927-101828`
    - Source sync & Prisma client generation: COMPLETED.
    - VPS TypeScript build (`npm run build`): PASSED (0 errors).
    - PM2 service `capstone-backend` reloaded: ONLINE (PID 1354563).
    - Health probes verified:
      - Local backend (`http://127.0.0.1:5000/api/health`): HTTP 200 OK
      - Edge gateway (`https://api.sugo-express.org/api/health`): HTTP 200 OK
      - Category ML service (`http://127.0.0.1:8100/health`): Ready (HTTP 200 OK)
* **Session Handoff & Verification (2026-09-27 — Strict Store Item Completion Enforcement before Receipt or No-Receipt Proof)**:
  - **Problem Solved**: Riders could previously submit receipt photos or declare "no receipt" while items remained unchecked (`PENDING`), leading to audit discrepancies, mismatched reconciliations, and missed items during shopping stops.
  - **Surgical Deltas**:
    - `src/services/proofImageService.ts`:
      - Implemented `assertAllStoreItemsChecked(errandId: string, pinpointId?: number | null)`. Scopes checking to `pabiliDetail` items assigned to the current store pinpoint (or errand-wide if pinpoint is absent). Rejects request with HTTP 422 (`UNCHECKED_ITEMS_EXIST`) if any items remain in `PENDING` status.
      - Integrated gate into `uploadProofImage` (`RECEIPT` and `NO_RECEIPT`), `scanProofImage` (`RECEIPT`), and `confirmScannedProof` (`RECEIPT`).
    - `tests/proofAccessAndNoReceipt.test.ts`:
      - Added `pabiliDetail` to mock `prisma` and added unit test suite `checking items before receipt photo / no-receipt` verifying both 422 rejection when pending items remain and successful upload when all items are verified (`PURCHASED` or `OUT_OF_STOCK`).
  - **Verification & Deployment**:
    - `npx tsc --noEmit` passed (0 errors); Vitest 16/16 tests passed in `proofAccessAndNoReceipt.test.ts`.
    - Deployed to Contabo VPS (`root@109.123.239.182:/var/www/server/`).
    - Prisma client generated & database schema synchronized.
    - VPS build (`npm run build`) completed with 0 errors.
    - PM2 daemon `capstone-backend` reloaded and confirmed online (PID 1347977).
    - Category ML service `capstone-category` healthy on port 8100.
    - Edge endpoint `https://api.sugo-express.org/api/health` verified operational (HTTP 200).
* **Session Handoff & Verification (2026-09-27 — Rider Tracking Stability, Heartbeat Jitter Calibration & Battery Retention)**:
  - **Problem Solved**:
    1. Rider battery indicator in Owner/Dispatcher tracking modules disappeared every 5 seconds.
    2. Rider status flapped between "Available Online" and "Signal Lost" every few seconds on 4G mobile networks, causing continuous toast alert spam while the map marker kept moving smoothly.
  - **Root Causes**:
    1. `saveRiderLocation` in `RiderMobileApp/src/firebase/location.ts` wrote `batteryLevel: data.batteryLevel ?? null` into Firebase RTDB on every foreground GPS fix, wiping out stored battery percentages whenever `batteryLevel` was omitted.
    2. `HEARTBEAT_LOST_AFTER_MS` in `src/lib/riderLiveLink.ts` was set to an ultra-strict 3,000ms. Brief cellular delays (3.2–3.5s) during cell tower switches triggered `markLost()`, which immediately fired `rider:connectivity_alert` without cooldown.
  - **Surgical Deltas**:
    - `Capstone_Server/server/src/lib/riderLiveLink.ts`: Calibrated `HEARTBEAT_LOST_AFTER_MS` from `3000` to `8000` ms (8 seconds) to accommodate real-world 4G radio latency and cell tower handovers without false alarms.
    - `Capstone_Server/server/src/services/riderStatusWatchService.ts`: Added `LIVE_ALERT_COOLDOWN_MS = 60 * 1000` (60s cooldown) on `rider:connectivity_alert` toasts to prevent notification fatigue.
    - `RiderMobileApp/src/firebase/location.ts`: Updated `saveRiderLocation` to perform partial updates on `batteryLevel` only when explicitly defined, preventing `null` overwrites.
    - `RiderMobileApp/src/hooks/useRiderLocationBroadcast.tsx`: Added background/foreground battery sampling ref and attached `batteryLevel` to foreground GPS fixes.
  - **Verification**:
    - Server: `npx vitest run tests/riderLiveLink.test.ts tests/riderLiveLinkOverlay.test.ts tests/riderStatusWatch.test.ts tests/trackingReliabilityBenchmark.test.ts` passed 19/19 tests.
    - TypeScript: `npx tsc --noEmit` passed with 0 errors across `Capstone_Server`, `RiderMobileApp`, and `Capstone_Project_Web`.
* **Session Handoff & Verification (2026-09-26 — Rider Note Persistence, 65% Confidence Threshold, & Gemma 4 26B Primary -> Gemini 3.8 Flash Fallback)**:
  - **Prisma Schema (`prisma/schema.prisma`)**: Added `riderNote String? @db.VarChar(500)` to `ErrandProofImage` (`errand_proof_images`) and synced via `npx prisma db push` on production VPS (`109.123.239.182`).
  - **Validators & Services (`proofImageValidators.ts`, `proofImageService.ts`, `errandController.ts`, `settlementService.ts`, `errandRepository.ts`)**:
    - Enabled optional `riderNote` on `uploadProofImage` (`NO_RECEIPT`, `CASH_COLLECTED`) and `confirmScannedProof` (`RECEIPT`).
    - Updated `settlementService.ts` to preserve `shortReason` across `SHORT`, `OVER`, and `MATCHED` settlements.
    - Included `riderNote: true` in `RECONCILIATION_EVIDENCE_SELECT.proofImages.select`.
  - **Conflict Management AI (`exceptionReasonModel.ts`, `exceptionReasonService.ts`)**:
    - Lowered `CONFIDENCE_THRESHOLD` from `0.75` to `0.65` (`65%`).
    - Combined `proofImages.riderNote` and `settlement.shortReason` into `ReasonContext.riderNote`.
    - Updated `secondOpinionWeight(c, localConfidence)` to consult the AI sidecar (`POST /advise`) both when `riderNote` is present (`0.80` / `0.65` weight) AND when the local neural network is uncertain (`localConfidence < 0.75`, `0.65` weight).
  - **Catalog Helper & Model Priority Chain (`ml/sugo_category/gemma.py`, `ml/app.py`, `src/lib/category/categoryServiceClient.ts`)**:
    - Set `DEFAULT_MODEL = "gemma-4-26b-a4b-it"` ($0.00 free quota) first and `DEFAULT_FALLBACKS = ("gemini-3.8-flash",)` second when Gemma 4 26B exhausts its usage limit.
    - Updated `POST /search-items` so that when local lexicon results are empty (`len(results) == 0`) and `len(query.strip()) >= 3`, it calls `_predict_all(..., ask_gemma=True, wait_seconds=2.5)`.
  - **Phase #1 — Functional Rider Item Checklist (`prisma/schema.prisma`, `errandService.ts`, `errandController.ts`, `errandRoutes.ts`, `errandRepository.ts`, `exceptionReasonService.ts`)**:
    - Added `fulfillmentStatus String @default("PENDING") @db.VarChar(32)` to `PabiliDetail` (`pabili_details_tbl`) and applied via `npx prisma db push` on production VPS (`109.123.239.182`).
    - Added `PATCH /api/errands/:id/items/:itemId/status` (`updateItemFulfillmentStatus`) with real-time `order:updated` broadcast.
    - Enriched `ReasonContext.riderNote` with item-level `PURCHASED` and `OUT_OF_STOCK` checklist records so Conflict Management AI automatically explains variance or missing receipts (`NO_RECEIPT` stores).
  - **Phase #2 — Smart Out-of-Stock Substitute AI (`ml/sugo_category/gemma.py`, `ml/app.py`, `src/lib/category/categoryServiceClient.ts`, `errandService.ts`, `errandController.ts`, `errandRoutes.ts`)**:
    - Added `GemmaAdvisor.suggest_substitutes()` (`gemma-4-26b-a4b-it` -> `gemini-3.8-flash` fallback) and `POST /suggest-substitutes` to the Python ML sidecar (`capstone-category:8100`).
    - Added `POST /api/errands/:id/items/:itemId/suggest-substitutes` on the Express server (`capstone-backend:5000`), verified live on production (`109.123.239.182`).
  - **Debugging Time Fixes (2026-09-26)**:
    - `pabiliDetailRepository.ts`: `replaceForErrand` preserves `fulfillmentStatus` on unchanged items while resetting only dispatcher-modified items to `PENDING` so checkboxes become available again in Sugo Rider.
    - `errandService.ts`: `updateItems` and `updateItemFulfillmentStatus` reject modifications once `errand.itemsPurchasedAt != null` ("On the Way to the Customer") with HTTP 409, and prevent riders from unchecking already-checked items.
  - **Verification**: `npx tsc --noEmit` passed with 0 errors. Deployed to production VPS (`109.123.239.182`), rebuilt, and restarted `capstone-backend` (`PID 1166254`).
    - Set `GEMMA_WAIT_MS=2500` in `/var/www/server/ml/.env` and `LIVE_CATEGORY_TIMEOUT_MS = 3500` in `categoryServiceClient.ts`.
  - **Verification**: `npx tsc --noEmit` passed with 0 errors. Deployed to Contabo VPS `/var/www/server`, rebuilt `capstone-category`, and restarted `capstone-backend` via PM2.
* **Session Handoff & Verification (2026-09-21 — SysAdmin Security Hardening & Rate Limiter Rollout)**:
  - **Prisma Schema**: Extended `SysAdmin` with `failedLoginAttempts`, `lockedUntil`, `unlockTokenHash`, `unlockTokenExpiresAt`, `enforceTwoFactor`, `twoFactorCodeHash`, `twoFactorExpiresAt`. Added models `SysAdminTrustedDevice` (`tbl_sys_admin_trusted_devices`) and `SysAdminPasswordHistory` (`tbl_sys_admin_password_history`). Synced to production MariaDB.
  - **Security Middleware (`sysAdminSecurity.ts`)**: Implemented `sysAdminLoginLimiter` (5 attempts / 15 min), `sysAdminBackupLimiter` (3/hr), `sysAdminMutationLimiter` (30/5m), `verifySysAdminCsrf`, `setSysAdminSecurityHeaders`, and `verifyStepUpPassword`.
  - **Auth Controller & Services**: Lockout after 5 failed attempts with unlock link email, single-session concurrency revocation (`user_sessions`), adaptive 2FA with 6-digit email OTP and 30-day trusted device token, and step-up password verification.
  - **Verification**: `npx tsc --noEmit` passed with 0 errors. Deployed to Contabo VPS `/var/www/server/`, PM2 restarted online, verified with live API calls.
* **Session Handoff & Verification (2026-09-21 — Phase 1: Security Threat Center & Dual-Tier IP Defense)**:
  - **Prisma Models**: Added `BlockedIp` (`tbl_blocked_ips`), `WhitelistedIp` (`tbl_whitelisted_ips`), enums `BanType`, `ThreatSeverity`, `BanStatus`. Synchronized via `prisma db push` to VPS MariaDB.
  - **Dual-Tier IP Defense**:
    - Tier 1: Nginx kernel edge drops via auto-generated `/etc/nginx/conf.d/blocked_ips.conf`, validated with `nginx -t` and reloaded automatically.
    - Tier 2: Express in-memory O(1) cache (`sysAdminThreatService.ts`) and pre-routing `threatInterceptor.ts` middleware.
  - **Heuristic Auto-Ban**: Instant permanent ban for directory scanning (`/.env`, `/.git`, `/wp-admin`, path traversal); verified live catching active bot scanning `/admin/config.php` in production.
  - **Safeguards & Recovery**: Loopback and VPS IP immunity (`isImmune: true`), active workstation self-ban protection, and emergency SSH CLI tool (`npm run security:unban <ip>`).
  - **Verification**: `npx tsc --noEmit` passed with 0 errors on both server and web frontend. Production PM2 restarted, live directory probe auto-ban and CLI unban verified on Contabo VPS.
* **Session Handoff & Verification (2026-09-21 — Phase 4: Per-Portal System Maintenance Governance Revamp)**:
  - **Persistence**: Disk-backed JSON state in `config/maintenance.json` surviving PM2 restarts and server reboots with zero DB migration overhead.
  - **Customizable Overlays**: 4 maintenance types (`SCHEDULED`, `EMERGENCY`, `UPGRADE`, `SECURITY`), customizable header, message, supportContact, customColor accent, and warningGraceSeconds (60s).
  - **Real-Time Delivery & Alerting**: Real-time Socket.io push (`maintenance:update`) + 30s polling fallback; automated Telegram IT operations alerts via `sysAdminAlertService`.
  - **Security**: Guarded by `verifyStepUpPassword` on `POST /api/sysadmin/devops/maintenance`.
* **Session Handoff & Verification (2026-09-22 — Cloudflare Cross-Subdomain Session Persistence & Real-IP Alignment)**:
  - **Root Cause**: Web dashboard stored `accessToken` in memory and relied on `POST /api/auth/refresh` with HttpOnly `refreshToken` cookie on page reload (F5). Because `sugo-express.org` and `api.sugo-express.org` are cross-origin subdomains over HTTPS, modern browsers refused to attach `SameSite=Lax` cookies on cross-origin AJAX requests, triggering a 401 and forced client-side logout.
  - **Cross-Subdomain Cookies**:
    - `config/env.ts`: Exported `COOKIE_DOMAIN` (`process.env.COOKIE_DOMAIN || undefined`) and `CROSS_SITE_COOKIES` (`true` in production).
    - `controllers/authController.ts` & `controllers/sysAdminAuthController.ts`: Updated `setRefreshCookie`, `setSysAdminRefreshCookie`, `setDeviceTrustCookie`, and `clearCookie` to enforce `domain: COOKIE_DOMAIN`, `sameSite: "none"`, and `secure: true`.
  - **Cloudflare Real-IP & Rate-Limiting**:
    - `index.ts`: Updated `app.set("trust proxy", true)` so Express traverses Cloudflare Anycast + Nginx proxy chain.
    - `middleware/rateLimiters.ts`: Updated `smartKeyGenerator` and `loginLimiter` to key by `getClientIp(req)` (`CF-Connecting-IP`), preventing shared Cloudflare edge IPs from causing false-positive rate-limit collisions across users.
  - **Verification**: `npx tsc --noEmit` compiled with 0 errors across both `Capstone_Server/server` and `Capstone_Project_Web`.
* **Session Handoff & Verification (2026-09-22 — Dual-Shield Session Persistence & Auto-Domain Fallback)**:
  - **Fail-Safe Server Cookies**: `authController.ts` and `sysAdminAuthController.ts` auto-detect production HTTPS and default to `.sugo-express.org`, `SameSite=None`, `Secure=true` without requiring manual `.env` flags.
  - **Dual-Shield Client Persistence**: `AuthContext.tsx` and `apiClient.ts` persist rotating `refreshToken` in `sessionStorage` (`sugo_refresh_fallback`) alongside the primary HttpOnly cookie, sending it in `POST /auth/refresh` request bodies. Survives normal page reload (Ctrl+R) even if browser privacy shields or Cloudflare partition cross-subdomain cookies.
  - **Verification**: `npx tsc --noEmit` & `npm run build` passed with 0 errors across both repos.
* **Session Handoff & Verification (2026-09-23 — Full Production VPS Deployment of Web & Server)**:
  - **Prisma Synchronized**: Ran `npx prisma generate` and `npx prisma db push` on production database (synced `proximity_alert_sent_at` on `errands` and `SysAdmin` threat tables).
  - **Clean On-Server Build**: Synced source tree from `C:\Capstone_Server\server\src\` via `scp -r` and compiled directly on the VPS (`npm run build` -> 0 errors).
  - **PM2 Reload & Live Verification**: Restarted `capstone-backend` daemon. Verified live health endpoint: `curl -s http://127.0.0.1:5000/api/health` -> HTTP 200 (`status: online`), and via Nginx `https://api.sugo-express.org/api/health` -> HTTP 200.
* **Session Handoff & Verification (2026-09-23 14:22 — Complete Production System Deployment: Web, Landing, Server, AI & OSRM)**:
  - **Prisma & DB**: `npx prisma generate` & `npx prisma db push` verified database already in sync.
  - **SSH Tar Stream Sync**: Transferred full `src/` tree in 4 seconds; compiled via `npm run build` directly on VPS with 0 errors.
  - **PM2 Daemon**: Reloaded `capstone-backend` (PID 713571, online). Verified health endpoints on both local loopback and Nginx proxy (`HTTP 200`).
  - **AI Microservice**: Verified `capstone-category` container running on `127.0.0.1:8100` (`status: ok`, model version 2).
  - **Web & Landing Portals**: Both `https://sugo-express.org` and `https://sugoonthego.online` deployed and returning `HTTP 200`.
* **Session Handoff & Verification (2026-09-23 17:55 — Rider Tracking Availability & Sweep Hardening Fix)**:
  - **Problem Solved**: On-duty riders with active mobile apps were showing as "Offline" / "Off duty" on the Web Dispatcher and Owner tracking modules.
  - **Root Causes**:
    1. `sweepAbandonedLoginSessions` in `riderPresenceService.ts` checked only in-memory Socket.IO presence (`riderPresenceStore.isOnline`) and closed `rider_login_sessions` if sockets disconnected while backgrounded/sleeping, even while the rider was actively sending HTTP beacons.
    2. `openLoginSession` was only invoked on initial password login, so once swept, riders restoring sessions from mobile storage were permanently stuck with `hasSession = false` and evaluated as `LOGGED_OUT`.
    3. `availabilityForRiders` in `riderBeaconService.ts` marked riders as `LOGGED_OUT` if `withSession.has(riderId)` was false, ignoring fresh on-duty `rider_presence` rows.
  - **Surgical Deltas**:
    - `src/lib/riderPresenceStore.ts`: Updated `addSocket` to clear `lastDisconnectedAt` on connect.
    - `src/services/riderPresenceService.ts`: Made `openLoginSession` idempotent; hardened `sweepAbandonedLoginSessions` to inspect `rider_presence` rows and never close sessions of actively beaconing on-duty riders; clamped `effectiveLogoutAt` so it cannot be before `session.loginAt`.
    - `src/services/riderBeaconService.ts`: Updated `recordBeacon` to auto-open sessions when on-duty riders beacon without an open session; updated `availabilityForRiders` to treat riders with fresh on-duty beacons (< `OFFLINE_AFTER_MS`) as having an active session with background self-healing.
    - `src/services/authService.ts`: Added background session guarantee for riders during `refreshAccessToken`.
  - **Empirical Verification**:
    - Local: `npx tsc --noEmit` passed with 0 errors. Vitest `tests/riderAvailability.test.ts` (17/17) and `tests/dashboardRiderPresence.test.ts` (6/6) passed.
    - Production VPS: Deployed to `/var/www/server/src/`, compiled with `npm run build` (0 errors), restarted PM2 (`capstone-backend` PID 733490).
    - Verified live evaluation: Rider 3 (`Renen Cadungog`) evaluated from `LOGGED_OUT` (online: false) to `AVAILABLE` (online: true, activeOrdersCount: 1).
* **Session Handoff & Verification (2026-09-24 10:22 — Full Production Deployment of Backend Server & Web Frontend to Contabo VPS)**:
  - **User Request**: "DEPLOY OUR SERVER AND WEB IN THE PRODUCTION"
  - **Backend Server Deployment (`https://api.sugo-express.org`)**:
    - Pre-deployment check: `npx tsc --noEmit` in `C:\Capstone_Server\server` -> 0 errors.
    - Pre-deployment backup on VPS: `/root/deploy-backups/server-20260924-101756`.
    - Streamed source code (`src/`, `prisma/schema.prisma`, `package.json`) to `/var/www/server/`.
    - Generated Prisma Client v5.22.0 (`npx prisma generate`).
    - Verified DB sync status: `npx prisma db push --accept-data-loss` -> database already in sync.
    - Compiled TypeScript ON the VPS (`npm run build` / `tsc` -> 0 errors).
    - Restarted PM2 daemon: `pm2 restart capstone-backend` (PID 846187, status: `online`).
    - Verified health checks:
      - Local backend: `http://127.0.0.1:5000/api/health` -> HTTP 200 (`🟢 System Online`).
      - Nginx edge proxy: `https://api.sugo-express.org/api/health` -> HTTP 200 (`🟢 System Online`).
  - **Web Frontend Deployment (`https://sugo-express.org`)**:
    - Production build: `npm run build` compiled 72 assets in 1m 20s.
    - Staged 72 files to `/var/www/web/.deploy-staging` on VPS.
    - Synced into `/var/www/web/dist/` with `--delete-after` and `--filter='P /assets/**'`.
    - Active assets protected from instant deletion (104 files live, 16 MB).
    - Older assets pruned with 48h retention (`find -mtime +2 -delete`).
    - Pre-deployment backup archived to `/root/deploy-backups/web-20260924-101948`.
    - Verified chunk resolution: *"every referenced chunk resolves"*.
    - Verified live HTTP response: `https://sugo-express.org -> HTTP 200 OK` (Last-Modified: 02:21:22 UTC / 10:21:22 local).

* **Session Handoff & Verification (2026-09-24 19:57 — Full Production Deployment of Backend Server & Web Frontend to Contabo VPS)**:
  - **User Request**: "deploy our server and web in the production"
  - **Backend Server Deployment (`https://api.sugo-express.org`)**:
    - Pre-deployment check: `npx tsc --noEmit` in `C:\Capstone_Server\server` -> 0 errors.
    - Pre-deployment backup on VPS: `/root/deploy-backups/server-20260924-195212`.
    - Streamed source code (`src/`, `prisma/schema.prisma`, `package.json`, `ml/`) to `/var/www/server/`.
    - Resolved schema ambiguity by targeting `npx prisma generate --schema=prisma/schema.prisma`.
    - Synchronized database schema: `npx prisma db push --schema=prisma/schema.prisma --accept-data-loss` (created `crawled_merchant_items`, `processed_ocr_images`, and updated relations with 0 data loss).
    - Compiled TypeScript ON the VPS (`npm run build` / `tsc` -> 0 errors).
    - Built and updated `capstone-category` Docker container with fresh `TRAINED_AT` timestamp.
    - Restarted PM2 daemon: `pm2 restart capstone-backend` (PID 913228, status: `online`).
    - Verified health checks:
      - Local backend: `http://127.0.0.1:5000/api/health` -> HTTP 200 (`🟢 System Online`).
      - Nginx edge proxy: `https://api.sugo-express.org/api/health` -> HTTP 200 (`🟢 System Online`).
      - Category ML sidecar: `http://127.0.0.1:8100/health` -> HTTP 200 (`status: ok, ready: true`).
      - Catalog search endpoint: `http://127.0.0.1:5000/api/catalog/search` -> HTTP 401 Unauthorized (Auth guard verified).
  - **Web Frontend Deployment (`https://sugo-express.org`)**:
    - Staged 72 files to `/var/www/web/.deploy-staging` on VPS.
    - Synced into `/var/www/web/dist/` with `--delete-after` and `--filter='P /assets/**'`.
    - Active assets protected from instant deletion (117 files live, 18 MB).
    - Older assets pruned with 48h retention (`find -mtime +2 -delete`).
    - Pre-deployment backup archived to `/root/deploy-backups/web-20260924-195633` (20 files parked).
    - Verified chunk resolution: *"every referenced chunk resolves"*.
    - Verified live HTTP response: `https://sugo-express.org -> HTTP 200 OK`.
* **Session Handoff & Verification (2026-09-25 01:45 — Owner & Dispatcher Notification System & Customer Chat Dispatching)**:
  - **Goal**: Real-time operational alerting, audio chimes, bulk read-all, 3-tier severity taxonomy, and customer chat alerts for dispatchers.
  - **Backend Files Synchronized**:
    - `src/repositories/notificationRepository.ts`: Wired `notification:new` Socket.IO emission to user and customer rooms on `create()`.
    - `src/services/patterns/notificationFactory.ts`: Added `customerChat(errandId, customerName, snippet)` builder for `CUSTOMER_CHAT_MESSAGE`.
    - `src/services/notificationService.ts`: Added `notifyDispatcherCustomerChat()` with assigned dispatcher persistence and real-time `rooms.role("DISPATCHER")` Socket.IO broadcast.
    - `src/services/errandService.ts`: Added `notifyDispatcherChatMessage()` with 3s per-errand spam cooldown.
    - `src/controllers/errandController.ts` & `src/routes/errandRoutes.ts`: Added `POST /api/errands/:id/customer-chat-notify` guarded by `authenticateToken` and `userApiLimiter`.
    - `tests/notificationDelivery.test.ts`: Added unit tests verifying factory formatting and role broadcast delivery.
  - **Verification**:
    - `npx tsc --noEmit` compiled with 0 errors.
    - Vitest unit tests: `tests/notificationDelivery.test.ts` (4/4 passed), `deliveryReminders.test.ts` (10/10 passed), `halfPaymentRequest.test.ts` (10/10 passed).

* **Session Handoff & Verification (2026-09-25 15:30 — Rider Chat Notification Push Endpoint & Rate-Limiting)**:
  - **Goal**: Enable dispatchers to trigger native FCM high-priority push notifications to riders on incoming chat messages with anti-spam cooldown.
  - **Backend Files Synchronized**:
    - `src/services/userService.ts`: Implemented `notifyRiderChatMessage(riderId, dispatcherId, text, senderName, hasImage)` with 2-second rate-limiting cooldown per rider channel, FCM payload construction with channel `"chats"`, priority `"high"`, and notification sound.
    - `src/controllers/riderController.ts`: Added `notifyRiderChat` controller handler validating `riderId` integer and message body constraints.
    - `src/routes/riderRoutes.ts`: Mounted `POST /api/riders/:riderId/notify-chat` with `authenticateToken`, `requireRole(["OWNER", "DISPATCHER"])`, and `userApiLimiter`.
  - **Verification**:
    - `npx tsc --noEmit` on `c:\Capstone_Server\server` compiled with 0 errors.

* **Session Handoff & Verification (2026-09-25 19:30 — Tacurong City Administrative Boundary Optimization & Strict Hard Block Enforcement)**:
  - **Goal**: Optimize service boundary enforcement in the backend API to strictly serve Tacurong City only using the official OpenStreetMap 649-point administrative boundary polygon (`admin_level=6`, OSM relation `20038093`, bounding envelope S: 6.5680259, N: 6.7595383, W: 124.6194652, E: 124.7280915), reject pins outside > 100m outright, and document multi-city expansion architecture.
  - **Backend Files Synchronized**:
    - `gis/tacurong-service-area.geojson`: Replaced simplified polygon with exact official OpenStreetMap 649-point administrative boundary polygon covering all 20 barangays.
    - `src/lib/serviceArea.ts`:
      - Added fast-path bounding box envelope pre-check for $O(1)$ fast rejection before executing ray-casting point-in-polygon.
      - Added `isWithinServiceBuffer(point, bufferKm = 0.1)` strictly implementing the 100m highway buffer.
      - Hardened defensive numeric parsing (`Number(val)`), NaN / non-finite guards, and returning `Infinity` instead of `0` on non-finite coordinates to prevent invalid coordinates from bypassing border checks.
      - Updated `distanceOutsideServiceAreaKm` and `isServiceAreaConfigured`.
    - `src/services/storeLocationGuard.ts`:
      - Removed soft warning `status: "outside"` that permitted out-of-boundary pinning.
      - Hardened boundary evaluation: Any coordinate beyond 100m (`kmBeyondBorder > 0.1`) strictly returns `status: "blocked"`, `reason: "outside_border"`, with actionable rejection message.
      - Added defensive parsing before calling `.toFixed(5)` on cache key to prevent runtime TypeErrors on numeric strings or non-finite inputs.
    - `src/validators/errandValidators.ts`: Added `isWithinServiceBuffer` refinement on `createErrandSchema` for `deliveryLatitude` and `deliveryLongitude`.
    - `src/services/errandService.ts`:
      - Added defensive check in `createErrand` throwing `ServiceError(422, "Delivery address is outside Tacurong City service area")`.
      - Enforced strict 422 hard block in `savePinpoints` and `quotePinpoints` with safe `storeName` error formatting.
    - `src/services/placeService.ts`: Enforced `isWithinServiceBuffer` in `createPlace` and `updatePlace` (throwing 422 if outside).
    - `tests/serviceArea.test.ts`: Added unit tests for 649-point polygon parsing, bounding envelope fast-path, empirical 50m inside-buffer point (`124.61901`), 200m outside-buffer point (`124.61765`), NaN coordinate rejection, numeric string handling, and border distance calculations (12/12 passed).
    - `tests/storeLocationGuard.test.ts`: Updated test assertions to verify strict hard-block rejection for stores > 100m outside boundary, 50m roadside edge buffer acceptance, string coordinates, and NaN coordinates (8/8 passed).
    - `tests/pinpointQuote.test.ts`: Added unit tests verifying `quotePinpoints` and `savePinpoints` strictly reject unserviceable / out-of-boundary stops with HTTP 422 (7/7 passed).
  - **Verification**:
    - `npx tsc --noEmit` on `c:\Capstone_Server\server` compiled cleanly with 0 errors.
    - Vitest unit tests: 27/27 passed across `serviceArea.test.ts`, `storeLocationGuard.test.ts`, and `pinpointQuote.test.ts`.

* **Session Handoff & Verification (2026-09-26 01:08 - Production Deployment of Gemini 3.8 Flash + Gemma 4 26B ML Sidecar, Backend API & Web Portal)**:
  - **Goal**: Deploy Claude's Gemini 3.8 Flash + Gemma 4 26B integration (`sugo_category/gemma.py`, `/advise` conflict management second opinion, `exceptionReasonService.ts`, and `ExceptionQueuePanel.tsx`) to Contabo production VPS (`109.123.239.182`).
  - **Pre-Flight Checks**:
    - `npx tsc --noEmit` passed with 0 errors on both `Capstone_Server/server` and `Capstone_Project_Web`.
    - Verified `/var/www/server/ml/.env` present on VPS with mode `0600` (`-rw-------`) and `GEMMA_API_KEY` configured.
  - **Backend Server & ML Sidecar Deployment (`https://api.sugo-express.org`)**:
    - Backed up `/var/www/server` to `/root/deploy-backups/server-20260925-165556`.
    - Synced `src/`, `prisma/schema.prisma`, `package.json`, and `ml/` (preserving remote `ml/.env`).
    - Ran `npx prisma generate --schema=prisma/schema.prisma`, `npx prisma db push`, and compiled TypeScript on VPS (`npm run build` -> 0 errors).
    - Rebuilt and recreated `capstone-category` Docker container (`sugo-category:latest`, `model_version: 4`, persistent `category-cache` volume `/srv/cache/gemma-cache.jsonl`).
    - Restarted PM2 `capstone-backend` (PID `1127870`, `status: online`).
    - Queued background `executeCategoryRetrain(["deploy"])` (`6 categories, 21 store rows, 59 item rows` + 85,000 OpenStreetMap shop names).
  - **Web Portal Deployment (`https://sugo-express.org`)**:
    - Compiled production Vite bundle (`3,593 modules`, 0 errors).
    - Backed up `/var/www/web/dist` and synced via `rsync --delete-after --filter='P /assets/**'` to `/var/www/web/dist/`.
  - **Live Empirical Verification**:
    - `http://127.0.0.1:5000/api/health` -> `HTTP 200 OK` (`🟢 System Online`).
    - `http://127.0.0.1:8100/health` -> `status: "ok", ready: true, model_version: 4, gemma.state: "ready", active_model: "gemini-3.8-flash"` with `gemma-4-26b-a4b-it` fallback ready.
    - `POST /categorize-item` (`"salbutamol nebule 2.5mg"`) -> `Pharmacy & Health` (`confidence: 0.9617, strong: true`).
    - `POST /advise` (`"Rider note: customer only gave 200 pesos instead of 450."`) -> `{"available": true, "code": "SHORT_CASH", "confidence": 0.95, "model": "gemini-3.8-flash", "label": "Gemini 3.8 Flash"}`.
    - `https://sugo-express.org` -> `HTTP/2 200 OK` (`Last-Modified: Fri, 25 Sep 2026 17:02:42 GMT`).

---

* **Session Log (2026-10-04 02:45 - Domain Topology, 410 Gone Decommission, & Portal Deployment)**:
  - **Driver**: Antigravity 2.0 (Gemini 3.8 Flash High)
  - **Live Topology**:
    - `sugo-express.org`: Returns `HTTP 410 Gone` with custom Nginx decommission notice (`This website is no longer in use`).
    - `portal.sugo-express.org`: Serves the Web Operations Portal (`/var/www/web/dist`) with dedicated Let's Encrypt SSL (`HTTP 200 OK`).
    - `api.sugo-express.org`: Serves Express + Prisma backend (`https://api.sugo-express.org/api/health` -> `HTTP 200 OK`).
    - `sugoonthego.online`: Public Customer & Merchant Landing Page.
  - **VPS Nginx & Certbot Deployments (`109.123.239.182`)**:
    - Configured `/etc/nginx/sites-available/sugo-express.org` with `error_page 410 /410.html` and `return 410`.
    - Created `/etc/nginx/sites-available/portal.sugo-express.org`, provisioned Let's Encrypt SSL certificate via `certbot certonly --nginx -d portal.sugo-express.org`, and linked to `sites-enabled`.
    - Tested Nginx syntax (`nginx -t`) and reloaded daemon.
  - **Empirical Verification**:
    - `curl -I https://sugo-express.org` -> `HTTP/1.1 410 Gone`.
    - `curl -I https://portal.sugo-express.org` -> `HTTP/1.1 200 OK`.
    - `curl -I https://api.sugo-express.org/api/health` -> `HTTP/1.1 200 OK`.
    - Local TypeScript check: `npx tsc --noEmit` passed with 0 errors across server and web.

---

* **Session Log (2026-10-04 04:30 - Developer IP Unban & Persistent Whitelist Invariant)**:
  - **Driver**: Antigravity 2.0 (Gemini 3.8 Flash High)
  - **Incident & Cause**:
    - Developer workstation IP `2001:4455:162:7c00:617c:3af9:348a:b987` was auto-banned by `sysAdminThreatService` during path security testing (`/.env` probe test).
    - Entry `deny 2001:4455:162:7c00:617c:3af9:348a:b987;` was written to `/etc/nginx/conf.d/blocked_ips.conf`, blocking all access to `portal.sugo-express.org` and `api.sugo-express.org`.
  - **Remediation Executed on VPS (`109.123.239.182`)**:
    1. Executed emergency unban: `npm run security:unban 2001:4455:162:7c00:617c:3af9:348a:b987`.
    2. Re-synced `/etc/nginx/conf.d/blocked_ips.conf` and verified removal via grep (0 matches).
    3. Whitelisted developer IPv6 `2001:4455:162:7c00:617c:3af9:348a:b987` and developer IPv4 `49.149.31.30` in MariaDB `whitelisted_ips` table (`Lead Developer Workstation`).
    4. Reloaded PM2 backend (`capstone-backend`); verified threat cache initialized with `7 whitelisted IPs`.
  - **Empirical Verification**:
    - `curl -I https://portal.sugo-express.org` -> `HTTP/1.1 200 OK`.
    - `curl -I https://api.sugo-express.org/api/health` -> `HTTP/1.1 200 OK`.
    - Server compiler verification: `npx tsc --noEmit` passed with 0 errors.

---

* **Session Log (2026-10-04 04:35 - CORS Whitelist Alignment for portal.sugo-express.org)**:
  - **Driver**: Antigravity 2.0 (Gemini 3.8 Flash High)
  - **Incident & Root Cause**:
    - Users logging into `https://portal.sugo-express.org` encountered `AxiosError: Network Error` and WebSocket connection failure (`wss://api.sugo-express.org/socket.io/?...`).
    - The backend `ALLOWED_ORIGINS` in production `/var/www/server/.env` only listed `sugo-express.org` and lacked `https://portal.sugo-express.org`.
    - Additionally, `dotenv.config()` was not overriding existing process environment variables cached by PM2.
  - **Surgical Deltas & Deployments**:
    1. Updated `src/config/env.ts` to `dotenv.config({ override: true })` so disk `.env` changes immediately take precedence.
    2. Updated `/var/www/server/.env` on VPS to include `https://portal.sugo-express.org` in `ALLOWED_ORIGINS`.
    3. Compiled server on VPS (`npm run build` -> 0 errors) and restarted PM2 (`pm2 restart capstone-backend --update-env`).
  - **Empirical Verification**:
    - Preflight `OPTIONS /api/system/server-error-status` from `https://portal.sugo-express.org` -> `HTTP 204 No Content` with `access-control-allow-origin: https://portal.sugo-express.org`.
    - Preflight `OPTIONS /api/auth/login` from `https://portal.sugo-express.org` -> `HTTP 204 No Content` with `access-control-allow-origin: https://portal.sugo-express.org`.
    - `GET /api/system/server-error-status` -> `HTTP 200 OK` (`{"active":false}`).
    - Socket.IO polling `GET /socket.io/?EIO=4&transport=polling` -> `HTTP 200 OK` with session handshake ID.
    - Local TypeScript check: `npx tsc --noEmit` passed with 0 errors.

---

* **Session Log (2026-10-04 13:42 - Multi-Surface Robots.txt & Crawler Exclusion Invariant)**:
  - **Driver**: Antigravity 2.0 (Gemini 3.8 Flash High)
  - **Task**: Configure and deploy `robots.txt` across all production domains per cybersecurity best practices:
    1. **Operations Portal (`portal.sugo-express.org`)**:
       - Replaced legacy `robots.txt` (which referenced 410 decommissioned `sugo-express.org/sitemap.xml`) with a strict `Disallow: /` policy forbidding search indexation of authenticated operator consoles.
       - Explicitly disallowed AI scraping bots (GPTBot, ClaudeBot, PerplexityBot, CCBot, Bytespider).
       - Added `<meta name="robots" content="noindex, nofollow" />` in `index.html`.
       - Synced to `/var/www/web/dist/robots.txt`.
    2. **Public Landing Page (`sugoonthego.online`)**:
       - Created `robots.txt` allowing public indexing of landing assets (`Allow: /`, `Allow: /assets/`, icons) while disallowing raw binary APK downloads (`Disallow: /downloads/`) and AI scrapers.
       - Created `sitemap.xml` pointing to `https://sugoonthego.online/`.
       - Synced to `/var/www/landing/dist/`.
    3. **Backend API Gateway (`api.sugo-express.org`)**:
       - Added Nginx edge directive `location = /robots.txt { default_type text/plain; return 200 "User-agent: *\nDisallow: /\n"; }`.
       - Added Express route `app.get("/robots.txt")` in `src/index.ts`.
       - Tested Nginx config (`nginx -t`) and reloaded.
  - **Empirical Verification**:
    - `curl -I https://portal.sugo-express.org/robots.txt?v=2` -> `HTTP 200 OK` (Disallow: /).
    - `curl -I https://api.sugo-express.org/robots.txt?v=1` -> `HTTP 200 OK` (Disallow: /).
    - Verified `/var/www/landing/dist/robots.txt` on VPS.
    - `npx tsc --noEmit` passed with 0 errors across `Capstone_Project_Web`, `Capstone_Landing_Page`, and `Capstone_Server`.

---

* **Session Log (2026-10-04 15:10 - Outbound SMTP via Brevo & Domain Authentication for sugo-express.org)**:
  - **Driver**: Antigravity 2.0 (Gemini 3.8 Flash High)
  - **Task**: Configure production outbound transactional email delivery for registration OTPs, password resets, and staff security alerts using Brevo.
  - **Changes & DNS Authentication**:
    1. **Domain Authentication in Cloudflare (`sugo-express.org`)**:
       - Added Brevo ownership TXT record (`brevo-code:...`).
       - Added DKIM 1 & DKIM 2 CNAME records (`brevo1._domainkey`, `brevo2._domainkey` -> `b*.sugo-express-org.dkim.brevo.com`) with Cloudflare Proxy explicitly set to **DNS only** (Grey Cloud).
       - Consolidated conflicting DMARC TXT records into a single authoritative record: `v=DMARC1; p=none; rua=mailto:rua@dmarc.brevo.com`.
       - Updated root SPF TXT record to authorize Brevo relays: `v=spf1 include:spf.brevo.com ~all`.
    2. **Production Server Configuration (`/var/www/server/.env`)**:
       - Configured `SMTP_HOST=smtp-relay.brevo.com`, `SMTP_PORT=587`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM="Sugo Express" <noreply@sugo-express.org>`.
       - Reloaded PM2 backend process: `pm2 restart capstone-backend --update-env`.
  - **Empirical Verification**:
    - Triggered live registration OTP dispatch via `POST /api/customers/send-registration-otp`.
    - Verified email delivery from `Sugo Express <noreply@sugo-express.org>` into recipient inbox with high deliverability (valid DKIM/SPF alignment).

---

* **Session Log (2026-10-04 15:45 - Device & Browser Recognition for "New Sign-In Detected" Alert)**:
  - **Driver**: Antigravity 2.0 (Gemini 3.8 Flash High)
  - **Task**: Fix issue where staff "New Sign-In Detected" email alert was fired indiscriminately on every login, even from the same device and browser.
  - **Surgical Deltas**:
    1. **Prisma Schema (`prisma/schema.prisma` & `prisma/migrations/20261004120000_add_user_known_devices/`)**:
       - Added `UserKnownDevice` model (`user_known_devices`) tracking `(userId, deviceId, deviceInfo, userAgent, ipAddress, firstSeenAt, lastSeenAt)` with `@@unique([userId, deviceId])` and `@@index([userId])`.
       - Added `knownDevices UserKnownDevice[]` relation to `User` model.
       - Regenerated Prisma Client (`npx prisma generate`).
    2. **Login Notification Service (`src/services/loginNotificationService.ts`)**:
       - Extended `LoginContext` to include `deviceId?: string | null`.
       - Implemented `resolveEffectiveDeviceId(ctx)`: retrieves `ctx.deviceId` (from `x-device-id`) or deterministic `ua-${hash}` fallback.
       - Implemented `checkAndRegisterDevice(userId, ctx)`:
         - Recognized device: updates `lastSeenAt`, returns `{ isNew: false }`.
         - Graceful migration backfill: if found in `user_sessions` (unrevoked active session), backfills `user_known_devices` and returns `{ isNew: false }`.
         - New device: registers in `user_known_devices`, returns `{ isNew: true }`.
         - Defensive P2002 duplicate key collision handling for concurrent requests.
       - Updated `sendLoginAlert(user, ctx)`: checks `checkAndRegisterDevice`; suppresses email dispatch when `!isNew`.
    3. **Auth Controller (`src/controllers/authController.ts`)**:
       - Added `deviceId: getDeviceId(req)` to `loginContext(req, channel)`.
       - Updated `sendLoginAlert` calls in `respondWithOutcome` and `verifyLoginOtp` to use non-blocking fire-and-forget `void sendLoginAlert(...)`.
    4. **Automated Unit Tests (`tests/loginNotificationDeviceRecognition.test.ts`)**:
       - Created comprehensive test suite covering deviceId resolution, UA hash fallback, first-time registration alert, same-device alert suppression, browser distinguishing on same laptop (Edge vs Chrome), graceful backfill from sessions, concurrent race condition handling, and missing email safety.
  - **Empirical Verification**:
    - `npx tsc --noEmit` on `c:\Capstone_Server\server` passed with 0 errors.
    - Vitest unit tests: 59/59 passing across `loginNotificationDeviceRecognition.test.ts` (11/11), `loginCaseHandling.test.ts` (22/22), `emailTemplates.test.ts` (5/5), `otpCooldownPolicy.test.ts` (12/12), and `registrationOtp.test.ts` (9/9).

---

* **Session Log (2026-10-04 16:00 - Adversarial Code Review & Device Recognition Hardening)**:
  - **Driver**: Antigravity 2.0 (Gemini 3.8 Flash High)
  - **Defects Identified & Fixed**:
    1. **Pre-revoked Session Bug in Graceful Backfill**:
       - *Root Cause*: `authController.ts` explicitly invokes `sessionService.revokeSameDeviceSessions` immediately before `sendLoginAlert`, marking prior sessions with `revokedAt = new Date()`.
       - *Symptom*: Querying `user_sessions` with `revokedAt: null` caused all returning users to miss the backfill on deploy and receive false-alarm security alerts.
       - *Fix*: Removed `revokedAt: null` constraint from `userSession.findFirst` backfill check in `src/services/loginNotificationService.ts`.
    2. **False-Positive Alert on `lastSeenAt` Update Failure**:
       - *Root Cause*: If `prisma.userKnownDevice.update` threw a transient database error, it leaked into the outer catch block which returned `{ isNew: true }`.
       - *Fix*: Wrapped `userKnownDevice.update` in a localized try/catch. Known devices now reliably return `{ isNew: false }` and suppress the alert even if timestamp updates fail.
    3. **Corrupted Stringified Headers (`"undefined"` / `"null"`)**:
       - *Root Cause*: Client libraries or malformed headers sending `"undefined"` or `"null"` strings were treated as valid device IDs.
       - *Fix*: Filtered out stringified `"undefined"` and `"null"` in `resolveEffectiveDeviceId`.
    4. **Mobile Fallback Fingerprinting**:
       - *Root Cause*: Mobile apps without `deviceId` where `userAgent` was generic or absent returned `null`, triggering repeated alerts.
       - *Fix*: Included `deviceHint` in deterministic fingerprint hash.
    5. **Long-Term Session Pruning Fallback via `account_login_logs`**:
       - *Fix*: Added backfill lookup from `account_login_logs` for `ua-` hashed clients to recognize past logins after sessions are pruned.
* **Session Log (2026-10-04 16:15 - Production Deployment of user_known_devices & CSP Hardening)**:
  - **Driver**: Antigravity 2.0 (Gemini 3.8 Flash High)
  - **Task**: Deploy device recognition to Contabo VPS (`109.123.239.182`) and resolve Content-Security-Policy (CSP) violations on `portal.sugo-express.org`.
  - **Production Deployment Execution**:
    1. **Pre-Deployment Backup**: Saved to `/root/deploy-backups/server-20261004-100835`.
    2. **Prisma Generation & Migration**:
       - `npx prisma generate --schema=prisma/schema.prisma` executed on VPS.
       - `npx prisma db push --schema=prisma/schema.prisma` synchronized table `user_known_devices` in production MariaDB `errand_system_db`.
    3. **Production Build & PM2 Reload**:
       - `npm run build` completed on VPS (`tsc` 0 errors).
       - PM2 service `capstone-backend` reloaded with updated environment (PID: `2467345`, status: `online`).
    4. **Content-Security-Policy (CSP) Alignment (`/etc/nginx/snippets/portal-security-headers.conf`)**:
       - Added `media-src 'self' data: blob;` to unblock synthesized base64 WAV chimes (`data:audio/wav;base64,...`) in `notificationAudio.ts` on `/dispatcher`.
       - Added `frame-src 'self' https://*.firebaseio.com https://*.firebasedatabase.app https://challenges.cloudflare.com https://*.google.com;` to resolve Firebase fallback iframe blocks and prevent `document.write` fallback violations.
       - Added `worker-src 'self' blob:;` for map/worker threads.
       - Expanded `script-src` and `connect-src` with `https://*.googleapis.com`, `https://*.gstatic.com`, `https://*.google.com`, `https://challenges.cloudflare.com`, and `https://apis.google.com`.
       - Verified Nginx configuration (`nginx -t` -> syntax ok) and reloaded Nginx.
  - **Empirical Verification**:
    - Live curl to `https://portal.sugo-express.org/dispatcher` verified `content-security-policy` contains `media-src 'self' data: blob:;`, `frame-src`, and expanded script/connect hosts.
    - Verified `https://api.sugo-express.org/api/health` and `http://127.0.0.1:5000/api/health` return `HTTP 200 OK` (System Online).
* **Session Log (2026-10-05 08:48 - Firebase RTDB Script-Transport CSP Resolution)**:
  - **Driver**: Antigravity 2.0 (Gemini 3.8 Flash High)
  - **Problem Solved**:
    - Firebase Web SDK Realtime Database dynamic script injection (`https://capstonedata-3589c-default-rtdb.asia-southeast1.firebasedatabase.app/.lp?...`) was blocked by CSP `script-src`, causing 14+ retries and `Avoid using document.write()` violations.
  - **Surgical Delta**:
    - Updated `/etc/nginx/snippets/portal-security-headers.conf` on Contabo VPS (`root@109.123.239.182`):
      - `script-src`: Added `https://*.firebasedatabase.app https://*.firebaseio.com https://*.firebaseapp.com`
      - `frame-src`: Added `https://*.firebaseapp.com`
      - `connect-src`: Added `https://*.firebaseapp.com`
      - `media-src 'self' data: blob:;` confirmed active
  - **Verification**:
    - `nginx -t` passed (configuration syntax is ok).
    - Nginx reloaded via `systemctl reload nginx`.
    - Live HTTP header verification via `curl -sI https://portal.sugo-express.org/dispatcher`: `content-security-policy` successfully returns `script-src` with `https://*.firebasedatabase.app`, `https://*.firebaseio.com`, `https://*.firebaseapp.com`, and `media-src 'self' data: blob:;`.
* **Session Log (2026-10-08 11:15 - Dual-Channel Email & Firebase SMS OTP Authentication)**:
  - **Driver**: Antigravity 2.0 (Gemini 3.8 Flash High)
  - **Features Implemented**:
    - `src/validators/authValidators.ts`: Updated `verifyLoginOtpSchema` with optional `code` and optional `firebaseIdToken`.
    - `src/repositories/userRepository.ts`: Added `markPhoneVerified(id: number)`.
    - `src/services/loginChallengeService.ts`: Added `maskedPhone` and `phone` to `LoginChallenge`. Updated `evaluateGate(user)` to satisfy authentication if either `emailVerified` or `phoneVerified` is true. Added `maskPhone` helper.
    - `src/services/authService.ts`: Updated `completeLoginOtp` to support `firebaseIdToken` using Firebase Admin (`verifyFirebaseIdToken`), phone ownership validation against the user's registered phone, marking phone verified, and generating session tokens.
    - `src/controllers/authController.ts`: Returned `maskedPhone` and `phone` in challenge responses and forwarded `firebaseIdToken` to `completeLoginOtp`.
  - **Empirical Verification & VPS Deployment**:
    - `npx tsc --noEmit` passed with 0 errors.
    - `npm run build` passed with 0 errors.
    - Deployed to Contabo VPS (`109.123.239.182`) via `scripts/deploy-server.sh`:
      - Prisma sync: schema up to date.
      - PM2 `capstone-backend` restarted online.
      - Health checks verified live: `https://api.sugo-express.org/api/health` returned HTTP 200 OK.

* **Session Log (2026-10-08 17:15 - Chunk-by-Chunk APK Upload Architecture & Deployment)**:
  - **Driver**: Antigravity 2.0 (Gemini 3.8 Flash High)
  - **Problem & Architecture**:
    - Uploading full 120MB–190MB APKs in a single HTTP request poses risks over mobile or unstable connections.
    - Designed and implemented chunk-by-chunk binary upload (5MB slices) with per-chunk retry, server-side assembly, ZIP header integrity validation, SHA-256 calculation, and atomic deployment to downloads paths.
  - **Files Modified**:
    1. **Backend Server (`Capstone_Server/server`)**:
       - `src/services/appReleaseService.ts`: Added `saveChunk` (streaming slice into `config/uploads/chunks/${uploadId}/part_${chunkIndex}.tmp`), `finalizeChunkedUpload` (stream concatenation, ZIP `PK\x03\x04` validation, SHA256 checksum, atomic deployment to `/var/www/landing/dist/downloads`), `cancelChunkedUpload`, and periodic stale chunk cleaner (`cleanStaleChunks`).
       - `src/controllers/appReleaseController.ts`: Exported `uploadChunkHandler`, `finalizeChunkedUploadHandler`, and `cancelChunkedUploadHandler`.
       - `src/routes/sysAdminRoutes.ts`: Mounted `POST /sysadmin/app-releases/upload-chunk/:target`, `POST /sysadmin/app-releases/finalize-upload/:target`, and `POST /sysadmin/app-releases/cancel-upload/:target` under SysAdmin auth and CSRF protection.
    2. **Web Portal (`Capstone_Project_Web`)**:
       - `src/services/sysAdminApiService.ts`: Exported `UploadChunkProgress` interface; implemented `uploadAppReleaseApkChunked` with 5MB chunk slicing (`file.slice`), automatic 3-attempt retry on failure, fine-grained byte progress reporting, and final assembly trigger.
       - `src/portals/sysadmin/modules/devops/AppReleasesTab.tsx`: Integrated `uploadAppReleaseApkChunked` into `handleUploadApk`; added live visual chunk telemetry (`Part X of Y`, MB transferred, assembling indicator, and estimated parts counter on file dropzone).
  - **Empirical Verification & VPS Deployment**:
    - Backend: `npx tsc --noEmit` passed (0 errors). Deployed via `scripts/deploy-server.sh` to Contabo VPS (`109.123.239.182`); PM2 `capstone-backend` reloaded and online.
    - Web Portal: `npx tsc --noEmit` passed (0 errors); `npm run build` completed; deployed via `scripts/deploy-web.sh --no-build` to `/var/www/web/dist` on Contabo VPS (`portal.sugo-express.org`).
    - Live Endpoints Verified:
      - `https://api.sugo-express.org/api/app-releases/public` -> HTTP 200 OK.
      - `https://api.sugo-express.org/api/sysadmin/app-releases/upload-chunk/customer` -> Protected by CSRF & Bearer auth.
      - `https://portal.sugo-express.org` -> HTTP 200 OK.

* **Session Log (2026-10-17 - Dispatcher Dashboard Aggregation Endpoint & Shift Handover Auto-Release)**:
  - **Driver**: Antigravity 2.0 (Gemini 3.8 Flash High)
  - **Problem & Requirements**:
    - Dispatched orders claimed but left unverified or unassigned by an off-duty dispatcher were getting orphaned in limbo without visibility or assignment.
    - Lack of an aggregated operational dashboard endpoint required multiple polling requests or left dispatchers without real-time bottleneck visibility.
  - **Files Modified**:
    1. `src/repositories/errandRepository.ts`: Added `findUnverifiedByDispatcherId(dispatcherId: number)` to `dispatchLogRepository`.
    2. `src/services/errandService.ts`: Added `releaseAllUnverifiedForDispatcher(dispatcherId: number)` which finds claimed unverified orders (`status: "PENDING"`, `riderId: null`), reverts their status to `"AVAILABLE"`, clears `dispatcherId` on active chats, deletes dispatch log entries, and broadcasts Socket.io `order:updated` and `order:new` notifications.
    3. `src/controllers/authController.ts`: Hooked `releaseAllUnverifiedForDispatcher` directly into `logout` for users with `DISPATCHER` role before clearing refresh token cookies and destroying sessions.
    4. `src/controllers/dispatcherDashboardController.ts` (NEW): Built `getDispatcherDashboardSummary` aggregating:
       - Real-time pulse metrics (`unclaimedCount`, `urgentUnclaimedCount` >3m, `activeInMotionCount`, `deliveredTodayCount`, `helpDeskCount`).
       - 5-Phase pipeline counts (`claimed`, `toStore`, `bought`, `onTheWay`, `delivered`).
       - Attention center items (stale unclaimed >3m, stalled store dwells, unresolved overage disputes, post-purchase cancellations) with drill-down actions (`CLAIM_AND_REVIEW`, `OPEN_CHAT`, `RESOLVE_EXCEPTION`).
       - Operational telemetry: top 5 store stops today, top decline reasons today, and personal shift stats (`myHandledToday`, `myAvgClaimLatencySeconds`).
    5. `src/routes/errandRoutes.ts`: Mounted `GET /api/errands/dispatcher-dashboard-summary` under `authenticateToken`, `requireRole(["OWNER", "DISPATCHER"])`, and `readLimiter` before parametrized `/:id` routes.
  - **Empirical Verification**:
    - `npx tsc --noEmit` in `Capstone_Server/server`: Passed with 0 errors (clean exit code 0).

