"""
POST /search-items: the lexicon half of stage 3's Catalog Helper.

It used to search only a crawled-menu table that nothing filled, so every search
was empty. These check it finds the items people actually type, files them under
the catalogue's own categories, and offers only real items.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import app as service
from sugo_category.item_search import ItemCatalogue, display_name
from sugo_category.lexicon import FOOD, GROCERY, PHARMACY, RETAIL
from sugo_category.model import CategoryModel

SIX = [FOOD, PHARMACY, GROCERY, RETAIL, "Bakery", "Convenience Store"]


@pytest.fixture(scope="module")
def catalogue() -> ItemCatalogue:
    return ItemCatalogue(SIX)


@pytest.mark.parametrize(
    "query,expected",
    [
        ("bio", ("Biogesic", PHARMACY)),
        ("chick", ("Chickenjoy", FOOD)),
        ("milktea", ("Milk Tea", FOOD)),  # run together, as customers type it
        ("pandesal", ("Pandesal", "Bakery")),  # the catalogue's own Bakery, not Fast Food
        ("aa batt", ("AA Battery", RETAIL)),
    ],
)
def test_finds_what_people_type(catalogue, query, expected):
    found = [(r["name"], r["category"]) for r in catalogue.search(query, 10)]
    assert expected in found, found


def test_exact_and_prefix_matches_come_first(catalogue):
    names = [r["name"] for r in catalogue.search("rice", 10)]
    assert names[0] == "Rice"
    assert names.index("Rice") < names.index("Jasmine Rice")


def test_only_items_never_shop_names_or_made_up_seeds():
    # "7 eleven" is a Convenience Store shop phrase, and "pet supplies item" a
    # generate_dynamic_seeds guess: both are training rows, neither is an item.
    catalogue = ItemCatalogue(SIX + ["Pet Supplies"])
    names = {r["name"].lower() for q in ("eleven", "pet supplies item", "bakeshop") for r in catalogue.search(q, 25)}
    assert "7 eleven" not in names
    assert "pet supplies item" not in names
    assert "bakeshop" not in names


def test_short_or_empty_queries_return_nothing(catalogue):
    assert catalogue.search("a") == []
    assert catalogue.search("   ") == []


def test_display_name():
    assert display_name("3 in 1 coffee") == "3 in 1 Coffee"
    assert display_name("aa battery") == "AA Battery"


def test_endpoint_returns_matches_and_a_guess_for_the_text_as_typed(tmp_path, monkeypatch):
    for kind in ("store", "item"):
        CategoryModel.train(kind, [], holdout=False, allowed=set(SIX)).save(tmp_path)
    monkeypatch.setattr(service, "MODEL_DIR", tmp_path)
    monkeypatch.setattr(service, "CURRENT", tmp_path / "current")
    monkeypatch.setattr(service, "_catalogue", None)
    service._models.clear()
    with TestClient(service.app) as client:
        body = client.post("/search-items", json={"query": "biogesic 500mg", "limit": 5}).json()
        assert body["results"][0] == {"name": "Biogesic", "category": PHARMACY}
        assert body["prediction"]["category"] == PHARMACY
        assert body["prediction"]["name"] == "biogesic 500mg"

        nothing = client.post("/search-items", json={"query": "zzqx"}).json()
        assert nothing["results"] == []
        assert client.post("/search-items", json={"query": "x" * 101}).status_code == 422
