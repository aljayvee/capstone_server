"""
One row per real shop, when two sources (or two mappers) describe the same one.

Same OSM object first: the snapshot and the live Overpass answer both carry
`node/123`, and the live copy is the newer. Then near-duplicates: the same
shop mapped twice, once as a point and once as its building, a few metres
apart and spelt the same or nearly. The one with more tags is kept.
"""

from __future__ import annotations

import math
from difflib import SequenceMatcher
from typing import Iterable

from sugo_category.model import normalize

NEAR_METRES = 60.0
SAME_NAME_RATIO = 0.9


def metres_between(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6_371_000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _richness(row: dict) -> int:
    return sum(1 for k in ("brand", "shop", "amenity", "healthcare", "cuisine", "city") if row.get(k))


def _same_place(a: dict, b: dict) -> bool:
    if not (a.get("lat") and a.get("lon") and b.get("lat") and b.get("lon")):
        return False
    if metres_between(float(a["lat"]), float(a["lon"]), float(b["lat"]), float(b["lon"])) > NEAR_METRES:
        return False
    na, nb = normalize(a["name"]), normalize(b["name"])
    return na == nb or SequenceMatcher(None, na, nb).ratio() >= SAME_NAME_RATIO


def dedupe(*sources: Iterable[dict]) -> list[dict]:
    """Later sources win on the same OSM id; near-duplicates keep the richer row."""
    by_id: dict[str, dict] = {}
    for source in sources:
        for row in source:
            by_id[f"{row.get('osm_type')}/{row.get('osm_id')}"] = row

    kept: list[dict] = []
    for row in sorted(by_id.values(), key=lambda r: -_richness(r)):
        if not any(_same_place(row, other) for other in kept):
            kept.append(row)
    return sorted(kept, key=lambda r: (r["name"].lower(), str(r.get("osm_id"))))
