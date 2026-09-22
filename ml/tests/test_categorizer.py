"""
Does the classifier actually work on names it was never trained on?

Every store name below is deliberately NOT a verbatim seed phrase: they carry
branch suffixes, misspellings, possessives and Tagalog/Bisaya wording of the
kind a dispatcher types at 9pm. A model that only answers its own lexicon back
is a lookup table with extra steps, and these tests exist to catch that.

The confidence floor is tested too, because "say nothing when unsure" is the
behaviour the dispatcher console depends on — the amber "Category needed" mark
on a pin is a promise that the machine did not have an opinion.
"""

from __future__ import annotations

import pytest

from sugo_category.lexicon import FOOD, GROCERY, PHARMACY, RETAIL
from sugo_category.model import CategoryModel, category_from_google_types, normalize


@pytest.fixture(scope="module")
def store_model() -> CategoryModel:
    return CategoryModel.train("store", [], holdout=False)


@pytest.fixture(scope="module")
def item_model() -> CategoryModel:
    return CategoryModel.train("item", [], holdout=False)


# ── store names the model has never seen verbatim ──────────────────────────

UNSEEN_STORES = [
    ("Aling Nena's Karinderya", FOOD),
    ("Tacurong Grill House and Restobar", FOOD),
    ("Jolibee Tacurong Branch", FOOD),  # misspelt on purpose
    ("Mang Kanor Lechon Manok Station", FOOD),
    ("Sweet Bites Bakeshop", FOOD),
    ("Mercury Drug Corporation - Poblacion Branch", PHARMACY),
    ("Botika ng Barangay San Emmanuel", PHARMACY),
    ("Santos Family Drugstore", PHARMACY),
    ("Tacurong Dental Clinic", PHARMACY),
    ("Generika Drugstore Alunan Highway", PHARMACY),
    ("Puregold Price Club Inc", GROCERY),
    ("Nanay Linda Sari Sari Store", GROCERY),
    ("Tacurong Public Market Stall 12", GROCERY),
    ("Savemore Market Tacurong", GROCERY),
    ("RJ Rice Dealer and Bigasan", GROCERY),
    ("Tacurong Builders Hardware Supply", RETAIL),
    ("National Book Store Tacurong", RETAIL),
    ("JM Cellphone and Gadget Shop", RETAIL),
    ("Ukay Ukay Bargain Center", RETAIL),
    ("Lito's Motor Parts and Auto Supply", RETAIL),
]


@pytest.mark.parametrize("name,expected", UNSEEN_STORES)
def test_unseen_store_names(store_model: CategoryModel, name: str, expected: str):
    result = store_model.predict(name)
    assert result["category"] == expected, (
        f"{name!r} -> {result['category']} @ {result['confidence']}"
    )


def test_store_accuracy_across_the_whole_unseen_set(store_model: CategoryModel):
    # The parametrised cases above fail one at a time, which is what you want
    # while fixing one. This one states the bar for the set as a whole, so a
    # change that trades three wins for four losses cannot pass unnoticed.
    correct = sum(
        store_model.predict(name)["category"] == expected for name, expected in UNSEEN_STORES
    )
    assert correct / len(UNSEEN_STORES) >= 0.9


# ── items ──────────────────────────────────────────────────────────────────

UNSEEN_ITEMS = [
    ("2pc Chickenjoy with rice", FOOD),
    ("large wintermelon milktea", FOOD),
    ("biogesic 500mg tablet", PHARMACY),
    ("neozep forte 10 tablets", PHARMACY),
    ("1 box face mask", PHARMACY),
    ("5kg sinandomeng rice", GROCERY),
    ("tide powder 1kg", GROCERY),
    ("lucky me pancit canton 6 pcs", GROCERY),
    ("1 dozen itlog", GROCERY),
    ("short bond paper ream", RETAIL),
    ("usb type c charger cable", RETAIL),
    ("walis tingting", RETAIL),
]


@pytest.mark.parametrize("name,expected", UNSEEN_ITEMS)
def test_unseen_item_names(item_model: CategoryModel, name: str, expected: str):
    result = item_model.predict(name)
    assert result["category"] == expected, (
        f"{name!r} -> {result['category']} @ {result['confidence']}"
    )


# ── the confidence floor ───────────────────────────────────────────────────


def test_meaningless_name_returns_no_category(store_model: CategoryModel):
    # The dispatcher console shows "Category needed" for this, which is the
    # honest answer. Ten server behaviours read the category field.
    result = store_model.predict("ABC XYZ 123", min_confidence=0.55)
    assert result["category"] is None


def test_empty_name_is_handled_rather_than_crashing(store_model: CategoryModel):
    result = store_model.predict("   ")
    assert result["category"] is None
    assert result["source"] == "empty"


def test_a_raised_floor_silences_a_weak_guess(store_model: CategoryModel):
    # Same name, two thresholds. Proves the floor is actually consulted rather
    # than the model simply being sure about everything.
    name = "JM Enterprises"
    permissive = store_model.predict(name, min_confidence=0.0)
    strict = store_model.predict(name, min_confidence=0.99)
    assert permissive["category"] is not None
    assert strict["category"] is None


def test_alternatives_are_offered_so_a_correction_is_one_glance(store_model: CategoryModel):
    result = store_model.predict("Tacurong Grill House and Restobar")
    assert result["alternatives"], "a runner-up helps the dispatcher correct it"
    assert all(0.0 <= alt["confidence"] <= 1.0 for alt in result["alternatives"])


# ── Google types fusion ────────────────────────────────────────────────────


def test_specific_google_type_outweighs_a_generic_one():
    specific, specific_weight = category_from_google_types(["pharmacy", "store"])
    generic, generic_weight = category_from_google_types(["store", "establishment"])
    assert specific == PHARMACY
    assert generic == RETAIL
    assert specific_weight > generic_weight


def test_restaurant_beats_the_generic_store_tail():
    # A Jollibee arrives as ["restaurant","food","point_of_interest",
    # "establishment"]. Consulting the generic tail first would file every
    # restaurant in the country under Retail.
    category, _ = category_from_google_types(
        ["restaurant", "food", "point_of_interest", "establishment"]
    )
    assert category == FOOD


def test_google_lifts_a_name_the_model_is_unsure_about(store_model: CategoryModel):
    name = "JM Enterprises"
    without = store_model.predict(name, min_confidence=0.0)
    with_types = store_model.predict(name, google_types=["pharmacy"], min_confidence=0.0)
    assert with_types["category"] == PHARMACY
    assert with_types["confidence"] > without["confidence"]
    assert with_types["source"] == "google+name"


def test_a_clear_name_can_still_outvote_a_generic_google_type(store_model: CategoryModel):
    # Google files plenty of Philippine carinderias as a bare "store". The name
    # is the better evidence there, and it is allowed to win.
    result = store_model.predict(
        "Aling Nena's Karinderya", google_types=["store", "establishment"]
    )
    assert result["category"] == FOOD


def test_no_google_types_is_not_treated_as_a_vote(store_model: CategoryModel):
    assert category_from_google_types(None) == (None, 0.0)
    assert category_from_google_types([]) == (None, 0.0)
    assert store_model.predict("Mercury Drug", google_types=None)["source"] == "name"


# ── normalisation ──────────────────────────────────────────────────────────


def test_branch_noise_is_stripped():
    # Otherwise "Tacurong" predicts every category, being in every row.
    assert "tacurong" not in normalize("Mercury Drug Tacurong City Branch")
    assert "mercury" in normalize("Mercury Drug Tacurong City Branch")


def test_normalisation_keeps_something_when_a_name_is_all_noise():
    # A shop genuinely called "The Store" still has to be classified.
    assert normalize("The Store") != ""


def test_real_rows_outweigh_the_seed_lexicon():
    # The lexicon is a floor, not an opinion to defend. If Tacurong's own data
    # says a name means something else, the data has to win — otherwise the
    # model can never be corrected by the dispatchers using it.
    contradicting = [("Mercury Drug", GROCERY)] * 12
    model = CategoryModel.train("store", contradicting, holdout=False)
    assert model.predict("Mercury Drug")["category"] == GROCERY
