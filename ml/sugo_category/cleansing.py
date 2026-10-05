"""
Data cleansing for the category models' training data.

    python -m sugo_category.cleansing          # audits the OpenStreetMap names,
                                               # writes data/osm_label_issues.csv
                                               # and category/CLEANSING.md

A model can only be as right as its labels, and these labels were not clean.
"Pandesal" was answered with Jollibee because the training data taught that
bakery words mean fast food: in the OpenStreetMap names alone, 625 shops with
"bakery", "bakeshop", "panaderia" or "pastries" in the name are tagged as fast
food (mappers file a bakery-cafe under amenity=cafe), 57 more as convenience
stores, and "Goldilocks" appears as both a bakery and a restaurant.

Four steps, in the order a data team would run them, each counted and
reported so nothing is changed silently:

1. Repair names. Business-registry codes glued onto names ("0148951 5MJ
   BAKERY", "001ISR 152638 EVELYN") and broken characters are removed. A name
   with nothing left is dropped.

2. Kind-word rules. A name that says what the shop is ("... Bakeshop",
   "... Panaderia", "... Pharmacy") and is filed under something else is
   relabelled. These are labelling functions in the sense of weak supervision
   (Snorkel): short, high-precision rules written by a person. A name that
   names two kinds ("Bakery and Restaurant", "Drugstore & Grocery") is dropped
   rather than guessed, and a supplier ("Bakery Supply") is left alone.

3. Conflicting labels. One name filed under several categories is resolved by
   weighted majority vote when two thirds agree, and dropped when they do not:
   an honest "we do not know" teaches less harm than a coin toss.

4. Confident learning (Northcutt, Jiang & Chuang, 2021). A model is trained on
   four folds and scores the fifth, so every name gets an opinion from a model
   that never saw it. Where that opinion confidently disagrees with the label
   and a single mapper made it, the name is flagged in data/osm_label_issues.csv.
   Flagged names are kept out of TRAINING only; the validation and test names
   keep their labels, so the reported accuracy is not flattered by the model
   having cleaned its own exam.

Production's own rows (a dispatcher's pin, a filed item) get steps 1 and 2, and
one more rule: an item filed under a concept's old parent category ("pandesal"
under Fast Food & Restaurant) after the owner created that concept's own
category (Bakery) is moved to it. Those rows are what the console wrote before
it stopped defaulting uncategorised items to Fast Food.
"""

from __future__ import annotations

import csv
import json
import re
import sys
import time
import zlib
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Sequence

import numpy as np

from .lexicon import CONTESTED_CONCEPTS, PHARMACY
from .osm_labels import BAKERY, resolve_label

ML_DIR = Path(__file__).resolve().parent.parent
LABEL_ISSUES = ML_DIR / "data" / "osm_label_issues.csv"
REPORT_DIR = ML_DIR / "category"

# ── 1. repair ──────────────────────────────────────────────────────────────

# A token of five or more characters, at least half of them digits: a registry
# or permit number, not part of a name. "7-Eleven", "24th", "1126 Pharmacy" and
# "Highway 127" all survive.
_CODE = re.compile(r"^(?=(?:\D*\d){3})[A-Za-z0-9]{5,}$")
_BROKEN = re.compile("[�\u0000-\u001f]")
_SPACES = re.compile(r"\s+")
_LETTER = re.compile(r"[A-Za-zÀ-ÿñÑ]")

# Quantities and packaging on an item: "Pandesal (10pcs)", "coke 1.5L x2".
_QUANTITY = re.compile(
    r"\(\s*[^)]*\)|\b\d+(?:\.\d+)?\s*(?:pcs?|pieces?|pc|packs?|kg|kilos?|g|grams?|ml|l|liters?|litres?|oz|dozen|doz|box(?:es)?|x)\b|\bx\s*\d+\b",
    re.IGNORECASE,
)


def _is_code(token: str) -> bool:
    return bool(_CODE.match(token)) and sum(ch.isdigit() for ch in token) * 2 >= len(token)


def repair_name(name: str) -> str:
    """The name without registry codes, broken characters or doubled spaces."""
    cleaned = _BROKEN.sub("", name or "")
    tokens = [t for t in cleaned.split() if not _is_code(t)]
    return _SPACES.sub(" ", " ".join(tokens)).strip(" -,;:")


def strip_quantity(item: str) -> str:
    """'Pandesal (10pcs)' -> 'Pandesal'. What was bought, not how many."""
    stripped = _SPACES.sub(" ", _QUANTITY.sub(" ", item or "")).strip(" -,;:")
    return stripped or (item or "").strip()


def is_junk(name: str) -> bool:
    return len(_LETTER.findall(name or "")) < 3


def _key(name: str) -> str:
    return _SPACES.sub(" ", re.sub(r"[^a-z0-9ñ]+", " ", (name or "").lower())).strip()


# ── 2. kind-word rules ─────────────────────────────────────────────────────

def _words(*alternatives: str) -> re.Pattern:
    return re.compile(r"\b(?:" + "|".join(alternatives) + r")\b", re.IGNORECASE)


# The label each rule gives, in the raw label space of osm_store_names.csv
# (a category name, or a concept that resolve_label maps onto the catalogue).
KIND_RULES: list[tuple[str, re.Pattern]] = [
    (
        BAKERY,
        _words(
            "bakery", "bakeries", "bakeshop", "bakeshoppe", "bake ?shop", "bake ?house", "bakehaus",
            "panaderia", "panaderya", "pastry", "pastries", "patisserie", "cake ?shop", "cakeshop",
            "cakes? (?:and|&|n) pastr(?:y|ies)", "pandesal", "cakes?", "cupcakes?", "baked",
            "bread ?house", "bread ?shop",
        ),
    ),
    (PHARMACY, _words("pharmacy", "pharmacie", "drugstore", "drug store", "botika", "botica", "farmacia", "parmasya")),
]

# Words that say a shop is ALSO something else. Present, the name is mixed, and
# no single label for it is right.
_MIXED = {
    BAKERY: _words(
        "eatery", r"restau\w*", r"resto\w*", r"\w*caf[eé]", "coffee", r"brew\w*", "grill", "kainan",
        "fast ?food", r"din+ing", "bulaluhan",
        "carinderia", "karinderya", "food", "foodstore", r"groc\w*", "minimart", "mini mart", "supermarket",
        "sari[- ]?sari", "stores?", "convenience", "variety", "deli", "table", "rotisserie",
        "drugstore", "pharmacy", "lechon", "pizza", "burgers?", "lomi", "panciteria", "bistro", "lounge",
        "bar", "diner", "canteen", "snacks?", "milk ?tea", "tea", "ice cream", r"sizzl\w*",
    ),
    PHARMACY: _words(
        "grocery", "minimart", "mini mart", "convenience", "supermarket", "sari[- ]?sari", "store and",
        "general merchandise", "eatery", "restaurant", "bakery", "bakeshop",
    ),
}

# Not the kind of shop but a supplier to it ("Bakery Supply", "Pharma
# Distributor"), which Retail rightly covers. Left as the mapper tagged it.
_SUPPLIER = _words(
    "supply", "supplies", "supplier", "trading", r"me?r?chandis\w*", "distributor", "distribution",
    "party", "needs", "souvenirs?", "school",
    "equipment", "enterprises", "wholesale", "laboratory", "laboratories", "pharmaceuticals?",
    "medical", "clinic", "hospital",
)


def rule_label(name: str) -> tuple[str | None, bool]:
    """
    `(label, mixed)`: the one kind this name names, or None; and whether it
    names a kind and ALSO another, in which case it should not be trained on.
    """
    hits = [label for label, pattern in KIND_RULES if pattern.search(name)]
    if len(hits) != 1:
        return None, len(hits) > 1
    label = hits[0]
    if _SUPPLIER.search(name):
        return None, False
    if _MIXED[label].search(name):
        return None, True
    return label, False


# ── the report ─────────────────────────────────────────────────────────────


@dataclass
class CleansingReport:
    source: str
    rows_in: int = 0
    rows_out: int = 0
    repaired: int = 0
    dropped_junk: int = 0
    relabelled_by_rule: int = 0
    dropped_mixed: int = 0
    resolved_conflicts: int = 0
    dropped_conflicts: int = 0
    relabelled_contested: int = 0
    quantities_stripped: int = 0
    examples: dict[str, list[str]] = field(default_factory=lambda: defaultdict(list))

    def note(self, what: str, example: str, limit: int = 8) -> None:
        if len(self.examples[what]) < limit:
            self.examples[what].append(example)

    def as_dict(self) -> dict:
        out = {k: v for k, v in self.__dict__.items() if k != "examples"}
        out["examples"] = {k: list(v) for k, v in self.examples.items()}
        return out


# ── OpenStreetMap names ────────────────────────────────────────────────────


def cleanse_osm_rows(rows: Iterable[dict]) -> tuple[list[dict], CleansingReport]:
    """
    Steps 1 to 3 over rows of osm_store_names.csv (`name`, `label`, `count`).
    Deterministic and fast: run on every training.
    """
    report = CleansingReport(source="OpenStreetMap names")
    staged: list[tuple[str, str, int]] = []
    for row in rows:
        report.rows_in += 1
        raw, label = row["name"], row["label"]
        count = int(row.get("count") or 1)
        name = repair_name(raw)
        if name != raw.strip():
            report.repaired += 1
            report.note("repaired", f"{raw!r} -> {name!r}")
        if is_junk(name):
            report.dropped_junk += 1
            report.note("dropped_junk", raw)
            continue
        ruled, mixed = rule_label(name)
        if mixed:
            report.dropped_mixed += 1
            report.note("dropped_mixed", f"{name} ({label})")
            continue
        if ruled and ruled != label:
            report.relabelled_by_rule += 1
            report.note("relabelled_by_rule", f"{name}: {label} -> {ruled}")
            label = ruled
        staged.append((name, label, count))

    by_key: dict[str, list[tuple[str, str, int]]] = defaultdict(list)
    for entry in staged:
        by_key[_key(entry[0])].append(entry)

    out: list[dict] = []
    for key, entries in by_key.items():
        votes = Counter()
        for _, label, count in entries:
            votes[label] += count
        top, top_votes = votes.most_common(1)[0]
        total = sum(votes.values())
        if len(votes) > 1:
            if top_votes * 3 >= total * 2:
                report.resolved_conflicts += 1
                report.note("resolved_conflicts", f"{entries[0][0]}: {dict(votes)} -> {top}")
            else:
                report.dropped_conflicts += 1
                report.note("dropped_conflicts", f"{entries[0][0]}: {dict(votes)}")
                continue
        # The most common spelling of the name stands for all of them.
        spelling = Counter()
        for name, _, count in entries:
            spelling[name] += count
        out.append({"name": spelling.most_common(1)[0][0], "label": top, "count": total})
    report.rows_out = len(out)
    return out, report


def load_label_issues(path: Path = LABEL_ISSUES) -> set[str]:
    """
    The names confident learning flagged (see find_label_issues), as written.
    The trainer normalises them its own way, the same way as the names they
    are compared with.
    """
    if not path.exists():
        return set()
    with path.open(encoding="utf-8", newline="") as handle:
        return {row["name"] for row in csv.DictReader(handle)}


def find_label_issues(
    rows: Sequence[dict],
    active: Sequence[str],
    folds: int = 5,
    seed: int = 20260925,
    max_label_probability: float = 0.05,
    min_suggested_probability: float = 0.9,
) -> list[dict]:
    """
    Confident learning's "confident joint", simplified.

    Out-of-fold probabilities from the TF-IDF model, folds split by name. A
    row is an issue when (a) the model's probability for the given label is at
    most `max_label_probability`, (b) another class is at or above both that
    class's own threshold (its average self-confidence, as in the paper) and
    `min_suggested_probability`, and (c) only one mapper made the tag (count
    1): a name several mappers agreed on is not overruled by a model.

    The two probability floors are deliberately strict. At the paper's looser
    setting (0.2, class threshold alone) this flagged 4,467 names and a hand
    check of 45 found about half of them right: the rest were names that say
    nothing about the shop ("Lins", "Jhun Rose") and a few where the model was
    simply wrong ("Brownies" as a convenience store, "KFC Waltermart" as a
    supermarket). Flagging costs a training row, so a flag must be sure.
    """
    from .config import STORE
    from .model import _build_pipeline, normalize

    resolved = []
    for row in rows:
        category = resolve_label(row["label"], list(active))
        if category:
            resolved.append((normalize(row["name"]), category, int(row["count"]), row))
    classes = sorted({c for _, c, _, _ in resolved})
    index = {c: i for i, c in enumerate(classes)}
    y = np.array([index[c] for _, c, _, _ in resolved])
    # crc32, not hash(): Python salts str hashes per process, and the folds must repeat.
    groups = np.array([zlib.crc32(t.encode("utf-8")) % folds for t, _, _, _ in resolved])
    rng = np.random.default_rng(seed)
    fold_of = rng.permutation(folds)[groups]
    oof = np.zeros((len(resolved), len(classes)))
    texts = [t for t, _, _, _ in resolved]
    for fold in range(folds):
        test = fold_of == fold
        pipeline = _build_pipeline(STORE)
        pipeline.fit([texts[i] for i in np.flatnonzero(~test)], y[~test])
        proba = pipeline.predict_proba([texts[i] for i in np.flatnonzero(test)])
        cols = [list(pipeline.classes_).index(i) for i in range(len(classes))]
        oof[test] = proba[:, cols]
        print(f"  confident learning: fold {fold + 1} of {folds} scored")

    thresholds = np.array([oof[y == j, j].mean() for j in range(len(classes))])
    issues = []
    for i, (text, category, count, row) in enumerate(resolved):
        if count > 1:
            continue
        given = oof[i, y[i]]
        if given > max_label_probability:
            continue
        rivals = np.flatnonzero((oof[i] >= thresholds) & (oof[i] >= min_suggested_probability))
        rivals = rivals[rivals != y[i]]
        if not len(rivals):
            continue
        best = rivals[np.argmax(oof[i, rivals])]
        issues.append(
            {
                "name": row["name"],
                "label": row["label"],
                "as_category": category,
                "suggested": classes[best],
                "p_label": round(float(given), 4),
                "p_suggested": round(float(oof[i, best]), 4),
            }
        )
    return issues


# ── production's own rows ──────────────────────────────────────────────────


_CONTESTED_INDEX: dict[str, set[str]] = defaultdict(set)
for _concept, _phrases in CONTESTED_CONCEPTS.items():
    for _phrase in _phrases:
        _CONTESTED_INDEX[_key(_phrase)].add(_concept)


def cleanse_real_rows(
    rows: Iterable[tuple[str, str]], kind: str, allowed: set[str]
) -> tuple[list[tuple[str, str]], CleansingReport]:
    """
    A dispatcher's pins and filed items: repaired, quantities stripped from
    items, kind rules applied to shop names, and items filed under a concept's
    old parent moved to the concept's own category when the catalogue has one.
    Disagreements between dispatchers are kept: two people filing "coffee"
    differently is real evidence that coffee is sold in both places.
    """
    from .catalogue import Catalogue, role_for_label

    report = CleansingReport(source=f"production {kind} rows")
    catalogue = Catalogue.of(allowed)
    active = catalogue
    out: list[tuple[str, str]] = []
    for raw, label in rows:
        report.rows_in += 1
        name = repair_name(raw)
        if kind == "item":
            without = strip_quantity(name)
            if without != name:
                report.quantities_stripped += 1
                report.note("quantities_stripped", f"{name!r} -> {without!r}")
                name = without
        if is_junk(name):
            report.dropped_junk += 1
            report.note("dropped_junk", raw)
            continue
        if kind == "store":
            ruled, _ = rule_label(name)
            target = resolve_label(ruled, active) if ruled else None
            if target and target != label:
                report.relabelled_by_rule += 1
                report.note("relabelled_by_rule", f"{name}: {label} -> {target}")
                label = target
        else:
            # The concept's own category in THIS catalogue, whatever it is called.
            concepts = sorted({
                target
                for concept in _CONTESTED_INDEX.get(_key(name), ())
                for role in [role_for_label(concept)]
                for target in [catalogue.category_for_role(role.key, fall_back=False) if role else None]
                if target and target != label
            })
            if len(concepts) == 1 and catalogue.role_of(label) in ("food", "grocery"):
                report.relabelled_contested += 1
                report.note("relabelled_contested", f"{name}: {label} -> {concepts[0]}")
                label = concepts[0]
        out.append((name, label))
    report.rows_out = len(out)
    return out, report


# ── the audit ──────────────────────────────────────────────────────────────


def _markdown(osm: CleansingReport, issues: list[dict], by_label_before: Counter, by_label_after: Counter) -> str:
    lines = [
        "# Training data cleansing",
        "",
        "Generated by `python -m sugo_category.cleansing` on "
        f"{time.strftime('%Y-%m-%d')}. See the module docstring for what each step does and why.",
        "",
        "## OpenStreetMap shop names",
        "",
        "| Step | Rows |",
        "|---|---:|",
        f"| Names read | {osm.rows_in:,} |",
        f"| Registry codes or broken characters removed | {osm.repaired:,} |",
        f"| Dropped: no name left | {osm.dropped_junk:,} |",
        f"| Relabelled by a kind-word rule | {osm.relabelled_by_rule:,} |",
        f"| Dropped: names two kinds of shop | {osm.dropped_mixed:,} |",
        f"| Conflicting labels resolved by two-thirds majority | {osm.resolved_conflicts:,} |",
        f"| Dropped: conflicting labels, no majority | {osm.dropped_conflicts:,} |",
        f"| Names kept | {osm.rows_out:,} |",
        f"| Flagged by confident learning, kept out of training only | {len(issues):,} |",
        "",
        "Labels before and after (raw OpenStreetMap label space; `bakery` and",
        "`convenience` are concepts mapped onto the live catalogue at training):",
        "",
        "| Label | Before | After |",
        "|---|---:|---:|",
    ]
    for label in sorted(set(by_label_before) | set(by_label_after)):
        lines.append(f"| {label} | {by_label_before[label]:,} | {by_label_after[label]:,} |")
    for what, examples in osm.examples.items():
        lines += ["", f"Examples, {what.replace('_', ' ')}:", ""]
        lines += [f"- {e}" for e in examples]
    if issues:
        lines += [
            "",
            "Confident learning, the most confident disagreements:",
            "",
            "| Name | Label | Model says | p(label) | p(model) |",
            "|---|---|---|---:|---:|",
        ]
        for issue in sorted(issues, key=lambda i: -i["p_suggested"])[:25]:
            lines.append(
                f"| {issue['name']} | {issue['as_category']} | {issue['suggested']} | "
                f"{issue['p_label']:.2f} | {issue['p_suggested']:.2f} |"
            )
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    from .evaluation import OSM_NAMES, PRODUCTION_CATEGORIES

    with OSM_NAMES.open(encoding="utf-8", newline="") as handle:
        raw = list(csv.DictReader(handle))
    cleaned, report = cleanse_osm_rows(raw)
    print(json.dumps({k: v for k, v in report.as_dict().items() if k != "examples"}, indent=1))

    issues = find_label_issues(cleaned, PRODUCTION_CATEGORIES)
    LABEL_ISSUES.parent.mkdir(parents=True, exist_ok=True)
    with LABEL_ISSUES.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["name", "label", "as_category", "suggested", "p_label", "p_suggested"])
        writer.writeheader()
        writer.writerows(issues)
    print(f"confident learning flagged {len(issues)} names -> {LABEL_ISSUES}")

    before = Counter()
    for row in raw:
        before[row["label"]] += 1
    after = Counter(row["label"] for row in cleaned)
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    (REPORT_DIR / "CLEANSING.md").write_text(_markdown(report, issues, before, after), encoding="utf-8")
    (REPORT_DIR / "cleansing.json").write_text(
        json.dumps({"osm": report.as_dict(), "label_issues": len(issues)}, indent=1, ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"report: {REPORT_DIR / 'CLEANSING.md'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
