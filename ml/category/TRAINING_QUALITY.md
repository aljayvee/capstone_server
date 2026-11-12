# Gemini-assisted training-data review

Implemented 2026-10-22. Production activation requires explicit authorization
to send training names and their labels to the configured Google model API.
`TRAINING_QUALITY_ENABLED` defaults to `0`; use `1` only after that authorization.
An offline first-batch preview is saved under ignored
`models/quality-study/review-preview.json`.

## Behavior

Before an automatic retrain, the service applies its existing deterministic
name/quantity/category cleansing, groups examples by normalized name, and
reviews at most 20 previously unreviewed unique store/item names. Suspicious
strings and conflicting labels are prioritized. The request contains only
the grouped name, its kind, saved category labels, and the active category
list. No customer account, address, phone, order ID, receipt, or API key is
added to the prompt. Names themselves remain user-entered production text.

The configured model chain and existing quota/pause controls are reused.
The whole request, including fallbacks, has a 20-second budget. The production
key's available-model list confirms `gemini-3.8-flash` and
`gemma-4-26b-a4b-it` are available; this is not a claim that either has reviewed
data until the audit records an actual response.

The provider returns one constrained decision per input:

* `KEEP`: plausible product/store name.
* `REVIEW`: ambiguous category labels or insufficient context.
* `EXCLUDE`: clear gibberish, instruction text, or a non-product/non-store.

Only `EXCLUDE` at confidence >= 0.95 quarantines a name from fitting. Lower
confidence becomes `REVIEW`. Conflicting labels remain flagged even if the
provider says the name is valid. No names/categories are automatically
rewritten, and no database records are modified. The existing normalization
and category-teacher pipelines continue separately.

Malformed/non-finite responses, unknown decisions and duplicate positions are
rejected. Provider failures leave ordinary training available; unreviewed
names remain as before. Cached valid reviews can be reused during outages.
`TRAINING_QUALITY_ENABLED=0` bypasses even cached exclusions on the next fit.

## Persistence and evidence

Review entries are stored separately from category predictions in
`/srv/cache/training-quality.jsonl`, alongside the existing persistent cache
volume. They cannot become category teaching examples. Cache keys include
name, kind, label set, current categories/descriptions and review version.
New orders with identical labels do not cause another paid review; label or
catalogue changes invalidate the decision.

Each retrain writes `models/runs/<run>/quality-audit.json` and includes the
quality data in its `production.json` export. Model reports and `/health`
expose counts, remaining names, provider availability and review failures;
individual production names stay in the private audit, not the health summary.
The limit applies to each retrain, so 294 names are not all reviewed at once.

## Evaluation

Exclusions apply to training/final fitting only. The held-out test examples
and their original labels remain in the evaluation, including excluded names.
The reviewer cannot inflate a score by deleting examples from its exam.
`real_rows` reports the real rows actually retained for fitting.

This is a data-quality control, not a guarantee that an external model is
correct or that accuracy will increase. Ambiguous items sold in several store
types still need human judgement.

## Image builds

Image builds should consume an already reviewed export; never provide a Google
API key as a Docker build argument. The offline-capable CLI is:

```text
python -m sugo_category.training_quality --from-export production.json \
  --out production-reviewed.json --audit quality-audit.json \
  --cache /srv/cache/training-quality.jsonl --enabled
```

Run the CLI with authorized runtime credentials outside the build, then train
the image from `production-reviewed.json`. Without `--enabled`, the CLI makes
no external calls. The automatic `/retrain` path performs this step itself
when the feature's environment flag is enabled.

## Verification

New coverage tests strict response parsing, input handling, confidence and
quota behavior, fallback models, persistent caching, opt-out, outage recovery,
model report persistence, and unchanged evaluation examples. The full suite
currently has 291 passing tests and the same nine previously reproduced Gemma
default-chain failures. TypeScript checking passed. A final targeted integration
run passed 19 tests after setting the default to explicit opt-in.

The user explicitly approved bounded automatic reviews of production names and
labels. The first approved batch was actually answered by `gemini-3.8-flash`:
20 of 294 unique normalized names reviewed, two item names quarantined, and
20 conflicting-label groups flagged across the complete dataset (including
unreviewed conflicts found deterministically). There are 274 names remaining
for later runs. No database records were changed. The first audit is stored
under ignored `models/quality-study/quality-audit.json`.

## Production activation

Deployed and enabled after that approval on 2026-10-22. Compose declares the
opt-in flag with default `0`; the VPS's private ML environment explicitly sets
`TRAINING_QUALITY_ENABLED=1`. Image `sugo-category:ml-quality-20261022`, also
promoted to `sugo-category:latest`, SHA
`aaa4d8f1178571200cc1de198f0a721d5cf25e7ab7edc696a7144ac0bdbaf5b8`.

The first fit retained 2,366 real item rows instead of 2,370: the two quarantined
names accounted for four rows. Original held-out populations remain 464 item
rows and 12,536 store rows. Reported accuracy remains **80.39% item** and
**82.47% store**; this release adds quality control, not a measured accuracy gain.

Verified ML readiness, backend HTTP 200, expected live predictions, preserved
external-model settings, loopback-only port, and read/write access to the
persistent quality cache under the non-root service user. All eight model
categories remain present. Future automatic retrains use the bounded reviewer;
this release does not claim all 294 names were already reviewed.

Rollback backup: `/root/deploy-backups/ml-quality-20261022-01` retains prior
source, model files, image ID, private environment backup and rollout/rollback
script. Previous image tagged `sugo-category:rollback-ml-quality-20261022`.
Database records and the Node backend process were not changed.
