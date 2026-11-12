"""Regression cases for faithful sentence-based shopping extraction."""
import json
import pytest
from sugo_category.gemma import NormalizedItem, keeps_the_customers_words, parse_normalized


def response(items, confident=True, n=1):
    return {"candidates": [{"content": {"parts": [{"text": json.dumps({"answers": [{"n": n, "items": items, "confident": confident}]})}]}}]}


@pytest.mark.parametrize("quantity", [99, 7])
def test_number_words_do_not_authorize_arbitrary_quantities(quantity):
    assert not keeps_the_customers_words("one Safeguard soap", [NormalizedItem("Safeguard soap", quantity, "")])


@pytest.mark.parametrize("quantity", [2.5, True, "2"])
def test_provider_quantity_must_be_an_actual_integer(quantity):
    assert parse_normalized(response([{"name": "Coke", "quantity": quantity, "size": ""}]), ["2 Coke"], "test") == {}


@pytest.mark.parametrize("flag", ["false", 1, None])
def test_provider_confidence_flag_must_be_boolean(flag):
    assert parse_normalized(response([{"name": "Coke", "quantity": 1, "size": ""}], confident=flag), ["Coke"], "test") == {}


def test_brand_number_cannot_be_reinterpreted_as_quantity():
    assert not keeps_the_customers_words("7 Up", [NormalizedItem("Up", 7, "")])
    assert not keeps_the_customers_words("555 Sardines", [NormalizedItem("Sardines", 1, "555 g")])
    assert not keeps_the_customers_words("7 Up", [NormalizedItem("7 Up", 7, "")])


@pytest.mark.parametrize("line,item", [
    ("I need some rice for dinner", NormalizedItem("rice", 1, "", "for dinner")),
    ("Could you please buy two Coke 1.5 L", NormalizedItem("Coke", 2, "1.5 L")),
    ("Palit ko ug duha ka itlog", NormalizedItem("itlog", 2, "")),
    ("half kilo rice", NormalizedItem("rice", 1, "1/2 kg")),
    ("twenty five pandesal", NormalizedItem("pandesal", 25, "")),
    ("Bakal ko sang isa ka kilo nga bugas", NormalizedItem("bugas", 1, "1 kg")),
    ("rice ½ kilo", NormalizedItem("rice", 1, "1/2 kg")),
    ("7 Up 1.5L x2", NormalizedItem("7 Up", 2, "1.5 L")),
])
def test_sentence_readings_keep_the_request(line, item):
    assert keeps_the_customers_words(line, [item])


@pytest.mark.parametrize("line,item", [
    ("rice no substitutes", NormalizedItem("rice", 1, "", "substitutes")),
    ("milk without sugar", NormalizedItem("milk", 1, "", "with sugar")),
    ("rice if unavailable call me", NormalizedItem("rice", 1, "")),
    ("Coke two bottles", NormalizedItem("Coke", 1, "2 L")),
])
def test_instructions_and_units_cannot_be_lost_or_invented(line, item):
    assert not keeps_the_customers_words(line, [item])


def test_duplicate_positions_discard_both_readings():
    payload = response([{"name": "Coke", "quantity": 1, "size": ""}])
    text = json.loads(payload["candidates"][0]["content"]["parts"][0]["text"])
    text["answers"] *= 2
    payload["candidates"][0]["content"]["parts"][0]["text"] = json.dumps(text)
    assert parse_normalized(payload, ["Coke"], "test") == {}
