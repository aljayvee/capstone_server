"""Data cleansing (sugo_category.cleansing) and the held-out item benchmark."""

from __future__ import annotations

import csv
from collections import defaultdict

from sugo_category.cleansing import (
    cleanse_osm_rows,
    cleanse_real_rows,
    repair_name,
    rule_label,
    strip_quantity,
)
from sugo_category.evaluation import ITEM_BENCHMARK, PRODUCTION_CATEGORIES
from sugo_category.lexicon import CONTESTED_CONCEPTS, FOOD, GROCERY, ITEM_PHRASES, PHARMACY, STORE_PHRASES
from sugo_category.model import normalize

BAKERY = "Bakery"


def test_registry_codes_come_off_and_real_numbers_stay():
    assert repair_name("0148951 5MJ BAKERY") == "5MJ BAKERY"
    assert repair_name("001ISR 152638 EVELYN") == "EVELYN"
    assert repair_name("7-Eleven") == "7-Eleven"
    assert repair_name("1126 Pharmacy") == "1126 Pharmacy"
    assert repair_name("Delicia�s Bake") == "Delicias Bake"


def test_quantities_come_off_items():
    assert strip_quantity("Pandesal (10pcs)") == "Pandesal"
    assert strip_quantity("coke 1.5L x2") == "coke"
    assert strip_quantity("Tide 1kg") == "Tide"
    assert strip_quantity("3 in 1 coffee") == "3 in 1 coffee"
    assert strip_quantity("555 sardines") == "555 sardines"


def test_kind_rules_name_the_shop_and_refuse_mixed_ones():
    assert rule_label("AMBOS Panaderia") == ("bakery", False)
    assert rule_label("Julie's Bakeshop") == ("bakery", False)
    assert rule_label("A Touch of Love Cakes and Pastries") == ("bakery", False)
    assert rule_label("Mercury Drug Store") == (PHARMACY, False)
    # Two kinds of shop in one name: no single label is right.
    assert rule_label("Borillo Bakery and Restaurant") == (None, True)
    assert rule_label("Green Pastures Fastfood & Bakeshop") == (None, True)
    assert rule_label("Adarna Drugstore & Grocery") == (None, True)
    # A supplier to bakeries is not a bakery.
    assert rule_label("Asaval Bakery Supply") == (None, False)
    assert rule_label("Jollibee") == (None, False)


def _osm(name, label, count=1):
    return {"name": name, "label": label, "count": str(count)}


def test_osm_cleansing_relabels_resolves_and_drops():
    rows = [
        _osm("AMBOS Panaderia", FOOD),
        _osm("Goldilocks", "bakery", 369),
        _osm("Goldilocks", FOOD, 2),
        _osm("Sari Sari Store", "convenience", 5),
        _osm("Sari Sari Store", GROCERY, 5),
        _osm("Borillo Bakery and Restaurant", "bakery"),
        _osm("0148956 R.J", "convenience"),
        _osm("Jollibee", FOOD, 3000),
    ]
    out, report = cleanse_osm_rows(rows)
    labels = {row["name"]: row["label"] for row in out}
    assert labels["AMBOS Panaderia"] == "bakery"
    assert labels["Goldilocks"] == "bakery"  # 369 of 371: majority
    assert "Sari Sari Store" not in labels  # 5 against 5: no majority, dropped
    assert "Borillo Bakery and Restaurant" not in labels  # mixed
    assert "R.J" not in labels and "0148956 R.J" not in labels  # nothing left
    assert labels["Jollibee"] == FOOD
    assert report.relabelled_by_rule == 1
    assert report.resolved_conflicts == 1
    assert report.dropped_conflicts == 1
    assert report.dropped_mixed == 1
    assert report.dropped_junk == 1
    assert report.rows_out == len(out) == 3


def test_items_filed_under_the_old_parent_move_to_the_owners_category():
    catalogue = set(PRODUCTION_CATEGORIES)
    rows = [("Pandesal (10pcs)", FOOD), ("Spanish bread", FOOD), ("Chickenjoy", FOOD), ("Pandesal", BAKERY)]
    out, report = cleanse_real_rows(rows, "item", catalogue)
    assert out == [("Pandesal", BAKERY), ("Spanish bread", BAKERY), ("Chickenjoy", FOOD), ("Pandesal", BAKERY)]
    assert report.relabelled_contested == 2
    assert report.quantities_stripped == 1


def test_without_a_bakery_category_nothing_moves():
    catalogue = {FOOD, GROCERY, PHARMACY}
    out, report = cleanse_real_rows([("Pandesal", FOOD)], "item", catalogue)
    assert out == [("Pandesal", FOOD)]
    assert report.relabelled_contested == 0


def test_a_pinned_bakeshop_filed_as_food_is_relabelled():
    out, _ = cleanse_real_rows([("Julie's Bakeshop Mabini", FOOD), ("Jollibee Tacurong", FOOD)], "store", set(PRODUCTION_CATEGORIES))
    assert out == [("Julie's Bakeshop Mabini", BAKERY), ("Jollibee Tacurong", FOOD)]


def test_the_benchmark_items_are_in_no_seed_list():
    taught = {normalize(p) for table in (ITEM_PHRASES, STORE_PHRASES) for phrases in table.values() for p in phrases}
    taught |= {normalize(p) for phrases in CONTESTED_CONCEPTS.values() for p in phrases}
    with ITEM_BENCHMARK.open(encoding="utf-8", newline="") as handle:
        benchmark = list(csv.DictReader(handle))
    assert len(benchmark) >= 40
    leaked = [row["name"] for row in benchmark if normalize(row["name"]) in taught]
    assert leaked == []
    assert {row["category"] for row in benchmark} <= set(PRODUCTION_CATEGORIES)


def test_the_lexicon_never_files_one_phrase_under_two_categories():
    for table in (ITEM_PHRASES, STORE_PHRASES):
        where = defaultdict(set)
        for category, phrases in table.items():
            for phrase in phrases:
                where[phrase].add(category)
        assert {p: c for p, c in where.items() if len(c) > 1} == {}
