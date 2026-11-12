# Customer shopping sentence extraction

Updated 2026-10-22. This is structured extraction using the configured Gemini/Gemma
chain, separate from the local store/item category classifier and its retraining.

The phone settles explicit simple entries locally. Sentence requests and ambiguous
counts go to the authenticated, rate-limited `POST /api/errands/normalize-items` on
Review. The API forwards at most 20 lines, each at most 500 characters, with a shared
9.25-second sidecar budget inside the existing 10-second API timeout. The phone
allows 12 seconds and Send can cancel the request. Each line may yield up to three
products. Product names remain limited to 120 characters, quantities to integers
1–99, sizes to 40 characters and notes to 200 characters.

Examples:

| Customer request | Item | Quantity | Size/unit | Note |
| --- | --- | --- | --- | --- |
| Could you please buy two bottles of Coke 1.5L, no substitutes | Coke | 2 | 1.5 L | no substitutes |
| Palit ko ug duha ka itlog | itlog | 2 | — | — |
| Bakal ko sang isa ka kilo nga bugas | bugas | 1 | 1 kg | — |
| Amlodipine 5mg isang banig | Amlodipine | 1 | 5 mg | 1 banig |

Validation rejects malformed provider types, duplicate answer positions, invented
numbers, unsupported changes to known units, and missing product or instruction words. Number words
authorize their actual values, including simple compound tens and fractions;
they no longer disable number validation. Known numeric brands/variants (7 Up,
555 Sardines, 3 in 1, 2x4, percentages) must remain in the product name and cannot
provide an otherwise unstated count or size. This is a conservative vocabulary
check, not proof that every semantic interpretation is correct.

Only confident valid answers are applied automatically. Uncertain answers keep
the original line. The updated phone also protects manual edits made while the
request is pending and preserves conflicting stepper/typed counts for review.
Unresolved rows show a check hint and can open their store editor. A raw sentence
over 120 characters must be split or edited before submitting if AI could not
extract it. Requests over 500 characters are never silently truncated. The
normalization cache keys the whole sentence, including its final instruction;
prompt version 5 invalidates previous readings.

Verification: 99 focused Python tests (extraction, endpoint, quality review and
retraining); 7 API tests; 167 Customer App tests; both TypeScript checks pass.
Regression cases were reproduced before fixes (14 failures among 15 initial
cases). Real Gemini checks used synthetic text only: first 11/12 exact field
matches, then a clarified strength/packaging instruction and two additional cases
produced 14/14 expected readings. Four-line batches took around 2–3 seconds.
These are small functional checks, not an independent production accuracy estimate.

Deployed to production; API health 200, ML ready, unchanged auth 401 and a live
compiled Node-to-sidecar extraction check passed. Initial configuration guard
compared ordered environment lists and rolled back; corrected key/value comparison
passed on retry. Release backup: `/root/deploy-backups/sentence-20261022-01`, containing the old four
source files, two compiled API modules, previous image tag, model snapshot/hashes,
candidate checks and `rollout-sentence.py` with rollback. Image:
`sugo-category:sentence-20261022`. Deploying this change preserves the current
trained model bytes, category reports, external-review setting, provider settings,
cache volume, loopback binding and memory limit. No schema change or retrain.

New local APK built successfully at CustomerApp's
`android/app/build/outputs/apk/release/app-release.apk` (1.2.0 / versionCode 10),
with v2 signature verification and bundled sources matched to all five final
feature files. It has not been installed, published, or distributed by OTA.
Mobile changes require that build; server safeguards also protect installed apps
that already use the normalization endpoint. Device behavior still needs an
Android smoke test. Local APKs use the project's existing signing configuration.
