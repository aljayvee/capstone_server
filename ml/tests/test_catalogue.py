"""
The catalogue edge cases found on 2026-09-25 (sugo_category.catalogue):

  - renaming Bakery sent pandesal to Jollibee again;
  - renaming "Fast Food & Restaurant" left the model answering the old name,
    which the API cannot use, so Chickenjoy got no suggestion at all;
  - a new category learned nothing about its items ("hammer" stayed Retail);
  - category descriptions were never read.
"""

from __future__ import annotations

from dataclasses import replace

import pytest

from sugo_category.catalogue import Catalogue, bind_roles, description_phrases
from sugo_category.config import ITEM
from sugo_category.lexicon import synthetic_rows
from sugo_category.model import CategoryModel
from sugo_category.osm_labels import resolve_label

# Production's catalogue on 2026-09-25, descriptions included.
PRODUCTION = {
    "Fast Food & Restaurant": "Fast food chains, diners, carinderias, bakeries, and cafes",
    "Pharmacy & Health": "Drugstores, medical supply stores, and clinics",
    "Supermarket & Grocery": "Supermarkets, convenience stores, and public market stalls",
    "Retail & General Merchandise": "Department stores, hardware, school supplies, and dry goods",
    "Bakery": "This is a bakery",
    "Convenience Store": "This is intended for 7/11 etc.",
}


def renamed(old: str, new: str, description: str | None = None) -> dict[str, str]:
    out = {k: v for k, v in PRODUCTION.items() if k != old}
    out[new] = PRODUCTION[old] if description is None else description
    return out


def labels(rows, kind: str) -> dict[str, str]:
    return {text: category for text, category, row_kind in rows if row_kind == kind}


# ── binding ────────────────────────────────────────────────────────────────


def test_production_binds_every_role_by_its_exact_name():
    binding, ambiguous = bind_roles(PRODUCTION)
    assert binding == {
        "food": "Fast Food & Restaurant",
        "pharmacy": "Pharmacy & Health",
        "grocery": "Supermarket & Grocery",
        "retail": "Retail & General Merchandise",
        "bakery": "Bakery",
        "convenience": "Convenience Store",
    }
    assert ambiguous == []


@pytest.mark.parametrize(
    "old, new, role",
    [
        ("Bakery", "Breads & Pastries", "bakery"),
        ("Bakery", "Panaderia", "bakery"),
        ("Fast Food & Restaurant", "Restaurants", "food"),
        ("Pharmacy & Health", "Drugstores", "pharmacy"),
        ("Supermarket & Grocery", "Groceries", "grocery"),
        ("Convenience Store", "Sari-Sari & Minimarts", "convenience"),
    ],
)
def test_a_rename_that_still_says_what_it_is_keeps_its_role(old, new, role):
    catalogue = Catalogue(renamed(old, new))
    assert catalogue.binding[role] == new
    # A row stored under the old name, and the map's concept, both follow.
    assert catalogue.resolve(old) == new


def test_an_opaque_new_name_is_bound_by_its_description():
    catalogue = Catalogue(renamed("Bakery", "Julie's Corner", "This is a bakery"))
    assert catalogue.binding["bakery"] == "Julie's Corner"


def test_a_tie_binds_nobody_and_the_concept_falls_back_to_its_parent():
    catalogue = Catalogue({**{k: v for k, v in PRODUCTION.items() if k != "Bakery"}, "Breads": "", "Cakes": ""})
    assert "bakery" in catalogue.ambiguous
    assert "bakery" not in catalogue.binding
    assert catalogue.resolve("bakery") == "Fast Food & Restaurant"


def test_without_a_bakery_category_bread_goes_to_food_as_before():
    catalogue = Catalogue({k: v for k, v in PRODUCTION.items() if k != "Bakery"})
    assert resolve_label("bakery", catalogue) == "Fast Food & Restaurant"


def test_a_role_no_category_carries_resolves_to_nothing():
    catalogue = Catalogue({"Bakery": "", "Pharmacy & Health": ""})
    assert catalogue.resolve("Fast Food & Restaurant") is None
    assert catalogue.resolve("Supermarket & Grocery") is None


# ── the lexicon follows ────────────────────────────────────────────────────


def test_renaming_bakery_keeps_bread_out_of_fast_food():
    items = labels(synthetic_rows(Catalogue(renamed("Bakery", "Breads & Pastries"))), "item")
    assert items["pandesal"] == "Breads & Pastries"
    assert items["spanish bread"] == "Breads & Pastries"
    assert items["chickenjoy"] == "Fast Food & Restaurant"


def test_renaming_fast_food_never_trains_the_old_name():
    rows = synthetic_rows(Catalogue(renamed("Fast Food & Restaurant", "Restaurants")))
    assert "Fast Food & Restaurant" not in {category for _, category, _ in rows}
    assert labels(rows, "item")["chickenjoy"] == "Restaurants"
    assert labels(rows, "store")["jollibee"] == "Restaurants"


# ── new categories learn from their descriptions ───────────────────────────


def test_description_phrases_split_a_list_and_drop_filler():
    assert description_phrases("Hardware, construction supplies: nails, cement, paint, plywood, hammers") == [
        "hardware", "construction supplies", "nails", "cement", "paint", "plywood", "hammers",
    ]
    assert description_phrases("This is intended for 7/11 etc.") == []
    assert description_phrases("Pet supplies such as dog food, cat food and pet shampoo.") == [
        "pet supplies", "dog food", "cat food", "pet shampoo",
    ]


def test_a_new_categorys_description_moves_the_lexicon_items_it_names():
    catalogue = Catalogue({**PRODUCTION, "Hardware & Construction": "Hardware, construction supplies: nails, cement, paint, hammers"})
    assert catalogue.custom() == ["Hardware & Construction"]
    items = labels(synthetic_rows(catalogue), "item")
    for item in ("hammer", "nails", "cement", "paint", "paint brush"):
        assert items[item] == "Hardware & Construction", item
    assert items["ballpen"] == "Retail & General Merchandise"


def test_a_generic_description_word_moves_nothing():
    catalogue = Catalogue({**PRODUCTION, "Pet Food & Supplies": "food, supplies, dog food"})
    items = labels(synthetic_rows(catalogue), "item")
    assert items["dog food"] == "Pet Food & Supplies"
    assert items["chickenjoy"] == "Fast Food & Restaurant"
    assert labels(synthetic_rows(catalogue), "store")["fast food"] == "Fast Food & Restaurant"


def test_built_in_categories_take_nothing_from_their_descriptions():
    # "Supermarkets, convenience stores, ..." must not pull convenience-store
    # phrases away from the Convenience Store category.
    stores = labels(synthetic_rows(Catalogue(PRODUCTION)), "store")
    assert stores["7 eleven"] == "Convenience Store"


def test_prepared_coffee_follows_cafe_but_packaged_coffee_stays_grocery():
    catalogue = Catalogue({**PRODUCTION, "Cafe": "Coffee shops, beverage stalls, and milk tea spots"})
    items = labels(synthetic_rows(catalogue), "item")
    for name in ("latte", "americano", "frappe", "espresso", "cold brew"):
        assert items[name] == "Cafe"
    for name in ("coffee", "nescafe", "3 in 1 coffee", "instant coffee sachet"):
        assert items[name] == "Supermarket & Grocery"


def test_prepared_coffee_keeps_parent_category_without_a_cafe():
    items = labels(synthetic_rows(Catalogue(PRODUCTION)), "item")
    for name in ("latte", "americano", "frappe"):
        assert items[name] == "Fast Food & Restaurant"


def test_cafe_rename_keeps_prepared_coffee_vocabulary():
    catalogue = Catalogue({**PRODUCTION, "Coffee & Tea Corner": "Coffee shops and milk tea"})
    assert labels(synthetic_rows(catalogue), "item")["cold brew"] == "Coffee & Tea Corner"


# ── through the trainer ────────────────────────────────────────────────────


@pytest.fixture(scope="module")
def quick():
    return replace(ITEM, classifier="logistic")


def test_the_item_model_after_bakery_is_renamed(quick):
    catalogue = Catalogue(renamed("Bakery", "Breads & Pastries"))
    # Filed before the rename: the stored text still says "Bakery".
    model = CategoryModel.train("item", [("ube pandesal", "Bakery")] * 3, allowed=catalogue, holdout=False, settings=quick)
    assert set(model.report.classes) <= catalogue.names
    assert model.predict("Pandesal")["category"] == "Breads & Pastries"
    assert model.predict("Spanish bread")["category"] == "Breads & Pastries"
    assert model.report.real_rows == 3


def test_the_item_model_after_fast_food_is_renamed(quick):
    catalogue = Catalogue(renamed("Fast Food & Restaurant", "Restaurants"))
    model = CategoryModel.train("item", [], allowed=catalogue, holdout=False, settings=quick)
    assert "Fast Food & Restaurant" not in model.report.classes
    assert model.predict("Chickenjoy")["category"] == "Restaurants"


def test_a_new_category_with_a_description_gets_its_items(quick):
    catalogue = Catalogue({**PRODUCTION, "Hardware & Construction": "Hardware, construction supplies: nails, cement, paint, hammers, plywood"})
    model = CategoryModel.train("item", [], allowed=catalogue, holdout=False, settings=quick)
    for item in ("Hammer", "Cement", "Nails"):
        assert model.predict(item, min_confidence=0)["category"] == "Hardware & Construction", item
    assert model.predict("Pandesal")["category"] == "Bakery"
