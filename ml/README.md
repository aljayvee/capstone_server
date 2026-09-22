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
character n-grams of the de-spaced text, feeding a multinomial logistic
regression. One for shop names, one for item names.

Three decisions worth knowing about:

- **Character n-grams carry it.** Philippine shop names are misspelt,
  abbreviated and run together: `Jolibee`, `MercuryDrug Tacurong`, `Aling Nena's
  Karinderya`. A word-only model treats every variant as an unrelated token.
  The de-spaced block exists specifically so `milk tea` and `milktea` share
  n-grams — `char_wb` alone never reads across a word boundary.
- **It is allowed to say nothing.** Below `min_confidence` (default 0.55) the
  service returns `category: null`, and the pin keeps its amber "Category
  needed" mark. Ten server behaviours read that field — dwell allowance,
  geofence radius, revenue allocation — so a confident wrong answer costs more
  than an absent one.
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
| `errand_pinpoints` | The category a dispatcher actually committed on a live errand. The gold labels — every one is a human answering this exact question, and the corrections are the only record of where the model used to be wrong. |
| `pabili_details_tbl`, `pabili_item_requests_tbl` | The item side. `storeCategory` is the composite `"Store 2 - Jollibee \| Fast Food & Restaurant"` the console writes, so the category is whatever follows `" \| "`. |
| `sugo_category/lexicon.py` | Hand-written seed knowledge: PH chains, Tagalog/Bisaya shop words, common product names. A floor for a fresh install and for the long tail. |

Real rows outweigh seed phrases 6:1 (`REAL_ROW_WEIGHT`). Where Tacurong's own
data disagrees with the lexicon, the data wins — otherwise dispatchers could
never correct the thing.

## Running it

```bash
cd server/ml
python -m venv .venv && .venv/bin/pip install -r requirements.txt -r requirements-dev.txt
python -m sugo_category.train --offline --out ./models   # seed lexicon only
uvicorn app:app --port 8100
```

Train against the live catalogue instead of the lexicon alone:

```bash
python -m sugo_category.train --database-url "mysql+pymysql://user:pass@host/capstone" --out ./models
```

`DATABASE_URL` from `server/.env` works directly — `mysql://` is rewritten to
`mysql+pymysql://` for you.

## Deploying

```bash
docker compose -f ml/docker-compose.category.yml build \
  --build-arg TRAIN_ARGS="--database-url mysql+pymysql://user:pass@host/capstone"
docker compose -f ml/docker-compose.category.yml up -d
```

Then in `server/.env`:

```
CATEGORY_SERVICE_URL=http://127.0.0.1:8100
```

The models are baked into the image rather than mounted, so the running
container needs no database. Retraining means rebuilding, which is deliberate
and leaves a tag behind. `POST /reload` re-reads the model directory without a
restart if you do choose to mount one.

**Security:** no authentication, no rate limiting — same rule as OSRM. Bind to
loopback (the default) or a private interface, and firewall the port to the API
server. Never `0.0.0.0`, never the open internet.

## When it is down

Blank `CATEGORY_SERVICE_URL`. Store and item categories fall straight back to
the TypeScript rules in `storeCategoryInference.ts`, which is how the feature
worked before this service existed. Leaving the variable pointing at a dead host
is worse than blanking it: every pin then waits for a timeout before falling
back.

`GET /health` reports whether the models loaded and how many *real* rows each
one saw. A model trained on seed phrases alone is not broken, but it explains a
lot of mediocre guesses.

## Tests

```bash
.venv/bin/python -m pytest tests -q
```

The store and item cases are deliberately **not** verbatim seed phrases — they
carry branch suffixes, misspellings, possessives and Tagalog wording. A model
that only answers its own lexicon back is a lookup table with extra steps, and
those tests exist to catch that.
