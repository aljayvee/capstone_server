"""
What an OpenStreetMap tag says about the kind of shop, in SUGO's categories.

OpenStreetMap is the crawler's main source because its data may be kept and
learned from (ODbL, with attribution), which Google's and Facebook's may not.
Google's Places policy lets a client store place IDs and nothing else, and
Meta's Automated Data Collection Terms forbid crawling without its written
permission. So Google's `types` stay a live signal (see model.py), and the
stored training rows come from here.

Only tags that name a KIND of shop unambiguously get a label. A tag that could
be two things is left out rather than guessed: `shop=general` in the Philippines
is as often a sari-sari store as a general merchandise store, and one wrong
label repeated a thousand times teaches the model the wrong thing a thousand
times. Services that sell nothing a rider can buy (hairdresser, laundry, car
repair) are left out too.

Some tags map to a CONCEPT rather than a category. `shop=bakery` is Bakery where
the catalogue has a Bakery category and Fast Food & Restaurant where it does
not, the same rule lexicon.CONTESTED_CONCEPTS applies to the seed phrases.
`resolve_label` makes that choice at training time, so the extracted file never
has to be regenerated when an owner adds a category.
"""

from __future__ import annotations

from functools import lru_cache

from typing import Iterable, Mapping

from .lexicon import FOOD, GROCERY, PHARMACY, RETAIL

# (OSM key, value) -> category or concept. Concepts are lowercase and resolved
# by resolve_label; categories are the exact merchant_categories names.
BAKERY = "bakery"
CONVENIENCE = "convenience"

TAG_LABELS: dict[tuple[str, str], str] = {
    # Food and drink
    **{("amenity", v): FOOD for v in (
        "restaurant", "fast_food", "cafe", "food_court", "ice_cream", "bar", "pub",
        "biergarten",
    )},
    **{("shop", v): BAKERY for v in ("bakery", "pastry", "cake")},
    # Health
    **{("amenity", v): PHARMACY for v in (
        "pharmacy", "clinic", "doctors", "dentist", "hospital", "veterinary",
    )},
    **{("healthcare", v): PHARMACY for v in (
        "pharmacy", "clinic", "doctor", "dentist", "hospital", "laboratory",
        "optometrist", "physiotherapist", "rehabilitation", "centre", "dialysis",
    )},
    **{("shop", v): PHARMACY for v in (
        "chemist", "medical_supply", "optician", "herbalist", "hearing_aids",
        "nutrition_supplements",
    )},
    # Groceries and fresh food
    **{("shop", v): GROCERY for v in (
        "supermarket", "grocery", "greengrocer", "butcher", "seafood", "deli",
        "frozen_food", "dairy", "rice", "water", "beverages", "farm", "food",
        "wholesale", "spices", "eggs", "poultry",
    )},
    ("amenity", "marketplace"): GROCERY,
    ("shop", "convenience"): CONVENIENCE,
    # Goods that are not food or medicine
    **{("shop", v): RETAIL for v in (
        "hardware", "doityourself", "trade", "building_materials", "clothes",
        "shoes", "boutique", "fashion", "second_hand", "electronics",
        "mobile_phone", "computer", "appliance", "furniture", "department_store",
        "variety_store", "books", "stationery", "copyshop", "gift", "toys", "pet",
        "motorcycle", "motorcycle_parts", "car_parts", "tyres", "bicycle",
        "agrarian", "garden_centre", "fabric", "sewing", "bag", "jewelry",
        "watches", "cosmetics", "houseware", "kitchen", "paint", "lighting",
        "electrical", "sports", "fishing", "party", "bed", "curtain", "glaziery",
        "tiles", "flooring", "plumbing", "energy", "gas", "telecommunication",
        "florist",
    )},
}

# Keys the extractor keeps. Anything else on the object is dropped at extraction.
KEYS = ("shop", "amenity", "healthcare")

# Where a concept goes when the catalogue has no category of its own for it.
CONCEPT_PARENTS: dict[str, str] = {BAKERY: FOOD, CONVENIENCE: GROCERY}

# Which catalogue names count as the concept's own category. Several spellings,
# because the name is the match key and an owner types whichever comes to mind.
CONCEPT_CATEGORIES: dict[str, tuple[str, ...]] = {
    BAKERY: ("Bakery", "Bakeshop", "Bakery & Pastry"),
    CONVENIENCE: ("Convenience Store", "Convenience Stores", "Convenience"),
}


def label_for_tags(tags: Mapping[str, str]) -> str | None:
    """
    The category or concept an object's tags name, or None when they name none
    or name two different ones.

    Two different answers ("amenity=cafe" and "shop=bakery" on one bakeshop café)
    count as ambiguous. Keeping it out costs one row; keeping it in under either
    label teaches half a lie.
    """
    found = {
        TAG_LABELS[(key, str(tags.get(key, "")).strip().lower())]
        for key in KEYS
        if (key, str(tags.get(key, "")).strip().lower()) in TAG_LABELS
    }
    return found.pop() if len(found) == 1 else None


def resolve_label(label: str | None, active: Iterable[str] | None) -> str | None:
    """
    A concept becomes a real category name for THIS catalogue.

    `active` is the list of category names the environment has, or None for the
    lexicon's four. A category label passes through unchanged if the catalogue
    has it, and is dropped (None) if it does not.
    """
    if label is None:
        return None
    # Through the catalogue's roles (catalogue.py): a concept or a category
    # name the catalogue has renamed goes to the category carrying its role,
    # which is what CONCEPT_CATEGORIES/CONCEPT_PARENTS spelled out by hand.
    return _catalogue_for(active).resolve(label)


def _catalogue_for(active):
    from .catalogue import Catalogue

    if isinstance(active, Catalogue):
        return active
    return _cached_catalogue(None if active is None else tuple(sorted(active)))


@lru_cache(maxsize=32)
def _cached_catalogue(names):
    from .catalogue import Catalogue

    return Catalogue.of(names)
