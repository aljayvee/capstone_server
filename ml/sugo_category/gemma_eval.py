"""
What Gemma 4 adds to the local models, measured (category/GEMMA.md).

    python -m sugo_category.gemma_eval --models-dir models
    python -m sugo_category.gemma_eval --gemma-models gemma-4-26b-a4b-it gemma-4-31b-it

Reads GEMMA_API_KEY from the environment or ml/.env. About 150 calls at the
default settings, well inside a day's free quota.

The benchmarks are hand-labelled names that no training source contains
(data/gemma_benchmark_items.csv, data/gemma_benchmark_stores.csv; names a seed
phrase, a production row or a map name already carries are dropped here, so
the local model is scored on what it generalises to, not what it memorised).
A name sold in two kinds of shop lists the second in `also`, and either counts
as right: pancit canton is on a convenience store's shelf and a supermarket's.

Each benchmark is split in half by name. The validation half chooses the
prompt, the Gemma model, the pooling weight and the consult threshold; the test
half is read once, with those choices, for the numbers the report leads with.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import statistics
import sys
import time
from pathlib import Path

from .catalogue import Catalogue
from .evaluation import DATA_DIR, ML_DIR, OSM_NAMES
from .gemma import DEFAULT_MODEL, GemmaError, GemmaSettings, ask, context_for, model_label
from .lexicon import synthetic_rows
from .model import (
    DEFAULT_MIN_CONFIDENCE,
    REVIEW_CONFIDENCE_THRESHOLD,
    CategoryModel,
    SecondOpinion,
    normalize,
)

BENCHMARKS = {"item": DATA_DIR / "gemma_benchmark_items.csv", "store": DATA_DIR / "gemma_benchmark_stores.csv"}
REPORT = ML_DIR / "category" / "GEMMA.md"
RESULTS = ML_DIR / "category" / "gemma.json"
WEIGHTS = (0.3, 0.4, 0.5, 0.6, 0.7, 0.8)
THRESHOLDS = (0.75, 0.85, 1.01)
DESCRIBE = ("custom", "all", "none")
BATCH = 20


def load_benchmark(kind: str, classes: list[str]) -> list[tuple[str, set[str]]]:
    with BENCHMARKS[kind].open(encoding="utf-8", newline="") as handle:
        rows = []
        for row in csv.DictReader(handle):
            right = {row["category"], *[c for c in (row.get("also") or "").split("|") if c]}
            if row["category"] in classes:
                rows.append((row["name"], right))
        return rows


def seen_names(kind: str, classes: list[str], export: Path | None) -> set[str]:
    seen = {normalize(text) for text, _, k in synthetic_rows(Catalogue.of(classes)) if k == kind}
    if export and export.exists():
        data = json.loads(export.read_text(encoding="utf-8"))
        seen |= {normalize(name) for name, _ in data["stores" if kind == "store" else "items"]}
    if kind == "store" and OSM_NAMES.exists():
        with OSM_NAMES.open(encoding="utf-8", newline="") as handle:
            seen |= {normalize(row["name"]) for row in csv.DictReader(handle)}
    return seen


def half(name: str) -> str:
    return "validation" if hashlib.md5(normalize(name).encode()).digest()[0] % 2 == 0 else "test"


def ask_all(settings: GemmaSettings, kind: str, names: list[str], context) -> tuple[dict[str, tuple[str, float]], list[float]]:
    """Every name, in batches, waiting out a quota pause rather than skipping."""
    answers: dict[str, tuple[str, float]] = {}
    seconds: list[float] = []
    for start in range(0, len(names), BATCH):
        chunk = names[start : start + BATCH]
        for attempt in range(6):
            began = time.perf_counter()
            try:
                parsed = ask(settings, kind, chunk, context)
            except GemmaError as exc:
                if exc.status in (429, 500, 503) or exc.status is None:
                    wait = exc.retry_after or 20 * (attempt + 1)
                    print(f"    {exc} ({exc.status}); waiting {wait:.0f} s", flush=True)
                    time.sleep(wait)
                    continue
                raise
            seconds.append(time.perf_counter() - began)
            for n, answer in parsed.items():
                answers[chunk[n - 1]] = answer
            break
    return answers, seconds


def score(predictions: list[tuple[str | None, float]], truth: list[set[str]], consulted: int = 0) -> dict:
    rows = len(truth)
    right = [p in t for (p, _), t in zip(predictions, truth)]
    answered = [c >= DEFAULT_MIN_CONFIDENCE for _, c in predictions]
    auto = [c >= REVIEW_CONFIDENCE_THRESHOLD for _, c in predictions]

    def share(mask):
        return round(sum(mask) / rows, 4) if rows else None

    def accuracy(mask):
        picked = [r for r, m in zip(right, mask) if m]
        return round(sum(picked) / len(picked), 4) if picked else None

    return {
        "rows": rows,
        "accuracy": share(right),
        "coverage": share(answered),
        "accuracy_when_answered": accuracy(answered),
        "auto_accepted": share(auto),
        "accuracy_when_auto": accuracy(auto),
        "consulted": round(consulted / rows, 4) if rows else None,
    }


def evaluate(model: CategoryModel, rows, verdicts: dict[str, tuple[str, float]], threshold: float, weight: float) -> dict:
    predictions, consulted = [], 0
    for name, _ in rows:
        local = model.predict(name, min_confidence=0.0)
        if local["confidence"] < threshold and name in verdicts:
            consulted += 1
            category, confidence = verdicts[name]
            local = model.predict(name, min_confidence=0.0, second_opinion=SecondOpinion(category, confidence, weight))
        predictions.append((local["category"], local["confidence"]))
    return score(predictions, [t for _, t in rows], consulted)


def pick(results: list[dict], gemma_model: str | None = None) -> dict:
    """
    Most right on validation; then fewer confident mistakes; then a lower
    consult threshold (fewer calls by design); then less weight on Gemma.

    The threshold, not the share of names actually consulted: a call that timed
    out consulted nothing, and ranking on that rewarded the slowest model.
    """
    candidates = [r for r in results if gemma_model is None or r["gemma_model"] == gemma_model] or results
    return max(
        candidates,
        key=lambda r: (
            r["validation"]["accuracy"],
            r["validation"]["accuracy_when_auto"] or 0,
            -r["threshold"],
            -r["weight"],
        ),
    )


def choose(results: dict, gemma_model: str) -> None:
    """
    One setting for both kinds, as the service has one: chosen on the item
    names, whose validation half is large enough to choose with. The store
    names are scored at that setting; theirs is too small to choose anything.
    """
    items = results["kinds"]["item"]
    chosen = pick(items["variants"], gemma_model)
    setting = {k: chosen[k] for k in ("gemma_model", "describe", "threshold", "weight")}
    results["shipped"] = setting
    for result in results["kinds"].values():
        result["chosen"] = next(
            v for v in result["variants"] if all(v[k] == setting[k] for k in setting)
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--models-dir", type=Path, default=ML_DIR / "models")
    parser.add_argument("--export", type=Path, default=DATA_DIR / "production.json",
                        help="The export the models were trained on; its names are not unseen.")
    parser.add_argument("--gemma-models", nargs="+", default=["gemma-4-26b-a4b-it", "gemma-4-31b-it"])
    parser.add_argument("--latency-samples", type=int, default=12)
    parser.add_argument("--no-write", action="store_true")
    parser.add_argument("--from-results", action="store_true",
                        help="Choose and write the report again from category/gemma.json; calls nothing.")
    parser.add_argument("--note", action="append", default=[], help="A line for the report's notes.")
    parser.add_argument("--results-file", type=Path, default=RESULTS,
                        help="Where the measurements are written (and read, with --from-results). The report "
                             "is written only when this is category/gemma.json.")
    parser.add_argument("--merge", type=Path, nargs="*", default=[],
                        help="With --from-results: other runs' results files, whose models are added.")
    parser.add_argument("--ship", default=DEFAULT_MODEL, help="The model the shipped setting is chosen for.")
    args = parser.parse_args(argv)

    if args.from_results:
        results = json.loads(args.results_file.read_text(encoding="utf-8"))
        for extra in args.merge:
            merge(results, json.loads(extra.read_text(encoding="utf-8")))
        results["notes"] = list(dict.fromkeys(results.get("notes", []) + args.note))
        return finish(results, args)

    base = GemmaSettings.from_env(dotenv=ML_DIR / ".env")
    if not base.api_key:
        parser.error("GEMMA_API_KEY is not set (environment or ml/.env)")
    base = GemmaSettings(api_key=base.api_key, timeout_seconds=60.0)

    results: dict = {"measured_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "kinds": {}}
    for kind in ("item", "store"):
        model = CategoryModel.load(args.models_dir, kind)
        classes = list(model.report.classes)
        seen = seen_names(kind, classes, args.export)
        rows = [(n, t) for n, t in load_benchmark(kind, classes) if normalize(n) not in seen]
        splits = {s: [r for r in rows if half(r[0]) == s] for s in ("validation", "test")}
        print(f"[{kind}] {len(rows)} unseen names ({len(splits['validation'])} validation, {len(splits['test'])} test)", flush=True)
        names = [n for n, _ in rows]

        local = {s: evaluate(model, splits[s], {}, 0.0, 0.0) for s in splits}
        kind_result = {"unseen_names": len(rows), "local": local, "variants": []}
        for gemma_model in args.gemma_models:
            settings = GemmaSettings(api_key=base.api_key, model=gemma_model, timeout_seconds=60.0)
            for describe in DESCRIBE:
                context = context_for(model.report, describe=describe)
                verdicts, seconds = ask_all(settings, kind, names, context)
                alone = {
                    s: score([verdicts.get(n, (None, 0.0)) for n, _ in splits[s]], [t for _, t in splits[s]])
                    for s in splits
                }
                print(
                    f"  {gemma_model} describe={describe}: answered {len(verdicts)}/{len(names)}, "
                    f"alone {alone['validation']['accuracy']:.1%} validation, batch {statistics.median(seconds):.1f} s",
                    flush=True,
                )
                for threshold in THRESHOLDS:
                    for weight in WEIGHTS:
                        kind_result["variants"].append({
                            "gemma_model": gemma_model,
                            "describe": describe,
                            "threshold": threshold,
                            "weight": weight,
                            "gemma_alone": alone,
                            "batch_seconds_median": round(statistics.median(seconds), 2),
                            "answered": len(verdicts),
                            **{s: evaluate(model, splits[s], verdicts, threshold, weight) for s in splits},
                        })
        results["kinds"][kind] = kind_result

    # How long one name takes, as the service asks when a dispatcher adds one item.
    latency: dict[str, dict] = {}
    item_model = CategoryModel.load(args.models_dir, "item")
    sample = [n for n, _ in load_benchmark("item", list(item_model.report.classes))][: args.latency_samples]
    context = context_for(item_model.report)
    for gemma_model in args.gemma_models:
        settings = GemmaSettings(api_key=base.api_key, model=gemma_model, timeout_seconds=60.0)
        seconds = []
        for name in sample:
            _, took = ask_all(settings, "item", [name], context)
            seconds += took
        ordered = sorted(seconds)
        latency[gemma_model] = {
            "samples": len(ordered),
            "median_ms": round(statistics.median(ordered) * 1000),
            "p90_ms": round(ordered[max(0, int(len(ordered) * 0.9) - 1)] * 1000),
            "max_ms": round(ordered[-1] * 1000),
        }
        print(f"[latency] {gemma_model}: one name {latency[gemma_model]}", flush=True)
    results["single_name_latency"] = latency
    results["notes"] = args.note
    return finish(results, args)


def merge(results: dict, other: dict) -> None:
    """Add another run's models to these results; a model measured in both keeps this run's rows."""
    for kind, result in other["kinds"].items():
        mine = results["kinds"].setdefault(kind, result)
        if mine is result:
            continue
        have = {v["gemma_model"] for v in mine["variants"]}
        mine["variants"] += [v for v in result["variants"] if v["gemma_model"] not in have]
    for model, row in other.get("single_name_latency", {}).items():
        results.setdefault("single_name_latency", {}).setdefault(model, row)


def finish(results: dict, args) -> int:
    choose(results, args.ship)
    for kind, result in results["kinds"].items():
        chosen = result["chosen"]
        print(
            f"[{kind}] shipped setting {results['shipped']}: test {result['local']['test']['accuracy']:.1%} local -> "
            f"{chosen['test']['accuracy']:.1%} with Gemma (Gemma alone {chosen['gemma_alone']['test']['accuracy']:.1%})"
        )
    if not args.no_write:
        args.results_file.write_text(json.dumps(results, indent=1), encoding="utf-8")
        if args.results_file.resolve() == RESULTS.resolve():
            REPORT.write_text(render(results), encoding="utf-8")
            print(f"wrote {REPORT.relative_to(ML_DIR)} and {RESULTS.relative_to(ML_DIR)}")
        else:
            print(f"wrote {args.results_file}")
    return 0


def _pct(value) -> str:
    return "n/a" if value is None else f"{value:.1%}"


def render(results: dict) -> str:
    shipped_model = results["shipped"]["gemma_model"]
    shipped_label = model_label(shipped_model)[1]
    out = [
        "# Large-model second opinion (Gemini and Gemma)",
        "",
        f"Measured {results['measured_at']} by `python -m sugo_category.gemma_eval`. How it is wired in is",
        "described at the top of `sugo_category/gemma.py`.",
        "",
        "The benchmarks are hand-labelled names no training source contains (a seed phrase, a production",
        "row or an OpenStreetMap name). Half of each chose the settings below; the other half, the test",
        "half, was read once with them. A name listed with a second acceptable category counts as right",
        "under either.",
        "",
    ]
    for kind, result in results["kinds"].items():
        chosen = result["chosen"]
        local = result["local"]["test"]
        pooled = chosen["test"]
        alone = chosen["gemma_alone"]["test"]
        rows = [("Local model alone", local), (f"Local + {shipped_label} (shipped)", pooled)]
        # Every other model measured, at the shipped setting: what the chain's
        # fallback does when it is the one answering.
        for other in sorted({v["gemma_model"] for v in result["variants"]} - {shipped_model}):
            same = next(
                (v for v in result["variants"] if v["gemma_model"] == other
                 and all(v[k] == chosen[k] for k in ("describe", "threshold", "weight"))),
                None,
            )
            if same:
                rows.append((f"Local + {other}, same setting", same["test"]))
        rows.append((f"{shipped_label} alone", alone))
        out += [
            f"## {kind.capitalize()} names ({result['unseen_names']} unseen, {pooled['rows']} in the test half)",
            "",
            f"Shipped setting (chosen on the item names' validation half): `{shipped_model}`, category",
            f"text `{chosen['describe']}`, asked below {chosen['threshold']:.2f} local confidence, weight",
            f"{chosen['weight']} on its answer.",
            "",
            "| Test half | Right | Get a category (>= 0.55) | Right when answered | Auto-accepted (>= 0.75) | Right when auto | Asked the model |",
            "|---|---|---|---|---|---|---|",
        ]
        for label, row in rows:
            out.append(
                f"| {label} | {_pct(row['accuracy'])} | {_pct(row['coverage'])} | {_pct(row['accuracy_when_answered'])} "
                f"| {_pct(row['auto_accepted'])} | {_pct(row['accuracy_when_auto'])} | {_pct(row.get('consulted')) if label.startswith('Local +') else '-'} |"
            )
        if pooled["rows"] < 30:
            out += ["", f"Only {pooled['rows']} test names: one name moves these by {1 / pooled['rows']:.0%}. Read them as"
                        " examples, not rates. Most shop names are already among the 83,000 OpenStreetMap names the"
                        " store model trains on, so few are unseen."]
        out += ["", "Validation half, best setting per model and category text:", "",
                "| Model | Category text | Below | Weight | Right | Right when auto | Model alone |",
                "|---|---|---|---|---|---|---|"]
        best: dict[tuple, dict] = {}
        for v in result["variants"]:
            key = (v["gemma_model"], v["describe"])
            if key not in best or pick([best[key], v]) is v:
                best[key] = v
        for (gemma_model, describe), v in sorted(best.items()):
            out.append(
                f"| {gemma_model} | {describe} | {v['threshold']:.2f} | {v['weight']} | {_pct(v['validation']['accuracy'])} "
                f"| {_pct(v['validation']['accuracy_when_auto'])} | {_pct(v['gemma_alone']['validation']['accuracy'])} |"
            )
        out.append("")
    out += ["## Time for one name", "", "| Model | Median | 90th percentile | Slowest |", "|---|---|---|---|"]
    for gemma_model, row in results["single_name_latency"].items():
        out.append(f"| {gemma_model} | {row['median_ms']} ms | {row['p90_ms']} ms | {row['max_ms']} ms |")
    out.append("")
    if results.get("notes"):
        out += ["## Notes", ""] + [f"- {note}" for note in results["notes"]] + [""]
    return "\n".join(out)

if __name__ == "__main__":
    sys.exit(main())
