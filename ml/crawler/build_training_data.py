"""
Turn an OpenStreetMap extract (crawler.sources.osm_pbf) into the store model's
training file, and pull out the places inside Tacurong.

    python -m crawler.build_training_data <extract.csv> [--out data]

Writes two files:

  data/osm_store_names.csv  name,label,count. One row per distinct shop name and
                            label, deduplicated on the normalised name, so the
                            4,000 7-Elevens in the country count as one lesson
                            rather than drowning every other name. `label` is a
                            category or a concept (bakery, convenience) and is
                            resolved against the live catalogue at training time.
  data/osm_tacurong.csv     every extracted place inside the Tacurong bounds,
                            with its position, for crawler.run to categorise.

Data (c) OpenStreetMap contributors, ODbL 1.0.
"""

from __future__ import annotations

import argparse
import csv
import re
import sys
from collections import Counter
from pathlib import Path

from crawler.config import TACURONG_BOUNDS
from sugo_category.model import normalize
from sugo_category.osm_labels import label_for_tags

DATA_DIR = Path(__file__).resolve().parent.parent / "data"

# Names that say nothing about the shop. A label on "Store" or "123" teaches
# the model that the word or number predicts the category, which it does not.
_JUNK = re.compile(r"^(?:[\d\s\W]+|unnamed.*|no name|none|n/?a|test|shop|store)$", re.IGNORECASE)


def usable_name(name: str) -> bool:
    name = (name or "").strip()
    return len(name) >= 3 and not _JUNK.match(name)


def in_tacurong(lat: str, lon: str) -> bool:
    if not lat or not lon:
        return False
    la, lo = float(lat), float(lon)
    return (
        TACURONG_BOUNDS["min_latitude"] <= la <= TACURONG_BOUNDS["max_latitude"]
        and TACURONG_BOUNDS["min_longitude"] <= lo <= TACURONG_BOUNDS["max_longitude"]
    )


def build(extract: Path, out_dir: Path) -> dict:
    counts: Counter[tuple[str, str]] = Counter()
    spelling: dict[tuple[str, str], str] = {}
    tacurong: list[dict] = []
    total = labelled = 0

    with extract.open(encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        fields = reader.fieldnames or []
        for row in reader:
            total += 1
            if in_tacurong(row.get("lat", ""), row.get("lon", "")):
                tacurong.append(row)
            label = label_for_tags(row)
            if label is None or not usable_name(row["name"]):
                continue
            key = (normalize(row["name"]), label)
            if not key[0]:
                continue
            labelled += 1
            counts[key] += 1
            spelling.setdefault(key, row["name"])

    out_dir.mkdir(parents=True, exist_ok=True)
    # Sorted, so a re-run over the same extract rewrites the same bytes and a
    # diff shows only what the mappers changed.
    with (out_dir / "osm_store_names.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["name", "label", "count"])
        for key in sorted(counts):
            writer.writerow([spelling[key], key[1], counts[key]])
    with (out_dir / "osm_tacurong.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(sorted(tacurong, key=lambda r: (r["name"].lower(), r["osm_id"])))

    return {
        "places": total,
        "labelled_places": labelled,
        "distinct_names": len(counts),
        "tacurong_places": len(tacurong),
        "by_label": dict(Counter(label for _, label in counts).most_common()),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("extract", type=Path)
    parser.add_argument("--out", type=Path, default=DATA_DIR)
    args = parser.parse_args(argv)
    summary = build(args.extract, args.out)
    for key, value in summary.items():
        print(f"{key}: {value}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
