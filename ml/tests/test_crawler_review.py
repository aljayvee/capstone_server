"""The crawl's review sheet (crawler.run.categorise): a mapper's tag beats a model's guess."""

from __future__ import annotations

from types import SimpleNamespace

from crawler.run import categorise

CLASSES = ["Bakery", "Fast Food & Restaurant", "Pharmacy & Health"]


class _StubModel:
    def __init__(self, answers):
        self.report = SimpleNamespace(classes=CLASSES)
        self._answers = answers

    def predict(self, name, **_):
        category, confidence = self._answers[name]
        return {"category": category, "confidence": confidence}


def _place(name, **tags):
    return {"name": name, "lat": "6.6899", "lon": "124.6825", "osm_type": "node", "osm_id": "1", **tags}


def test_the_mappers_tag_wins_and_a_disagreement_is_flagged():
    model = _StubModel({"Minute Burger": ("Bakery", 0.62), "Julson Bakeshop": ("Bakery", 0.99)})
    rows = categorise(
        [_place("Minute Burger", amenity="fast_food"), _place("Julson Bakeshop", shop="bakery")], model
    )
    burger, bakeshop = rows
    assert burger["final_category"] == "Fast Food & Restaurant"
    assert burger["needs_review"] == "yes"
    assert "Mappers tag it Fast Food & Restaurant" in burger["reason"]
    assert bakeshop["final_category"] == "Bakery"
    assert bakeshop["needs_review"] == "no"


def test_an_untagged_place_takes_the_models_answer():
    model = _StubModel({"Honesty Bakeshop": ("Bakery", 0.98)})
    (row,) = categorise([_place("Honesty Bakeshop")], model)
    assert row["mapper_category"] == ""
    assert row["final_category"] == "Bakery"
    assert row["needs_review"] == "no"
