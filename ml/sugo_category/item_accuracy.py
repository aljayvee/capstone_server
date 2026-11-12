"""Offline, name-disjoint comparison of item vocabularies on a training export.

python -m sugo_category.item_accuracy --from-export models/accuracy-study/production.json \
    --baseline-seeds models/accuracy-study/baseline-seeds.json \
    --out models/accuracy-study/comparison.json

No database, external model, or deployed model is touched. Repeated splits
are a sensitivity analysis, not independent test sets or a production SLA.
Both candidates use the same logistic classifier: this isolates vocabulary
changes, rather than attributing effects to an unmeasured CNN.
"""
from __future__ import annotations

import argparse
import json
from dataclasses import replace
from pathlib import Path

import numpy as np

from .catalogue import Catalogue
from .cleansing import cleanse_real_rows
from .config import ITEM
from .evaluation import apply_temperature, fit_temperature, group_split, measure
from .lexicon import synthetic_rows
from .model import _build_pipeline, _fit, normalize


def compare(real, baseline_seeds, candidate_seeds, seeds=(20260923, 20260924, 20260925, 20260926, 20260927)):
    settings = replace(ITEM, classifier="logistic")
    rows = [(normalize(n), c) for n, c in real if normalize(n)]
    baseline = [(normalize(n), c) for n, c in baseline_seeds]
    candidate = [(normalize(n), c) for n, c in candidate_seeds]
    output = []
    for seed in seeds:
        real_train, _, test = group_split(rows, val=0, test=.2, seed=seed)
        test_names = {n for n, _ in test}
        development = [(n, c, settings.seed_weight) for n, c in baseline if n not in test_names]
        development += [(n, c, settings.real_weight) for n, c in real_train]
        train, validation, _ = group_split(development, val=.15, test=0, seed=seed + 2)
        val_names = {n for n, _, _ in validation}
        # Freeze partitions using the baseline vocabulary. Added phrases may
        # train, but cannot teach the model a name in validation or test.
        train_real = [(n, c, settings.real_weight) for n, c in real_train if n not in val_names]
        result = {"seed": seed, "test_names": len(test_names), "test_rows": len(test), "models": {}}
        for name, vocabulary in (("baseline", baseline), ("candidate", candidate)):
            training = train_real + [(n, c, settings.seed_weight) for n, c in vocabulary
                                     if n not in test_names and n not in val_names]
            pipeline = _fit(_build_pipeline(settings), [n for n, _, _ in training],
                            [c for _, c, _ in training], np.array([w for _, _, w in training]))
            classes = list(pipeline.classes_)
            known_val = [(n, classes.index(c)) for n, c, _ in validation if c in classes]
            temperature = fit_temperature(pipeline.predict_proba([n for n, _ in known_val]),
                                          np.array([i for _, i in known_val])) if known_val else 1.
            proba = apply_temperature(pipeline.predict_proba([n for n, _ in test]), temperature)
            # Equal weight per normalized name, preserving disagreements about
            # that name as a distribution rather than arbitrarily relabeling it.
            frequencies = {n: sum(t == n for t, _ in test) for n in test_names}
            predictions = [classes[i] for i in proba.argmax(axis=1)]
            name_accuracy = sum((pred == label) / frequencies[n]
                                for (n, label), pred in zip(test, predictions)) / len(test_names)
            result["models"][name] = {"temperature": temperature, "name_accuracy": round(name_accuracy, 4),
                                     "test": measure(proba, classes, [c for _, c in test])}
        output.append(result)
        print(json.dumps({"seed": seed, **{name: {"accuracy": value["test"]["accuracy"],
                                                  "name_accuracy": value["name_accuracy"]}
                                         for name, value in result["models"].items()}}), flush=True)
    return {"method": "same name-disjoint partitions; fixed logistic settings; repeated splits overlap",
            "real_rows": len(rows), "unique_names": len({n for n, _ in rows}), "splits": output,
            "mean": {name: {"accuracy": round(float(np.mean([r["models"][name]["test"]["accuracy"] for r in output])), 4),
                            "name_accuracy": round(float(np.mean([r["models"][name]["name_accuracy"] for r in output])), 4)}
                     for name in ("baseline", "candidate")}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--from-export", type=Path, required=True)
    parser.add_argument("--baseline-seeds", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    data = json.loads(args.from_export.read_text(encoding="utf-8-sig"))
    catalogue = Catalogue.of(data["categories"], data.get("descriptions"))
    real, _ = cleanse_real_rows([(n, catalogue.resolve(c)) for n, c in data["items"] if catalogue.resolve(c)],
                               "item", catalogue)
    baseline = [(n, c) for n, c, kind in json.loads(args.baseline_seeds.read_text(encoding="utf-8-sig")) if kind == "item"]
    candidate = [(n, c) for n, c, kind in synthetic_rows(catalogue) if kind == "item"]
    result = compare(real, baseline, candidate)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print("MEAN", json.dumps(result["mean"]), flush=True)


if __name__ == "__main__":
    main()
