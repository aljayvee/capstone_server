"""
Crawl Tacurong's establishments and file each one under a SUGO category.

    python -m crawler.run [--live] [--models models] [--out data/tacurong_places_review.csv]

1. Places: data/osm_tacurong.csv (from the VPS's Philippines extract, via
   crawler.build_training_data), plus, with --live, the Overpass API's current
   answer for the Tacurong box, so shops mapped since the snapshot are found.
2. One row per shop (crawler.dedupe).
3. The store model reads each name. Where the mappers tagged the place, the
   tag's own category is kept beside the model's answer.
4. establishment_matcher applies the Tacurong bounds and zone priors and the
   0.75 review threshold.

The output is a review sheet, not a write to the database: verified_places is
the owner's hand-picked store catalogue, and a crawl must not add to it without
a person saying yes. Each row says whether it can be accepted as is or needs a
look, and whether the model and the mappers agree.

Google Maps and Facebook are not sources, on purpose. Google's Places policy
allows storing place IDs only, and Meta's Automated Data Collection Terms
forbid crawling without Meta's written permission. Google's place types are
still used, live, when a dispatcher pins a shop (model.category_from_google_types).
"""

from __future__ import annotations

import argparse
import csv
import sys
from collections import Counter
from pathlib import Path

from sugo_category.model import CategoryModel
from sugo_category.osm_labels import label_for_tags, resolve_label

from .config import OVERPASS_MAX_RETRIES, OVERPASS_TIMEOUT_SECONDS, TACURONG_BOUNDS
from .dedupe import dedupe
from .establishment_matcher import match_establishment_category
from .fetcher import PoliteFetcher

ML_DIR = Path(__file__).resolve().parent.parent
SNAPSHOT = ML_DIR / "data" / "osm_tacurong.csv"
REVIEW = ML_DIR / "data" / "tacurong_places_review.csv"
CACHE = ML_DIR / ".crawl-cache"

FIELDS = [
    "name", "lat", "lon", "osm", "mapper_category", "model_category", "confidence",
    "final_category", "needs_review", "agrees_with_mappers", "reason",
]


def load_snapshot(path: Path = SNAPSHOT) -> list[dict]:
    if not path.exists():
        return []
    with path.open(encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def categorise(places: list[dict], model: CategoryModel) -> list[dict]:
    classes = model.report.classes
    out = []
    for place in places:
        prediction = model.predict(place["name"])
        match = match_establishment_category(
            place["name"],
            address=place.get("city", ""),
            latitude=float(place["lat"]) if place.get("lat") else None,
            longitude=float(place["lon"]) if place.get("lon") else None,
            model_prediction=prediction,
        )
        mapper = resolve_label(label_for_tags(place), classes) or ""
        model_category = match.predicted_category or ""
        # A mapper's tag is a person who looked at the shop saying what it is,
        # so it wins. The model only fills the places nobody tagged. This used
        # to be the other way round, and the sheet filed both of Tacurong's
        # Minute Burgers and its Dunkin' Donuts under Bakery on a 0.62 guess
        # over the mappers' fast_food tags. Disagreement still means review:
        # the shop may have changed since it was mapped.
        final = mapper or model_category
        disagree = bool(mapper and model_category and mapper != model_category)
        out.append({
            "name": place["name"],
            "lat": place.get("lat", ""),
            "lon": place.get("lon", ""),
            "osm": f"{place.get('osm_type')}/{place.get('osm_id')}",
            "mapper_category": mapper,
            "model_category": prediction.get("category") or "",
            "confidence": f"{match.confidence:.3f}",
            "final_category": final,
            "needs_review": "yes" if (match.needs_review and not mapper) or disagree else "no",
            "agrees_with_mappers": "" if not mapper or not prediction.get("category")
            else ("yes" if mapper == prediction["category"] else "no"),
            "reason": (
                f"Mappers tag it {mapper}; the model reads the name as {model_category} ({match.confidence:.2f}). Check it."
                if disagree
                else "Tagged by OpenStreetMap mappers." if mapper
                else match.reason
            ),
        })
    return out


def summarise(rows: list[dict]) -> dict:
    tagged = [r for r in rows if r["mapper_category"] and r["model_category"]]
    return {
        "places": len(rows),
        "auto_accepted": sum(r["needs_review"] == "no" for r in rows),
        "needs_review": sum(r["needs_review"] == "yes" for r in rows),
        "no_category": sum(not r["final_category"] for r in rows),
        "model_agrees_with_mappers": f"{sum(r['agrees_with_mappers'] == 'yes' for r in tagged)} of {len(tagged)}",
        "by_category": dict(Counter(str(r["final_category"] or "(none)") for r in rows).most_common()),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--live", action="store_true", help="also ask the Overpass API for the current map")
    parser.add_argument("--models", type=Path, default=ML_DIR / "models")
    parser.add_argument("--out", type=Path, default=REVIEW)
    args = parser.parse_args(argv)

    sources = [load_snapshot()]
    if args.live:
        from .sources.overpass import fetch_places

        fetcher = PoliteFetcher(cache_dir=CACHE, timeout=OVERPASS_TIMEOUT_SECONDS, max_retries=OVERPASS_MAX_RETRIES)
        try:
            sources.append(fetch_places(fetcher, TACURONG_BOUNDS))
            print(f"overpass: {len(sources[-1])} places, fetcher {fetcher.stats}")
        except Exception as exc:  # noqa: BLE001 - the snapshot is still a full answer
            print(f"overpass unavailable ({exc}); using the snapshot alone")
    places = dedupe(*sources)
    model = CategoryModel.load(args.models, "store")
    rows = categorise(places, model)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows)
    for key, value in summarise(rows).items():
        print(f"{key}: {value}")
    print(f"review sheet: {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
