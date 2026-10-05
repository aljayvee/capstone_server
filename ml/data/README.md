# Category model data

| File | What it is | Made by |
|---|---|---|
| `osm_store_names.csv` | 85,464 distinct shop names from OpenStreetMap, each with the kind of shop its mappers tagged (`name,label,count`). The store model's main training data. | `crawler.build_training_data` |
| `osm_tacurong.csv` | Every named shop, eatery and health place inside the Tacurong bounds (`crawler.config.TACURONG_BOUNDS`), with its position. | `crawler.build_training_data` |
| `tacurong_places_review.csv` | Those places, categorised by the store model, with a review flag. A sheet for a person, not a database write. | `crawler.run` |
| `real_jobs.csv` | Production's own labelled jobs on 2026-09-24: the category a dispatcher chose for each shop pinned and each item bought. A fixed test set for `sugo_category.experiments`; the live trainer reads the database instead. | exported by hand, 2026-09-24 |
| `production.json` | Production's catalogue and labelled rows at deploy time. Not committed; written just before a Docker build so the build never needs the database. | `sugo_category.train --export` |
| `gemma_benchmark_items.csv`, `gemma_benchmark_stores.csv` | Hand-labelled item and shop names (`name,category,also`) for measuring what Gemma 4 adds. `also` lists other categories that count as right (`|`-separated): pancit canton is on a convenience store's shelf and a supermarket's. Names a training source already carries are dropped when scored. Never trained on. | by hand, 2026-09-25; scored by `sugo_category.gemma_eval` |

## OpenStreetMap

Data (c) OpenStreetMap contributors, available under the Open Database License
(ODbL) 1.0, https://www.openstreetmap.org/copyright. Anything that shows or
passes on names from these files must credit OpenStreetMap the same way.

Extracted on 2026-09-24 from `philippines-latest.osm.pbf` (the file the VPS keeps
for the routing graph in `server/gis/data/`): 157,309 named places in 66 seconds,
128,374 of them with a tag that names one kind of shop. `label` is either a
category name or a concept (`bakery`, `convenience`) that becomes a category
only if the catalogue has one; see `sugo_category/osm_labels.py`, which also lists
the tags left out on purpose (`shop=general`, services such as hairdressers).

To refresh it where the PBF is (the VPS), in a throwaway container:

```bash
docker run --rm -v /var/www/server/gis/data:/data:ro -v "$PWD":/work -w /work python:3.12-slim bash -c \
  "apt-get update -qq && apt-get install -y -qq libexpat1 && pip install -q osmium && \
   python -m crawler.sources.osm_pbf /data/philippines-latest.osm.pbf /work/philippines.csv"
python -m crawler.build_training_data philippines.csv
```

## Why not Google Maps or Facebook

Both were asked for. Neither is used as a stored source:

- **Google Maps.** The Places API policy lets a client store place IDs and nothing
  else ("You must not pre-fetch, cache, or store Places API content beyond the
  allowed exceptions"), and scraping Maps pages is against Google's terms. Google's
  place types are still used live: the web console sends them with each pin and
  `model.category_from_google_types` blends them into the answer.
- **Facebook.** Meta's Automated Data Collection Terms forbid scrapers, bots and
  crawlers without Meta's express written permission. A shop's own menu photo,
  shared with SUGO, can go through the OCR path in `crawler/vision_quota_guard.py`.
