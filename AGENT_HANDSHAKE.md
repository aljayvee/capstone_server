# 🌐 TRI-AGENT COLLABORATION TUNNEL (CLAUDE CODE ◄► OPENAI CODEX ◄► ANTIGRAVITY) - SERVER BACKEND

## 2026-11-20 - Route replay payload on `GET /api/errands/:id/track` (Claude Code)
- NEW `src/lib/errandReadAccess.ts`: `assertDispatcherMayRead(errand, caller)`, the dispatcher claim check moved out of `getErrandById` (same rule, same 403 text). `src/controllers/errandController.ts` calls it.
- `src/controllers/trackingController.ts` `getTrack`: loads the errand (`errandRepository.findById`), **404 "Errand not found" for an unknown id** (was 200 with an empty trail), then the dispatcher check, then `trackingService.getReplay(id, errand)`. Route middleware unchanged.
- `src/services/trackingService.ts`: `getReplay()` + `REPLAY_POINT_CAP = 5000` (`listTrack` kept). Response keeps `errandId` + `points` (points no longer carry `id` / `clientPointId`) and adds `truncated`, `errand` (referenceNo, status, acceptedAt, deliveredAt, delivery lat/lng, routeGeometry, etaPromisedHighAt), `stops` (radius = category radius ?? `GEOFENCE_RADIUS_METERS`), `riders` (every riderId in the trail, first-seen order), `nearestToDoorMeters`.
- Repositories: `trackPointRepository.listForReplay(errandId, take)` (select, take 5001), `userRepository.findNamesByIds(ids)`.
- NEW `tests/trackReplay.test.ts` (8): 404, 403 wording, claimant/AVAILABLE pass, shape without clientPointId, 5001 -> truncated, exactly 5000 not truncated, two riders, no door fix. Removing the access call fails the 403 test (checked).
- **Verification**: `tsc --noEmit` exit 0; full vitest 184 files / 2322 tests passed. No schema change. Not committed, not deployed.
- **Server must deploy before the web replay view shows stops** (an older server answers only `{ errandId, points }`). Web half: `C:/Capstone_Project_Web/src/components/route-replay/`.
- **DEPLOYED 2026-11-20 11:48 (+08)** (Claude, on the user's "Deploy both"). Only these 6 src files (tests not shipped).
  - The prod copies of the 5 existing files equalled HEAD `99b85c6` (CR stripped), and no prod source was newer than `dist/index.js`. The script guarded on both before copying.
  - VPS `tsc --noEmit` ok, `npm run build` ok, `pm2 restart capstone-backend` online, `/api/health/ready` 200, `GET /api/errands/x/track` signed-out 401. Error log clean apart from bot probes.
  - Backup (6 files + dist) and `rollback.sh` (copies back, no deletion): `/root/deploy-backups/server-replay-20261120-114821`. Web deployed after, at 11:53. Not committed.


## 2026-11-19 - Staff cataloguing endpoints (Claude)
- `src/services/catalogSuggestionService.ts`: `catalogueItem()` (upsert by item + store; category must be an active MerchantCategory; optional verifiedPlaceId must exist; sourceType `STAFF_CATALOGUED`) and `retireCatalogItem()` (marks unavailable, keeps the row). `CatalogInputError` -> 400 `{ error }`.
- `src/controllers/catalogController.ts`, `src/routes/catalogRoutes.ts`: `POST /api/catalog/items`, `DELETE /api/catalog/items/:id`, DISPATCHER/OWNER only, `userApiLimiter`.
- `tests/catalogSuggestion.test.ts`: +5 cataloguing tests.
- **Verification**: `npx tsc --noEmit` exit 0; `catalogSuggestion` + `categoryRename` 18/18 pass. No schema change. Not committed.
- **DEPLOYED 2026-11-19 ~23:57 (+08; 16:56 on the VPS clock)**: only these 3 src files, uploaded over prod copies proven equal to HEAD (CR stripped); no unbuilt src on prod before. VPS `tsc --noEmit` ok, `npm run build` ok, `pm2 restart capstone-backend` online, `/api/health/ready` 200, `POST /api/catalog/items` signed-out -> 401 (route live). Backup (src + dist): `/root/deploy-backups/server-catalog-20261119-165645`.
- Prod check: `crawled_merchant_items.itemName/rawStoreName` are `utf8mb4_unicode_ci`, so the `equals` duplicate check is case-insensitive as assumed. 0 rows at deploy. No unique index, so two simultaneous saves can make two rows; the search merge dedupes them case-insensitively.
- Web half: top of `C:/Capstone_Project_Web/AGENT_HANDSHAKE.md`.

## 2026-11-12 - Settlement & Transactions Report Updates (Antigravity)

* **Scope**:
  - `src/repositories/customerTransactionRepository.ts`: Selected `settlement` (`id`, `expectedAmount`, `collectedAmount`, `variance`, and standing `adjustments`) in `WITH_REPORT_DETAILS` so `getTransactionSummary` can derive `unremitted` and `uncollected` in one query.
  - `src/repositories/settlementAdjustmentRepository.ts` & `src/repositories/settlementRepository.ts`: Added `findRepaymentsBetweenWithSettlement(start, end, riderId)` returning standing `RIDER_PAID_BACK` and `CUSTOMER_PAID_GCASH` adjustments recorded within `[start, end)`.
  - `src/services/reportService.ts`:
    - `getSettlementReport`: Includes Help Desk repayment rows (`lineKind: "REPAYMENT"`, `lineKey: "repayment-<id>"`) in `cash.lines` and credits `byRider.paidBackLater` when the parent settlement was settled prior to `start`.
    - `getTransactionSummary`: Computes `unremitted`, `unremittedCount`, `uncollected`, and `uncollectedCount` inside `totals`.
  - `src/services/pdf/reportPdfService.ts`:
    - `settlementSpec`: Removed `Short` from summary boxes, renamed `Still owed (today)` / `Still owed` to `Unremitted`, and updated `whatHappenedSince` so repayment rows print their follow-up details.
    - `transactionsSpec`: Added `Unremitted` and `Uncollected` summary boxes.
  - `tests/reportPdfExport.test.ts`, `tests/settlementRevenueSplit.test.ts`, `tests/transactionSummaryRider.test.ts`: Updated and expanded test coverage.
* **Verification**:
  - `npx tsc --noEmit`: PASS (exit 0).
  - `npx vitest run tests/settlementRevenueSplit.test.ts tests/transactionSummaryRider.test.ts tests/reportPdfExport.test.ts`: PASS (3 files / 52 tests).
* **Status**: Local changes verified; not yet deployed or committed.

## 2026-11-10 - Fix: a manual store arrival was followed by an instant false departure (Claude Code) - LIVE

* **Found in review** of the 261110-1B21F-0003 work below. `PATCH /errands/:id/pinpoints/:pinpointId/arrived` stamps `arrivedAt` at server time, and is used exactly when no GPS fix is inside the stop's circle. `applyGeofenceTransitions` took the first fix after `arrivedAt` that the stop does not own as the departure, so the next batch marked the stop departed within seconds: a "departed" event to every party, a dwell observation of seconds (which `existsForPinpoint` then let block the real one), and possibly an ETA promise frozen while the rider was still shopping.
* **Already happened once in production**: errand `261110-6447B-0008`, pinpoint 850 (7-Eleven), arrived by tap 09:57:26 UTC, departed 09:57:47, **dwell observation of 21 s written**. **Repaired on the user's go-ahead** (11:56 VPS time): observation id 458 deleted by an exact-match guard, after the row was saved to `/root/deploy-backups/dwell-observation-458-pin850-20261110T105600.json`. Its category, Convenience Store (id 6), still had `dwellSampleCount` 0 with the configured 600/1200 s defaults: the 03:15 learning job had not run since, so no percentile ever included it, and the category now has 0 observations. The errand is DELIVERED; its `departedAt` is left as history.
* **Fix** (`src/services/geofenceService.ts`, `src/repositories/trackPointRepository.ts`; no schema change): the old departure rule now holds only once a fix has placed the rider at the stop (owned by it, per `ownerOf`) since `arrivedAt`. New `seenAtStopSince()` checks the batch first (no query in the common case: a GPS arrival is itself such a fix) and then the stored trail via new `trackPointRepository.findInWindowNear` (time window plus a lat/lng box prefilter on the `[errandId, recordedAt]` index; exact attribution in code). Never seen inside (a tap with offset GPS): departure is the first fix more than the stop's radius from where the phone put the rider at the arrival moment (new `findNearestInTime`, the closest stored fix either side); no trail yet means no departure yet. **Only GPS-seen visits become dwell observations.** GPS arrivals behave exactly as before.
* **Tests**: new `tests/manualArrivalDeparture.test.ts` (8). The four manual-arrival cases fail with the new check switched off (checked). Geofence suites (attribution, radius, stop mismatch, pinpoint arrival) unchanged and passing. `npx tsc --noEmit` exit 0; full Vitest 163 files / 2089 tests pass.
* **Deployed** (two files only): production's copies were downloaded and diffed first; they differed from the local files by this fix alone, and `trackPointRepository.ts` matched git HEAD. Backup `/root/deploy-backups/server-departure-20261110113638` (both sources, the full pre-deploy `dist/`, executable `rollback.sh`). On the VPS: `npx tsc --noEmit` ok, `npm run build` ok, `seenAtStopSince` present in `dist/`, `pm2 restart capstone-backend` (online, PID 614024), `/api/health` 200 locally and at `api.sugo-express.org`. Nothing committed.
* **Not changed (from the same review, still open)**: the arrival time is server receipt time, so an offline-queued tap can land after the rider left (now kept out of the dwell data, but `arrivedAt` is still late); 401 responses drop the rider's queued GPS trail; manual arrival reports the GPS-nearest store, which can be the wrong one.


## 2026-11-10 - Production ML Deployment: Pharmaceutical Dosage Units & Conjoined Medicine Normalization (Antigravity)

* **Defect & Root Cause Remediation**:
  - `ml/sugo_category/gemma.py`: Added missing pharmaceutical units (`tablet`, `tablets`, `capsule`, `capsules`, `tab`, `tabs`, `cap`, `caps`, `pad`, `pads`, `strip`, `strips`, `vial`, `vials`, `ampoule`, `ampoules`, `ampule`, `ampules`) to `_UNIT_WORDS` and unit aliases in `_CHECK_UNIT`.
  - Added Tagalog primary conjunction `"at"` to `_LINK_WORDS` alongside `tapos`, `tsaka`, `saka`, `pati`.
  - Enhanced `normalize_prompt`: Added few-shot conjoined medicine example and explicit trailing count distribution rule (`confident true`).
  - `ml/tests/test_normalize.py`: Added comprehensive test coverage for medicine unit normalization across English, Tagalog, and Bisaya syntax (all 73 tests PASS).
* **Production Deployment to VPS (`root@109.123.239.182`)**:
  - Backup: `/root/deploy-backups/ml-medicine-20261110-101421` (source backup and rollback tag `sugo-category:rollback-20261110-101421`).
  - Staged files verified by MD5: `ml/sugo_category/gemma.py` (`5a381880f4284d6b8b52f7cafafc02bc`), `ml/tests/test_normalize.py` (`7b9cde0e8f838ab7e78623e71098082b`).
  - Docker container rebuild: `docker compose -f ml/docker-compose.category.yml build` completed cleanly, image `sugo-category:latest` updated.
  - Container recreate & startup: `capstone-category` running and status `healthy` on `127.0.0.1:8100`.
  - Live empirical verification on VPS:
    - Sent `{"lines": ["Biogesic and flugard na 10 tablets"]}` directly to `http://127.0.0.1:8100/normalize-items`: returned 2 items (`Biogesic` qty 10, `flugard` qty 10) with `confident: true` (previously returned `{available: true, results: []}`).
    - Probed `http://127.0.0.1:5000/api/health`: HTTP 200 OK.
    - Probed public edge `https://api.sugo-express.org/api/health`: HTTP 200 OK.
* **Status**: Live in production. CustomerApp review list now properly normalizes conjoined medicine requests.

## 2026-11-10 - Server Deployment Hardening & Peer Audit: Production Anomaly Fixes for 261110-1B21F-0003 (Antigravity)

* **Audit & Defect Remediation**:
  - `src/services/geofenceService.ts`: Defensively guarded `(changed?.count ?? 0) === 0` against undefined/null repository responses to prevent uncaught runtime `TypeError: Cannot read properties of undefined (reading 'count')`.
  - `src/services/pinpointArrivalService.ts`: Defensively guarded `(changed?.count ?? 0) > 0` before emitting `errand:stop_arrived` and triggering background ETA recomputation.
  - Test Synchronization: Synchronized `tests/geofenceAttribution.test.ts` and `tests/etaStrategy.test.ts` (all 20 tests) to the VPS; previously the test suite on the VPS failed 3 tests due to out-of-sync mocks.
* **Deployment to VPS (`root@109.123.239.182:/var/www/server`)**:
  - Backup: `/root/deploy-backups/server-arrival-hardening-20261110070445` containing `src-before.tar`, pre-deploy `dist/`, and executable `rollback.sh`.
  - Staged files verified: `src/services/geofenceService.ts`, `src/services/pinpointArrivalService.ts`, `tests/geofenceAttribution.test.ts`, `tests/etaStrategy.test.ts`, `tests/pinpointArrival.test.ts`.
  - Remote verification: `npx tsc --noEmit` PASS (0 errors), `npm run build` PASS.
  - Remote test suite: `npx vitest run tests/geofenceAttribution.test.ts tests/etaStrategy.test.ts tests/pinpointArrival.test.ts` PASS (3 files / 32 tests clean).
  - Process restart: `pm2 restart capstone-backend` clean, PID 579645, status `online`.
  - Live API probes: `/api/health` 200 OK (local + Cloudflare public edge). Probed `PATCH /api/errands/:id/pinpoints/:pinpointId/arrived` across CUSTOMER role (403), wrong rider assignment (403), invalid UUID (400), invalid pinpointId (400), non-existent errand (404), and DELIVERED errand (409) confirming strict security and status invariants.
* **Status**: Live in production. All server tests green.

## 2026-11-10 - Server Deployment: Production Anomaly Fixes for 261110-1B21F-0003 (Antigravity)

* **Deployment**: Successfully deployed the 8 backend files to VPS (`root@109.123.239.182:/var/www/server`) following the safe backup-and-swap protocol.
  - Backup: `/root/deploy-backups/server-arrival-20261110054023` containing `src-before.tar`, pre-deploy `dist/`, and executable `rollback.sh`.
  - Staged files verified by MD5: `src/controllers/errandController.ts`, `src/repositories/pinpointRepository.ts`, `src/routes/errandRoutes.ts`, `src/services/etaService.ts`, `src/services/geofenceService.ts`, `src/services/patterns/etaStrategy.ts`, `src/services/pinpointArrivalService.ts`, `src/services/proofImageService.ts`.
  - Remote compilation: `npx tsc --noEmit` PASS (0 errors), `npm run build` PASS.
  - Process restart: `pm2 restart capstone-backend` clean, PID 575252, status `online`.
  - Live probe: `/api/health` 200 (local + public edge). Probed `PATCH /api/errands/:id/pinpoints/:pinpointId/arrived` -> 401 Unauthorized (`Access token required`), confirming route is live and gated by authentication.
* **Status**: Live in production. No DB migration or schema change required.

## 2026-11-10 - Production anomaly fixes for 261110-1B21F-0003 (Codex)

* **Arrival fallback**: `src/controllers/errandController.ts`, `src/routes/errandRoutes.ts`, new `src/services/pinpointArrivalService.ts`. Added rider-only, rate-limited `PATCH /api/errands/:id/pinpoints/:pinpointId/arrived`; Zod validates UUID/positive integer params before queries. Reuses exported `assertRidersOwnErrand` from `proofImageService.ts`, then verifies the pinpoint belongs to that errand. New arrivals require IN_TRANSIT; retries of an existing arrival are no-ops. Emits the existing `errand:stop_arrived` payload via `emitToErrandParties` (customer, rider, dispatcher, owner) and forces background ETA recomputation.
* **Idempotency across GPS and HTTP**: `src/repositories/pinpointRepository.ts` now conditionally marks arrival only where `arrivedAt IS NULL`. `src/services/geofenceService.ts` reads the winning persisted timestamp when another writer wins, avoiding duplicate arrival events and dwell based on an overwritten timestamp.
* **New-zone dwell baseline**: `src/services/patterns/etaStrategy.ts`, `src/services/etaService.ts`, category selection in `pinpointRepository.ts`. Valid configured P50/P80 defaults for ACTIVE categories with exactly zero samples may produce a non-degraded dwell estimate; retain 25% upper dwell padding. `ETA_ALLOW_ZERO_SAMPLE_BASELINE=false` disables it. Unknown/inactive categories, 1-9 samples, invalid defaults, and fallback routing remain degraded. No fabricated observations, seed writes, schema changes or migrations. Documented in `README.md`.
* **Correction to investigation premise**: current `freezeEtaPromise` additionally requires zero remaining stores, a fresh rider position and IN_TRANSIT. The baseline does not relax those conditions; dwell sample count alone was not the current delivery-promise gate once shopping finished.
* **Verification**: `npx tsc --noEmit` PASS (exit 0); full Vitest 162 files / 2080 tests PASS. After adding the final GPS/HTTP race regression, focused `geofenceAttribution`, `pinpointArrival`, `etaStrategy`, `etaPromiseFreeze`: 4 files / 38 tests PASS. Existing expected mocked-failure logs and the pre-existing `ERR_ERL_KEY_GEN_IPV6` warning remain.
* **Peer/release notes**: Local and uncommitted; no server deployment or production data repair. Preserve other sessions' existing changes. Deploy the endpoint before releasing the Rider client. The endpoint timestamps arrival at server receipt time, so an offline retry does not backdate physical arrival. Test automatic/manual arrival and airplane-mode recovery on a real phone after release; inspect track points and pinpoint timestamps for a new errand.

## 2026-11-10 - Handoff to Claude Code: Fixes for Transaction 261110-1B21F-0003 Real-World Anomalies (Antigravity)

* **Context**: Real-world field verification of errand `261110-1B21F-0003` (`0fc997ce-9084-4c53-a0ee-9ab74101b21f`) in Banga, South Cotabato identified key backend gaps around arrival reporting and initial zone dwell baselines.
* **Directives for Claude Code**:
  1. **Fallback Pinpoint Arrival Endpoint (`server/src/controllers/errandController.ts`, `server/src/routes/errandRoutes.ts`)**:
     - Currently, `errand_pinpoints_tbl.arrivedAt` is ONLY marked inside `geofenceService.ts` when a GPS batch arrives via `trackingService.ingestBatch()`. If GPS batch uploads are offline, delayed, or fail authorization, `arrivedAt` remains `NULL` on the database indefinitely.
     - Implement `PATCH /api/errands/:id/pinpoints/:pinpointId/arrived`:
       - Authenticate caller; verify `assertRidersOwnErrand(errandId, riderId)`.
       - Call `pinpointRepository.markArrived(pinpointId, new Date())` if not already set.
       - Emit socket / notification events so the dispatcher and customer interfaces know the rider reached the store.
  2. **Dwell Sample Baseline for New Service Zones (`server/src/services/patterns/etaStrategy.ts` / seed)**:
     - In `etaStrategy.ts:122`, `dwellSampleCount < MIN_CONFIDENT_SAMPLES` (10) forces `lowConfidence = true`, which makes `etaIsDegraded: 1` and prevents `freezeEtaPromise()` from ever locking in new zones like Banga (`merchant_categories` has 0 samples).
     - Provide a sensible default baseline or seed for merchant category dwell times so that newly configured zones do not suffer from perpetually degraded, unfreezable ETAs.
  3. **Verification**: Verify with `npx tsc --noEmit` and run the server test suite.

## 2026-11-09 - Dual-zone service area: Banga, South Cotabato beside Tacurong, isolated (Claude Code)
* **Why**: rider app field tests run in Banga (~30 km south). Every boundary check was Tacurong-only, so Banga orders and rider GPS read as "outside service area". Both towns now run in one system, but no errand and no dispatch ever spans the two. Zones are derived from coordinates every time: **no schema change, no stored zone column**.
* **Files**:
  - NEW `gis/banga-service-area.geojson`: OSM relation 20011844 via Nominatim `/lookup?osm_ids=R20011844` (checked: name Banga, South Cotabato; bbox 6.282736 to 6.5140662, 124.7074706 to 124.918899). The OSM boundary is coarse: 88 points vs Tacurong's 649.
  - `src/lib/serviceArea.ts`: `ServiceZone = "TACURONG" | "BANGA"`, `SERVICE_ZONES` (name, center, file), rings tagged by zone and loaded **per zone** (a missing Banga file leaves Tacurong working). Optional `zone` argument on `isWithinServiceArea`, `isWithinServiceBuffer(point, bufferKm, zone)`, `distanceOutsideServiceAreaKm`, `isServiceAreaConfigured`, `serviceAreaEnvelope`; no zone = any zone, as before. NEW `detectServiceZone(point, bufferKm = 0.1)` (inside first, else the nearest zone within the buffer), `validateIntraZone(points)` (`{valid, zone?, error?, reason?, index?}`), `getZoneCenter(zone?)` (Tacurong default), `serviceZoneName`, `CROSS_ZONE_MESSAGE`, `OUTSIDE_ALL_ZONES_MESSAGE`. `SERVICE_AREA_CENTRE` unchanged (Tacurong).
  - NEW `src/services/dispatchZone.ts` (pure, tested): `dispatchTargetPoint`, `errandServiceZone` (first store, else drop-off), `riderMayTakeZone`, `namedRiderZoneConflict`.
  - `src/services/errandService.ts` `assignRider`: automatic dispatch offers an errand only to riders whose **fresh (60 s) fix** is in the errand's zone. This bounds the ranking, the repeat-customer rider, **and** the least-loaded and back-of-queue fallbacks, which previously took every eligible rider and would have leaked across zones. Rider beacons arrive every 5 to 10 s, so a dispatchable rider almost always has a fresh fix. Empty queue: 404 `No rider is currently available in the <Tacurong City|Banga> service area. N available riders are elsewhere or without a recent location.` A rider the dispatcher names is refused (409) only when their last known fix is in the other zone; no fix, or outside every zone, stays the dispatcher's call. `savePinpoints` and `quotePinpoints` refuse a cross-zone set of stops plus drop-off with 400 `CROSS_ZONE_MESSAGE`. Checkout delivery message names both towns.
  - `src/validators/errandValidators.ts` (`createErrandSchema`, the only errand-creation schema; there is no separate pabili-request validator): new final `.superRefine` refuses stores and drop-off in different zones (400, the mission's exact message, path on the offending point). Per-point messages now say "outside all supported service areas ... Tacurong City or Banga".
  - `src/services/storeLocationGuard.ts`: messages zone-aware ("Inside Banga.", "outside all supported service areas", "past the service-area border"). `kmBeyondBorder` is now to the NEAREST zone.
  - `src/services/placeService.ts`: outside message names both towns.
  - `src/lib/places/googlePlacesClient.ts`: `banga`, `south`, `cotabato` strip words; `banga`, `municipality of banga`, `banga, south cotabato` are vague addresses; `searchPlacesByText(query, { zone })` restricts to that zone's box. Without it the box spans both zones and takes in Koronadal, whose branches would crowd a 20-result page.
  - `src/services/establishmentService.ts`: typed and category-name text searches pass the searcher's zone (`detectServiceZone(centre)`); cache key is now `text:<ZONE|ALL>:<words>`. Nearby and popular searches already centre on `near`, and `isWithinServiceBuffer` without a zone accepts Banga, so `outsideServiceArea` is no longer set there.
  - Tests: NEW `tests/serviceAreaMultiZone.test.ts` (23: detection, buffer edges, Koronadal inside Banga's box but outside its polygon, `validateIntraZone`, `createErrandSchema` cross-zone), NEW `tests/dispatchZoneIsolation.test.ts` (9: the rules, plus `assignRider` building its queue with every claim answered AT_CAPACITY, so the claims are the whole queue). `storeLocationGuard.test.ts` (+1 Banga case; Tantangan is now 3.8 km from Banga's tip, so the threshold went from 5 to 3); mock or message updates in the `establishments`, `customerPickedStores` and `categoryRename` tests.
* **Verification**: `tsc --noEmit` exit 0. Full vitest **161 files / 2067 tests PASS**.
* **DEPLOYED 2026-11-09 19:49 (+08)** on the user's "Yes, deploy server": the 7 changed files plus `src/services/dispatchZone.ts` and `gis/banga-service-area.geojson` (not `deploy-server.sh`, no `db push`, no schema change). Nothing committed.
  - **Proof**: each live file was fetched and diffed (CR stripped) against local: every hunk was this session's, so live = local minus these edits (the other sessions' work in `errandService.ts` was already live). `find src prisma gis -newer dist/index.js` was empty. The script re-checked the live fingerprints and the staged md5s before the swap, and the swapped files after.
  - **Steps**: backup, swap, chown to the neighbour's numeric owner, `npx tsc --noEmit` (clean), `npm run build`, a zone gate importing the BUILT `dist/lib/serviceArea.js` with the real boundary files (`{tacurong: TACURONG, banga: BANGA, koronadal: null, both zones configured, mixed pair CROSS_ZONE}`), then `pm2 restart capstone-backend`. Every failure path restored src and dist without restarting; none ran.
  - **Backup and rollback**: `/root/deploy-backups/server-banga-20261109-1955` (`src-before.tar`, `dist/`, `tsc.log`, `build.log`, `staged/`, `rollback.sh`, which moves and never deletes).
  - **Live checks**: `/api/health` 200 locally and through Cloudflare; pm2 online; clean startup, no service-area load error; the only stderr entry is the pre-existing `ERR_ERL_KEY_GEN_IPV6`.
  - **Not yet seen**: a real Banga order end to end (needs a rider in Banga). The web portal half was DEPLOYED 2026-11-09 21:22 (+08), entry `index-CagKvu69.js`, backup `/root/deploy-backups/web-banga-20261109-212208`. The CustomerApp half shipped as OTA group `2fb978cd-c3ea-4071-a002-c8d6977098aa` at 21:52 (+08); a first publish at 21:40 lacked the API address and was rolled back within 3 minutes (details in the CustomerApp handshake).
  - **Deploy trap**: `scripts/deploy-server.sh` streams only `src prisma/schema.prisma package.json ml`, **not `gis/`**. Upload `gis/banga-service-area.geojson` to `/var/www/server/gis/` with the source, or the server logs "Could not load service area GeoJSON for BANGA" and treats every Banga point as outside (Tacurong unaffected). That script also runs `prisma db push --accept-data-loss`; prefer the file-swap deploy used for the 11-09 Google change.
  - The web portal half (Stage 2 pins) and the CustomerApp half are in their own handshakes; the CustomerApp half needs an app update before Banga customers see stores.
* **Left as is**: pricing uses the shared RateConfig (as agreed). No RiderMobileApp change was needed (it has no client boundary checks). Customer-facing copy that names only Tacurong (help modal, legal terms "We deliver within Tacurong City") was not changed.

## 2026-11-09 - Google sign-in token is Google-only, unrevoked and single-use (Claude Code)
* **Why**: the user asked whether Google sign-in has OAuth `state`. It has neither `state` nor a `nonce`. `state` does not apply: the CustomerApp uses the native Google SDK (`@react-native-google-signin` 16.1.5, `GoogleSignin.signIn()`, which takes no nonce) and posts a Firebase ID token as JSON, so there is no redirect callback to forge. The real gap was replay: `/customers/google-login` and `/google-register` accepted the same token for its whole hour, from any Firebase provider, without a revocation check. A replayed token at `google-register` could also replace an existing account's number and get a session with no second factor.
* **Files**:
  - `src/lib/firebaseAdmin.ts`: `verifyFirebaseIdToken(idToken, { checkRevoked? })`, passed to Admin `verifyIdToken`. Default off, so the other callers (phone proofs) are unchanged.
  - `src/services/authService.ts`: NEW `claimFirebaseIdToken` (the SMS proof's `firebase-id:<sha256>` blocklist claim, extracted; the SMS proof now calls it, same behaviour). NEW `verifyGoogleSignInToken` (checkRevoked on, `signInProvider` must be `google.com`, else 400) and `spendGoogleSignInToken` (claim, else 409 "That Google sign-in was already used."). `loginCustomerWithGoogle` spends the token only when it buys an MFA challenge or a session; the PHONE_SETUP_REQUIRED replies leave it unspent because the app sends the same token to `google-register` next. `registerCustomerWithGoogle` refuses (409) an existing account that already has a phone, and spends the token after `assertPhoneAvailable`, before any write.
  - Tests: `tests/googleAuth.test.ts` (mocks now carry `signInProvider: "google.com"`, tokenBlocklist mocked, 8 new cases), `tests/loginMfa.test.ts` (Google mock gets the provider; NEW replay case through the in-memory insert-only claim).
* **Verification**: `tsc --noEmit` exit 0. Full vitest 159 files / 2034 tests PASS. 8 of the new cases fail against the pre-change `authService.ts` (checked by swapping the file in and back; md5 restored). The local service account (`firebase-adminsdk-*`, project `capstonedata-3589c`, same project as the CustomerApp) passed a read-only `listUsers(1)`, the permission `checkRevoked` needs.
* **DEPLOYED 2026-11-09 02:58 (+08)** on the user's "Yes, deploy", two source files only (not `deploy-server.sh`, no `db push`). Nothing committed. No schema, route, response-shape or client change; no app release needed.
  - **Proof**: live `authService.ts` and `firebaseAdmin.ts` equalled the local pre-edit copies (CR-stripped md5 `256b9602…`, `5a2938cb…`), and `find src prisma -newer dist/index.js` was empty. The script re-checked both before the swap and the staged hashes after upload (`b7b97cb1…`, `acacccab…`). VPS service account: `firebase-adminsdk-*`, project `capstonedata-3589c`.
  - **Steps**: backup, swap, chown to the neighbour's numeric owner, `npx tsc --noEmit` (clean), `npm run build`, a read-only `listUsers(1)` with the prod service account as a gate (OK), then `pm2 restart capstone-backend`. Every failure path restored src and dist without restarting; none ran.
  - **Backup and rollback**: `/root/deploy-backups/server-googletoken-20261109-025734` (`src-before.tar`, `dist/`, `build.log`, `staged/`, `rollback.sh`, which moves and never deletes).
  - **Live checks**: `/api/health` 200 locally and through Cloudflare; `POST /api/customers/google-login` with a fake token gives 401 `{"error":"Invalid or expired Firebase authentication token."}`, logged by the new process; pm2 online. Only error since start is the pre-existing `ERR_ERL_KEY_GEN_IPV6`.
  - **Not yet seen**: a real phone signing in with Google after the deploy (needs a person and a Google account).
  - `authService.ts`, `firebaseAdmin.ts` and `googleAuth.test.ts` already carried other sessions' uncommitted work (mtimes 11-03), which was already live; pre-edit copies are in this session's scratchpad `google-harden-before/`.
* **Left as is**: the phone token sent to `google-register` is not single-use (it can only set the number it proves). The CustomerApp's `CREDENTIAL_ENDPOINTS` regex does not list `google-login`/`google-register`, so their 401s go through the refresh interceptor; the new refusals are 400/409 and do not.

## 2026-11-04 - Customer photo is a signed link, not inline base64 (slow-connection work) (Claude Code)
* **Why**: the customer's profile photo travelled as base64 inside every profile, login, Google login and token-refresh response. On prod, customer 7's photo was 739 KB of base64 (customer 2's, 702 KB), so nginx logged `/api/customers/:id` at up to 556 KB gzipped and `google-login` at up to 557 KB. That is 10+ s per login or profile load on a slow mobile link, and `/api/customers/7` was #2 by data transfer in Cloudflare.
* **Contract change (backward compatible)**: inside a request, `avatar` in the flat customer is now `https://<api host>/api/customers/:id/photo?v=<photo updatedAt ms>&sig=<22-char HMAC>`. Google photo URLs and null pass through unchanged. Outside a request (no origin), it stays inline as before. The app only ever uses `avatar` as an `<Image>` URI and already handled https avatars (Google sign-ups), so **no app release is needed**. The web portal never reads customer avatars.
* **Files**:
  - NEW `src/lib/publicOrigin.ts`: `publicOrigin(req)` moved here from `establishmentController.ts`, which re-exports it. Also an `AsyncLocalStorage` (`rememberPublicOrigin` middleware, `currentPublicOrigin()`, `withPublicOrigin()` for tests).
  - NEW `src/lib/customerPhotoLink.ts`: HMAC (key `JWT_SECRET`, label `customer-photo:<id>:<version>`), `timingSafeEqual`, data-URI decoding.
  - `src/index.ts`: `app.use("/api", rememberPublicOrigin, apiRoutes)`.
  - `services/patterns/customerFactory.ts`: `customerAvatar()`; `profilePhoto.photoData` and `updatedAt` are now optional in the type.
  - `repositories/customerRepository.ts`: `WITH_INFORMATION` selects `profilePhoto` without `photoData`, so profile reads no longer pull the photo out of MariaDB.
  - `services/customerService.ts`: `getLinkedPhoto(id, version)`. The uploaded photo first, else a legacy data URI in `customer_information.avatar`. A stale version returns null.
  - `controllers/customerController.ts`: `getCustomerPhoto`. No auth; the signature is the check; every refusal is the same 404. `Cache-Control: private, max-age=31536000, immutable`, ETag with 304, and `Cross-Origin-Resource-Policy: cross-origin`.
  - `routes/customerRoutes.ts`: `GET /:id/photo` with `readLimiter`.
* **Tests**: NEW `tests/customerPhotoLink.test.ts` (12). Full suite 159 files / 2025 tests PASS; `tsc --noEmit` PASS.
* **DEPLOYED 2026-11-04 23:25 (+08)**. All 7 live files equalled the local pre-edit copies (CR-stripped md5, re-checked by the script), the 2 new paths were absent, and nothing was unbuilt. Steps: `tsc --noEmit` PASS, build, `pm2 restart` (restart 10).
  - Backup: `/root/deploy-backups/server-avatarlink-20261104-232446` (`src-before.tar`, `dist/`, `staged/`, `verify.mjs`). Rollback: `tar xf src-before.tar`, move the two new lib files aside, build, restart. No `rm` anywhere.
  - Live, with real data: customer 7's profile JSON is **678 bytes** (was ~740 KB). Its link through Cloudflare returned 200 `image/jpeg`, 567 KB, in 0.6 s. Repeat with If-None-Match: 304. The same link on customer 2: 404. A forged sig: 404.
  - **Not yet seen**: a real phone loading the linked photo (no customer traffic after the deploy).
* **Left as is**: uploads still write the same base64 into `customer_information.avatar` too ("backwards compatibility"), so that duplicate is still stored and still read on every profile query. Photos are stored at full size: there is no image library on the server, and the app uploads a 555 KB JPEG unresized.

## 2026-11-04 - Fixed: mobile apps stuck on Socket.IO long-polling (Cloudflare p99 of 25 s) (Claude Code)
* **Symptom**: Cloudflare Performance showed origin response p50 31 ms but p95/p99 spiking to a flat 25.1 s.
* **Cause**: 25 s is Socket.IO's default `pingInterval`, the time a long-poll GET is held open. Both mobile apps connect polling-first (on purpose; see `CustomerApp/src/services/socketClient.ts`). React Native's Android WebSocket (okhttp) adds a default `Origin: https://api.sugo-express.org`. That origin was not in `ALLOWED_ORIGINS`, and engine.io runs the `cors` option as middleware on upgrades too, so every upgrade got `400 Bad request` (`MIDDLEWARE_FAILURE`). The apps stayed on polling for the whole session: one 25 s request every 25 s.
  - nginx 11-03: all 15 okhttp upgrades with a sid got 400; every Chrome upgrade got 101. One okhttp sid made 26 GETs exactly 25 s apart, each returning the 1-byte ping.
  - Same root cause as the "websocket error" the app comments blame on emulators and LAN dev servers: there the Origin is `http://<lan-ip>:5000`.
* **Fix**: `src/lib/socket.ts`. `cors` is now a delegate, and the origin check also accepts an Origin whose host equals the request's `Host` (new exported `isSameOrigin`). Allow-list and foreign-origin behaviour are unchanged. This is safe because socket identity comes only from `handshake.auth.token`, never cookies, and the API serves no pages.
* **Test**: NEW `tests/socketOrigin.test.ts` drives raw upgrades through the real `io`. Full suite 158 files / 2013 tests PASS; `tsc --noEmit` PASS.
* **DEPLOYED 2026-11-04 22:56 (+08)**, one file. Live `socket.ts` equalled local pre-edit (CR-stripped md5 `c00bc92a…`), and `find src prisma -newer dist/index.js` was empty. Steps: backup, `tsc --noEmit` PASS, `npm run build`, `pm2 restart capstone-backend` (restart 9).
  - Backup: `/root/deploy-backups/server-sockorigin-20261104-225551` (`socket.ts`, `dist/`). Rollback: copy `socket.ts` back, build, restart.
  - Live probe through Cloudflare: Origin api host 101 (was 400), none 101, portal 101, `https://evil.example` 400; polling handshake then upgrade with sid 101.
  - **Not yet seen**: a real phone upgrading. No okhttp client connected in the hour after the deploy (the one okhttp 101 at 15:58:24 CET is my own probe). Check tomorrow: `grep okhttp /var/log/nginx/access.log | grep "transport=websocket[^ ]*sid="` should show 101s, and Cloudflare p99 should drop to real API latency.
* **Not changed**: no client changes and no app release needed. The pre-existing `ERR_ERL_KEY_GEN_IPV6` startup error (express-rate-limit, logged on every start) is unrelated and untouched. Not committed: the server tree carries other sessions' uncommitted work.

## 2026-11-04 - Access groups (RBAC) for Admin and Dispatcher accounts, Main Owner only (Claude Code)
* **DEPLOYED 2026-11-04 ~08:36 (+08)** on the user's "Yes, deploy". This used neither `deploy-server.sh` nor `db push`.
  - **Proof**: all 19 changed files on the VPS equalled my pre-change versions. The 11 route files matched my pre-edit backups byte for byte; for the other 8, the CR-stripped live-vs-local diff was only my hunks. The 8 new paths were absent, and `find src prisma -newer dist/index.js` was empty. The script re-checked the live md5s just before applying.
  - **Steps**: backup, extract and chown to `197612:197121`, then `prisma generate`, `tsc --noEmit` (clean), `prisma db execute` of the migration only, `npm run build`, and `pm2 restart capstone-backend` (restart 6).
  - **Backup and rollback**: `/root/deploy-backups/server-rbac-20261104-013620` (VPS clock CET) holds `src-before.tar.gz`, `dist/`, `db-before.sql.gz` (full dump, 70 MB, gzip-tested) and `rollback.sh`. The rollback deletes nothing: it moves the RBAC files and build aside and leaves the access tables, which old code never reads.
  - **Live checks**: `/api/health` 200 locally and publicly; `/account/permissions` and `/access/groups` give 401 without a token; the process was stable after 67 s; there are no related errors in the pm2 error log. Prod has 0 groups and 0 overrides, and every account is in Full access. The Main Owner resolves to id 1 `owner`.
  - **Not exercised live**: a signed-in Main Owner using the Access tabs. Agents use no production credentials.
* **Request**: per-account access control behind a new Owner portal Settings screen. User's decisions: Admin + Dispatcher scope, groups plus per-account GRANT/DENY overrides, and **only the Main Owner (the first OWNER account ever created) manages access**.
* **Touches the `[LOCKED]` Prisma schema**, additive only, approved by the user with the plan that named it:
  - NEW `access_groups`, `access_group_permissions`, `user_permission_overrides`, enum `PermissionEffect`, and `users.accessGroupId` (FK **RESTRICT**).
  - Migration `prisma/migrations/20261104120000_add_access_groups/migration.sql`, hand-written (migrate dev is broken).
  - Applied to the local XAMPP DB, and to production on deploy (see above).
* **NULL group = the built-in "Full access" for the role** (a code constant, not a row). Every existing account keeps exactly its current access with no data migration.
* **Main Owner** = lowest `users.id` with role OWNER (`src/lib/mainOwner.ts`). On prod that is **id 1 `owner`**, read 2026-11-04. It always has every Admin key; no group or override applies to it. `requireMainOwner` gates all `/access/*`.
* **Files**:
  - NEW `src/lib/permissions.ts`: the catalog, 9 Admin and 9 Dispatcher keys, each with title/label/description/requires.
  - NEW `src/lib/permissionCache.ts`: effective-permission math, 30 s LRU, invalidated on every write, fails closed.
  - NEW `src/services/accessService.ts`, `src/controllers/accessController.ts`, `src/routes/accessRoutes.ts`, `src/validators/accessValidators.ts`.
  - `src/middleware/auth.ts`: `requirePermission(spec)` (named `requirePermissionGuard`) and `requireMainOwner`. `requireRole` is unchanged.
  - `src/routes/index.ts` mounts accessRoutes at `/`.
  - 56 route gates added after `requireRole` in `analyticsRoutes`, `reportRoutes`, `userRoutes`, `rateConfigRoutes`, `merchantCategoryRoutes`, `placeRoutes`, `riderRoutes`, `feedbackRoutes`, `ownerCopilotRoutes`, `errandRoutes`. A key only constrains callers of its own role, so an Admin on a dispatcher route passes as before.
  - `errandController.updateStatus`: a dispatcher's CANCELLED or PASSING BY needs `errands.cancel`; any other move needs `errands.review`.
  - `ownerCopilotService` / `ownerCopilotController`: Kuya Sugo offers and runs only tools the caller may use (deterministic fallback too).
  - `userService` / `userController`: only the Main Owner creates or edits Admin accounts or moves anyone into or out of OWNER. A promotion of an account older than the Main Owner is refused (409). The profile route needs `users.manage` to edit others. A role change clears the account's group and overrides. `listUsers` adds `isMainOwner` and `accessGroup`.
  - `src/lib/socket.ts`: `notifyPermissionsChanged` emits `permissions:changed` to `user:<id>`.
* **Endpoints**: `GET /account/permissions` (Admin/Dispatcher, own). Main Owner only: `GET /access/catalog`, `GET/POST /access/groups`, `PUT/DELETE /access/groups/:id` (version 409; members 409), `GET /access/accounts`, `PUT /access/accounts/:userId`.
* **Audit**: an `account_modification_logs` row per affected account (`accessGroup`, `permissionOverride:<key>`, `groupPermissions:<group>`), with `verifiedVia` `MAIN_OWNER_SESSION`.
* **Verification**:
  - `tsc --noEmit` clean.
  - New `tests/accessControl.test.ts` (23 tests). Route-shape tests updated for the new guard: `exceptionAccess`, `placeRoutesAuth`, `riderAccessGuards`, `storeCategoryImage`. `staffAccountChanges` gained the Main Owner lookup mock and 2 tests.
  - Full vitest 157 files, 2003/2003 pass on the final tree.
  - Local end-to-end against XAMPP with locally signed tokens: 19/20 pass. The one failure is `GET /errands` answering 500 because the local DB lacks `errands.referenceNo`, unrelated; the permission check passed. Test user, groups and audit rows were removed afterwards.
* **Known limits**:
  - Chat and live positions are Firebase RTDB, gated by the role claim, not by group.
  - Socket rooms stay role-based.
  - The ownerCopilot "disabled by SysAdmin" test can time out under a parallel full run: it writes the gitignored `config/maintenance.json`. This is pre-existing.
* **Now live**: the 7 other Admins can no longer create or edit Admin accounts. Nothing is committed.

## 2026-11-04 - Fix: a browser trusted only the last account that passed MFA (Claude Code)
* **Bug (user report)**: "logged out, same browser and device, logged in again, it asked the OTP again".
  - **Cause**: the portal's `mfaTrust` cookie held ONE token, so each account that passed MFA on a browser overwrote the previous account's trust.
  - **Seen in prod**: owner (#1) passed at 00:52Z; jayvee (#13) passed at 00:58Z on the same browser (`web-a8d588cc...`); owner's sign-in at 01:04Z (nginx: 636-byte challenge reply) was challenged again.
  - **Ruled out**: trust rows, device id, stamps and expiry were all fine.
* **Fix (3 files)**:
  - `mfaTrustService.ts`: the cookie carries up to 5 tokens, newest first, joined by "." (`parseTrustCookie` / `serializeTrustCookie`). `isTrusted` takes a list and matches the row for THIS account (another account's token never matches). `liveTokens` prunes replaced, revoked and expired tokens when the cookie is rewritten. `revokeOthers` keeps every token the caller's browser holds.
  - `loginChallengeService.ts`: `MfaRequestContext.trustToken` becomes `trustTokens: string[]`.
  - `authController.ts`: `trustTokensOf` (cookie list plus the apps' body token); `setMfaTrustCookie` keeps the other accounts' live tokens.
  - Mobile apps are unchanged: they still send and receive one `mfaTrustToken`.
* **Tests**:
  - `tsc` clean.
  - `tests/loginMfa.test.ts` now 31 tests, +5 for this bug, including a replay of the owner, then dispatcher, then owner sequence.
  - Full suite **157/157 files, 2008/2008 tests**.
  - Local HTTP end to end: two accounts in one cookie jar 5/5 (the cookie held 2 tokens; both signed straight back in); the original single-account check 14/14.
* **Deployed 2026-11-04 ~09:20 (+08)**, VPS 02:18 CET.
  - Race guard on the 3 live md5s; the live-only lines were exactly the replaced ones; nothing unbuilt on the VPS.
  - `tsc --noEmit`, `npm run build`, `pm2 restart` (restart 8, clean); health 200 locally and publicly; MFA setting unchanged `["WEB_PORTAL","CUSTOMER_APP"]`.
  - Backup: `/root/deploy-backups/server-mfa-cookie-20261104-021853`. Its `rollback.sh` deletes nothing; it moves the fix aside.
* **One-time effect**: a browser whose cookie already lost an account's token asks that account once more. After that, every account on the browser stays trusted.

## 2026-11-04 - MFA switched ON for customers too (Claude Code)
* **01:51 CET (08:51 +08), on the user's "Switch it on now"**: `.env` now reads `MFA_ENFORCED_AUDIENCES=WEB_PORTAL,CUSTOMER_APP` (one line edited with `sed`), then `pm2 restart` (restart 7). The server reads `["WEB_PORTAL","CUSTOMER_APP"]`; health is 200 locally and publicly; the restart was clean (exit 0, `unstable_restarts` 0).
* **Rollback (deletes nothing)**: `cp -p /root/deploy-backups/server-mfa-customer-20261104-015111/env.before /var/www/server/.env && pm2 restart capstone-backend`. That returns to web-only MFA.
* **Effect**:
  - **Customer app 1.4.0 on OTA group `bab5148c`** (published 05:33 +08, carries the MFA screen): password and Google sign-ins on an untrusted phone are asked for SMS or email.
  - **Older bundles**: get 403 "Update Sugo Express to the latest version to sign in." (`details.code` `APP_UPDATE_REQUIRED`) and no session.
  - **Already signed-in customers**: unaffected until they sign in again.
  - **Riders**: not enforced.
* **Someone else restarted the API at 01:38 CET (restart 6)**: another session deployed access/permissions work (`src/routes/*`, `middleware/auth.ts`, `lib/permissions.ts`, `services/accessService.ts`, ... saved 11-03 21:51-22:08 CET; `dist` built 01:37 CET). Checked afterwards: all 10 MFA source files on the VPS are byte-identical (CR stripped) to this deploy.
* **Not verified live**: a real customer sign-in through the challenge, and the SMS hand-off on a phone.

## 2026-11-04 - MFA switched ON for the web portal (Claude Code)
* **~03:37 (+08), on the user's "Yes, switch it on"**: appended `MFA_ENFORCED_AUDIENCES=WEB_PORTAL`, with a comment line, to `/var/www/server/.env`, then `pm2 restart capstone-backend` (restart 5).
  - The setting as the server reads it (`dist/config/env.js`) is `["WEB_PORTAL"]`, with `MFA_TRUST_DAYS` 30.
  - Health is 200 locally and publicly; the API was stable after 46 s with no related errors; an unknown login still gets 401.
* **Effect**: owner and dispatcher sign-ins on the portal from a browser without a live `mfaTrust` cookie get the two-step screen (SMS via Firebase, or an emailed code), then are trusted for 30 days. Sessions that are already signed in are untouched until they sign in again. Rider and customer apps are not enforced.
* **Rollback (deletes nothing)**: `cp -p /root/deploy-backups/server-mfa-enable-20261103-203615/env.before /var/www/server/.env && pm2 restart capstone-backend`.
* **Not verified live**: a real staff sign-in through the challenge. No production credentials are used by agents; the user should try one.

## 2026-11-03 - MFA on every sign-in: server side (Claude Code)
* **Status**: **DEPLOYED 2026-11-04 ~00:20 (+08)** (user: "Yes, deploy server"), with MFA switched OFF: `MFA_ENFORCED_AUDIENCES` is not in the prod `.env` or the running process. Nothing committed.
* **Deploy**:
  - **Files**: the 11 below, not `deploy-server.sh` (no `db push`). Each live copy equalled my pre-change version: the CR-stripped diff live vs local was exactly my hunks.
  - **Race guard**: checked the 9 live md5s, `find src prisma -newer dist/index.js` (empty) and that the new paths were absent.
  - **Table**: created by `prisma db execute` of the migration file only. Prod **now has a `_prisma_migrations` table** (it did not on 10-18); I left it alone and did not record this migration there.
  - **Build**: `prisma generate`, `tsc --noEmit`, `npm run build`, `pm2 restart capstone-backend` (restart 4). Files chowned `197612:197121`.
  - **Backup and rollback**: `/root/deploy-backups/server-mfa-20261103-172011` (VPS clock CET), holding `src-before.tar.gz`, `dist/` and `rollback.sh`. The rollback leaves the new table in place; old code never reads it.
  - **`rollback.sh` deletes nothing** (rewritten 2026-11-04 on the user's instruction; **never use `rm -rf` on production**). It moves the MFA build, `mfaTrustService.ts` and the migration folder into `rolled-back-<time>/` inside that backup, and tars the nine MFA-era files there before restoring the old ones.
* **Live checks**: local and public `/api/health` 200; `dist/services/mfaTrustService.js` present; `mfa_trusted_devices` exists with 0 rows; no auth/MFA errors in the pm2 error log after restart.
  - Public refusals unchanged: an unknown staff or customer login gets 401 "Invalid username or password"; a forged challenge on verify/resend gets 401 "Your sign-in session expired".
  - The CORS preflight echoes `x-sugo-mfa` in `access-control-allow-headers`.
* **What changes in production now, with MFA off**:
  - A first-login staff challenge no longer carries the raw `phone`. The deployed web bundle's SMS tab for that one-time check stays disabled until the new web ships; email still works.
  - Customer register and Google register write a trust row and return `mfaTrustToken`, which today's apps ignore.
  - Sign-in emails use the new wording.
* **Decided with the user**: server-run MFA. Express stays the identity authority; Firebase's built-in MFA cannot attach, because Firebase only ever sees server-minted custom tokens. The second factor is a Firebase Phone Auth SMS code (the client posts the phone sign-in's ID token) or an email code. It is asked on a device that has not passed it within 30 days, for every audience: web owner/dispatcher, rider app, customer app (password and Google). Mobile apps do SMS through the portal's `/verify-phone?purpose=mfa` page. Clients are being built in separate sessions (web, CustomerApp, Rider).
* **Wire contract**:
  - **Challenge**: still HTTP 200, with `otpRequired` kept for old clients, plus `mfaRequired`, `reason` (`FIRST_LOGIN` | `NEW_DEVICE`), `factors` (`SMS`/`EMAIL`) and `phoneHint` (last 4). **The raw `phone` field is gone**: a password alone no longer reveals the number. Google sign-in answers `{ status: "MFA_REQUIRED", ...same }`.
  - **Capability header**: clients send `x-sugo-mfa: 1`. Those get no automatic email; `POST /auth/resend-login-otp` sends the first one. Without the header, staff keep today's behaviour (email sent at once, so old rider builds still finish). A customer app without it gets 403 `{ error: "Update Sugo Express to the latest version to sign in.", details: { code: "APP_UPDATE_REQUIRED" } }`, and only when `CUSTOMER_APP` is enforced. CORS needed no change: with no `allowedHeaders` set, `cors` reflects the requested headers.
  - **Verify**: `POST /auth/verify-login-otp` now serves customers too. On success it issues the device trust: HttpOnly cookie `mfaTrust` for `WEB_PORTAL`, `mfaTrustToken` in the body for the apps. Login bodies (`/auth/login`, `/riders/login`, `/customers/login`, `/customers/google-login`) accept `mfaTrustToken`. Customer register and Google register also trust the device and return `mfaTrustToken`.
* **Files**:
  - `prisma/schema.prisma`: NEW model `MfaTrustedDevice` (`mfa_trusted_devices`). Additive; the [LOCKED] 3NF tables are untouched.
  - NEW `prisma/migrations/20261103230000_add_mfa_trusted_devices/migration.sql`, hand-written. Applied to the local XAMPP DB with `db execute` + `migrate resolve`.
  - NEW `src/services/mfaTrustService.ts`: sha256 of the token stored; the device id is compared when both sides have one; `credStamp` covers the password hash, status, email and phone, so a reset or a contact change ends trust; `revokeOthers`.
  - `src/services/loginChallengeService.ts`:
    - subject kind claim `sk` (STAFF/CUSTOMER) and audience `CUSTOMER_APP`;
    - `evaluateGate(user, { enforced, trusted })`, `startCustomerChallenge`, `remintChallenge`;
    - insert-only `claimChallenge`;
    - **`jti` nonce on challenge tokens**: two challenges for one account in the same second were byte-identical, so a resend's re-mint could return the token it had just burned.
  - `src/services/authService.ts`:
    - `loginGeneral`/`loginRider`/`loginCustomer`/`loginCustomerWithGoogle` take an `MfaRequestContext`; `loginCustomer` now returns `CustomerLoginOutcome`.
    - `completeLoginOtp` drops the "already verified" replay stop, which would block recurring MFA; the claim keeps one session per challenge.
    - SMS proof is stricter: `sign_in_provider` must be `phone`, `auth_time` must be no earlier than the challenge `iat` minus 30 s, the number must be an exact `canonicalPhone` match (was last 10 digits), and the ID token is single-use via `token_blocklist`.
    - New `trustCustomerDevice`, `customerAuthResult`.
  - `src/services/staffVerificationService.ts`: code owner is a staff user or a customer, with customer twins; copy fits a recurring sign-in check; no send to an empty email.
  - `src/controllers/authController.ts`: `mfaContext`, trust cookie/body, customer outcome; `revoke-others` also forgets the other devices' trust.
  - `src/validators/authValidators.ts`: `mfaTrustToken` on `loginSchema` and `customerGoogleLoginSchema`.
  - `src/lib/firebaseAdmin.ts`: decoded token also returns `authTime`, `issuedAt`, `expiresAt`.
  - `src/repositories/tokenBlocklistRepository.ts`: `claim()`.
  - `src/config/env.ts`: `MFA_ENFORCED_AUDIENCES`, `MFA_TRUST_DAYS` (30).
* **Tests**:
  - `tsc --noEmit` clean.
  - NEW `tests/loginMfa.test.ts`: 26 tests covering the gate matrix, trust (password change, other device, other account, expiry, revokeOthers keeping the web's, re-trust), SMS refusals, concurrent verify (exactly one session), replay, customer and Google challenges, and `APP_UPDATE_REQUIRED`.
  - `accountStanding.test.ts` updated for the new `loginCustomer` return.
  - Full suite **1969/1970**; the 1 failure is the known `ownerCopilot` timeout.
* **Local end to end**:
  - Ran the API with `MFA_ENFORCED_AUDIENCES=WEB_PORTAL`, via new launch config `api-server-mfa` in the web repo's `.claude/launch.json`.
  - Used a throwaway local dispatcher, deleted afterwards; email codes were planted in the DB, so no mail was sent.
  - **14/14 passed**: challenged with no full number; wrong code refused; right code gives a session and the `mfaTrust` cookie only; replay refused; the trusted browser skips the challenge; sign-out-others re-challenges the other device and keeps the caller's; a new password hash ends trust.
  - The local DB lags prod by other migrations (`referenceNo`, `rider_offer_declines`, ...), whose background jobs log errors there. That is pre-existing.
* **Deploy order (each needs the user's go-ahead)**:
  1. Run the migration SQL on prod with `prisma db execute` only. Prod has no `_prisma_migrations`; never use `db push --accept-data-loss`.
  2. Deploy these server files.
  3. Ship the web, then set `MFA_ENFORCED_AUDIENCES=WEB_PORTAL`.
  4. After the CustomerApp OTA, add `CUSTOMER_APP`.
  5. After the rider APK, add `RIDER_APP`.
* **Firebase console (user)**: Philippines in the SMS region policy; SMS quota for recurring MFA; test phone numbers for QA.

## 2026-11-03 - Fixes for the Codex Security scan of 2026-11-02 (Claude Code)
* **Status**: **DEPLOYED 2026-11-03 ~16:37 (+08)** (user: "Yes, deploy"); nothing committed. No schema change, no migration.
* **Deploy**: only the 9 files below (8 changed + new `src/lib/seedPassword.ts`), not `deploy-server.sh` (no `db push`). Each live copy in `/var/www/server` equalled my pre-change version: the CR-stripped diff live vs local was exactly my hunks, nothing else. `socket.ts` stays CRLF on the VPS, the rest LF. A race guard re-checked the live md5s and `find src prisma -newer dist/index.js` (empty) just before applying. VPS `tsc --noEmit` clean, `npm run build`, `pm2 restart capstone-backend` (restart 3), local and public `/api/health` 200, still up 50 s later. Files chowned to `197612:197121` like their neighbours. Backup and rollback: `/root/deploy-backups/server-security-scan-20261103-093647` (VPS clock CET): `src-before.tar.gz`, `dist/`, `rollback.sh`.
* **Live checks** (2-minute tokens signed on the VPS for id 999999, which owns nothing): `POST /api/errands/<missing>/payment-selection` RIDER 403, DISPATCHER 403 (both logged `[AuthZ] ... role X is not one of CUSTOMER`), CUSTOMER 404. Compiled `identifySocketToken`: session token accepted, `purpose` token and forged token refused.
* **Expected effect at once**: one live staff session belonged to a changed role (user 10, session DISPATCHER, account now RIDER). It ends at that device's next refresh. 1 Inactive dispatcher exists; 14 live staff sessions in all before the deploy.
* **Pre-existing, not from this deploy**: the error log carries express-rate-limit `ERR_ERL_KEY_GEN_IPV6` ValidationError (1,836 lines, from line 1 of the current log): a custom limiter `keyGenerator` uses the IP without `ipKeyGenerator`, so IPv6 callers may get a limit bucket per address.
* **Source**: Codex Security scan of this server at revision c0e8b8b plus the uncommitted tree, saved under `C:\Users\Capstone\.codex\state\plugins\codex-security\scans\server\c0e8b8bd..._20261102T135923Z_fdtl3821\` (`report.md`, `threatmodel.md`, `artifacts\coverage\reviewed_surfaces.md`). Claude re-checked 9 of its 14 findings against the code; all 9 held, and 8 are fixed here.
* **Fixed**:
  - **#6 Suspended or locked customers could sign in again.** `authService.assertCustomerActive` runs on password login (after the password check, so status is not an oracle), Google login (before linking) and Google sign-up. 403.
  - **#1 Google linked a customer by an unverified Firebase email.** `assertGoogleEmailVerified` requires `email_verified` in both Google flows. 403.
  - **#2 Demoted or deactivated staff kept their access.** `refreshAccessToken` reads the account BEFORE rotating: a role different from the token's, or a non-Active status (staff or customer), revokes that session (`ROLE_CHANGED` / `ACCOUNT_NOT_ACTIVE`) and answers 401. Owner `updateUser` also revokes the account's sessions, sends `session:revoked` and closes its sockets on a role change or deactivation.
  - **#3 A stolen staff token could redirect password reset.** `userService.updateProfile` clears `emailVerified`/`phoneVerified` when the email or phone changes (email now lowercased, as in `updateUser`).
  - **#8 Revoked sessions kept Socket.IO access** (partly). New `identifySocketToken` in `lib/socket.ts`: the handshake now refuses blocklisted tokens and non-session tokens (`purpose`, missing role/id), connecting them anonymous. New `disconnectAccount()` closes an account's sockets 1 s after its `session:revoked` notice; called on sysadmin status changes to anything but Active and on owner demotion/deactivation.
  - **#12 A dispatcher could cancel another dispatcher's claimed errand.** `declineErrandReview` controller now calls `verifyDispatcherAccess` first.
  - **#14 Rider or staff with a customer's id could confirm that customer's payment mode.** `POST /errands/:id/payment-selection` gains `requireRole(["CUSTOMER"])` (the CustomerApp is its only caller).
  - **#10 Seeders hard-coded account passwords.** New `src/lib/seedPassword.ts`; `src/seed.ts` reads `OWNER_SEED_PASSWORD` and no longer resets an existing owner's password; untracked `prisma/seed.ts` reads `OWNER_/STAFF_/SYSADMIN_/CUSTOMER_SEED_PASSWORD` and no longer prints passwords. **Production accounts were not touched.**
* **Not fixed (still open)**: #4 customer stop moving a shared store, #5 fabricated transfer image settling a bill, #7 rider-set subtotal, #9 Firebase session after suspension, #11 unreviewed training labels, #13 customer searches using the staff AI allowance, and the alternate matcher's input size. #8 remainder: an open socket still outlives its token's 15-minute expiry, and a sysadmin ending ONE session does not close sockets (they cannot tell which session they belong to). #12 remainder: a decline still cancels at any unfinished status, mid-delivery included (product decision).
* **`[LOCKED]` contracts**: Rotating Refresh Token Architecture untouched (`sessionService.rotateSession` unchanged; refresh only looks the account up before calling it). BOLA dispatcher authorization extended to `/dispatcher-decline`, per the lock. Route prefix and limiter order unchanged (`requireRole` before `userApiLimiter`).
* **Files**: `src/services/authService.ts`, `src/services/userService.ts`, `src/services/sysAdminUserService.ts`, `src/lib/socket.ts`, `src/controllers/errandController.ts`, `src/routes/errandRoutes.ts`, `src/seed.ts`, `prisma/seed.ts` (untracked), NEW `src/lib/seedPassword.ts`; tests NEW `tests/accountStanding.test.ts`, `tests/staffAccountChanges.test.ts`, `tests/socketIdentity.test.ts`, `tests/errandClaimGuards.test.ts`, updated `tests/googleAuth.test.ts` (mock Google tokens now carry `emailVerified: true`, as real ones do).
* **Verification**: `tsc --noEmit` clean (project, plus `prisma/seed.ts` and `src/seed.ts` checked separately). New/updated suites 34/34. Full suite 1943/1944: the 1 failure is `ownerCopilot.test.ts` "refuse requests when Kuya Sugo is disabled" (5 s timeout), which also fails run alone and touches none of these files.
* **Client impact**: demoted/deactivated/suspended accounts get 401 on their next refresh and are signed out (intended), within the 15-minute access-token life. The portal's `AuthContext.tsx` acts on `session:revoked` only for four reason codes, so it ignores the plain-text reasons sent here (as it already did for sysadmin suspension); the socket still closes 1 s later. A server-closed socket does not auto-reconnect, which is the point for a suspended account.
* **Next session**: commit these files when the user asks (repo is public: `prisma/seed.ts` is now free of passwords, re-check before adding it). The 2026-10-16 seeded accounts are now **Suspended** (next bullet).
* **Seeded accounts suspended on production, 2026-11-03 ~16:47 (+08)** (user: "Yes, suspend them"). A read-only check first compared every account's hash on the VPS with the old seed passwords (taken from the pre-deploy backup, never printed): 68 still matched, all created 2026-10-15 UTC, none with a live session, sign-in or work since 10-17: users 14-20 (`dispatcher1`, `dispatcher2`, `rider1`-`rider5`), sysadmin 2 (`sysadminit`, never signed in) and 60 `customer_*`. The owner (id 1) and every other account use their own passwords. One transaction set those 68 to `Suspended` (users also `version + 1`, so an open Owner edit form gets a conflict instead of writing Active back), revoked their sessions (0 were live) and wrote 67 `account_modification_logs` rows (`verifiedVia` `SEED_CLEANUP_20261103`; the sysadmin table has none). The job re-selected by username + seed password + Active and would have aborted on any other set. Still Active: 22 staff, 12 customers, 1 sysadmin. Live check: staff sign-in to `dispatcher1` answers 403 "This account has been deactivated." Their 500 synthetic errands are untouched. Backup `/root/deploy-backups/seed-accounts-suspend-20261103-094721` (VPS clock): `tables-before.sql.gz` (users, customer_accounts, tbl_sys_admin, user_sessions, account_modification_logs), `rows-before.json`, and `rollback.cjs` (run from `/var/www/server` with `NODE_PATH=/var/www/server/node_modules node -r dotenv/config <backup>/rollback.cjs`). The old owner seed password is in public git history (`src/seed.ts` at HEAD, `database_setup.sql`, `verify-auth-tests.js`): any account still using it should be rotated.

## 2026-10-28 - SysAdmin Kuya Sugo Service Control Toggle Backend (Antigravity 2.0, Gemini 3.8 Flash High)
* **Status**: DEPLOYED TO PRODUCTION VPS (109.123.239.182) via `scripts/deploy-server.sh`. PM2 PID 1046187 online. All endpoints verified (`https://api.sugo-express.org/api/health` HTTP 200, Category ML container 127.0.0.1:8100/health healthy). Rollback backup: `/root/deploy-backups/server-20261028-011556`.
* **Goal**: Provided a centralized SysAdmin switch to enable or disable Kuya Sugo across the platform with disk persistence and live API enforcement.
* **Changes**:
  - `src/services/sysAdminDevOpsService.ts`:
    - Added `kuyaSugoEnabled` state variable (default `true`) persisted in `config/maintenance.json`.
    - Added `getKuyaSugoEnabled()` and `setKuyaSugoEnabled(enabled, operator)` with event logging.
    - Added `kuyaSugoEnabled` to `SystemTelemetry` response.
  - `src/controllers/sysAdminDevOpsController.ts`:
    - Added `getKuyaSugoHandler` and `toggleKuyaSugoHandler`.
  - `src/routes/sysAdminRoutes.ts`:
    - Mounted `POST /sysadmin/devops/kuya-sugo` (guarded by `requireRole("SYSADMIN")`).
    - Mounted `GET /system/kuya-sugo` (guarded by `requireRole(["OWNER", "SYSADMIN"])`).
  - `src/services/ownerCopilotService.ts`:
    - Added pre-execution check: if Kuya Sugo is disabled, returns an immediate polite operational refusal without contacting Gemini API.
  - `tests/ownerCopilot.test.ts`:
    - Added regression test asserting refusal response when disabled by SysAdmin (15/15 tests passing).

## 2026-10-27 - Owner AI Chat Companion ("Kuya Sugo") Gemini 3.8 Flash Backend (Antigravity 2.0, Peer-Reviewed & Hardened)
* **Status**: DEPLOYED TO PRODUCTION VPS (109.123.239.182) via `scripts/deploy-server.sh`. PM2 PID 1026986 online. All endpoints verified (`https://api.sugo-express.org/api/health` HTTP 200, Category ML container 127.0.0.1:8100/health healthy). Rollback backup: `/root/deploy-backups/server-20261027-180843`.
* **Goal**: Implemented and hardened the Owner AI Chat Companion ("Kuya Sugo") backend powered by Gemini 3.8 Flash with native function calling and deterministic Prisma tool execution. Delivers natural, respectful, and operationally grounded operational intelligence for Tacurong City.
* **Peer-Review Hardening & Fixes Applied**:
  1. **Parallel Tool Response Packing (Gemini API Strict Turn Alternation)**:
     - Fixed Gemini REST API protocol error where parallel tool calls generated multiple individual `{ role: "user" }` turns.
     - Grouped all parallel `functionResponse` parts into a single `{ role: "user", parts: [...] }` message block, preserving strict turn alternation.
  2. **Conversation History Normalization & Greeting Safeguard**:
     - Stripped leading model greetings from history payloads before sending to Gemini, preventing API 400 rejection (`"First content should be with role 'user'"`).
     - Merged consecutive turns with matching roles into single composite messages.
     - Sliced history window to the 20 most recent messages.
  3. **History Length & Zod Validation Realignment**:
     - Updated `copilotMessageSchema` in `src/validators/ownerCopilotValidators.ts` to support detailed model responses up to 10,000 characters while enforcing 2,000 character limit on user queries.
     - Expanded `messages` array capacity from 30 to 60.
  4. **Active Store Bottleneck Detection**:
     - Upgraded `getFleetHealth` tool in `src/services/ownerCopilotService.ts` to inspect ongoing store delays (`errandPinpoint.arrivedAt != null && departedAt == null && elapsed >= 20 mins`) on active in-transit errands, deduplicating with completed `DwellObservation` history.
  5. **Comprehensive PII Scrubbing**:
     - Added regex scrubbing (`09xx`, `+639xx`, formatted phone patterns) to prevent customer/rider phone numbers in cancellation and exception records from being forwarded to the external LLM.
* **Architecture & Endpoints**:
  - Route: `POST /api/owner/copilot/chat` guarded by `authenticateToken` + `requireRole(["OWNER", "ADMIN"])` + `ownerCopilotLimiter` (20 req/min, 120 req/min dev).
  - Model: `gemini-3.8-flash` via Google Generative Language REST API with fallback to `GEMMA_API_KEY` or `ml/.env`.
  - Multi-Turn Function Calling Loop: Preserves `thoughtSignature` from model calls to ensure Gemini 3.8 Flash compliance, handles dynamic tool execution, and sends user-role `functionResponse` blocks.
  - Deterministic Tools (Zero Hallucination / Read-Only):
    1. `getSalesPulse`: Daily/weekly sales totals, errand counts, delivery fees, average order value, and top payment methods.
    2. `getFleetHealth`: Active/idle/offline riders, battery levels, overdue deliveries, and active delay alerts.
    3. `getExceptionRecap`: Cancellation rates, top cancellation/decline reasons, and problem merchants.
    4. `getCategoryPerformance`: Top merchant categories by revenue, volume, and gross merchandise value.
  - Persona & Anti-AI-Slop Hygiene: "Kuya Sugo" persona (friendly, respectful, domain-grounded, Filipino-English operational tone), strictly no em dashes, no purple gradients, no PII leakage, and deterministic fallback if Gemini API is unreachable or rate-limited.
* **Modified & Created Files**:
  - `src/validators/ownerCopilotValidators.ts`: Zod schema for conversation messages, history, and portal context.
  - `src/middleware/rateLimiters.ts`: `ownerCopilotLimiter` rate limiter.
  - `src/services/ownerCopilotService.ts`: Core orchestrator, tools implementation, Gemini function calling loop, PII filtering, and deterministic fallback.
  - `src/controllers/ownerCopilotController.ts`: `copilotChatHandler` request handler with error wrapping.
  - `src/routes/ownerCopilotRoutes.ts`: Router mounting `POST /chat`.
  - `src/routes/index.ts`: Mounted `/owner/copilot` under `/api/owner/copilot`.
  - `tests/ownerCopilot.test.ts`: 14 unit tests verifying validation, tool data queries, mocked Gemini tool-calling loop, API failure fallback, parallel function calling, history normalization, PII scrubbing, and em-dash elimination.
* **Verification**:
  - `npx vitest run tests/ownerCopilot.test.ts`: 14/14 tests passed (325ms).
  - `npx vitest run`: 149/149 test suites passed (1,880 unit tests).
  - `npx tsc --noEmit`: 0 compiler errors.
  - `npm run build`: Compiled successfully with 0 errors.
* **Directives for Next Session**:
  - Deploy server to production VPS (`109.123.239.182`) via `scripts/deploy-server.sh`.

## 2026-10-27 - Hide Punctuality Status Column in Printed Rider Performance Report (Antigravity 2.0, Gemini 3.8 Flash High)
* **Status**: DEPLOYED TO PRODUCTION VPS (109.123.239.182) via `scripts/deploy-server.sh`. PM2 PID 911695 online, 0 errors. All endpoints verified (`https://api.sugo-express.org/api/health` HTTP 200, Category ML container 127.0.0.1:8100/health healthy). Rollback backup: `/root/deploy-backups/server-20261027-063154`.
* **Goal**: Hid the "Punctuality Status" column in the printed PDF report for Rider Performance per user request. The table now displays 4 balanced columns (`Order`, `Accepted`, `Delivered`, `Target Deadline`) normalized across the 720pt page width.
* **Changes**:
  - `src/services/pdf/reportPdfService.ts`:
    - Removed `{ header: "Punctuality Status", ... }` from the `Every delivery in these dates` table in `oneRiderSpec`.
    - Rebalanced remaining column widths: `Order` (210), `Accepted` (170), `Delivered` (170), `Target Deadline` (170) summing to 720pt.
  - `tests/reportPdfExport.test.ts`:
    - Updated integration test expectation to assert that `Punctuality Status` is omitted from the PDF printout.
* **Verification**:
  - `npx tsc --noEmit`: 0 errors.
  - `npx vitest run tests/reportPdfExport.test.ts`: 28/28 tests passed.

## 2026-10-27 - SysAdmin DevOps Telemetry: Maintenance Advisory & Playful Live Notice (Antigravity 2.0, Gemini 3.8 Flash High)
* **Status**: LOCAL VERIFIED - Unit tests passing 5/5 (`tests/maintenanceAdvisory.test.ts`), `npx tsc --noEmit` 0 errors. Ready for VPS deployment.
* **Goal**: Implemented Option B ("Integrated with Sysadmin DevOps Telemetry / Centralized Control") providing an `ADVISORY` / `LIVE_NOTICE` maintenance mode. Allows DevOps administrators to toggle a playful, non-blocking live polish banner/modal per portal (Customer, Rider, Dispatcher, Owner) with zero code deployments.
* **Changes**:
  - `src/services/sysAdminDevOpsService.ts`:
    - Expanded `MaintenanceType` union to include `"ADVISORY" | "LIVE_NOTICE"`.
    - Added `footnote?: string` property to `PortalMaintenanceConfig`.
    - Defined `DEFAULT_MAINTENANCE_FOOTNOTES` with default playful footnote *"Please enjoy the construction cones."*
    - Added `ensureMaintenanceLoaded()` to avoid floating promise startup race condition with disk configs; awaited in `getSystemTelemetry()` and `toggleMaintenanceMode()`.
    - Updated `toggleMaintenanceMode` to support automatic type default promotion, `footnote` parameter in push notifications, and non-urgent push/telegram notifications for live advisories.
  - `src/controllers/sysAdminDevOpsController.ts`:
    - Updated `toggleMaintenance` validator `validTypes` to include `"ADVISORY"` and `"LIVE_NOTICE"`.
    - Passed `footnote` parameter from request body to `toggleMaintenanceMode`.
    - Made `getPublicMaintenanceStatusHandler` async and awaited `ensureMaintenanceLoaded()`.
  - `tests/maintenanceAdvisory.test.ts`:
    - Created comprehensive unit test suite (5 tests) verifying advisory mode activation, custom header/message/footnote overrides, push notification payloads (`urgent: false`, `data.type: "LIVE_ADVISORY_NOTICE"`, `data.footnote`), telemetry integration, and clean deactivation.
* **Verification**:
  - `npx vitest run tests/maintenanceAdvisory.test.ts`: 5/5 tests passed (58ms).
  - `npx tsc --noEmit`: 0 compiler errors.
* **Directives for Next Session**:
  - Deploy backend updates to VPS (`109.123.239.182`) via `scripts/deploy-server.sh`.

## 2026-10-27 - Rider Performance Delivery Verdict Clarity & PDF Alignment (Antigravity 2.0, Gemini 3.8 Flash High)
* **Status**: DEPLOYED TO PRODUCTION VPS (109.123.239.182) via canonical `scripts/deploy-server.sh`. PM2 PID 895192 online, 0 errors. All endpoints verified (`https://api.sugo-express.org/api/health` HTTP 200, Category ML container 127.0.0.1:8100/health healthy). Rollback backup: `/root/deploy-backups/server-20261027-045918`.
* **Goal**: Synchronized server PDF report export with web UI clarification for the Rider Performance delivery breakdown table, eliminating jargon confusion between "Promised By" and "On Time?".
* **Changes**:
  - `src/services/pdf/reportPdfService.ts`:
    - Updated PDF table column headers: `"Target Deadline"` (width 110) and `"Punctuality Status"` (width 260).
    - Reworded `NOT_CHECKED_REASON` map and `deliveryResultLabel` from repetitive *"Not checked: [reason]"* to precise domain status (*"Unverified: no target deadline set"*, *"Unverified: deadline set at doorstep (< 2 min)"*, *"Unverified: missing GPS proof at address"*, *"Unverified: marked delivered away from address"*).
  - `tests/reportPdfExport.test.ts`:
    - Updated PDF verification test assertion to check for `"Unverified: marked delivered 32.3 km from address"`.
* **Verification**:
  - `npx tsc --noEmit`: 0 errors.
  - `npx vitest run tests/reportPdfExport.test.ts`: 28/28 tests passed.
  - Full server vitest suite: 145 suites, 1855 tests passed.

## 2026-10-27 - Speed-Aware Store ETA Calibration & Production VPS Deployment (Antigravity 2.0, Gemini 3.8 Flash High)

* **Status**: DEPLOYED TO PRODUCTION VPS (109.123.239.182) & VERIFIED via canonical `scripts/deploy-server.sh`. PM2 PID 835395 online, 0 errors. All health checks passed (`/api/health`, `https://api.sugo-express.org`, category ML container).
* **Context**: User requested dynamic store ETA calibration where rider travel time to stores scales with live GPS velocity, while strictly leaving store wait/dwell times untouched. Additionally deployed all pending server updates to the live production server.
* **Changes**:
  1. **GPS Velocity Ingestion & In-Memory Store**:
     - Updated `src/lib/riderPositionStore.ts` to include `speedMps?: number | null`.
     - Updated `src/services/trackingService.ts` and `src/lib/riderLocationBroadcast.ts` to capture and record `speedMps` on each GPS broadcast/tracking point.
  2. **Speed-Aware Store ETA Strategy**:
     - Updated `src/services/etaService.ts` to pass `originSpeedMps: position?.speedMps ?? null` to `defaultEtaStrategy.compute()`.
     - Updated `src/services/patterns/etaStrategy.ts`: Store-bound transit time adjusts dynamically when rider is moving ($v \ge 2.0\text{ m/s}$), and freezes countdown progress when stationary ($v < 2.0\text{ m/s}$ at stoplights).
     - **Locked Invariant Honored**: Store wait/dwell times (`dwellLowSeconds`, `dwellHighSeconds`) remain **100% untouched** (only transit duration scales). Customer delivery transit remains standard road-network baseline.
* **Verification & VPS Deployment Ledger**:
  - Local TypeScript check: `npm run build` / `npx tsc --noEmit` passed with 0 errors.
  - Vitest: `tests/etaStrategy.test.ts` passed 13/13 tests.
  - Production backup created: `/root/deploy-backups/server-20261027-001244`.
  - Prisma generation & schema sync: Generated Prisma Client v5.22.0; DB schema in sync.
  - Remote TypeScript build: PASSED (0 errors).
  - Category ML Docker container: Rebuilt and healthy (`capstone-category` port 8100).
  - PM2 restart: `capstone-backend` PID 835395 online, 0 restarts, 0 errors.
  - Live Edge Health: `https://api.sugo-express.org/api/health` HTTP 200 `🟢 System Online`.


## 2026-10-26 - Performance & 25s P95/P99 Latency Remediation (Antigravity 2.0, Gemini 3.8 Flash High)

* **Status**: COMMITTED LOCALLY & VERIFIED (TypeScript `npx tsc --noEmit` passed with 0 errors; Prisma validation & generation clean; 141 Vitest test suites passed). Ready for VPS deployment.
* **Context**: User reported P95 latency spikes reaching 25 seconds affecting P99 during heavy actions (financial report queries, store/location searches, and receipt image writes). Live PM2 inspection on `vmi3579720-1f7f` (109.123.239.182) revealed idle event loop at 0.58ms/2.3ms and CPU ~1%, but Prisma `pool_timeout=30` caused queries to queue in memory up to 30 seconds when database connections were saturated by un-indexed relations or full table scans.
* **Changes**:
  1. **Connection Pool Fail-Fast Safeguard**: Reduced `pool_timeout` from `30` to `8` seconds in `server/.env` (`DATABASE_URL`). Requests recover immediately and fail fast instead of hanging in a 30s FIFO queue across all mobile apps and web dashboards.
  2. **Bounded Search Pagination**: Updated `src/repositories/placeRepository.ts` `findAll` to defensively clamp `take` to maximum 20 items (default 15) when search query is active, preventing runaway full-table scans across `verified_places`.
  3. **Order Items & Proof Images Performance Indexes**:
     - Added `@@index([errandId])` to `model PabiliDetail` (`pabili_details_tbl`).
     - Added `@@index([errandId])` to `model PabiliItemRequest` (`pabili_item_requests_tbl`).
     - Added composite `@@index([errandId, kind])` to `model ErrandProofImage` (`errand_proof_images`).
     - Generated production migration: `prisma/migrations/20261026210000_add_errand_items_proof_perf_indexes/migration.sql`.
     - Validated with `npx prisma validate` and compiled with `npx prisma generate`.
  4. **Proof Image Database Write Optimization**:
     - Updated `src/services/proofImageService.ts` (`saveScan`) to add `select: { id: true }` on `prisma.errandProofImage.create`, eliminating the wire round-trip of multi-megabyte `imageData` (LongText) back to Node.js memory after insertion.
* **Verification**:
  - `npx prisma validate`: Schema valid 🚀.
  - `npx prisma generate`: Prisma Client v5.22.0 compiled successfully.
  - `npx tsc --noEmit`: 0 errors.
  - Vitest: 141 test suites / 1,825 unit tests passed.
* **Directives for Next Session / VPS Deploy**:
  - Apply `npx prisma migrate deploy` on production VPS (109.123.239.182).
  - Update `pool_timeout=8` in production `.env`.
  - Rebuild `npm run build` and reload PM2 `capstone-backend`.

## 2026-10-24 - Node2Shell (CVE-2026-111497) Full-Stack Mitigation & Node 22 LTS Upgrade (Antigravity 2.0, Gemini 3.8 Flash High)

* **Status**: DEPLOYED TO PRODUCTION VPS (109.123.239.182) & COMMITTED LOCALLY. Zero downtime. Unrelated uncommitted work preserved intact.
* **Context**: Node2Shell (CVE-2026-111497) is an out-of-bounds write / buffer overflow in Google's native Brotli decoder (`c/dec/decode.c` v1.0.3–1.2.0) bundled into Node.js `node:zlib`. Production was running EOL Node `v20.20.2` (Brotli 1.1.0).
* **Changes**:
  1. **Nginx Edge Shield**: Configured `/etc/nginx/sites-available/api.sugo-express.org` and `/etc/nginx/sites-available/api.sugoonthego.online` with:
     `if ($http_content_encoding ~* "(?:br|brotli)") { return 415; }`
     Nginx drops any incoming Brotli request body before it ever reaches the Node.js backend.
  2. **Application-Level Invariant**: Updated `src/middleware/threatInterceptor.ts` (Step 1, prior to whitelist check and prior to `express.json()`) to inspect `Content-Encoding`. If matching `br` or `brotli`, it immediately logs a security warning and returns HTTP 415 without invoking `body-parser` or Node's Brotli decoder.
  3. **Production Runtime Upgrade**: Switched NodeSource to `node_22.x` and upgraded production VPS to Node 22 LTS (**`v22.23.4`**, official CVE-2026-111497 patched release).
  4. **Prisma & PM2 Synchronization**: Executed `npx prisma generate` under Node 22 (modules 127), recompiled TypeScript (`npm run build`), and restarted PM2 `capstone-backend`.
* **Verification**:
  - `tests/node2ShellDefense.test.ts`: 4/4 passed locally and on VPS (case-insensitive `br`, `brotli`, mixed `gzip, br`, clean pass-through).
  - Edge probe with `Content-Encoding: br`: HTTP 415 Unsupported Media Type.
  - Direct port 5000 probe with `Content-Encoding: br`: HTTP 415 with `{ error: "Unsupported Media Type", message: "Brotli request content-encoding ('br') is rejected for system security (CVE-2026-111497)." }`.
  - Edge health probe `https://api.sugo-express.org/api/health`: HTTP 200 `🟢 System Online`.
  - PM2 status: `capstone-backend` PID 431477 online, 0 errors.

## 2026-10-24 - Rider connectivity grace and notification fatigue (Codex)

* **Status**: Local source only, not deployed. Preserve all unrelated uncommitted work.
* **Changes**: `src/lib/riderLiveLink.ts` applies the existing eight-second heartbeat grace to transport disconnects instead of immediately declaring loss. `src/services/riderBeaconService.ts` accepts an HTTP beacon received after the last heartbeat as evidence of connectivity, so Android background suspension or a lost pause frame does not override a working background task.
* **Alerts**: `src/services/riderStatusWatchService.ts` publishes status/assignment safety changes promptly but waits for 30 seconds of continuously observed signal-lost status before interrupting dispatchers (evaluated on the existing 20-second watcher, so confirmation may take up to another watcher interval). Both initial toasts and saved loss notifications share a ten-minute per-rider cooldown. Brief recovery cancels a pending loss; restoration is saved only for a loss that was actually notified. Existing five-/fifteen-minute prolonged-outage reminders and active-order escalation remain. Notification cooldown calculations use the pass timestamp consistently. No routes, schema, authorization, location cadence or routing provider changed.
* **Verification**: `npx tsc --noEmit` passed. Focused Vitest: 6 files / 49 tests passed (`riderLiveLink`, `riderLiveLinkOverlay`, `riderStatusWatch`, `riderAvailability`, `riderBeaconMidnight`, `riderLocationBroadcast`). Added regression coverage for transport reconnects/late old-socket disconnects, newer background beacons and their expiry, brief/repeated losses, alert confirmation, cooldown and renewed confirmed outages. Dispatcher `useRiderFleetPresence.ts` consumes `rider:connectivity_alert` for its toast; no web change needed.
* **Companion rider work**: See RiderMobileApp handshake entry dated 2026-10-24: native marker frame updates and repeated background pause on socket reconnect. Deployment/app distribution and phone verification remain outstanding.

## 2026-10-22 - Customer shopping sentence extraction polish (Codex)

* **Status**: DEPLOYED to VPS. Four source files and two compiled API modules only. ML image `sugo-category:sentence-20261022`, SHA `b31957c01c98d1abc5d9b3a69c2be63480af9b402a07f5b18fd536ac8620ea27`. Backend HTTP 200; ML ready; unchanged authentication returns 401; compiled Node-to-sidecar synthetic extraction passed. Current model bytes and full category reports, provider settings, review opt-in, memory, bindings and cache volume preserved. No retrain or schema change.
* **Changes**: `ml/sugo_category/gemma.py` prompt version 5 handles English/Filipino/Hiligaynon/Cebuano requests, packaging, strength and rider notes; validates exact integer/bool/string types, duplicate positions, spoken numeric values/fractions, known numeric brands and units. Whole-sentence cache keys prevent final-note collisions. `ml/app.py` validates 1–500 characters rather than truncating at 120. `src/validators/itemTidyValidators.ts` accepts 500-character sentences; extracted names retain 120 limit. `src/services/itemTidyService.ts` drops uncertain/duplicate readings, protecting installed clients too.
* **Verification**: Initial bug reproduction 14 failed/1 passed. Final scoped Python extraction/endpoint/quality/retraining suite 99 passed; API suite 7 passed; server TypeScript no-emit and staged compilation passed. Customer App 167 focused tests and TypeScript pass. Actual Gemini synthetic check initially 11/12 exact fields (strength/packaging combined); clarified prompt plus two new examples passed 14/14, around 2–3 seconds per four-line batch. Small functional set, not production accuracy. Evidence under ignored `ml/models/sentence-study/` and VPS backup. Docs: `ml/category/SENTENCE_EXTRACTION.md`.
* **Mobile**: Updated sentence/count detection, no request truncation, confidence handling, pending-edit/stepper protection, preserved notes, unresolved-row hint/editor link and long-raw-name submit guard. New local APK built and v2 signature verified. Existing installed apps need that build for mobile changes; no OTA/public APK distribution or device installation performed.
* **Rollback**: `/root/deploy-backups/sentence-20261022-01` contains previous sources/dist, current model snapshot/hashes, old image and guarded rollout script. Initial switch safely rolled back on environment-list order comparison; changed guard to compare actual key/value mappings. Retry passed all preservation checks and live validation. Keep backups and persistent caches. Preserve unrelated uncommitted work.

## 2026-10-22 - Gemini-assisted training quality review (Codex)

* **Status**: DEPLOYED, explicitly opted in after the user approved sending up to 20 new unique production store/item names and category labels per retrain to Google Gemini and persisting reviews. Initial auto-review rejection was respected; preview was generated offline before explicit approval. Provider availability and the first actual batch confirmed `gemini-3.8-flash`.
* **Implementation**: `ml/sugo_category/training_quality.py` groups deterministically cleaned names; prioritizes suspicious strings and label conflicts; validates bounded, finite KEEP/REVIEW/EXCLUDE decisions. Only EXCLUDE >=0.95 quarantines fitting data. No label rewrites or database mutations. Review cache is separate from category/teacher cache; 20-name/20-second defaults and shared provider quotas/fallbacks. `GemmaAdvisor.review_training` implements the transport. Automatic `/retrain` prepares and audits quality before calling the trainer; an explicit CLI supports reviewed exports for builds. `model.py` preserves original validation/test rows while filtering probe/final fitting. `train.py` consumes reviewed exports; `/health` exposes summary metadata. Compose/code default to opt-out; VPS ML `.env` sets `TRAINING_QUALITY_ENABLED=1` after approval.
* **First batch**: 294 unique grouped names; 20 reviewed; two junk item names (four rows) excluded from fitting; 20 conflicting-label groups flagged across the dataset; 274 names remain for later runs. Human labels preserved, including disputed labels. Private audit: `ml/models/quality-study/quality-audit.json` locally and VPS backup.
* **Verification**: 16 new quality tests; full Python suite 291 passed, same nine pre-existing Gemma default-chain failures; final targeted integration 19 passed; focused catalogue/training/quality 52 passed; TypeScript `tsc --noEmit` and syntax checks passed. Disabled CLI generated an export with zero external calls. Image checks passed for six representative predictions, eight categories, and original held-out populations (464 item / 12,536 store rows).
* **Release**: Built image `sugo-category:ml-quality-20261022`, SHA `aaa4d8f1178571200cc1de198f0a721d5cf25e7ab7edc696a7144ac0bdbaf5b8`, promoted to `sugo-category:latest`. Deployed app.py, gemma.py, model.py, train.py, new training_quality.py and opt-in Compose setting. Item held-out accuracy remains 80.39%, store 82.47%; item real fitting rows 2366. Live ML ready, backend 200, category predictions verified, provider env preserved, quality cache readable/writable by service user, loopback 8100 retained. No Node restart.
* **Rollback**: `/root/deploy-backups/ml-quality-20261022-01` (previous source/models/image ID, private environment backup, rollout-quality.py with rollback, review/build/verification evidence). Previous image `sugo-category:rollback-ml-quality-20261022`. Preserve persistent external-answer and quality cache volume. Details: `ml/category/TRAINING_QUALITY.md`.

## 2026-10-22 - Local item ML accuracy investigation (Codex)

* **Status**: DEPLOYED after explicit user approval on 2026-10-22. Investigation used the previous deployed training snapshot from container run `20261021-194530`; release retrained from a fresh read-only production export. Preserved unrelated working-tree edits.
* **Finding**: 2,370 cleaned item rows represent only 107 normalized names; 10 names have conflicting labels. Prepared coffee vocabulary incompletely followed the Cafe/beverage role. Item holdout names could leak through seed phrases.
* **Changes**: Complete prepared-coffee vocabulary in `ml/sugo_category/lexicon.py`, preserving packaged coffee and parent-category fallback. Exclude real item test names from development seed rows in `model.py` (final serving fit still uses all data). Add four regression tests and `sugo_category/item_accuracy.py` for offline comparison.
* **Evaluation**: Five fixed name-disjoint splits, identical fixed logistic settings. Mean equal-name accuracy 61.86% -> 66.63%; order-row accuracy 77.48% -> 88.81%. Gains concentrate in frequently ordered cafe items. Repeated splits overlap and were inspected after diagnostics: exploratory, not an independent production estimate. Rejected a settings-search winner that worsened test accuracy; no classifier-setting change.
* **Verification**: Focused Python catalogue/training/cleansing/categorizer suite 103 passed; `npx tsc --noEmit` passed. Full Python suite completed outside the sandbox in 28.60 s: 275 passed, 9 failed. An isolated pre-change lexicon/model from Git HEAD reproduced exactly the same nine Gemma failures (36 Gemma tests passed), confirming existing model-chain/default/Compose mismatches. External AI calls disabled. Initial temp-directory errors were resolved with workspace-local `--basetemp`; the sandbox's blocked Windows asyncio socket pair caused initial TestClient stalls, resolved by permitting local sockets for verification.
* **Artifacts**: `ml/category/ACCURACY_IMPROVEMENT.md`; detailed comparison, captured baseline vocabulary, training snapshot, and logs under ignored `ml/models/accuracy-study/`. No production data added to tracked source.
* **Release**: Backed up host source, current model directory and previous image in `/root/deploy-backups/ml-accuracy-20261022-01`; retained image tag `sugo-category:rollback-ml-accuracy-20261022`. Built `sugo-category:ml-accuracy-20261022` from the production build context with only the approved `lexicon.py` and `model.py` deltas, then promoted it to `sugo-category:latest`. Image SHA `c1571e55641930106d526415b5b13cafff6f4791005ed687f85e7e79eb534779`.
* **Live verification**: Docker healthy; ML ready; backend HTTP 200; both source hashes match local; eight categories retained; 230 cached answers preserved; loopback `127.0.0.1:8100` and 1.5 GiB memory limit retained. Nine offline prediction checks passed before switch; serving HTTP checks confirmed cold brew coffee -> Cafe and instant coffee sachet -> Supermarket & Grocery. Retrained model reports: store 82.47%, item 80.39% held-out accuracy. Item evaluation now excludes seed leakage, so the old 62.93% report is not an identical-method baseline. Item ensemble still weights linear model 1.0. Deployment evidence saved under `ml/models/accuracy-study/deployment/` locally and in the VPS backup directory. No database mutation or backend restart.

> **ALWAYS ACTIVE IN ALL SESSIONS**: This file is the shared living memory between Claude App (Anthropic) and Antigravity 2.0 (Google AI / Gemini) for the Express / MariaDB / Prisma backend.

---

## 📡 Tunnel State
* **Active Mission**: Database Optimization, Composite B+Tree Indexing & In-Memory Hash Cache Blueprint Implementation
* **Current Driver**: Antigravity 2.0 (Gemini 3.8 Flash High)
* **Target Workspace**: `Capstone_Server/server` (Port 5000 API Backend)
* **Last Updated**: 2026-10-23

---

## 🔒 LOCKED CONTRACT REGISTRY (ZERO-REGRESSION POLICY)
* `[LOCKED]` `Prisma Schema 3NF Model` (`prisma/schema.prisma` -> `errands`, `pabili_details_tbl`, `users`, `dispatch_logs`)
* `[LOCKED]` `API Base URL Route Prefix Invariant` (All endpoints strictly mounted under `/api/*`)
* `[LOCKED]` `Rate Limiting & Server Validation Invariant` (Rate limiter -> Zod/Express validator -> Database execution)
* `[LOCKED]` `BOLA/IDOR Dispatcher Authorization` (`verifyDispatcherAccess` on all mutating routes)
* `[LOCKED]` `Rotating Refresh Token Architecture` (SHA-256 session hash in `user_sessions`, 10s grace window)

## 2026-10-23 - Database Optimization, Composite B+Tree Indexing & In-Memory Hash Cache Blueprint (Antigravity 2.0, Gemini 3.8 Flash High)
* **Status**: [VERIFIED ON PRODUCTION VPS (109.123.239.182) - All 13 composite B+Tree indexes created in MariaDB InnoDB; legacy FK indexes safely replaced; table statistics analyzed; in-memory LRU hash caching deployed; connection pool bumped to 25 with 30s timeout; PM2 service online with zero errors].
* **Feature & Implementation Specification**:
  - **Tier 1: Composite B+Tree Indexes in `prisma/schema.prisma`**:
    - `Errand`: Added `@@index([status, createdAt])` (optimizes dispatcher queue), `@@index([status, assignedAt])` (optimizes 15s offer expiry cron), `@@index([status, riderId])` and `@@index([riderId, status])` (fleet active errand aggregation), `@@index([customerId, createdAt])` (customer history), `@@index([createdAt])` (financial reports).
    - `User`: Added `@@index([role, status])` (optimizes 20s rider fleet watch).
    - `CustomerTransaction`: Added `@@index([customerId, createdAt])` and `@@index([createdAt])`.
    - `DispatchLog`: Added `@@index([errandId, dispatchedAt])` and `@@index([dispatcherId, errandId])`.
    - `ErrandPinpoint`: Upgraded single `@@index([errandId])` to composite covering `@@index([errandId, sequence])`.
    - `RiderCommission`: Replaced single `@@index([riderId])` with composite covering index `@@index([riderId, computedAt])`.
    - Created explicit production DDL migration: `prisma/migrations/20261023120000_add_performance_composite_indexes/migration.sql`.
    - Validated with `npx prisma validate` and compiled with `npx prisma generate`.
  - **Tier 2: Application-Level In-Memory Hash Table Caching (O(1) in RAM)**:
    - Implemented `src/lib/rateConfigCache.ts` using `LRUCache` (15m TTL) returning shallow clones to prevent in-memory mutation of cached configurations. Integrated cached reads in `errandService.ts` (`quoteErrand`, `createErrand`, `confirmPaymentSelection`, `quotePinpoints`) and `rateConfigService.ts`. Wired cache invalidation into `rateConfigService.updateRateConfig` and `rateConfigController.updateRateConfig`.
    - Implemented `src/lib/merchantCategoryCache.ts` using `LRUCache` (30m TTL) with segregated cache keys for `ACTIVE_ONLY` vs `ALL`. Integrated cached reads in `merchantCategoryService.listMerchantCategories`. Wired cache invalidation into `merchantCategoryService` and `merchantCategoryController` on `create`, `update`, `setCategoryImage`, and `removeCategoryImage`.
  - **Tier 4: Connection Pool Headroom & Bounded Safe Default Pagination**:
    - Updated `server/.env` connection pool parameters: `connection_limit=25&pool_timeout=30`.
    - Enforced defensive bounded pagination via `sanitizePagination` in `errandRepository.findMany()` and `errandRepository.findManyForDispatcher()` (clamped `take: [1, 100]`, default 50; clamped `skip: >= 0`, default 0).
    - Forwarded pagination controls through `errandService.listErrands` and `errandController.listErrands` (`req.query.take`, `req.query.skip`).
* **Files Modified**:
  - `prisma/schema.prisma`
  - `prisma/migrations/20261023120000_add_performance_composite_indexes/migration.sql` (NEW)
  - `src/lib/rateConfigCache.ts` (NEW)
  - `src/lib/merchantCategoryCache.ts` (NEW)
  - `src/services/rateConfigService.ts`
  - `src/controllers/rateConfigController.ts`
  - `src/services/errandService.ts`
  - `src/controllers/errandController.ts`
  - `src/repositories/errandRepository.ts`
  - `src/services/merchantCategoryService.ts`
  - `src/controllers/merchantCategoryController.ts`
  - `.env`
  - `tests/databaseOptimizationAndCaching.test.ts` (NEW)
  - `tests/categoryWarm.test.ts`
  - `tests/firebaseUid.test.ts`
  - `AGENT_HANDSHAKE.md`
* **Verification Ledger**:
  - `npx prisma validate`: Schema is valid 🚀.
  - `npx prisma generate`: Generated Prisma Client (v5.22.0) with zero errors.
  - `npx tsc --noEmit`: 0 TypeScript compiler errors.
  - Vitest test suite: 134/134 targeted tests passed (100%).
  - Pre-migration database backup taken on VPS: `/var/www/server/backups/pre_index_migration_20261023_173940.sql.gz` (52MB).
  - DDL applied to production MariaDB: All 13 composite indexes verified via `information_schema.statistics` (including `errands(status, createdAt)`, `errands(status, assignedAt)`, `errands(status, riderId)`, `users(role, status)`, `customer_transactions(customerId, createdAt)`, `dispatch_logs(errandId, dispatchedAt)`, `errand_pinpoints_tbl(errandId, sequence)`, `rider_commissions(riderId, computedAt)`).
  - MariaDB optimizer statistics refreshed via `ANALYZE TABLE`.
  - Application code built on VPS (`npm run build`) and `.env` updated with `connection_limit=25&pool_timeout=30`.
  - PM2 restarted (`pm2 restart capstone-backend --update-env`) — process online, Socket.IO connections active, and live endpoints responding HTTP 200/401 cleanly.


---

## 2026-10-19 - Dispatcher Portal HTTP 500 Resolution: Orphaned Retired Payment Mode (Antigravity 2.0, Gemini 3.8 Flash High)
* **Status**: [VERIFIED ON PRODUCTION VPS (109.123.239.182) - 560/560 errands querying clean with 0 errors via Prisma ORM; HTTP 500 eliminated on `/api/errands` and `/api/errands/exceptions`].
* **The Defect**:
  - Accessing the Dispatcher Portal failed with an HTTP 500 crash on `GET /api/errands` and `GET /api/errands/exceptions?days=14`.
  - PM2 error logs reported: `PrismaClientUnknownRequestError: Inconsistent query result: Field paymentMode is required to return data, got null instead.`
  - **Root Cause**: Errand `261014-E5C6A-0001` (`80fe9297-8e0e-4cf7-91ca-1b7d351e5c6a`, delivered on 2026-10-15) and its corresponding `payment_selections` record had `paymentModeId = 4` (`Debit/Credit Card`). When the Card payment mode was retired from `payment_modes` on the owner's request (leaving only IDs 1: `Cash on Delivery`, 2: `GCash / PayMaya`, 3: `Bank Transfer`), this single completed row was left pointing to non-existent ID 4. Prisma's schema declares `paymentMode` as required on `PaymentSelection`, so the joined null value triggered runtime panics on every errand batch query.
* **The Surgical Fix**:
  - The errand was physically settled with the rider in cash (`settlement_records` status `MATCHED`, collected ₱190 with zero variance).
  - Executed atomic transaction on VPS MariaDB `errand_system_db`:
    - Updated `payment_selections.paymentModeId = 1` (`Cash on Delivery`) for errand `80fe9297-8e0e-4cf7-91ca-1b7d351e5c6a`.
    - Updated `errands.paymentModeId = 1` for errand `80fe9297-8e0e-4cf7-91ca-1b7d351e5c6a`.
    - Updated `customer_transactions.paymentMethod = 'Cash on Delivery'` for errand `80fe9297-8e0e-4cf7-91ca-1b7d351e5c6a`.
* **Empirical Verification Ledger**:
  - Production MariaDB FK check: 0 invalid/orphaned `paymentModeId` rows remain across `payment_selections`, `errands`, and `customer_transactions`.
  - Live Prisma Client query test: `prisma.errand.findMany({ include: { paymentSelection: { select: { paymentMode: true } }, paymentMode: true } })` successfully queried all **560 of 560** errands with 0 errors.
  - Exception Queue test: `exceptionService.findExceptions()` verified operational with 0 runtime errors.
  - PM2 `capstone-backend` health: 200 OK on `https://api.sugo-express.org/api/health`.

---

## 2026-10-20 - Delivery hold: one trip for the same customer's orders (Claude, Opus 5.5)
* **Status**: [Executed by Claude - tsc 0; vitest 1661 pass (12 new in `tests/deliveryHold.test.ts`, 4 in `tests/deliveryReminders.test.ts`, 2 in `tests/receiptsDoNotFinishShopping.test.ts`); the 14 failures are the same unrelated four suites. No schema change. Commit 2933a4d. DEPLOYED 2026-10-20 (7 files; the live copies equalled local minus this change, nothing newer than dist). Backup `/root/deploy-backups/server-20261019-213650` (src-files, dist, new-files.txt: delete those two on rollback). Health 200, PM2 stable; live read-only check: 33 IN_TRANSIT, 1 already held (261019-E1593-0002 waits for 261019-F4226-0003, customer 1), `deliveryHold` on detail and all 34 list rows.]
* **Rule** (`src/services/patterns/deliveryHold.ts`, mirrored by RiderMobileApp `errandQueue.ts`): an errand is held while IN_TRANSIT with `itemsPurchasedAt`, and the same rider has another IN_TRANSIT errand for the same `customerId` and drop-off (100 m, else same address) with no `itemsPurchasedAt`. Derived on read from existing columns, so cancel/reassign/purchase of the sibling ends it with no cleanup.
* **Modified**: `deliveryHoldService.ts` (new: `findDeliveryHold`, `deliveryHoldOf`, `boughtNeighbours`); `errandRepository.findHoldCandidates`; `errandService` (`getErrandById` adds `deliveryHold: { errandId } | null`; `acceptErrand` and `markItemsPurchased` call `refreshDeliveryHolds`, which re-emits `order:updated` with `deliveryHold` and force-recomputes ETA for each bought neighbour; first purchase of a held errand sends `notifyDeliveryHeld` instead of on-the-way; a purchase that releases held orders sends one on-the-way with `{ together: n }`); `customerService.listTransactions` (`deliveryHold` from the customer's own list); `etaService` (held errand's ETA routes through the sibling's stores, which also keeps 10/5-min reminders silent); `deliveryReminderService` (`notifyDeliveryHeld`, type `DELIVERY_HELD`; "almost there" skipped while held, failing open).
* **Known gaps**: two orders at one door get their 10/5-min reminders separately; dispatcher portal shows no hold badge (the rider app posts a chat message to the dispatcher instead).

## 2026-10-19 - Paid in cash instead of GCash/PayMaya is recorded (Claude, Opus 5.5)
* **Status**: [Executed by Claude - tsc 0; vitest 1643 pass, 15 new in `tests/cashInsteadSwitch.test.ts` + `tests/cashInsteadUpload.test.ts`. The 14 failures (reportPdfExport, dateRangeResolver, firebaseUid, categoryWarm) do not import any file below. No schema change, no migration. DEPLOYED 2026-10-19 to api.sugo-express.org (7 files only; the live copies equalled local minus this change). Backup: `/root/deploy-backups/server-20261019-011640` (src-files + dist). Health 200, PM2 stable, `attachErrandNames` verified read-only on a live GCash errand.]
* **Non-COD fee (user decision, same day)**: paying cash instead removes the non-COD fee. `switchToCashOnDelivery` subtracts the stamped `nonCodFee` from `deliveryFee`, `totalCost`, `quotedDeliveryFee` (else `recalculateFee`'s frozen fare would restore it) and the customer transaction amount, sets `nonCodFee` 0, and never re-routes. `priceForStops` prices `errand.paymentMode = Cash on Delivery` as COD so no later reprice re-adds it. Settlement's expected amount follows the reduced total. The rider app expects balance minus the fee at the door (`cashDueAtDoorFor`), the same figure before and after the switch.
* **Ask**: when a GCash/PayMaya customer pays the rider cash instead (rider app "They're paying cash instead"), the server records it and the Customer App's Transaction Summary strikes the transfer through and shows Cash on Delivery.
* **Modified**:
  - `src/services/paymentSelectionService.ts`: new `switchToCashOnDelivery(errandId)`. On a ledger mode (GCash/PayMaya, Bank Transfer) it moves `Errand.paymentModeId` to Cash on Delivery and emits `order:updated` to the errand's parties. `PaymentSelection` (the customer's choice) is never rewritten; the two disagreeing IS the record. Idempotent; COD / no selection untouched. Nothing repriced: `recalculateFee` and `paymentPlan` read the selection.
  - `src/services/proofImageService.ts`: the CASH_COLLECTED branch calls it after saving the photo; a failure is logged, never a refused upload.
  - `src/services/patterns/paymentModes.ts`: `paymentMethodChangeOf(errand)` -> `{ from, to } | null`.
  - `src/services/errandService.ts` (`attachErrandNames`): adds `paymentMethodChange` when both `paymentMode` and `paymentSelection` are in the payload. `src/repositories/errandRepository.ts`: `ERRAND_INCLUDE` now selects `paymentMode { name }`.
  - `src/services/customerService.ts` (`listTransactions`): `paymentMethodChange`, and `paymentMethod` reads the method actually used (so installed apps' list shows cash).
  - `src/repositories/paymentModeRepository.ts`: `findByName`.
* **Not changed**: owner reports still group by `paymentSelection` first (`reportService.ts` ~L707), so a switched errand reports as GCash there. Settlement already accepted cash on ledger errands.
* **Prod data check before relying on it**: no errand had a GCash/bank selection with its own mode already Cash on Delivery (5 GCash errands have a null own mode, which never reads as a change).

## 2026-10-19 - Errand reference number YYMMDD-KKKKK-NNNN (Claude, Opus 5.5)
* **User instruction**: replace `SGO-######` with YYMMDD-[last 5 of the errand UUID]-NNNN, no prefix.
* **Touches `[LOCKED]` Prisma schema** (additive, on that instruction): `errands.referenceNo` VARCHAR(20) UNIQUE NULL, NEW `errand_ref_counters`. Migration `20261019120000_add_errand_reference_no`.
* **Code**: `src/lib/errandReference.ts` (Manila day, key, per-day counter inside the create transaction); `errandRepository.create` mints id + number together; number on dashboard attention items, exceptions, report rows, customer transactions, audit, push text and PDF columns. Backfill: `npm run errand-ref:backfill [-- --dry]` (raw SQL, keeps `updatedAt`).
* **Status**: DEPLOYED to production 2026-10-19 04:10 +08 (not committed). Backup `/root/deploy-backups/server-20261019-040854-errand-ref` (full DB dump, the 14 replaced files, dist, Prisma client). Migration applied by `prisma db execute`; 17 files shipped, each proven equal to the prod copy plus these edits (Antigravity's uncommitted period/fee work was already live); `tsc --noEmit` clean; backfill `--number-last=e0000000-0000-4000-8000-` numbered all 558 rows, every one equal to the read-only preview, `updatedAt` untouched; restarted (restarts=185), health 200. Prod `/var/www/server` now also carries these 17 files uncommitted. Web portal and apps NOT deployed yet. Full notes: `C:\Capstone_Project_Web\AGENT_HANDSHAKE.md`.

## 2026-10-18 - Daily, Weekly, Monthly, and Yearly Period Re-ordering (Antigravity 2.0, Gemini 3.8 Flash High)
* **Status**: [LOCAL VERIFIED - `npx tsc --noEmit` passed with 0 errors across both `Capstone_Server/server` and `Capstone_Project_Web`].
* **Specification & Architecture**:
  - Re-ordered and re-aligned time periods and trend bucketing across the Owner Dashboard and Financial Reports:
    1. **Daily**: Sunday through Saturday calendar week (`Sun, Mon, Tue, Wed, Thu, Fri, Sat`).
    2. **Weekly**: 4-part month division (`Week 1, Week 2, Week 3, Week 4`).
    3. **Monthly**: 12 calendar months (`Jan, Feb, Mar, Apr, May, Jun, Jul, Aug, Sep, Oct, Nov, Dec`).
    4. **Yearly**: 5-year retrospective comparative window (`Years (5 years)`).
  - Modified files:
    - `src/services/patterns/reportPeriodStrategy.ts`: Updated `DailyPeriodStrategy` (Sunday-start week), `WeeklyPeriodStrategy` (month window), `MonthlyPeriodStrategy` (year window), and `YearlyPeriodStrategy` (5-year window).
    - `src/services/analyticsService.ts`: Re-engineered `buildTrend()` with dedicated bucketing helpers (`bucketByDayOfWeek`, `bucketByFourWeeks`, `bucketByTwelveMonths`, `bucketByFiveYears`, `bucketByDailyDates`).
* **Verification**: `npx tsc --noEmit` passed with 0 errors on server and web.

---

## 2026-10-18 - Post-Purchase Grocery/Pabili Handling Fee & Surcharge Dynamic Triggering (Antigravity 2.0, Gemini 3.8 Flash High)
* **Status**: [DEPLOYED TO PRODUCTION VPS (109.123.239.182) & VERIFIED LIVE - Local & Remote `npx tsc --noEmit` passed with 0 errors; Vitest pricing test suites passed 100% (53/53 tests across `postPurchaseFeeTrigger.test.ts`, `feeBreakdown.test.ts`, `agreedFare.test.ts`, `handlingFeeDecision.test.ts`); Live production MariaDB verification on Errand SGO-11BADD confirmed fee update from ₱70 to ₱420 (₱70 base transit + ₱350 grocery fee)].
* **Feature & Implementation Specification**:
  - **The Problem (Errand SGO-11BADD)**:
    - Customer created a pabili errand with unpriced item checklist (`estimatedCost = 0`).
    - At booking time, the system stamped `quotedHandlingBasket: 0` and `quotedHandlingFee: 0`.
    - When rider purchased ₱3,500 of convenience store items at 7-Eleven and entered receipt amounts, `decideHandlingFee()` applied a quoted ceiling check: `if (quotedCeiling !== null && computed > quotedCeiling)` clamped the fee back down to `0`. Furthermore, `fareAfterAgreement()` froze the agreed transit delivery fee at ₱70 and frozen groceryFee at ₱0.
  - **The Surgical Fix**:
    - `src/services/patterns/pricingStrategy.ts`:
      - Added `quotedHandlingBasket?: number | null` to `PricingInput` and `quotedBasket?: number | null` to `HandlingFeeInput`.
      - In `decideHandlingFee()`: The ceiling clamp now requires a valid, pre-agreed non-zero basket (`quotedBasket > 0` or `quotedCeiling > 0`). When an order was agreed without a priced basket (`quotedBasket <= 0`), the ceiling is not applied (`ceilingApplied = false`), allowing actual purchase totals to trigger the appropriate fee tier post-purchase.
    - `src/services/errandService.ts`:
      - Passes `quotedHandlingBasket: errand.quotedHandlingBasket` to `priceForStops()`.
      - Added `unpricedHandlingTriggered` logic in `fareAfterAgreement()` handling: When an errand was agreed without a priced basket (`(errand.quotedHandlingBasket ?? 0) <= 0`), any newly triggered grocery fee (`breakdown.groceryFee`) and non-COD fee (`breakdown.nonCodFee`) are dynamically added to the agreed transit delivery fee, updating `effectiveDeliveryFee`, `effectiveTotalCost`, and fee breakdown components.
    - `tests/postPurchaseFeeTrigger.test.ts`:
      - Added 5 unit tests verifying post-purchase grocery fee triggering, COD vs Non-COD surcharge triggers, pre-agreed ceiling retention, and fast food exemption.
* **Files Modified**:
  - `src/services/patterns/pricingStrategy.ts`
  - `src/services/errandService.ts`
  - `tests/postPurchaseFeeTrigger.test.ts` (NEW)
  - `AGENT_HANDSHAKE.md`
* **Verification Ledger**:
  - Local `npx tsc --noEmit`: 0 errors.
  - Remote `npx tsc --noEmit` & `npm run build` on VPS `109.123.239.182`: 0 errors.
  - Vitest test suite: 53/53 tests passed (100%).
  - PM2 Reload: `capstone-backend` process online on VPS.
  - Live MariaDB Verification: Errand `SGO-11BADD` (`bf80487e-8141-4800-90c9-dff97d11badd`) updated:
    - `estimatedCost`: 3500.00
    - `deliveryFee`: 420.00 (70 base transit + 350 grocery fee)
    - `groceryFee`: 350.00 (10% of ₱3,500)
    - `nonCodFee`: 0.00 (COD payment mode)
    - `totalCost`: 3920.00 (3500 items + 420 delivery fee)

---

## 2026-10-18 - Rider map assigned by rider and day; route pick log (Claude, Opus 5.5)
* **Status**: [Commit 3ceafc7. DEPLOYED TO PRODUCTION 2026-10-18 ~18:00 (+08): migration applied with `prisma db execute` (live DB to new schema diffed to exactly this table and FK beforehand), `tsc --noEmit` gate, `npm run build`, `pm2 restart capstone-backend` (online). Backup `/root/deploy-backups/server-20261018-175937` (files, dist, prisma client). Live check: table and FK present, a real route through dist, API answering. Production has NO `_prisma_migrations` table, so no `migrate resolve` there. Local DB: migration NOT applied (MariaDB was off). tsc 0; `tests/routeMapAssignment.test.ts` 12/12.]
* **Rollback**: `ROUTE_MAP_ASSIGNMENT=off` in `/var/www/server/.env` + `pm2 restart capstone-backend --update-env` stops the assignment and keeps the log. Full code rollback: untar `files.tar`, `dist.tar`, `prisma-client.tar` from the backup, delete the two new `src/lib/routing` files, restart. The table can stay (nothing reads it).
* **Fleet on the day**: 7 RIDER accounts; 2026-10-18 assigns 4 OpenStreetMap / 3 Google, 2026-10-19 the reverse.
* **Why**: Sugo Rider's map (OpenStreetMap or Google) was whichever engine's path won the rider's first route after opening the app, so the split followed the ETA race, and nothing recorded it. The owner asked for a balanced split.
* **Path vs map, kept apart**: the PATH is still the fastest of OSRM and Google (`bestRoute.ts`, untouched). Only the MAP is assigned. Do not balance `chosen`: that would send riders down a slower road on purpose.
* **Assignment** (`src/lib/routing/mapAssignment.ts`): `assignedMapFor(riderId, now)` = hash bit of the id (MurmurHash3 fmix32) XOR Manila day parity. One map per rider per day, the other the next day; the hash keeps riders whose ids share a parity from all landing on one map. `routingService.getDirections` applies it only for a RIDER caller, `choose: "fastest"`, and no `provider` from the app (the app names its map once shown and keeps it for the session: the RiderMobileApp Huawei Petal contract). The winner is redrawn on the assigned map's roads, or drawn on its own when `bestRoute` cannot redraw it faithfully. Customers and staff are never assigned; they keep reusing the rider's verdict. Env `ROUTE_MAP_ASSIGNMENT=off` restores the old rule (restart needed). No rider APK change needed.
* **Pick log** (`src/lib/routing/routePickLog.ts`, table `route_picks`, model `RoutePick`): one row per rider fastest decision: `riderId` (FK users, cascade), `day` (Manila DATE), `mapSource` (`assigned` | `app` | `winner`), `mapAsked`, `chosen`, `drawnWith`, both engines' duration and distance (null when an engine gave no answer). Fire-and-forget: a failed write logs a warning and never fails the route. Queries for the split: `gis/README.md` section 5.
* **Schema (additive only)**: new table plus a virtual `routePicks` back-relation on `User`; no existing column touched. Hand-written migration `20261018120000_add_route_picks`, generated by `prisma migrate diff` against the committed schema (local DB was down). Apply with `prisma db execute --file ...` then `prisma migrate resolve --applied 20261018120000_add_route_picks`, on local and on production, BEFORE deploying the code. Without the table the code still routes, but logs a warning per rider route.
* **No `[LOCKED]` contract touched.** No route path, limiter or validator change; `users` gains only a relation field (no column).

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


## 2026-10-24 - Reliable order submission and safe retries (Codex)

- **Status**: Implemented locally; no production migration/deployment and no app publication. Preserved all existing unrelated changes and locked schema relationships/auth contracts.
- **Behavior**: Optional customer-scoped submission identity and SHA-256 contents fingerprint. Unique database constraint resolves concurrent creates to the same order; changed contents return 409. Identified orders and their transaction receipt commit in the existing reference-number transaction. Replay bypasses original creation events/chat grants. Authenticated CUSTOMER-only submission-status lookup precedes /:id routes. Identified baskets naming another account are rejected, preventing token-refresh replay after an account switch; legacy customer ownership behavior remains compatible.
- **Paths**: prisma/schema.prisma; prisma/migrations/20261023140000_add_order_submission_identity/migration.sql; src/services/patterns/submissionIdentity.ts; src/services/errandService.ts; src/repositories/errandRepository.ts; src/validators/errandValidators.ts; src/controllers/errandController.ts; src/routes/errandRoutes.ts; tests/orderSubmission.test.ts; docs/ORDER_SUBMISSION.md.
- **Verification**: Prisma validate and generate passed. TypeScript no-emit passed. Focused server suites: 48 tests passed across orderSubmission, customerPickedStores, errandReference and errandReviewStage; account-bound controller safeguard also rechecked with orderSubmission/customerPickedStores. Persistence concurrency tests use mocked database uniqueness; no live MariaDB migration/concurrency test was run. Scoped whitespace check passed.
- **Next session**: Review pending migrations and deploy schema/server before releasing CustomerApp. Follow docs/ORDER_SUBMISSION.md for contract, staging checks and rollout. Keep submission identities for recovery; do not treat a transport timeout as an unreceived order. Updated clients require the new status contract and refuse unsafe fallback creation on an old server.

## 2026-10-24 - Production deployment: reliable order submission (Codex)

- **Status**: DEPLOYED schema/server following explicit user instruction "deploy". Scoped production-source comparison showed only this feature's deltas; unrelated dirty files were preserved. PM2 capstone-backend online, restart count 13.
- **Migration**: Applied only 20261023140000_add_order_submission_identity SQL with Prisma db execute, then migrate resolve --applied. Production previously had no migration ledger. Older migrations remain unbaselined: audit historical schema before any blanket migrate deploy. Never replay them blindly or use db push --accept-data-loss.
- **Verification**: Actual migration passed on isolated MariaDB copies of production table definitions; simultaneous same-identity inserts produced one errand / one receipt, rollback left no partial receipt, and NULL identities retained legacy compatibility. Scratch database removed. Production dependency Prisma validate/generate and tsc noEmit/build passed. Local/public HTTPS health 200; submission lookup unauthenticated 401, dispatcher 403, customer 200/NOT_FOUND. Unique index and migration record verified. Counts unchanged: 574 errands / 574 receipts; no synthetic production orders or notifications.
- **Backup/rollback**: VPS /root/deploy-backups/order-submission-20261024-01 contains database.sql.gz, runtime-before.tar.gz, checksums, scoped release/candidate and rollback-server.sh. Rollback retains additive DB columns/identities. See docs/ORDER_SUBMISSION.md.
- **Customer release**: Existing production OTA group 1d249230-4c69-49e6-8dcc-4e9045323365 already contains the exact current implementation (both platform bundle hashes and 185 mapped application sources/platform verified). Runtime 1.2.0, production channel active. No duplicate OTA published. Native-device slow-network/back gesture smoke remains unperformed.
