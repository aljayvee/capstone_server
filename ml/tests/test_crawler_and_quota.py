"""
Unit tests for crawler item cleaner, establishment matcher, dynamic seeds,
and Cloud Vision quota guard.
"""

import pytest
from crawler.parsers.item_cleaner import clean_item_name
from crawler.establishment_matcher import match_establishment_category, is_in_tacurong
from crawler.vision_quota_guard import (
    compute_image_sha256,
    validate_image_preflight,
    read_image_with_quota_guard,
    can_attempt_cloud_vision,
)
from sugo_category.lexicon import generate_dynamic_seeds, synthetic_rows


def test_clean_item_name():
    # Strips trailing prices
    assert clean_item_name("1pc Chickenjoy with rice P85.00") == "1pc Chickenjoy with Rice"
    assert clean_item_name("Pork BBQ on stick ₱25 each") == "Pork BBQ on Stick"
    assert clean_item_name("Coca cola 1.5L") == "Coca-Cola 1.5L"
    assert clean_item_name("   ") == ""
    assert clean_item_name("X") == ""


def test_establishment_matcher_confidence_threshold():
    # Below 0.75 must flag needs_review = True
    low_conf_match = match_establishment_category(
        store_name="Random Corner Store",
        address="Barangay Poblacion, Tacurong City",
        latitude=6.6900,
        longitude=124.6700,
        model_prediction={"category": "Retail & General Merchandise", "confidence": 0.65},
    )
    assert low_conf_match.needs_review is True
    assert low_conf_match.is_within_bounds is True

    # 0.75 or higher must auto-accept with needs_review = False
    high_conf_match = match_establishment_category(
        store_name="Mercury Drug Tacurong",
        address="Alunan Highway, Tacurong City",
        latitude=6.6910,
        longitude=124.6720,
        model_prediction={"category": "Pharmacy & Health", "confidence": 0.85},
    )
    assert high_conf_match.needs_review is False
    assert high_conf_match.predicted_category == "Pharmacy & Health"


def test_establishment_matcher_bounds_check():
    # Outside Tacurong bounding box must be flagged for review
    out_of_bounds_match = match_establishment_category(
        store_name="Davao Grocery Store",
        latitude=7.1907,  # Davao City latitude, outside Tacurong
        longitude=125.4553,
        model_prediction={"category": "Supermarket & Grocery", "confidence": 0.90},
    )
    assert out_of_bounds_match.is_within_bounds is False
    assert out_of_bounds_match.needs_review is True


def test_dynamic_seeds_generation():
    seeds = generate_dynamic_seeds("Pet Supplies")
    store_seeds = [text for text, cat, kind in seeds if kind == "store"]
    assert "pet supplies" in store_seeds
    assert "pet supplies shop" in store_seeds
    assert "pet supplies store" in store_seeds

    # Check synthetic_rows integration
    all_rows = synthetic_rows(allowed={"Pet Supplies", "Fast Food & Restaurant"})
    categories_present = {cat for _, cat, _ in all_rows}
    assert "Pet Supplies" in categories_present


def test_vision_quota_guard_deduplication():
    dummy_image = b"test_image_bytes_for_tacurong_flyer_1234567890" * 30
    sha256 = compute_image_sha256(dummy_image)

    vision_calls = 0

    def mock_local_ocr(b):
        return "Aling Nena Menu: Pork Adobo, Sinigang, Pancit Canton"

    def mock_vision_ocr(b):
        nonlocal vision_calls
        vision_calls += 1
        return {"text": "High Quality Vision Result", "confidence": 0.95}

    # First call: Local OCR returns sufficient text, 0 vision calls made
    res1 = read_image_with_quota_guard(dummy_image, mock_local_ocr, mock_vision_ocr)
    assert res1["sha256"] == sha256
    assert res1["vision_calls_made"] == 0
    assert vision_calls == 0

    # Second call with same image: Hits SHA-256 cache, 0 vision calls made
    res2 = read_image_with_quota_guard(dummy_image, mock_local_ocr, mock_vision_ocr)
    assert "CACHE_HIT" in res2["engine"]
    assert res2["vision_calls_made"] == 0
    assert vision_calls == 0
