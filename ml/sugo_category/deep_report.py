"""
The deep learning comparison, through the real training pipeline.

    python -m sugo_category.deep_report            # writes category/DEEP_LEARNING.md,
                                                   # category/deep_learning.json and
                                                   # category/charts/cnn-*.svg

Trains, on the cleansed data and production's catalogue:

  store model   the TF-IDF logistic regression, the CharCNN and their ensemble,
                each scored on the same held-out OpenStreetMap test names
                (the ensemble's members are measured separately)
  item model    logistic; CharCNN from scratch; CharCNN transferred from the
                store network; the ensemble with the transferred network;
                each scored on data/item_benchmark.csv, items no seed list has

and reports which one config.py ships and why. The test names and benchmark
items are read once, for this report; every choice inside training (epochs,
ensemble weight, temperature) is made on validation names.
"""

from __future__ import annotations

import json
import sys
import time
from dataclasses import replace
from pathlib import Path

import numpy as np

from .cleansing import cleanse_real_rows, load_label_issues
from .config import ITEM, STORE
from .evaluation import PRODUCTION_CATEGORIES, load_item_benchmark, load_osm_rows, load_real_jobs, measure
from .lexicon import CATEGORIES
from .model import CategoryModel
from .svg_chart import line_chart

ML_DIR = Path(__file__).resolve().parent.parent
REPORT = ML_DIR / "category"
EXPORT = ML_DIR / "data" / "production.json"

PROBES = ["Pandesal", "Spanish bread", "Ensaymada", "Monay", "Pan de coco", "Kababayan", "Hopia",
          "Chickenjoy", "Biogesic", "Coke 1.5L"]


def _pct(value) -> str:
    return "-" if value is None else f"{value:.1%}"


def _rows():
    allowed = set(PRODUCTION_CATEGORIES) | set(CATEGORIES)
    stores: list = []
    items: list = []
    if EXPORT.exists():
        export = json.loads(EXPORT.read_text(encoding="utf-8"))
        allowed |= set(export["categories"])
        stores = [(n, c) for n, c in export["stores"] if c in allowed]
        items = [(n, c) for n, c in export["items"] if c in allowed]
    stores, _ = cleanse_real_rows(stores, "store", allowed)
    items, _ = cleanse_real_rows(items, "item", allowed)
    return allowed, stores, items


def _store_summary(model: CategoryModel, jobs) -> dict:
    ev = model.report.evaluation or {}
    out = {"seconds": model.report.train_seconds, "ensemble_weight": model.report.ensemble_weight,
           "temperature": model.report.temperature, "test": ev.get("test"), "members": ev.get("members")}
    out["real_jobs"] = [sum(model.predict(n, min_confidence=0)["category"] == c for n, c in jobs), len(jobs)]
    return out


def _item_summary(model: CategoryModel, bench) -> dict:
    proba = np.vstack([model.probabilities(n) for n, _ in bench])
    result = measure(proba, list(model.pipeline.classes_), [c for _, c in bench])
    return {
        "seconds": model.report.train_seconds,
        "ensemble_weight": model.report.ensemble_weight,
        "benchmark": result,
        "probes": {p: [model.predict(p, min_confidence=0)["category"], model.predict(p, min_confidence=0)["confidence"]]
                   for p in PROBES},
        "deep": model.report.deep and {k: model.report.deep[k] for k in ("parameters", "epochs_run", "best_epoch", "transferred_from")},
    }


def run() -> dict:
    allowed, stores, items = _rows()
    osm = load_osm_rows(sorted(allowed))
    issues = load_label_issues()
    bench = load_item_benchmark(PRODUCTION_CATEGORIES)
    jobs = load_real_jobs("store", allowed)
    print(f"{len(osm)} map names after cleansing, {len(issues)} kept out of training, "
          f"{len(stores)} store rows, {len(items)} item rows, {len(bench)} benchmark items", flush=True)

    started = time.time()
    store = CategoryModel.train("store", stores, allowed=allowed, extra_rows=osm, exclude_from_training=issues,
                                settings=replace(STORE, classifier="ensemble"))
    results = {"store": _store_summary(store, jobs), "store_history": store.report.deep["history"]}
    print("store", json.dumps({k: v for k, v in results["store"].items() if k != "test"}, default=str)[:600], flush=True)

    items_out = {}
    for name, settings, source in [
        ("logistic", replace(ITEM, classifier="logistic"), None),
        ("charcnn (from scratch)", replace(ITEM, classifier="charcnn"), None),
        ("charcnn (transferred from the store network)", replace(ITEM, classifier="charcnn", cnn_transfer_from_store=True), store),
        ("ensemble (logistic + transferred charcnn)", replace(ITEM, classifier="ensemble", cnn_transfer_from_store=True), store),
    ]:
        model = CategoryModel.train("item", items, allowed=allowed, settings=settings, pretrained=source)
        items_out[name] = _item_summary(model, bench)
        print("item", name, _pct(items_out[name]["benchmark"]["accuracy"]), flush=True)
    results["item"] = items_out
    results["seconds"] = round(time.time() - started, 1)
    return results


def write(results: dict) -> None:
    REPORT.mkdir(parents=True, exist_ok=True)
    (REPORT / "charts").mkdir(exist_ok=True)
    history = results["store_history"]
    series = [
        ("training loss", [(h["epoch"], h["train_loss"]) for h in history]),
        ("validation loss", [(h["epoch"], h["val_loss"]) for h in history if "val_loss" in h]),
    ]
    (REPORT / "charts" / "cnn-learning-curve.svg").write_text(
        line_chart("CharCNN on shop names: loss by epoch", "Epoch", "Cross-entropy", series,
                   subtitle="Training loss includes label smoothing; validation loss does not."),
        encoding="utf-8",
    )
    (REPORT / "deep_learning.json").write_text(json.dumps(results, indent=1, default=str), encoding="utf-8")

    store = results["store"]
    members = store.get("members") or {}
    test = store.get("test") or {}
    lines = [
        "# Deep learning for the category models",
        "",
        f"Generated by `python -m sugo_category.deep_report` on {time.strftime('%Y-%m-%d')}. "
        "The architecture and training practice are described in `sugo_category/deep.py`; "
        "the data cleansing that came first is in [CLEANSING.md](CLEANSING.md).",
        "",
        "## Shop names (the store model)",
        "",
        "Scored on the held-out OpenStreetMap test names, which no model trained on.",
        "",
        "| Model | Accuracy | Log loss |",
        "|---|---:|---:|",
    ]
    for label, key in (("TF-IDF logistic regression", "linear"), ("CharCNN", "deep")):
        m = members.get(key) or {}
        lines.append(f"| {label} | {_pct(m.get('accuracy'))} | {m.get('log_loss', '-')} |")
    lines.append(
        f"| Ensemble, linear weight {members.get('ensemble_weight', '-')} (calibrated) | "
        f"{_pct(test.get('accuracy'))} | {test.get('log_loss', '-')} |"
    )
    lines += [
        "",
        f"Calibrated ensemble: {_pct(test.get('coverage'))} of names get a category, "
        f"{_pct(test.get('accuracy_when_answered'))} of those right; "
        f"{_pct(test.get('auto_accepted'))} auto-accepted, {_pct(test.get('accuracy_when_auto'))} right. "
        f"Production's own labelled shops: {store['real_jobs'][0]} of {store['real_jobs'][1]} right.",
        "",
        "![CharCNN learning curve](charts/cnn-learning-curve.svg)",
        "",
        "## Items (the item model)",
        "",
        "Scored on `data/item_benchmark.csv`: items a person labelled that appear in no seed list, so the",
        "only test of whether a model generalises rather than recalls.",
        "",
        "| Model | Benchmark accuracy | Bakery items right | Log loss |",
        "|---|---:|---:|---:|",
    ]
    for name, r in results["item"].items():
        b = r["benchmark"]
        bakery = (b["per_class"].get("Bakery") or {}).get("recall")
        weight = f", linear weight {r['ensemble_weight']}" if r["ensemble_weight"] is not None else ""
        lines.append(f"| {name}{weight} | {_pct(b['accuracy'])} | {_pct(bakery)} | {b['log_loss']} |")
    lines += ["", "What each answers for items customers actually order:", "",
              "| Item | " + " | ".join(results["item"].keys()) + " |",
              "|---|" + "---|" * len(results["item"])]
    for probe in PROBES:
        cells = [f"{r['probes'][probe][0]} {r['probes'][probe][1]:.2f}" for r in results["item"].values()]
        lines.append(f"| {probe} | " + " | ".join(cells) + " |")
    (REPORT / "DEEP_LEARNING.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"report: {REPORT / 'DEEP_LEARNING.md'}")


def main(argv: list[str] | None = None) -> int:
    write(run())
    return 0


if __name__ == "__main__":
    sys.exit(main())
