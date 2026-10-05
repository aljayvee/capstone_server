"""
The data side of training: what counts as a shop name, how the OpenStreetMap
labels meet the catalogue, how the held-out split is drawn, how confidence is
calibrated, and the export file a Docker build trains from.
"""

from __future__ import annotations

import json

import numpy as np
import pytest

from sugo_category.evaluation import apply_temperature, fit_temperature, group_split, load_osm_rows, measure
from sugo_category.lexicon import FOOD, GROCERY, PHARMACY, RETAIL
from sugo_category.model import CategoryModel, normalize
from sugo_category.train import is_shop_name, main as train_main

SIX = [FOOD, PHARMACY, GROCERY, RETAIL, "Bakery", "Convenience Store"]


@pytest.mark.parametrize(
    "name,ok",
    [("Unnamed Road", False), ("unnamed", False), ("N/A", False), ("  ", False), (None, False),
     ("Kimsan Plaza", True), ("Road House Grill", True)],
)
def test_is_shop_name(name, ok):
    assert is_shop_name(name) is ok


def test_osm_labels_resolve_against_the_catalogue(tmp_path):
    path = tmp_path / "osm.csv"
    path.write_text(
        "name,label,count\n"
        "Julie's Bakeshop,bakery,12\n"
        "7-Eleven,convenience,3065\n"
        "Mercury Drug,Pharmacy & Health,400\n",
        encoding="utf-8",
    )
    assert load_osm_rows(None, path) == [
        ("Julie's Bakeshop", FOOD), ("7-Eleven", GROCERY), ("Mercury Drug", PHARMACY),
    ]
    assert load_osm_rows(SIX, path) == [
        ("Julie's Bakeshop", "Bakery"), ("7-Eleven", "Convenience Store"), ("Mercury Drug", PHARMACY),
    ]
    assert load_osm_rows([FOOD, GROCERY], path) == [("Julie's Bakeshop", FOOD), ("7-Eleven", GROCERY)]


def test_group_split_never_puts_one_name_in_two_splits():
    rows = [(f"Shop {i % 50}", FOOD) for i in range(500)] + [(f"Drug {i}", PHARMACY) for i in range(300)]
    train, val, test = group_split(rows, seed=3)
    names = [{normalize(n) for n, _ in part} for part in (train, val, test)]
    assert not (names[0] & names[1]) and not (names[0] & names[2]) and not (names[1] & names[2])
    assert len(train) + len(val) + len(test) == len(rows)


def test_temperature_keeps_the_ranking_and_fixes_overconfidence():
    rng = np.random.default_rng(0)
    y = rng.integers(0, 3, size=2000)
    # A model that is right 60% of the time but always 95% sure.
    pred = np.where(rng.random(2000) < 0.6, y, (y + 1) % 3)
    proba = np.full((2000, 3), 0.025)
    proba[np.arange(2000), pred] = 0.95
    t = fit_temperature(proba, y)
    assert t > 1.5
    softened = apply_temperature(proba, t)
    assert np.array_equal(softened.argmax(axis=1), proba.argmax(axis=1))
    assert abs(float(softened.max(axis=1).mean()) - 0.6) < 0.05
    assert np.array_equal(apply_temperature(proba, 1.0), proba)


def test_measure_counts_a_category_the_model_lacks_as_wrong():
    proba = np.array([[0.9, 0.1], [0.2, 0.8]])
    m = measure(proba, [FOOD, PHARMACY], [FOOD, "Bakery"])
    assert m["accuracy"] == 0.5
    assert m["unpredictable_rows"] == 1


def test_trains_from_an_export_without_a_database(tmp_path):
    export = tmp_path / "production.json"
    export.write_text(json.dumps({
        "exported_at": "2026-09-24T00:00:00Z",
        "categories": SIX,
        "stores": [["Julie's Bakeshop Tacurong", "Bakery"]] * 4 + [["Unnamed Road", FOOD]] * 3
        + [["7-Eleven Tacurong NDTC (3502)", "Convenience Store"]] * 4,
        "items": [["Pandesal (10pcs)", "Bakery"]] * 3,
    }), encoding="utf-8")
    out = tmp_path / "models"
    assert train_main(["--from-export", str(export), "--out", str(out), "--no-osm"]) == 0
    store = CategoryModel.load(out, "store")
    assert {"Bakery", "Convenience Store"} <= set(store.report.classes)
    assert store.report.real_rows == 8  # "Unnamed Road" is not a shop name
    assert store.predict("Julie's Bakeshop Isulan")["category"] == "Bakery"
    assert store.predict("7-Eleven Koronadal")["category"] == "Convenience Store"
