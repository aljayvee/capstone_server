"""
How the category models are measured: which rows, which split, which numbers.

Shared by train.py (the report baked into every image) and experiments.py (the
comparisons in category/EXPERIMENTS.md), so both use the same definitions.

The split is by NAME, not by row. The OpenStreetMap file carries thousands of
branches of the same chain and many shops that share a name ("Sari-Sari Store"
is one row per label after deduplication, but "Jollibee Koronadal" and
"Jollibee" are separate names). A shop name in both training and test would
measure memory, not learning, so every normalised name lives in one split only.

The numbers are the ones the dispatcher console depends on, not accuracy alone:

  accuracy                 the top category is right, whatever its confidence
  coverage                 share of names that get a category at all (top
                           confidence >= 0.55, DEFAULT_MIN_CONFIDENCE); below
                           it the pin keeps its amber "Category needed" mark
  accuracy_when_answered   of those, how many are right
  auto_accepted            share at or above 0.75 (REVIEW_CONFIDENCE_THRESHOLD),
                           filed without a dispatcher's review
  accuracy_when_auto       of those, how many are right: the cost of a
                           confident wrong answer lands here
"""

from __future__ import annotations

import csv
from pathlib import Path
from typing import Iterable, Sequence

import numpy as np

from .lexicon import FOOD, GROCERY, PHARMACY, RETAIL
from .model import DEFAULT_MIN_CONFIDENCE, REVIEW_CONFIDENCE_THRESHOLD, normalize
from .osm_labels import resolve_label

ML_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ML_DIR / "data"
OSM_NAMES = DATA_DIR / "osm_store_names.csv"
REAL_JOBS = DATA_DIR / "real_jobs.csv"

# The catalogue production had on 2026-09-24 (merchant_categories, all Active).
# The experiments train against it so their numbers describe the live service.
PRODUCTION_CATEGORIES = [FOOD, PHARMACY, GROCERY, RETAIL, "Bakery", "Convenience Store"]

SPLIT_SEED = 20260924


def load_osm_rows(
    active: Iterable[str] | None, path: Path = OSM_NAMES, cleanse: bool = True
) -> list[tuple[str, str]]:
    """
    `(name, category)` for every OSM name whose label this catalogue has,
    after the deterministic cleansing steps (cleansing.cleanse_osm_rows):
    registry codes stripped, kind-word rules, conflicts resolved by majority.
    `cleanse=False` reads the file as the crawler wrote it.
    """
    if not path.exists():
        return []
    from .catalogue import Catalogue

    active_list = active if isinstance(active, Catalogue) or active is None else list(active)
    with path.open(encoding="utf-8", newline="") as handle:
        raw = list(csv.DictReader(handle))
    if cleanse:
        from .cleansing import cleanse_osm_rows

        raw, _ = cleanse_osm_rows(raw)
    rows = []
    for row in raw:
        category = resolve_label(row["label"], active_list)
        if category:
            rows.append((row["name"], category))
    return rows


ITEM_BENCHMARK = DATA_DIR / "item_benchmark.csv"


def load_item_benchmark(active: Iterable[str] | None = None, path: Path = ITEM_BENCHMARK) -> list[tuple[str, str]]:
    """
    Items a person labelled that appear in no seed phrase list
    (data/item_benchmark.csv). The only test of whether the item model
    generalises: every other item it is scored on, it was taught.
    """
    if not path.exists():
        return []
    allowed = set(active) if active is not None else None
    with path.open(encoding="utf-8", newline="") as handle:
        return [
            (row["name"], row["category"])
            for row in csv.DictReader(handle)
            if allowed is None or row["category"] in allowed
        ]


def load_real_jobs(kind: str, active: Iterable[str] | None = None, path: Path = REAL_JOBS) -> list[tuple[str, str]]:
    """Production's own labelled rows (see data/README.md), for one model kind."""
    if not path.exists():
        return []
    allowed = set(active) if active is not None else None
    with path.open(encoding="utf-8", newline="") as handle:
        return [
            (row["name"], row["category"])
            for row in csv.DictReader(handle)
            if row["kind"] == kind and (allowed is None or row["category"] in allowed)
        ]


def group_split(
    rows: Sequence[tuple[str, str]],
    val: float = 0.15,
    test: float = 0.15,
    seed: int = SPLIT_SEED,
) -> tuple[list, list, list]:
    """
    Train / validation / test with every normalised name in exactly one of them.
    Rows may carry more than `(name, label)`, e.g. a weight; only the name is read.
    """
    groups = sorted({normalize(row[0]) for row in rows})
    order = np.random.default_rng(seed).permutation(len(groups))
    n_test = int(len(groups) * test)
    n_val = int(len(groups) * val)
    test_g = {groups[i] for i in order[:n_test]}
    val_g = {groups[i] for i in order[n_test : n_test + n_val]}
    parts: tuple[list, list, list] = ([], [], [])
    for row in rows:
        g = normalize(row[0])
        parts[2 if g in test_g else 1 if g in val_g else 0].append(row)
    return parts


# ── temperature scaling ────────────────────────────────────────────────────


def apply_temperature(proba: np.ndarray, temperature: float) -> np.ndarray:
    """
    softmax(z / T) from softmax(z), without the logits.

    p_i is proportional to exp(z_i), so p_i^(1/T) is proportional to
    exp(z_i / T). T > 1 softens overconfident answers, T < 1 sharpens timid
    ones, and the ranking never changes, so accuracy never changes either.
    """
    if temperature == 1.0:
        return proba
    logp = np.log(np.clip(proba, 1e-12, None)) / temperature
    logp -= logp.max(axis=1, keepdims=True)
    e = np.exp(logp)
    return e / e.sum(axis=1, keepdims=True)


def fit_temperature(proba: np.ndarray, y_idx: np.ndarray) -> float:
    """The T that minimises validation log loss: a coarse grid, then a fine one."""

    def nll(t: float) -> float:
        p = apply_temperature(proba, t)
        return float(-np.mean(np.log(np.clip(p[np.arange(len(y_idx)), y_idx], 1e-12, None))))

    best = min(np.linspace(0.25, 4.0, 76), key=nll)
    fine = np.linspace(max(0.05, best - 0.05), best + 0.05, 21)
    return round(float(min(fine, key=nll)), 3)


# ── the numbers ────────────────────────────────────────────────────────────


def measure(
    proba: np.ndarray,
    classes: Sequence[str],
    labels: Sequence[str],
    min_confidence: float = DEFAULT_MIN_CONFIDENCE,
    review_threshold: float = REVIEW_CONFIDENCE_THRESHOLD,
) -> dict:
    """
    A row whose true category the model cannot predict at all (a class it was
    never trained on) counts as wrong, not as missing: that is exactly the
    failure of a model trained without the catalogue's newer categories.
    """
    classes = list(classes)
    index = {c: i for i, c in enumerate(classes)}
    if not len(labels):
        return {"rows": 0}
    y = np.array([index.get(label, -1) for label in labels])
    known = y >= 0
    top = proba.max(axis=1)
    pred = proba.argmax(axis=1)
    right = pred == y
    answered = top >= min_confidence
    auto = top >= review_threshold

    def share(mask) -> float:
        return round(float(mask.mean()), 4)

    def acc(mask) -> float | None:
        return round(float(right[mask].mean()), 4) if mask.any() else None

    bands = [(0.0, 0.55), (0.55, 0.75), (0.75, 0.9), (0.9, 1.01)]
    per_class = {}
    for i, name in enumerate(classes):
        actual, predicted = y == i, pred == i
        per_class[name] = {
            "rows": int(actual.sum()),
            "recall": acc(actual),
            "precision": round(float(right[predicted].mean()), 4) if predicted.any() else None,
        }
    return {
        "rows": int(len(y)),
        "accuracy": acc(np.ones(len(y), dtype=bool)),
        "unpredictable_rows": int((~known).sum()),
        # Over the rows it could have got right; an impossible row has no probability to score.
        "log_loss": round(float(-np.mean(np.log(np.clip(proba[known][np.arange(int(known.sum())), y[known]], 1e-12, None)))), 4)
        if known.any()
        else None,
        "coverage": share(answered),
        "accuracy_when_answered": acc(answered),
        "auto_accepted": share(auto),
        "accuracy_when_auto": acc(auto),
        "reliability": [
            {"from": lo, "to": min(hi, 1.0), "rows": int(m.sum()), "right": acc(m)}
            for lo, hi in bands
            for m in [(top >= lo) & (top < hi)]
        ],
        "per_class": per_class,
    }
