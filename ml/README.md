# SUGO Category Service

Guesses what kind of shop a store name refers to, and what kind of shop an item
is bought at. The dispatcher console calls it through the Node API when a store
is pinned in stage 2 and when an item is added in stage 3.

Deployed the same way the OSRM sidecar in `../gis` is: a container on a private
port, reached by the API server through a URL in `server/.env`, and **skipped
entirely when that URL is blank**. It is an improvement to a guess, never a
dependency of the dispatch flow.

## What it actually is

Two scikit-learn pipelines — TF-IDF over word n-grams, character n-grams, and
character n-grams of the de-spaced text, feeding a classifier. One for shop
names, one for item names. The classifier is set in `sugo_category/config.py`:
multinomial logistic regression, or the backpropagation network written out in
`sugo_category/neural.py` (any number of layers, sigmoid, tanh, ReLU or leaky
ReLU, SGD, momentum, RMSProp or Adam, L2, dropout, early stopping). Which one
ships, and why, is measured in **[category/EXPERIMENTS.md](category/EXPERIMENTS.md)**:
one neuron and three neurons, network size, activation functions, gradient
descent, overfitting, and production's own jobs.

Four decisions worth knowing about:

- **Real shop names are the training data.** Since 2026-09-24 the store model
  learns from 85,464 shop names from OpenStreetMap, each tagged by the people
  who mapped it (`data/`, see its README), as well as the lexicon and
  production's own rows. Before that it had 291 seed phrases and nothing else.
  Section 1 of EXPERIMENTS.md measures the difference; it is the largest gain in
  the report by far.
- **Character n-grams carry it.** Philippine shop names are misspelt,
  abbreviated and run together: `Jolibee`, `MercuryDrug Tacurong`, `Aling Nena's
  Karinderya`. A word-only model treats every variant as an unrelated token.
  The de-spaced block exists specifically so `milk tea` and `milktea` share
  n-grams — `char_wb` alone never reads across a word boundary.
- **It is allowed to say nothing.** Below `min_confidence` (default 0.55) the
  service returns `category: null`, and the pin keeps its amber "Category
  needed" mark. Ten server behaviours read that field — dwell allowance,
  geofence radius, revenue allocation — so a confident wrong answer costs more
  than an absent one. The confidences are temperature-scaled on held-out names
  at training time (`report.temperature`), so 0.55 and 0.75 mean what they say.
- **Google's `types` are a prior, not a feature.** Fused after the name model
  rather than trained into it, because the column is missing for most Tacurong
  shops and a model that learned to lean on it would have nothing to lean on.
  A specific type (`pharmacy`) is weighted 0.85; the generic tail (`store`,
  `establishment`) only 0.15, because Google attaches it to nearly every
  business with a door — including a great many carinderias.

## Where the labels come from

| Source | What it is |
| --- | --- |
| `verified_places` | An owner catalogued this shop and chose its category. Its `keywords` aliases each become their own row. |
| `errand_pinpoints_tbl` | The category a dispatcher actually committed on a live errand. The gold labels — every one is a human answering this exact question, and the corrections are the only record of where the model used to be wrong. |
| `pabili_details_tbl`, `pabili_item_requests_tbl` | The item side. `storeCategory` is the composite `"Store 2 - Jollibee \| Fast Food & Restaurant"` the console writes, so the category is whatever follows `" \| "`. |
| `data/osm_store_names.csv` | OpenStreetMap shop names across the Philippines, labelled by their mappers' tags (store model only). Extracted from the PBF the VPS keeps for routing; see `data/README.md`. |
| `sugo_category/lexicon.py` | Hand-written seed knowledge: PH chains, Tagalog/Bisaya shop words, common product names. A floor for a fresh install and for the long tail. |

Real rows outweigh seed phrases and OpenStreetMap names 6:1 (`real_weight` in
`config.py`). Where Tacurong's own data disagrees, the data wins — otherwise
dispatchers could never correct the thing.

Items have no OpenStreetMap equivalent (a map lists shops, not what they sell),
so the item model still learns from the lexicon and production's rows alone.

## Cleansing, then deep learning

On 2026-09-25 "pandesal", "Spanish bread" and "Ensaymada" were being sent to
Jollibee. Two causes, fixed in this order:

1. **The labels.** `sugo_category/cleansing.py` runs before every training:
   registry codes stripped from names, kind-word rules (a "... Panaderia"
   filed as fast food becomes a bakery; "Bakery and Restaurant" is dropped, not
   guessed), conflicting labels settled by two-thirds majority, and items
   filed under a concept's old parent moved to the owner's own category.
   Confident learning (`python -m sugo_category.cleansing`) flags the names a
   cross-validated model confidently disputes, in `data/osm_label_issues.csv`;
   those are kept out of training but left in the test names, so the score is
   not flattered. Counts and examples: **[category/CLEANSING.md](category/CLEANSING.md)**.
   The Bakery lexicon also grew from 20 phrases to a panaderia's actual shelf.
2. **The model.** Both models are now an ensemble of the TF-IDF logistic
   regression and a character-level CNN (`sugo_category/deep.py`: embedding,
   convolutions 2 to 6 characters wide, max-pooling, dropout, dense softmax;
   AdamW, warm-up and cosine decay, gradient clipping, label smoothing, typo
   augmentation, early stopping). The item network starts from the store
   network (transfer learning) because 700 phrases cannot train one from
   nothing. The ensemble weight and the temperature are chosen on validation
   names. Measured in **[category/DEEP_LEARNING.md](category/DEEP_LEARNING.md)**
   (`python -m sugo_category.deep_report`): shop names 82.7% linear, 77.6% CNN,
   83.0% ensemble; unseen items 70.8% linear, 31.2% CNN from scratch, 56.2% CNN
   transferred, 72.9% ensemble. The gains from the network are real but small;
   the Jollibee answers were a data problem, and the cleansing fixed them.

Numpy, not PyTorch: the container retrains itself nightly inside 1.5 GB, and
PyTorch would roughly double the image and its memory. The store network takes
most of a training run (about 18 minutes on an 8-core machine, capped at 20
minutes of network training by `cnn_max_seconds`).

**Renamed and new categories.** Merchant categories are owner-editable, and
everything the models know used to be keyed by the category's name: renaming
Bakery sent pandesal back to Jollibee, and renaming "Fast Food & Restaurant"
left the model answering a name the API no longer had. Now:

- `sugo_category/roles.json` names the built-in vocabularies (food, pharmacy,
  grocery, retail, bakery, convenience, beverages, produce), and
  `sugo_category/catalogue.py` binds each to the live category that carries it:
  exact name first, then the words in the name and description. The lexicon,
  the map names and old stored labels all follow the binding, and only live
  names are ever trained. The Node store suggester reads the same file
  (`src/services/categoryRoles.ts`), so the mapped Tacurong shops follow too.
- A rename in the owner portal rewrites the stored category text on filed
  items, customer requests and crawled items (`merchantCategoryService.renameFiledCategory`).
- A category no role binds is the owner's own. Its name seeds it, and so does
  its **description**: "Hardware, construction supplies: nails, cement, paint"
  teaches it those items and moves them out of Retail. Built-in categories
  take nothing from their descriptions, which describe their neighbours too.
- Adding, editing or removing a verified place retrains within minutes, not
  overnight.

Pinned by `tests/test_catalogue.py` and the server's `categoryRoles`,
`categoryRename` and `storePrediction` tests.

**The API keeps the served models honest.** `jobs/categoryRetraining.ts` checks
`/health` two minutes after boot and every 30 minutes; if either model lacks an
active category, or the store model learned none of production's own rows, it
retrains (at most once every two hours). That is how a container rebuilt with
the offline default, as happened on 2026-09-25, stops serving a model without
Bakery.

## The crawler

`crawler/` collects the places and the training names:

- `sources/osm_pbf.py` reads every named shop, eatery and health place from an
  OpenStreetMap PBF (the Philippines file on the VPS: 157,309 places in 66 s).
- `build_training_data.py` turns that into `data/osm_store_names.csv` and the
  Tacurong places, `data/osm_tacurong.csv`.
- `sources/overpass.py` asks a public Overpass API for places mapped since the
  snapshot (`python -m crawler.run --live`).
- `fetcher.py` is how any of it touches the internet: robots.txt obeyed, one
  honest user agent, per-host delays, backoff that honours Retry-After, and a
  day's disk cache. It refused overpass-api.de, whose robots.txt disallows
  `/api/`, as it should.
- `run.py` categorises the Tacurong places into `data/tacurong_places_review.csv`,
  a sheet for the owner to review, never a write to `verified_places`.

Google Maps and Facebook are deliberately not sources: Google's Places policy
allows storing place IDs only, and Meta forbids automated collection without its
written permission. Google's place types still feed every pin live.

## Running it

```bash
cd server/ml
python -m venv .venv && .venv/bin/pip install -r requirements.txt -r requirements-dev.txt
python -m sugo_category.train --offline --out ./models   # seed lexicon + map names, production's six categories
uvicorn app:app --port 8100
```

Train against the live catalogue instead of the lexicon alone:

```bash
python -m sugo_category.train --database-url "mysql+pymysql://user:pass@host/capstone" --out ./models
```

`DATABASE_URL` from `server/.env` works directly — `mysql://` is rewritten to
`mysql+pymysql://` for you. Training the store model takes a few minutes now:
it fits twice (once holding out 30% of the OpenStreetMap names to measure and
calibrate, then on everything). `--no-osm` leaves those names out.

## Deploying

Export production's rows first, then build from the export, so the database
password never becomes a build argument (those are kept in the image history).
On the VPS, from `/var/www/server/ml`:

```bash
docker run --rm --network host --user root -v "$PWD":/work -w /work \
  -e DATABASE_URL="$(grep -E '^DATABASE_URL=' ../.env | cut -d= -f2- | tr -d '"')" \
  sugo-category:latest python -m sugo_category.train --export data/production.json
TRAIN_ARGS="--from-export data/production.json" TRAINED_AT=$(date +%s) \
  docker compose -f docker-compose.category.yml build
docker compose -f docker-compose.category.yml up -d
```

Then in `server/.env`:

```
CATEGORY_SERVICE_URL=http://127.0.0.1:8100
```

**Always pass a fresh `TRAINED_AT` when retraining.** Without it, a build with
no code change reuses Docker's cached training layer: it reports success and
the container keeps serving the old model. `/health`'s `real_rows` is the
check - it must move when the data has.

The models are baked into the image rather than mounted, so the running
container needs no database.

## Retraining without a rebuild

`POST /retrain` takes the catalogue and the labelled rows as JSON (the same
shape `--export` writes), trains in a separate, lower-priority process inside the
container, and swaps the new models in only once both have loaded. A failed
retrain leaves the old models answering; `GET /health` shows `training` and
whether the models came from the image or a retrain. The API server sends it
(`categoryRetrainingService.ts`) 30 s after an owner adds or edits a category,
and nightly at 03:45 (`jobs/categoryRetraining.ts`), so each day's pins and
items are learned without a deploy. A rebuilt image starts from its baked models
again; the next nightly retrain catches up.

Before 2026-09-24 that hook called `POST /reload`, which only re-read the same
files: nothing new was ever learned between deploys.

## Large-model second opinion (Gemini 3.8 Flash, Gemma 4 behind it)

For names the local model is unsure of, the service also asks a large model on
Google's Gemini API and pools its answer with the local one: Gemini 3.8 Flash
first, Gemma 4 (`gemma-4-26b-a4b-it`) while Flash is paused. Gemini 2.5 Flash,
the one first asked for, is closed to new API keys. `sugo_category/gemma.py`
explains the design; `category/GEMMA.md` has the measurements
(`python -m sugo_category.gemma_eval`). In short:

- On item names no training source contains, the test half went from 74.1%
  right (local model alone) to 96.5% (with Gemini 3.8 Flash), and 93.1% of
  them get a category, against 84.5%.
- Only answers below 0.85 are sent, a basket in one call. Search-as-you-type
  never calls; it reads the cache.
- The model must answer with one of the live categories (a JSON schema enum),
  and sees how this business files things: names each category was taught.
- One name takes about 1.6 s, more than the API server's 1.5 s for the whole
  request, so requests do not wait for it (`GEMMA_WAIT_MS`, 0). It is asked in
  the background and answers the next look; a new order's items are sent to
  `POST /warm` when it is placed, so they are usually answered before a
  dispatcher opens it.
- Answers are cached (`GEMMA_CACHE_PATH`), and a retrain teaches the surest
  ones (>= 0.9) to the local model at weight 2, below a person's 6.
- Pooled at weight 0.6, the model overruling the local model's top answer is
  auto-accepted only when the local model had its answer as a close second
  (0.375 or more); otherwise the dispatcher sees it marked for review.
- No key, a refused key, a spent quota (that model paused for as long as
  Google asks, the next in the chain answering), Google down: the local answer
  goes out unchanged. `GET /health` says which (`gemma.state`,
  `gemma.models`, `gemma.last_error`), and never shows the key.
- `POST /advise` is the other use: the API server's Conflict Management
  suggestions ask which of their filled-in reasons the evidence and the rider's
  note support, or none (`ml/exception-reasons/GEMINI.md`).

Set it up by putting the key in `ml/.env` (ignored by git and by the Docker
build context):

```
GEMMA_API_KEY=...
```

`uvicorn` run by hand reads that file. In Docker, compose reads it and passes
the key to the container at run time; it is never a build argument. Optional:
`GEMMA_MODEL` (the chain, comma-separated; default
`gemini-3.8-flash,gemma-4-26b-a4b-it`), `GEMMA_ENABLED=0` (off),
`GEMMA_WAIT_MS`, `GEMMA_CONSULT_BELOW`, `GEMMA_WEIGHT`, `GEMMA_PER_MINUTE`
(25), `GEMMA_PER_DAY` (5000). The names keep the GEMMA_ prefix from when Gemma
was the only model.

**Security:** no authentication, no rate limiting — same rule as OSRM. Bind to
loopback (the default) or a private interface, and firewall the port to the API
server. Never `0.0.0.0`, never the open internet.

## When it is down

Blank `CATEGORY_SERVICE_URL`. Store and item categories fall straight back to
the TypeScript rules in `storeCategoryInference.ts`, which is how the feature
worked before this service existed. Leaving the variable pointing at a dead host
is worse than blanking it: every pin then waits for a timeout before falling
back.

`GET /health` reports whether the models loaded and how many *real* and
OpenStreetMap rows each one saw. A model trained on seed phrases alone is not
broken, but it explains a lot of mediocre guesses: that was production's store
model until 2026-09-24 (`real_rows: 0`, and no Bakery or Convenience Store class).

## Tests

```bash
.venv/bin/python -m pytest tests -q
```

The store and item cases are deliberately **not** verbatim seed phrases — they
carry branch suffixes, misspellings, possessives and Tagalog wording. A model
that only answers its own lexicon back is a lookup table with extra steps, and
those tests exist to catch that.

`tests/test_neural.py` checks backpropagation against numerical gradients for
every activation, for a sparse first layer, and with no hidden layer at all.
`tests/test_deep.py` does the same for every layer of the CharCNN, and trains an
ensemble with transfer end to end. `tests/test_cleansing.py` pins each cleansing
rule and checks that no benchmark item appears in any seed list.
`tests/test_gemma.py` covers the Gemma cascade against a fake Google: the
schema, pooling, caching, timeouts, quota pauses and that the key never leaks.
No test calls Google (`tests/conftest.py` switches Gemma off for the suite).

Rerun every comparison behind `config.py` (about an hour; `--quick` checks the
script in minutes):

```bash
.venv/bin/python -m sugo_category.experiments
```
