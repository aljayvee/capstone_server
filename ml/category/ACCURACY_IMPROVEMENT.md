# Item category accuracy investigation — 2026-10-22

Local evaluation against a read-only copy of the deployed training export
from run `20261021-194530`. No production code, model, configuration, or
database was changed during this investigation.

## Findings and changes

The export contains 2,370 cleaned item rows but only 107 normalized names.
Ten names carry conflicting categories. Repeated purchases are useful for
learning local preferences, but are not 2,370 independent vocabulary examples.
No recorded labels were automatically rewritten or discarded for this change.

The beverage vocabulary moved iced/hot coffee to Cafe, but left existing
latte, americano, and frappe seeds under Fast Food & Restaurant. Complete
that prepared-drink vocabulary through the existing beverage-role mechanism.
Keep packaged/instant coffee in Grocery and preserve the parent categories
when Cafe is absent. The mechanism also follows renamed categories.

The item evaluation held out production rows while sometimes training or
calibrating on the identical names through seed phrases. Exclude test names
from development seeds before splitting training/validation. Final serving
models still learn from all rows. This correction can lower reported scores;
it improves measurement, not predictions by itself.

An exploratory 30-setting logistic search (regularization, class balancing,
and real-row weights) selected a candidate on validation that performed worse
on test: 57.11% versus 62.93%. Reject it; no classifier settings were changed.

## Vocabulary comparison

Both sides use the same fixed logistic classifier and name-disjoint partitions,
including withholding matching seed names. Candidate vocabulary changes do not
change the partitions. Temperatures are fitted on validation only. This isolates
the vocabulary effect; it does not evaluate a newly trained CNN or external LLM.

| Split seed | Baseline, order rows | Candidate, order rows | Baseline, equal names | Candidate, equal names |
| --- | ---: | ---: | ---: | ---: |
| 20260923 | 62.28% | 76.08% | 54.76% | 59.52% |
| 20260924 | 83.10% | 94.95% | 47.02% | 51.79% |
| 20260925 | 67.82% | 76.37% | 65.48% | 70.24% |
| 20260926 | 85.42% | 97.60% | 65.87% | 70.63% |
| 20260927 | 88.78% | 99.04% | 76.19% | 80.95% |
| Mean | **77.48%** | **88.81%** | **61.86%** | **66.63%** |

Each test split contains 21 distinct production item names. Equal-name accuracy
weights each name equally while preserving disagreements about its label as a
distribution. Row accuracy weights repeated orders; its larger gain is
concentrated in frequently ordered cafe items. The splits overlap, are small,
and were evaluated after error inspection, so these are exploratory sensitivity
results, not independent trials or a promise of future production accuracy.
The original deployed 62.93% figure uses a different evaluation procedure and
must not be directly compared with the candidate figures above.

## Reproduction and artifacts

From `server/ml`, using the existing virtual environment:

```powershell
.venv/Scripts/python.exe -m sugo_category.item_accuracy `
  --from-export models/accuracy-study/production.json `
  --baseline-seeds models/accuracy-study/baseline-seeds.json `
  --out models/accuracy-study/comparison.json
```

`baseline-seeds.json` captures the vocabulary before these edits. The deployed
training snapshot, diagnostic item names, detailed results, and test logs stay
under ignored `models/accuracy-study/`; they are not added to source control.

Regression coverage checks prepared versus packaged coffee, absent/renamed
Cafe categories, and test-name leakage through seed vocabulary. The focused
catalogue/training/cleansing/categorizer suite passes 103 tests. TypeScript
`tsc --noEmit` passes. The full Python suite completes with 275 passing tests
and nine failures in `test_gemma.py`. An isolated pre-change copy of the
lexicon/model from Git HEAD reproduces exactly the same nine failures
(36 other Gemma tests pass), confirming that this change introduces none of
those failures. The existing model-chain defaults disagree with the tests
and Compose configuration. External AI calls were disabled throughout.

The sandbox initially blocked Windows asyncio's local socket pair, stalling
FastAPI TestClient fixtures. Running with local sockets permitted allowed
the full suite to complete in 28.60 seconds.

## Production release — 2026-10-22

Deployed after explicit user approval, using a fresh read-only production
export with eight categories, 885 store rows, and 2,426 item rows before
filtering/cleansing. Built and trained a separate image while the old service
continued answering, then switched only after offline model checks passed.

The deployed image is `sugo-category:ml-accuracy-20261022`, also tagged
`sugo-category:latest`, SHA
`c1571e55641930106d526415b5b13cafff6f4791005ed687f85e7e79eb534779`.
Its model reports record **82.47% store accuracy** and **80.39% item accuracy**.
These are held-out evaluation figures, not prospective production accuracy.
The item evaluation excludes seed leakage; the previous 62.93% report uses
a different procedure and must not be presented as an identical-method baseline.
The deployed item ensemble's linear weight remains 1.0.

Verified Docker healthy, ML ready, backend HTTP 200, matching source hashes,
eight model categories, 230 preserved cached answers, loopback-only ML port,
and the existing 1.5 GiB memory limit. Nine isolated prediction checks passed;
serving HTTP checks classified cold brew coffee as Cafe and instant coffee
sachets as Supermarket & Grocery. No database changes or Node backend restart.

Rollback backup: `/root/deploy-backups/ml-accuracy-20261022-01` contains old
host source, the complete pre-release models, previous image ID, build logs,
deployment/rollback script and verification JSON. Previous image retained as
`sugo-category:rollback-ml-accuracy-20261022`. Local deployment evidence is
under ignored `models/accuracy-study/deployment/`.

A broader improvement needs more independently labeled, distinct item
names, especially the less represented categories, and review of ambiguous
items sold by several store types. Do not add arbitrary labels merely to raise
the held-out score.
