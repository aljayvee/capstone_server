"""
Every named shop, eatery and health place in an OpenStreetMap extract.

The bulk source. The VPS already keeps `philippines-latest.osm.pbf` for the
routing graph (gis/data), so reading it costs no request to anyone: no rate
limit, no API key, no terms that forbid keeping what was read. One pass over the
whole country took 66 seconds on the VPS (2026-09-24) and yielded 157,309 named
places, most with their kind already tagged by the people who mapped them. That
is the learning data the lexicon never was: names people actually give shops.

The raw tags are written out, not a category. Which category a tag means
depends on the catalogue (a Bakery row exists or not), and that is decided at
training time by sugo_category.osm_labels.resolve_label, so this file never has
to be regenerated when an owner adds a category.

    python -m crawler.sources.osm_pbf <file.osm.pbf> <out.csv>

Needs `osmium` (pyosmium 4), which is deliberately not in requirements.txt: the
running service never reads a PBF. Install it where the extraction runs.

Data (c) OpenStreetMap contributors, ODbL 1.0. Anything built from the output
must say so; see ml/data/README.md.
"""

from __future__ import annotations

import argparse
import csv
import sys
import time
from pathlib import Path
from typing import Iterator, Mapping

from sugo_category.osm_labels import KEYS, TAG_LABELS

FIELDS = [
    "osm_type", "osm_id", "name", "brand", "lat", "lon",
    "shop", "amenity", "healthcare", "cuisine", "city",
]

# amenity=* also covers schools, banks, churches and parking. Only the values
# that are a place to buy something are kept; every shop=* and healthcare=* is.
KEPT_AMENITIES = {value for (key, value) in TAG_LABELS if key == "amenity"}


def wanted(tags: Mapping[str, str]) -> bool:
    if not (tags.get("name") or "").strip():
        return False
    if tags.get("shop") or tags.get("healthcare"):
        return True
    return (tags.get("amenity") or "") in KEPT_AMENITIES


def _centroid(way) -> tuple[float, float] | None:
    """The mean of a way's node locations. Close enough to pin a shop's building."""
    points = [(n.lat, n.lon) for n in way.nodes if n.location.valid()]
    if not points:
        return None
    return (
        sum(lat for lat, _ in points) / len(points),
        sum(lon for _, lon in points) / len(points),
    )


def iter_places(pbf: Path) -> Iterator[dict]:
    import osmium  # the service image does not have it; only extraction needs it

    processor = osmium.FileProcessor(str(pbf)).with_locations()
    # Filtering in C++ before Python sees an object is what makes a national
    # file take minutes rather than an hour: tens of millions of untagged nodes
    # never cross into the interpreter. Node locations are still cached for the
    # ways, because the location handler runs ahead of the filters.
    processor = processor.with_filter(osmium.filter.KeyFilter(*KEYS))

    for obj in processor:
        tags = {k: obj.tags.get(k) for k in (*KEYS, "name", "brand", "cuisine", "addr:city")}
        if not wanted(tags):
            continue
        if obj.is_node():
            point = (obj.location.lat, obj.location.lon) if obj.location.valid() else None
            kind = "node"
        elif obj.is_way():
            point = _centroid(obj)
            kind = "way"
        else:
            # Relations are kept for their name and tags (still a labelled shop
            # name) but get no position; assembling a multipolygon for one pin
            # is not worth the second pass.
            point = None
            kind = "relation"
        yield {
            "osm_type": kind,
            "osm_id": obj.id,
            "name": " ".join(tags["name"].split()),
            "brand": tags.get("brand") or "",
            "lat": f"{point[0]:.6f}" if point else "",
            "lon": f"{point[1]:.6f}" if point else "",
            "shop": tags.get("shop") or "",
            "amenity": tags.get("amenity") or "",
            "healthcare": tags.get("healthcare") or "",
            "cuisine": tags.get("cuisine") or "",
            "city": tags.get("addr:city") or "",
        }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("pbf", type=Path)
    parser.add_argument("out", type=Path)
    args = parser.parse_args(argv)

    started = time.time()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with args.out.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDS)
        writer.writeheader()
        for row in iter_places(args.pbf):
            writer.writerow(row)
            count += 1
    print(f"{count} named places from {args.pbf.name} in {time.time() - started:.0f} s -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
