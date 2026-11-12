"""
POST /retrain: the service learns a new catalogue without a rebuild.

Runs the real endpoint and the real trainer subprocess against a temporary
model directory, with the OpenStreetMap names left out so it takes seconds.
"""

from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

import app as service
from sugo_category.lexicon import FOOD, GROCERY, PHARMACY, RETAIL
from sugo_category.model import CategoryModel


@pytest.fixture()
def client(tmp_path, monkeypatch):
    for kind in ("store", "item"):
        CategoryModel.train(kind, [], holdout=False).save(tmp_path)
    monkeypatch.setattr(service, "MODEL_DIR", tmp_path)
    monkeypatch.setattr(service, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(service, "CURRENT", tmp_path / "current")
    monkeypatch.setattr(service, "_training", {"state": "idle"})
    service._models.clear()
    with TestClient(service.app) as c:
        yield c


def _wait_for_training(c: TestClient, timeout: float = 180.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        body = c.get("/health").json()
        if body["training"].get("state") in ("done", "failed") and not service._worker_running:
            return body
        time.sleep(0.5)
    raise AssertionError("retrain did not finish")


def test_retrain_teaches_a_new_category_and_swaps_it_in(client):
    before = client.get("/health").json()
    assert before["loaded_from"] == "image"
    assert "Bakery" not in before["models"]["store"]["classes"]

    bakeries = [["Julie's Bakeshop Tacurong", "Bakery"], ["Panaderia ni Aling Rosa", "Bakery"],
                ["Sweet Crust Bakeshop", "Bakery"], ["Tinapay Express Bakery", "Bakery"]] * 3
    response = client.post("/retrain", json={
        "categories": [FOOD, PHARMACY, GROCERY, RETAIL, "Bakery"],
        "stores": bakeries,
        "items": [["Pandesal (10pcs)", "Bakery"], ["Spanish Bread", "Bakery"]] * 3,
        "reasons": ["test"],
        "include_osm": False,
    })
    assert response.status_code == 202
    after = _wait_for_training(client)

    assert after["training"]["state"] == "done", after["training"]
    assert after["loaded_from"] == "retrain"
    assert "Bakery" in after["models"]["store"]["classes"]
    assert after["models"]["store"]["real_rows"] == len(bakeries)
    quality = after["models"]["store"]["training_quality"]
    assert quality["provider_available"] is False  # suite disables external AI
    audit = service.RUNS_DIR / after["training"]["run"] / "quality-audit.json"
    assert audit.exists()
    assert quality["excluded_names"] == {"store": 0, "item": 0}
    guess = client.post("/categorize-store", json={"name": "Malinao Bakeshop"}).json()
    assert guess["category"] == "Bakery"
    assert (service.MODEL_DIR / "current").read_text().strip() == after["training"]["run"]


def test_a_failed_retrain_keeps_the_old_models_answering(client, monkeypatch):
    import subprocess

    def trainer_crashes(command, **kwargs):
        return subprocess.CompletedProcess(command, 1, stdout="", stderr="MemoryError: out of memory")

    monkeypatch.setattr(service.subprocess, "run", trainer_crashes)
    response = client.post("/retrain", json={
        "categories": [FOOD, PHARMACY, GROCERY, RETAIL, "Bakery"], "stores": [], "items": [], "include_osm": False,
    })
    assert response.status_code == 202
    after = _wait_for_training(client)
    assert after["training"]["state"] == "failed"
    assert "MemoryError" in after["training"]["error"]
    assert after["ready"] is True and after["loaded_from"] == "image"
    assert not list((service.RUNS_DIR).glob("*/store.joblib"))
    assert client.post("/categorize-store", json={"name": "Mercury Drug"}).json()["category"] == PHARMACY


def test_retrain_refuses_a_catalogue_of_one(client):
    assert client.post("/retrain", json={"categories": ["Bakery"]}).status_code == 422
