"""
Live OpenStreetMap places inside a bounding box, from the Overpass API.

The PBF on the VPS is a snapshot from the day it was downloaded. This reads
what mappers have added since, for one small area (Tacurong by default), and
returns rows in exactly the shape crawler.sources.osm_pbf writes, so both feed
the same pipeline.

One query per run, through PoliteFetcher (robots.txt, backoff, a day's cache).
Overpass's usage policy is about volume, and this is a few hundred objects.

Data (c) OpenStreetMap contributors, ODbL 1.0.
"""

from __future__ import annotations

from urllib.parse import urlencode

from sugo_category.osm_labels import TAG_LABELS

from ..config import OVERPASS_URL, TACURONG_BOUNDS
from ..fetcher import PoliteFetcher

AMENITIES = sorted({value for (key, value) in TAG_LABELS if key == "amenity"})


def build_query(bounds: dict = TACURONG_BOUNDS, timeout: int = 60) -> str:
    bbox = (
        f"{bounds['min_latitude']},{bounds['min_longitude']},"
        f"{bounds['max_latitude']},{bounds['max_longitude']}"
    )
    amenity = "|".join(AMENITIES)
    # `out center tags` gives ways and relations a single point, which is all
    # a pin needs, and skips their geometry, which is most of the bytes.
    return (
        f"[out:json][timeout:{timeout}];("
        f'nwr["shop"]["name"]({bbox});'
        f'nwr["amenity"~"^({amenity})$"]["name"]({bbox});'
        f'nwr["healthcare"]["name"]({bbox});'
        ");out center tags;"
    )


def parse(payload: dict) -> list[dict]:
    rows = []
    for el in payload.get("elements", []):
        tags = el.get("tags") or {}
        name = " ".join((tags.get("name") or "").split())
        if not name:
            continue
        lat = el.get("lat", (el.get("center") or {}).get("lat"))
        lon = el.get("lon", (el.get("center") or {}).get("lon"))
        rows.append({
            "osm_type": el.get("type", ""),
            "osm_id": el.get("id", ""),
            "name": name,
            "brand": tags.get("brand", ""),
            "lat": f"{lat:.6f}" if lat is not None else "",
            "lon": f"{lon:.6f}" if lon is not None else "",
            "shop": tags.get("shop", ""),
            "amenity": tags.get("amenity", ""),
            "healthcare": tags.get("healthcare", ""),
            "cuisine": tags.get("cuisine", ""),
            "city": tags.get("addr:city", ""),
        })
    return rows


def fetch_places(fetcher: PoliteFetcher, bounds: dict = TACURONG_BOUNDS, url: str = OVERPASS_URL) -> list[dict]:
    body = urlencode({"data": build_query(bounds)}).encode()
    response = fetcher.fetch(url, data=body, headers={"Content-Type": "application/x-www-form-urlencoded"})
    return parse(response.json())
