"""
The classifier: what kind of shop is this, and where is this item bought.

Two models, one shape. Each is a TF-IDF vectoriser over word and character
n-grams feeding a multinomial logistic regression. Character n-grams are the
part that earns its keep here: Philippine shop names are misspelt, abbreviated
and run together ("Jolibee", "MercuryDrug Tacurong", "Aling Nena's Karinderya"),
and a word-only model sees each variant as an unrelated token. Character
n-grams see "karinder" inside all of them.

Logistic regression rather than anything deeper because the decision needs a
CALIBRATED probability, not just an argmax. The dispatcher-facing rule is "say
nothing unless you are fairly sure" — ten server behaviours read the category
field, so a confident wrong answer costs more than an absent one — and that rule
is only meaningful if the number attached to a prediction means something.
`predict_proba` on a linear model over TF-IDF is well behaved for that; a small
tree ensemble on this much data is not.

Google's own `types` array, where the caller has one, is fused in afterwards as
a prior rather than as a feature. It is a far stronger signal than a name when
it is present and specific, and it is missing entirely for most Tacurong shops,
so leaving it as a feature would teach the model to lean on a column that is
usually empty.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, asdict, fields
from pathlib import Path
from typing import Iterable, Sequence

import joblib
import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import FeatureUnion, Pipeline

from .config import SETTINGS, ModelSettings
from .lexicon import CATEGORIES, FOOD, GROCERY, PHARMACY, RETAIL, synthetic_rows
from .deep import CharCNNClassifier, LinearDeepEnsemble, choose_ensemble_weight
from .neural import NeuralClassifier

# A real row — a place an owner catalogued, or a category a dispatcher chose on
# a live errand — is worth this many seed phrases. Seed knowledge is a floor,
# not an opinion to be defended: where Tacurong's actual data disagrees with the
# lexicon, the data is right and the lexicon is out of date. The per-model
# values live in config.py; these are the defaults they were measured against.
SYNTHETIC_ROW_WEIGHT = 1.0
REAL_ROW_WEIGHT = 6.0

# Below this, the service returns no category at all and the pin keeps its amber mark.
DEFAULT_MIN_CONFIDENCE = 0.55

# Below this, the prediction requires staff/dispatcher review (needsReview = True).
# Only predictions with confidence >= 0.75 (75%) are automatically accepted.
REVIEW_CONFIDENCE_THRESHOLD = 0.75

# Above this the answer is treated as strong enough to be worth showing as the
# model's own rather than as a coin-flip.
STRONG_CONFIDENCE = 0.85

# Below this many training rows ModelSettings.min_df is ignored (see _fit).
MIN_DF_FROM_ROWS = 5000

# 3: trained on OpenStreetMap shop names as well as the lexicon, a choice of
# classifier (config.py), and temperature-scaled confidence.
MODEL_VERSION = 4


# ── Google Places types ────────────────────────────────────────────────────
#
# Mirrors GOOGLE_TYPE_TO_CATEGORY in the web app's storeCategoryInference.ts.
# Order matters: a Jollibee comes back as
# ["restaurant","food","point_of_interest","establishment"], so the specific
# types must be consulted before the generic tail, or the bare "store" entry
# wins and files every restaurant under Retail.
GOOGLE_TYPE_RULES: list[tuple[str, tuple[str, ...]]] = [
    # Ahead of FOOD, which also lists "bakery". Production's catalogue has a
    # Bakery category, and filing Google's `bakery` type under Fast Food sent
    # a pinned Julie's Bakeshop there on 2026-09-23. Skipped wherever the model
    # has no Bakery class, so the FOOD fallback still applies there.
    ("Bakery", ("bakery",)),
    # Production added "Convenience Store" on 2026-09-24. Same rule as Bakery:
    # skipped where the model has no such class, so GROCERY still takes it.
    ("Convenience Store", ("convenience_store",)),
    (PHARMACY, ("pharmacy", "drugstore", "doctor", "hospital", "dentist",
                "physiotherapist", "health", "veterinary_care")),
    (GROCERY, ("supermarket", "grocery_or_supermarket", "grocery_store",
               "convenience_store", "liquor_store", "market", "food_store",
               "asian_grocery_store", "butcher_shop")),
    # The newer Places API names cuisines ("filipino_restaurant",
    # "fast_food_restaurant"); category_from_google_types adds a bare
    # "restaurant" for them.
    (FOOD, ("restaurant", "meal_takeaway", "meal_delivery", "cafe", "bakery",
            "bar", "food", "coffee_shop", "ice_cream_shop", "dessert_shop",
            "juice_shop", "tea_house", "sandwich_shop", "food_court")),
    (RETAIL, ("department_store", "clothing_store", "hardware_store",
              "electronics_store", "home_goods_store", "furniture_store",
              "shoe_store", "book_store", "pet_store", "shopping_mall",
              "florist", "bicycle_store", "car_repair", "cell_phone_store",
              "discount_store", "gift_shop", "sporting_goods_store", "store")),
]

# How much a Google types hit is believed. A specific type is close to decisive.
#
# The generic tail is deliberately almost weightless. "store" and "establishment"
# are attached to nearly every business with a door, so they carry close to no
# information, and Google files plenty of Philippine carinderias under exactly
# that pair. At 0.35 the generic vote was strong enough to drag a name the model
# was RIGHT about ("Aling Nena's Karinderya") below the confidence floor and
# silence it; 0.15 lets it nudge a genuine tie without overruling a clear name.
GENERIC_GOOGLE_TYPES = {"store", "food", "point_of_interest", "establishment"}
SPECIFIC_GOOGLE_WEIGHT = 0.85
GENERIC_GOOGLE_WEIGHT = 0.15


def category_from_google_types(
    types: Sequence[str] | None,
    available: Iterable[str] | None = None,
) -> tuple[str | None, float]:
    """
    The category Google's types imply, and how much that is worth.

    `available` is the set of classes the calling model can actually predict.
    A rule naming anything else is skipped rather than returned: a Google vote
    for a category the model has never heard of cannot be blended with its
    scores, and would otherwise silently cancel the rule that should have
    applied after it.
    """
    if not types:
        return None, 0.0
    present = {str(t).strip().lower() for t in types if t}
    if any(t.endswith("_restaurant") for t in present):
        present.add("restaurant")
    if not present:
        return None, 0.0
    allowed = set(available) if available is not None else None

    for category, rule_types in GOOGLE_TYPE_RULES:
        if allowed is not None and category not in allowed:
            continue
        hit = present.intersection(rule_types)
        if not hit:
            continue
        specific = hit - GENERIC_GOOGLE_TYPES
        weight = SPECIFIC_GOOGLE_WEIGHT if specific else GENERIC_GOOGLE_WEIGHT
        return category, weight
    return None, 0.0


# ── text normalisation ─────────────────────────────────────────────────────

_PUNCT = re.compile(r"[^a-z0-9\s]+")
_SPACE = re.compile(r"\s+")

# Words that name a branch, not a business. Stripping them stops the model
# learning that "Tacurong" or "Branch" predicts anything, which it would,
# because nearly every row in a single-city catalogue contains one.
BRANCH_NOISE = {
    "branch", "brgy", "barangay", "poblacion", "tacurong", "city", "sultan",
    "kudarat", "philippines", "main", "annex", "highway", "national", "road",
    "st", "street", "ave", "avenue", "corner", "cor", "bldg", "building",
    "inc", "incorporated", "corp", "corporation", "co", "ltd", "enterprises",
    "store", "shop",
}


def normalize(text: str) -> str:
    """Lowercase, strip punctuation, and drop branch/location noise words."""
    lowered = _PUNCT.sub(" ", (text or "").lower())
    tokens = [t for t in _SPACE.sub(" ", lowered).strip().split() if t]
    kept = [t for t in tokens if t not in BRANCH_NOISE]
    # Keep the original tokens when stripping would empty the string — a shop
    # genuinely called "The Store" still has to be classified as something.
    return " ".join(kept or tokens)


def squash(text: str) -> str:
    """
    The same text with its spaces removed.

    This is what makes run-together spelling work. Filipino shop and product
    names are written both ways by the same person on the same day — "milk tea"
    and "milktea", "sari sari" and "sarisari", "ukay ukay" and "ukayukay" — and
    the character n-grams are `char_wb`, which stays inside word boundaries and
    so never sees "ilkte" in the spaced form.

    It is a separate feature block rather than extra text appended to the name,
    because appending it made a four-word shop name carry one long unseen blob
    whose n-grams diluted the one token that actually identified the shop.
    Module level, not a lambda, so the fitted pipeline stays picklable.
    """
    return text.replace(" ", "")


def _classifier(settings: ModelSettings):
    if settings.classifier == "neural":
        return NeuralClassifier(
            hidden=tuple(settings.hidden),
            activation=settings.activation,
            optimizer=settings.optimizer,
            learning_rate=settings.learning_rate,
            batch_size=settings.batch_size,
            epochs=settings.epochs,
            l2=settings.l2,
            dropout=settings.dropout,
            patience=settings.patience,
            class_weight="balanced",
            seed=settings.seed,
        )
    return LogisticRegression(
        max_iter=2000,
        # Multinomial with balanced weights: the catalogue is not
        # evenly split across the categories, and without this
        # the largest category absorbs every uncertain name.
        class_weight="balanced",
        C=settings.C,
    )


def _build_pipeline(settings: ModelSettings | None = None) -> Pipeline:
    """Word n-grams for the phrases, character n-grams for the misspellings."""
    settings = settings or ModelSettings()
    min_df = settings.min_df
    return Pipeline(
        [
            (
                "features",
                FeatureUnion(
                    [
                        (
                            "word",
                            TfidfVectorizer(
                                analyzer="word",
                                ngram_range=(1, 2),
                                sublinear_tf=True,
                                min_df=min_df,
                            ),
                        ),
                        (
                            "char",
                            # char_wb keeps n-grams inside word boundaries, so
                            # "karinderya" contributes "karind" without also
                            # learning spurious grams that straddle two words.
                            TfidfVectorizer(
                                analyzer="char_wb",
                                ngram_range=(3, 5),
                                sublinear_tf=True,
                                min_df=min_df,
                            ),
                        ),
                        (
                            "squashed",
                            # The same characters with the spaces taken out, so
                            # "milk tea" and "milktea" land on shared n-grams.
                            # Plain `char`, not char_wb: the whole point is to
                            # read across what used to be a word boundary.
                            TfidfVectorizer(
                                analyzer="char",
                                ngram_range=(3, 5),
                                sublinear_tf=True,
                                min_df=min_df,
                                preprocessor=squash,
                            ),
                        ),
                    ]
                ),
            ),
            ("clf", _classifier(settings)),
        ]
    )


def _fit(
    pipeline: Pipeline,
    texts: list[str],
    labels: list[str],
    weights: np.ndarray,
    eval_texts: list[str] | None = None,
    eval_labels: list[str] | None = None,
) -> Pipeline:
    """
    Fit features then classifier, handing the network its validation names.

    Done in two steps rather than pipeline.fit so early stopping can watch
    held-out names run through the SAME fitted features; a Pipeline has no way
    to transform an eval set mid-fit.
    """
    features = pipeline.named_steps["features"]
    clf = pipeline.named_steps["clf"]
    if len(texts) < MIN_DF_FROM_ROWS:
        # The lexicon alone (a fresh install, or the item model) has every
        # phrase exactly once, so pruning one-document n-grams would prune
        # the lexicon itself: "ukay ukay" stopped being a column at all.
        features.set_params(**{f"{name}__min_df": 1 for name, _ in features.transformer_list})
    X = features.fit_transform(texts)
    if isinstance(clf, NeuralClassifier) and eval_texts:
        clf.fit(X, labels, sample_weight=weights, eval_set=(features.transform(eval_texts), eval_labels))
    else:
        clf.fit(X, labels, sample_weight=weights)
    return pipeline


DEEP_CLASSIFIERS = ("charcnn", "ensemble")


def _build_deep(settings: ModelSettings, epochs: int | None = None, pretrained=None) -> CharCNNClassifier:
    return CharCNNClassifier(
        pretrained=pretrained,
        pretrained_lr_scale=settings.cnn_pretrained_lr_scale,
        embed_dim=settings.cnn_embed_dim,
        widths=tuple(settings.cnn_widths),
        filters=settings.cnn_filters,
        hidden=settings.cnn_hidden,
        dropout=settings.cnn_dropout,
        epochs=epochs or settings.cnn_epochs,
        batch_size=settings.cnn_batch_size,
        learning_rate=settings.cnn_learning_rate,
        weight_decay=settings.cnn_weight_decay,
        label_smoothing=settings.cnn_label_smoothing,
        augment=settings.cnn_augment,
        patience=settings.cnn_patience,
        max_seconds=settings.cnn_max_seconds,
        seed=settings.seed,
    )


def _deep_member(predictor) -> CharCNNClassifier | None:
    if isinstance(predictor, LinearDeepEnsemble):
        return predictor.deep
    return predictor if isinstance(predictor, CharCNNClassifier) else None


def _fit_predictor(settings: ModelSettings, rows, val_rows, template=None, pretrained=None):
    """
    The model `settings.classifier` names, fitted on `(text, label, weight)` rows.

    First call (`template` None): the probe, trained on the training names and
    watching `val_rows`: the network early-stops on them and the ensemble
    weight is chosen on them. Second call: the shipped model, on every row,
    reusing what the probe decided. With `cnn_refit` the network is trained
    again for the probe's best epoch count; without, the probe's network ships.
    """
    texts = [t for t, _, _ in rows]
    labels = [c for _, c, _ in rows]
    weights = np.array([w for _, _, w in rows], dtype=float)
    val_texts = [t for t, _ in val_rows]
    val_labels = [c for _, c in val_rows]

    linear = None
    if settings.classifier != "charcnn":
        linear = _fit(
            _build_pipeline(settings), texts, labels, weights,
            eval_texts=val_texts or None, eval_labels=val_labels or None,
        )
        if settings.classifier not in DEEP_CLASSIFIERS:
            return linear
        if template is None and not val_texts:
            # No validation names (holdout=False) means no way to tell whether
            # the network helps, so it is not trusted: the linear model ships
            # alone. A blind 50/50 blend with an unchecked network made seed-only
            # models worse ("Aling Nena's Karinderya" dropped below 0.55).
            return linear
        if isinstance(template, Pipeline):
            return linear

    probe_deep = _deep_member(template)
    if probe_deep is None:
        deep = _build_deep(settings, pretrained=pretrained).fit(
            texts, labels, sample_weight=weights, eval_set=(val_texts, val_labels) if val_texts else None
        )
    elif settings.cnn_refit:
        deep = _build_deep(settings, epochs=probe_deep.best_epoch_, pretrained=pretrained).fit(
            texts, labels, sample_weight=weights
        )
    else:
        deep = probe_deep
    if linear is None:
        return deep

    if isinstance(template, LinearDeepEnsemble):
        weight = template.weight
    elif val_texts:
        pair = LinearDeepEnsemble(linear, deep, 1.0)
        index = {c: i for i, c in enumerate(pair.classes_)}
        known = [i for i, c in enumerate(val_labels) if c in index]
        linear_p, deep_p = pair.member_proba([val_texts[i] for i in known])
        weight = choose_ensemble_weight(linear_p, deep_p, np.array([index[val_labels[i]] for i in known]))
    else:
        weight = 1.0
    return LinearDeepEnsemble(linear, deep, weight)


@dataclass
class TrainingReport:
    kind: str
    rows: int
    real_rows: int
    synthetic_rows: int
    classes: list[str]
    holdout_accuracy: float | None
    # Added in version 3. Defaults keep a version 2 report loadable.
    osm_rows: int = 0
    temperature: float = 1.0
    evaluation: dict | None = None
    settings: dict | None = None
    train_seconds: float | None = None
    # Added in version 4.
    classifier: str = "logistic"
    excluded_as_mislabelled: int = 0
    ensemble_weight: float | None = None
    deep: dict | None = None
    # What sugo_category.gemma tells Gemma about each class: the owner's
    # description, and names the model was taught under it. Empty in older reports.
    descriptions: dict | None = None
    examples: dict | None = None
    # Gemma's cached answers taught to this model (distillation), if any.
    teacher_rows: int = 0
    training_quality: dict | None = None


@dataclass(frozen=True)
class SecondOpinion:
    """
    Another model's answer for the same name (sugo_category.gemma), pooled
    with this one's by `pool_second_opinion`.
    """

    category: str
    confidence: float
    # Its share of the pooled probabilities.
    weight: float
    # Appended to `source`, e.g. "name+gemma".
    source: str = "gemma"
    # How the reason names it.
    label: str = "Gemma 4"


def pool_second_opinion(scores: dict[str, float], opinion: SecondOpinion) -> dict[str, float]:
    """
    A linear opinion pool: (1 - w) * ours + w * theirs.

    Theirs is a single answer and a confidence, so it is spread into a
    distribution first: the confidence on its category, the rest shared out in
    proportion to our own scores. Pooling, rather than taking their answer,
    keeps a confident local answer from being overturned by one unsure outside
    one, and keeps the result a probability the 0.55 and 0.75 thresholds still
    mean something against.
    """
    if opinion.category not in scores or len(scores) < 2 or opinion.weight <= 0:
        return dict(scores)
    confidence = min(max(opinion.confidence, 0.0), 1.0)
    weight = min(opinion.weight, 1.0)
    rest = {c: s for c, s in scores.items() if c != opinion.category}
    rest_total = sum(rest.values())
    theirs = {
        c: (1.0 - confidence) * (s / rest_total if rest_total > 0 else 1.0 / len(rest))
        for c, s in rest.items()
    }
    theirs[opinion.category] = confidence
    return {c: (1.0 - weight) * s + weight * theirs[c] for c, s in scores.items()}


def _examples_by_class(*sources: Iterable[tuple[str, str]], per_class: int = 8) -> dict[str, list[str]]:
    """
    A few names each class was taught, for the Gemma prompt: production's own
    first (how this business files things), then seed phrases, then map names,
    the most frequent of each first.
    """
    from collections import Counter

    examples: dict[str, list[str]] = {}
    for rows in sources:
        for (text, category), _ in Counter(rows).most_common():
            bucket = examples.setdefault(category, [])
            if len(bucket) < per_class and text not in bucket:
                bucket.append(text)
    return examples


class CategoryModel:
    """One trained classifier plus the metadata needed to explain an answer."""

    def __init__(self, kind: str, pipeline: Pipeline, report: TrainingReport):
        self.kind = kind
        self.pipeline = pipeline
        self.report = report
        self.temperature = report.temperature or 1.0
        # The last few names scored. The service scores a name twice when it
        # asks Gemma about it (once to decide, once to pool the answer), and
        # the network's forward pass is the costly part of both.
        self._recent: dict[str, dict[str, float]] = {}

    # ── training ───────────────────────────────────────────────────────────
    @classmethod
    def train(
        cls,
        kind: str,
        real_rows: Iterable[tuple[str, str]],
        holdout: bool = True,
        allowed: set[str] | None = None,
        extra_rows: Iterable[tuple[str, str]] | None = None,
        settings: ModelSettings | None = None,
        exclude_from_training: Iterable[str] | None = None,
        pretrained: "CategoryModel | None" = None,
        teacher_rows: Iterable[tuple[str, str]] | None = None,
        excluded_training_names: Iterable[str] | None = None,
        training_quality: dict | None = None,
    ) -> "CategoryModel":
        """
        `real_rows` are `(text, category)` pairs read from the database.
        Seed phrases for this `kind` are always mixed in underneath them.

        `allowed` is the set of category names this environment actually has,
        read from `merchant_categories`. It defaults to the lexicon's own four,
        but production carries a fifth ("Bakery") that no seed phrase covers —
        and filtering real rows against the lexicon silently threw every one of
        those away, so the model could never learn a category the owner added.

        `extra_rows` are `(name, category)` pairs from OpenStreetMap
        (evaluation.load_osm_rows), already resolved against the catalogue.
        When present they also provide the held-out test: 15% of the names are
        kept out of a first fit and scored, 15% calibrate the confidence, and
        then the shipped model is fitted on everything.

        `teacher_rows` are `(name, category)` answers Gemma gave with high
        confidence (GemmaAdvisor.teacher_rows). They train at
        `settings.teacher_weight`, below a real row, never for a name a real row
        already files, and never in a validation or test split.
        """
        started = time.time()
        settings = settings or SETTINGS.get(kind, ModelSettings())
        from .catalogue import Catalogue

        # The catalogue: names, descriptions, and the role each carries. A
        # stored label resolves through it, so a row filed "Bakery" before the
        # category was renamed still teaches the renamed category.
        permitted = Catalogue.of(allowed)
        # The catalogue is passed into the lexicon too, so a concept the owner
        # has promoted into its own category (Bakery) stops being asserted
        # under its old parent and arguing against the real rows.
        seeds = [
            (text, cat)
            for text, cat, row_kind in synthetic_rows(permitted)
            if row_kind == kind
        ]

        real = [
            (normalize(text), permitted.resolve(cat))
            for text, cat in real_rows
            if text and permitted.resolve(cat) and normalize(text)
        ]
        synthetic = [(normalize(text), cat) for text, cat in seeds]
        extra = [
            (normalize(text), permitted.resolve(cat))
            for text, cat in (extra_rows or [])
            if text and permitted.resolve(cat) and normalize(text)
        ]

        # Names confident learning flagged as probably mislabelled
        # (cleansing.find_label_issues) never train anything. They stay in the
        # validation and test names with their original labels, so the score
        # is not flattered by the model having cleaned its own exam.
        excluded = {normalize(name) for name in (exclude_from_training or ())}
        # Transfer learning: the store model's network starts this one.
        source = _deep_member(pretrained.pipeline) if pretrained is not None and settings.cnn_transfer_from_store else None
        trainable_extra = [row for row in extra if row[0] not in excluded]
        quality_excluded = {normalize(name) for name in (excluded_training_names or ()) if normalize(name)}
        # Gemma's answers: a dispatcher's or owner's filing of the same name
        # outranks them, and a name flagged as mislabelled teaches nothing.
        filed = {t for t, _ in real} | excluded | quality_excluded
        teacher = list(dict.fromkeys(
            (normalize(text), permitted.resolve(cat))
            for text, cat in (teacher_rows or [])
            if text and permitted.resolve(cat) and normalize(text) and normalize(text) not in filed
        ))

        def triples(parts):
            """[(rows, weight), ...] -> [(text, label, weight), ...]"""
            return [(t, c, weight) for part, weight in parts for t, c in part]

        def teacher_outside(*held_out):
            """Teacher rows for names in no held-out split, so no score is flattered."""
            names = {row[0] for rows in held_out for row in rows}
            return [row for row in teacher if row[0] not in names]

        everything = triples(
            [(synthetic, settings.seed_weight), (real, settings.real_weight), (trainable_extra, settings.osm_weight),
             (teacher, settings.teacher_weight)]
        )
        # Quality decisions apply only to fitting. Do not remove or relabel a
        # held-out row because another model disliked it: that would let the
        # reviewer change its own exam and inflate the reported accuracy.
        everything = [row for row in everything if row[0] not in quality_excluded]
        if len({c for _, c, _ in everything}) < 2:
            raise ValueError(
                f"{kind}: need at least two categories to train, got {sorted({c for _, c, _ in everything})}"
            )

        # Imported here: evaluation imports this module for normalize().
        from .evaluation import apply_temperature, fit_temperature, group_split, measure

        accuracy: float | None = None
        evaluation: dict | None = None
        temperature = 1.0
        probe = None
        # holdout=False skips all of this: one fit, no probe, temperature 1.
        if holdout:
            if extra:
                # The store model: OpenStreetMap names split by name. 70% train,
                # 15% validation (early stopping, the ensemble weight, the
                # temperature), 15% test, read once for the report.
                osm_train, val_rows, test_rows = group_split(extra)
                osm_train = [row for row in osm_train if row[0] not in excluded]
                train_rows = triples(
                    [(synthetic, settings.seed_weight), (real, settings.real_weight), (osm_train, settings.osm_weight),
                     (teacher_outside(val_rows, test_rows), settings.teacher_weight)]
                )
                held_out = "OpenStreetMap names, split by name (evaluation.group_split)"
            else:
                # The item model has no map names. 20% of the real names are held
                # out for the reported accuracy, as before; of the rest, 15% of
                # the phrases validate. Whole names at a time: the same
                # "Pandesal (10pcs)" ordered eight times is one lesson.
                real_train, real_test = real, []
                if len(real) >= 40:
                    real_train, _, real_test = group_split(real, val=0.0, test=0.2, seed=20260923)
                # A real test name may also be a seed phrase. Excluding it
                # from real_train alone still lets the probe memorize it via
                # the lexicon (or even use it to choose its temperature).
                # Final serving models still train on everything below.
                test_names = {normalize(t) for t, _ in real_test}
                development_seeds = [(t, c) for t, c in synthetic if normalize(t) not in test_names]
                development = triples([(development_seeds, settings.seed_weight), (real_train, settings.real_weight)])
                train_rows, validation, _ = group_split(development, val=0.15, test=0.0, seed=20260925)
                val_rows = [(t, c) for t, c, _ in validation]
                test_rows = real_test
                train_rows = train_rows + triples([(teacher_outside(val_rows, test_rows), settings.teacher_weight)])
                held_out = "production's own item names, split by name"

            train_rows = [row for row in train_rows if row[0] not in quality_excluded]
            probe = _fit_predictor(settings, train_rows, val_rows, pretrained=source)
            classes = list(probe.classes_)
            index = {c: i for i, c in enumerate(classes)}
            known_val = [(t, index[c]) for t, c in val_rows if c in index]
            if settings.calibrate and known_val:
                temperature = fit_temperature(
                    probe.predict_proba([t for t, _ in known_val]), np.array([i for _, i in known_val])
                )
            if test_rows:
                test_texts, test_labels = [t for t, _ in test_rows], [c for _, c in test_rows]
                evaluation = {
                    "held_out": held_out,
                    "train_names": len(train_rows),
                    "validation_names": len(val_rows),
                    "test": measure(apply_temperature(probe.predict_proba(test_texts), temperature), classes, test_labels),
                }
                if isinstance(probe, LinearDeepEnsemble):
                    linear_p, deep_p = probe.member_proba(test_texts)
                    evaluation["members"] = {
                        "ensemble_weight": probe.weight,
                        "linear": measure(linear_p, list(probe.classes_), test_labels),
                        "deep": measure(deep_p, list(probe.classes_), test_labels),
                    }
                accuracy = evaluation["test"]["accuracy"]

        texts = [t for t, _, _ in everything]
        pipeline = _fit_predictor(settings, everything, [], template=probe, pretrained=source)
        deep_member = _deep_member(pipeline)

        report = TrainingReport(
            kind=kind,
            rows=len(texts),
            real_rows=sum(name not in quality_excluded for name, _ in real),
            synthetic_rows=len(synthetic),
            classes=sorted({c for _, c, _ in everything}),
            holdout_accuracy=accuracy,
            osm_rows=len(extra),
            temperature=temperature,
            evaluation=evaluation,
            settings=asdict(settings),
            train_seconds=round(time.time() - started, 1),
            classifier=settings.classifier,
            excluded_as_mislabelled=len(extra) - len(trainable_extra),
            ensemble_weight=pipeline.weight if isinstance(pipeline, LinearDeepEnsemble) else None,
            descriptions={c: permitted.descriptions.get(c, "") for c in sorted({c for _, c, _ in everything})},
            examples=_examples_by_class(real, synthetic, trainable_extra),
            teacher_rows=len(teacher),
            training_quality=training_quality,
            deep=None
            if deep_member is None
            else {
                "architecture": "character CNN (Kim 2014; Zhang et al. 2015)",
                "transferred_from": "store model" if source is not None else None,
                "parameters": deep_member.parameter_count,
                "epochs_run": len(deep_member.history_),
                "best_epoch": deep_member.best_epoch_,
                "history": (_deep_member(probe) or deep_member).history_,
            },
        )
        return cls(kind, pipeline, report)

    # ── prediction ─────────────────────────────────────────────────────────
    def probabilities(self, text: str) -> np.ndarray:
        """Calibrated probabilities for one text, in `self.pipeline.classes_` order."""
        scores = self._name_scores(text)
        return np.array([scores.get(c, 0.0) for c in self.pipeline.classes_]) if scores else np.full(
            len(self.pipeline.classes_), 1.0 / len(self.pipeline.classes_)
        )

    def _name_scores(self, text: str) -> dict[str, float]:
        cleaned = normalize(text)
        if not cleaned:
            return {}
        cached = self._recent.get(cleaned)
        if cached is not None:
            return dict(cached)
        proba = self.pipeline.predict_proba([cleaned])
        if self.temperature != 1.0:
            from .evaluation import apply_temperature

            proba = apply_temperature(proba, self.temperature)
        proba = proba[0]
        classes = list(self.pipeline.classes_)
        scores = {cls_name: float(p) for cls_name, p in zip(classes, proba)}
        if len(self._recent) >= 512:
            self._recent.clear()
        self._recent[cleaned] = scores
        return dict(scores)

    def predict(
        self,
        text: str,
        google_types: Sequence[str] | None = None,
        min_confidence: float = DEFAULT_MIN_CONFIDENCE,
        second_opinion: SecondOpinion | None = None,
    ) -> dict:
        """
        The category for one shop or item, or None when nothing is confident.

        Returns the runner-up as well. A dispatcher shown "Supermarket &
        Grocery (62%), or Retail (31%)" can correct it in one glance; one shown
        only the winner has to open the whole list to find out what else it
        nearly was.

        `second_opinion` is Gemma's answer for the same name, when the service
        asked for one; it is pooled in after Google's types (pool_second_opinion).
        """
        scores = self._name_scores(text)
        if not scores:
            return {
                "category": None,
                "confidence": 0.0,
                "source": "empty",
                "alternatives": [],
                "reason": "No usable text to read.",
            }

        google_category, google_weight = category_from_google_types(
            google_types, available=scores.keys()
        )
        source = "name"
        reason = "Matched the shop name against the catalogue and the local lexicon."

        if google_category and google_weight > 0:
            # A weighted blend rather than an override. Google is usually right
            # and occasionally confidently wrong — it files plenty of Philippine
            # carinderias as a generic "store" — so its vote is strong but the
            # name still gets to disagree with it.
            blended = {
                cat: (1.0 - google_weight) * score
                + google_weight * (1.0 if cat == google_category else 0.0)
                for cat, score in scores.items()
            }
            total = sum(blended.values()) or 1.0
            scores = {cat: value / total for cat, value in blended.items()}
            source = "google+name"
            reason = (
                "Google's place type and the shop name agree."
                if max(scores, key=scores.get) == google_category
                else "The shop name disagreed with Google's place type; the name won."
            )

        if second_opinion is not None and second_opinion.category in scores and second_opinion.weight > 0:
            ours = max(scores, key=scores.get)
            scores = pool_second_opinion(scores, second_opinion)
            source = f"{source}+{second_opinion.source}"
            pooled = max(scores, key=scores.get)
            if second_opinion.category == ours:
                reason = f"{reason} {second_opinion.label} agrees."
            elif pooled == second_opinion.category:
                reason = f"{second_opinion.label} recognised this as {second_opinion.category}; the local model was unsure."
            else:
                reason = f"{reason} {second_opinion.label} suggested {second_opinion.category}, less surely."

        ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
        top_category, top_score = ranked[0]

        if top_score < min_confidence:
            return {
                "category": None,
                "confidence": round(top_score, 4),
                "source": source,
                "alternatives": [
                    {"category": c, "confidence": round(s, 4)} for c, s in ranked[:3]
                ],
                "reason": (
                    "Too close to call between "
                    f"{ranked[0][0]} and {ranked[1][0]}. Left for the dispatcher."
                ),
            }

        return {
            "category": top_category,
            "confidence": round(top_score, 4),
            "strong": top_score >= STRONG_CONFIDENCE,
            "needsReview": top_score < REVIEW_CONFIDENCE_THRESHOLD,
            "source": source,
            "alternatives": [
                {"category": c, "confidence": round(s, 4)} for c, s in ranked[1:3]
            ],
            "reason": reason,
        }

    # ── persistence ────────────────────────────────────────────────────────
    def save(self, directory: Path) -> None:
        directory.mkdir(parents=True, exist_ok=True)
        joblib.dump(self.pipeline, directory / f"{self.kind}.joblib")
        (directory / f"{self.kind}.report.json").write_text(
            json.dumps({"version": MODEL_VERSION, **asdict(self.report)}, indent=2),
            encoding="utf-8",
        )

    @classmethod
    def load(cls, directory: Path, kind: str) -> "CategoryModel":
        pipeline = joblib.load(directory / f"{kind}.joblib")
        raw = json.loads((directory / f"{kind}.report.json").read_text(encoding="utf-8"))
        raw.pop("version", None)
        known = {f.name for f in fields(TrainingReport)}
        return cls(kind, pipeline, TrainingReport(**{k: v for k, v in raw.items() if k in known}))
