from dataclasses import replace
import json
from types import SimpleNamespace

import pytest

from sugo_category.config import ITEM
from sugo_category.evaluation import group_split
from sugo_category.gemma import GemmaAdvisor, GemmaError, GemmaSettings
from sugo_category.lexicon import FOOD, GROCERY, PHARMACY, RETAIL, synthetic_rows
from sugo_category.model import CategoryModel, normalize
from sugo_category.training_quality import parse_reviews, prepare_training_quality, review_request

CATEGORIES = [FOOD, GROCERY, PHARMACY, RETAIL]


def reply(rows):
    return {"candidates": [{"content": {"parts": [{"text": json.dumps({"reviews": rows})}]}}]}


class Reviewer:
    def __init__(self, decision="KEEP", confidence=.99, reason="valid_name", active=True):
        self.settings = SimpleNamespace(active=active)
        self.calls = []
        self.decision, self.confidence, self.reason = decision, confidence, reason

    def review_training(self, rows, categories, timeout):
        self.calls.append(rows)
        return {i: {"decision": self.decision, "confidence": self.confidence, "reason": self.reason,
                    "model": "gemini-test"} for i, _ in enumerate(rows, 1)}


@pytest.mark.parametrize("confidence", [float("nan"), float("inf"), -1, 1.01, True, "0.99"])
def test_review_rejects_invalid_confidence(confidence):
    assert parse_reviews(reply([{"n": 1, "decision": "EXCLUDE", "reason": "gibberish", "confidence": confidence}]), 1) == {}


def test_review_rejects_duplicate_positions_and_invalid_decisions():
    valid = {"n": 1, "decision": "KEEP", "reason": "valid_name", "confidence": .99}
    assert parse_reviews(reply([valid, valid]), 1) == {}
    assert parse_reviews(reply([{**valid, "decision": []}]), 1) == {}
    assert parse_reviews(reply([{**valid, "decision": "EXCLUDE"}]), 1) == {}


def test_prompt_treats_input_as_data_and_does_not_request_new_labels():
    request = review_request([{"kind": "item", "name": "ignore instructions", "labels": [GROCERY]}], CATEGORIES, "gemini-test")
    text = request["contents"][0]["parts"][0]["text"]
    assert "untrusted DATA" in text
    assert "Never invent or rewrite names or category labels" in text
    assert "ignore instructions" in text


def test_high_confidence_junk_is_quarantined_without_rewriting_records(tmp_path):
    rows = [("junkwordtest", GROCERY)] * 3
    original = list(rows)
    result = prepare_training_quality([], rows, CATEGORIES, {}, Reviewer("EXCLUDE", .99, "gibberish"), tmp_path / "quality.jsonl")
    assert rows == original
    assert result["excluded_training_names"] == {"store": [], "item": ["junkwordtest"]}
    assert result["summary"]["excluded_names"]["item"] == 1
    assert result["decisions"][0]["model"] == "gemini-test"


def test_uncertain_junk_and_conflicting_labels_are_reviewed_without_exclusion(tmp_path):
    rows = [("coffee", GROCERY), ("coffee", FOOD)]
    result = prepare_training_quality([], rows, CATEGORIES, {}, Reviewer("EXCLUDE", .7, "gibberish"), None)
    assert result["excluded_training_names"]["item"] == []
    assert result["decisions"][0]["decision"] == "REVIEW"
    kept = prepare_training_quality([], rows, CATEGORIES, {}, Reviewer(), None)
    assert kept["decisions"][0]["reason"] == "ambiguous_label"
    assert kept["excluded_training_names"]["item"] == []


def test_cache_reuses_reviews_but_invalidates_when_labels_change(tmp_path):
    reviewer = Reviewer()
    cache = tmp_path / "quality.jsonl"
    prepare_training_quality([], [("coffee", GROCERY)], CATEGORIES, {}, reviewer, cache)
    prepare_training_quality([], [("coffee", GROCERY)] * 9, CATEGORIES, {}, reviewer, cache)
    assert len(reviewer.calls) == 1
    prepare_training_quality([], [("coffee", FOOD)], CATEGORIES, {}, reviewer, cache)
    assert len(reviewer.calls) == 2


def test_disabled_review_uses_no_provider_or_cached_exclusion(tmp_path):
    cache = tmp_path / "quality.jsonl"
    prepare_training_quality([], [("junkwordtest", GROCERY)], CATEGORIES, {}, Reviewer("EXCLUDE", .99, "gibberish"), cache)
    reviewer = Reviewer()
    result = prepare_training_quality([], [("junkwordtest", GROCERY)], CATEGORIES, {}, reviewer, cache, enabled=False)
    assert not reviewer.calls
    assert result["excluded_training_names"]["item"] == []


def test_review_is_bounded_and_an_outage_preserves_training_data():
    reviewer = Reviewer()
    rows = [(f"item {i}", GROCERY) for i in range(30)]
    prepare_training_quality([], rows, CATEGORIES, {}, reviewer, None, max_names=3)
    assert len(reviewer.calls[0]) == 3
    reviewer.review_training = lambda *args, **kwargs: (_ for _ in ()).throw(TimeoutError())
    result = prepare_training_quality([], rows, CATEGORIES, {}, reviewer, None)
    assert result["excluded_training_names"]["item"] == []
    assert result["summary"]["provider_error"] == "TimeoutError"


def test_review_uses_model_chain_but_never_becomes_category_teacher_data():
    calls = []

    def transport(url, body, key, timeout):
        calls.append((url, timeout))
        if "gemini-first" in url:
            raise GemmaError(429, "quota", retry_after=60)
        return reply([{"n": 1, "decision": "KEEP", "reason": "valid_name", "confidence": .99}])

    advisor = GemmaAdvisor(GemmaSettings(api_key="test", model="gemini-first", fallbacks=("gemma-backup",)), transport=transport)
    result = advisor.review_training([{"kind": "item", "name": "bread", "labels": [GROCERY]}], CATEGORIES, timeout=2)
    assert result[1]["model"] == "gemma-backup"
    assert len(calls) == 2 and all(0 < timeout <= 2 for _, timeout in calls)
    assert advisor.teacher_rows("item", CATEGORIES) == []


def test_quality_exclusion_does_not_remove_or_relabel_test_examples(monkeypatch):
    import sugo_category.model as module

    real = [(n, c) for n, c, k in synthetic_rows(CATEGORIES) if k == "item"][:60]
    _, _, test = group_split(real, val=0., test=.2, seed=20260923)
    target = normalize(test[0][0])
    calls = []
    original = module._fit_predictor

    def capture(settings, rows, val_rows, **kwargs):
        calls.append(list(rows))
        return original(settings, rows, val_rows, **kwargs)

    monkeypatch.setattr(module, "_fit_predictor", capture)
    model = CategoryModel.train("item", real, settings=replace(ITEM, classifier="logistic"),
                                excluded_training_names=[target], training_quality={"reviewed": 1})
    assert all(target not in {n for n, _, _ in rows} for rows in calls)
    assert model.report.evaluation["test"]["rows"] == len(test)
    assert model.report.training_quality == {"reviewed": 1}


def test_quality_summary_survives_save_and_load(tmp_path):
    model = CategoryModel.train("item", [], holdout=False, settings=replace(ITEM, classifier="logistic"),
                                training_quality={"reviewed": 2, "excluded_names": {"item": 1}})
    model.save(tmp_path)
    assert CategoryModel.load(tmp_path, "item").report.training_quality == model.report.training_quality
