# Large-model second opinion (Gemini and Gemma)

Measured 2026-09-25T15:11:15Z by `python -m sugo_category.gemma_eval`. How it is wired in is
described at the top of `sugo_category/gemma.py`.

The benchmarks are hand-labelled names no training source contains (a seed phrase, a production
row or an OpenStreetMap name). Half of each chose the settings below; the other half, the test
half, was read once with them. A name listed with a second acceptable category counts as right
under either.

## Item names (143 unseen, 58 in the test half)

Shipped setting (chosen on the item names' validation half): `gemini-3.8-flash`, category
text `custom`, asked below 0.85 local confidence, weight
0.6 on its answer.

| Test half | Right | Get a category (>= 0.55) | Right when answered | Auto-accepted (>= 0.75) | Right when auto | Asked the model |
|---|---|---|---|---|---|---|
| Local model alone | 74.1% | 84.5% | 81.6% | 67.2% | 87.2% | - |
| Local + Gemini 3.8 Flash (shipped) | 96.5% | 93.1% | 96.3% | 74.1% | 95.3% | 48.3% |
| Local + gemma-4-26b-a4b-it, same setting | 96.5% | 91.4% | 96.2% | 72.4% | 95.2% | 48.3% |
| Local + gemma-4-31b-it, same setting | 96.5% | 94.8% | 96.4% | 72.4% | 95.2% | 48.3% |
| Gemini 3.8 Flash alone | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | - |

Validation half, best setting per model and category text:

| Model | Category text | Below | Weight | Right | Right when auto | Model alone |
|---|---|---|---|---|---|---|
| gemini-3.8-flash | all | 0.85 | 0.6 | 100.0% | 100.0% | 100.0% |
| gemini-3.8-flash | custom | 0.85 | 0.6 | 100.0% | 100.0% | 100.0% |
| gemini-3.8-flash | none | 0.85 | 0.6 | 100.0% | 100.0% | 100.0% |
| gemma-4-26b-a4b-it | all | 0.85 | 0.6 | 96.5% | 100.0% | 96.5% |
| gemma-4-26b-a4b-it | custom | 0.85 | 0.5 | 98.8% | 100.0% | 95.3% |
| gemma-4-26b-a4b-it | none | 0.85 | 0.5 | 97.7% | 100.0% | 95.3% |
| gemma-4-31b-it | all | 0.85 | 0.6 | 100.0% | 100.0% | 100.0% |
| gemma-4-31b-it | custom | 0.85 | 0.6 | 100.0% | 100.0% | 98.8% |
| gemma-4-31b-it | none | 0.85 | 0.6 | 100.0% | 100.0% | 87.1% |

## Store names (13 unseen, 9 in the test half)

Shipped setting (chosen on the item names' validation half): `gemini-3.8-flash`, category
text `custom`, asked below 0.85 local confidence, weight
0.6 on its answer.

| Test half | Right | Get a category (>= 0.55) | Right when answered | Auto-accepted (>= 0.75) | Right when auto | Asked the model |
|---|---|---|---|---|---|---|
| Local model alone | 77.8% | 88.9% | 75.0% | 66.7% | 83.3% | - |
| Local + Gemini 3.8 Flash (shipped) | 100.0% | 100.0% | 100.0% | 66.7% | 100.0% | 44.4% |
| Local + gemma-4-26b-a4b-it, same setting | 100.0% | 88.9% | 100.0% | 66.7% | 100.0% | 44.4% |
| Local + gemma-4-31b-it, same setting | 100.0% | 88.9% | 100.0% | 66.7% | 100.0% | 44.4% |
| Gemini 3.8 Flash alone | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | - |

Only 9 test names: one name moves these by 11%. Read them as examples, not rates. Most shop names are already among the 83,000 OpenStreetMap names the store model trains on, so few are unseen.

Validation half, best setting per model and category text:

| Model | Category text | Below | Weight | Right | Right when auto | Model alone |
|---|---|---|---|---|---|---|
| gemini-3.8-flash | all | 0.75 | 0.3 | 100.0% | 100.0% | 100.0% |
| gemini-3.8-flash | custom | 0.75 | 0.3 | 100.0% | 100.0% | 100.0% |
| gemini-3.8-flash | none | 0.75 | 0.3 | 100.0% | 100.0% | 100.0% |
| gemma-4-26b-a4b-it | all | 0.75 | 0.3 | 100.0% | 100.0% | 100.0% |
| gemma-4-26b-a4b-it | custom | 0.75 | 0.3 | 100.0% | 100.0% | 100.0% |
| gemma-4-26b-a4b-it | none | 0.75 | 0.3 | 100.0% | 100.0% | 25.0% |
| gemma-4-31b-it | all | 0.75 | 0.3 | 100.0% | 100.0% | 100.0% |
| gemma-4-31b-it | custom | 0.75 | 0.3 | 100.0% | 100.0% | 100.0% |
| gemma-4-31b-it | none | 0.75 | 0.3 | 100.0% | 100.0% | 100.0% |

## Time for one name

| Model | Median | 90th percentile | Slowest |
|---|---|---|---|
| gemma-4-26b-a4b-it | 1709 ms | 1789 ms | 2061 ms |
| gemma-4-31b-it | 2139 ms | 2474 ms | 3823 ms |
| gemini-3.8-flash | 1616 ms | 1731 ms | 2012 ms |

## Notes

- Gemini 3.8 Flash is the first model; Gemma 4 (gemma-4-26b-a4b-it) answers while Flash is paused. Gemini 2.5 Flash, the model first asked for, is closed to new API keys (HTTP 404, 'no longer available to new users', 2026-09-25); Google names 3.8 Flash as its replacement.
- Flash answered 100% of the validation items on its own under every category text, against Gemma 4's best of 96.5%, and a batch of 20 names in about 3 s against about 9 s. One name alone takes both about 1.6 to 1.7 s, still over the API server's 1.5 s budget, so requests never wait (GEMMA_WAIT_MS 0) and new orders are warmed (POST /warm).
- Gemini Flash thinks even under a JSON schema unless thinkingConfig.thinkingBudget is 0 (about 3 s against 1.7 s for 4 items). Gemma refuses that setting with HTTP 400, so it is sent to Gemini Flash models only.
- The shipped setting for Flash (below 0.85, weight 0.6) tied on validation with asking about every name (below 1.01), which scored 100% on the test half against 96.5%: the two names it misses are ones the local model is at least 0.85 sure of and wrong about. GEMMA_CONSULT_BELOW=1.01 asks about everything, at one call per new basket.
- At weight 0.6, a model overruling the local model's top answer reaches auto-accept (0.75) only when the local model already gave that answer 0.375 or more: a near tie the model breaks. Anything clearer goes to review.
- gemma-4-31b-it: at most one validation item better than the 26B, but twice as slow per batch, and six consecutive calls timed out at 60 s in the measuring run.
- Category text 'custom' (role keywords for built-in categories, the owner's description only for new ones) beat the owner's own descriptions on Gemma 4, 98.8% to 96.5%: production's Fast Food & Restaurant description still lists bakeries. With no category text, Gemma 4 got 1 of 4 validation shop names right; Flash got all three variants right.
