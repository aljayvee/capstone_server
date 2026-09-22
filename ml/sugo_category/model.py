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
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Iterable, Sequence

import joblib
import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import FeatureUnion, Pipeline

from .lexicon import CATEGORIES, FOOD, GROCERY, PHARMACY, RETAIL, synthetic_rows

# A real row — a place an owner catalogued, or a category a dispatcher chose on
# a live errand — is worth this many seed phrases. Seed knowledge is a floor,
# not an opinion to be defended: where Tacurong's actual data disagrees with the
# lexicon, the data is right and the lexicon is out of date.
SYNTHETIC_ROW_WEIGHT = 1.0
REAL_ROW_WEIGHT = 6.0

# Below this, the service returns no category at all and the pin keeps its amber
# "Category needed" mark. Chosen so that the model has to be roughly two-to-one
# on its favourite before it speaks: at four classes, chance is 0.25, and a
# top-class probability under 0.55 in practice means two categories are close
# enough that a dispatcher's glance is worth more than the guess.
DEFAULT_MIN_CONFIDENCE = 0.55

# Above this the answer is treated as strong enough to be worth showing as the
# model's own rather than as a coin-flip — it does not auto-confirm anything,
# it only selects the wording the panel uses.
STRONG_CONFIDENCE = 0.80

MODEL_VERSION = 2


# ── Google Places types ────────────────────────────────────────────────────
#
# Mirrors GOOGLE_TYPE_TO_CATEGORY in the web app's storeCategoryInference.ts.
# Order matters: a Jollibee comes back as
# ["restaurant","food","point_of_interest","establishment"], so the specific
# types must be consulted before the generic tail, or the bare "store" entry
# wins and files every restaurant under Retail.
GOOGLE_TYPE_RULES: list[tuple[str, tuple[str, ...]]] = [
    (PHARMACY, ("pharmacy", "drugstore", "doctor", "hospital", "dentist",
                "physiotherapist", "health", "veterinary_care")),
    (GROCERY, ("supermarket", "grocery_or_supermarket", "grocery_store",
               "convenience_store", "liquor_store", "market")),
    (FOOD, ("restaurant", "meal_takeaway", "meal_delivery", "cafe", "bakery",
            "bar", "food")),
    (RETAIL, ("department_store", "clothing_store", "hardware_store",
              "electronics_store", "home_goods_store", "furniture_store",
              "shoe_store", "book_store", "pet_store", "shopping_mall",
              "florist", "bicycle_store", "car_repair", "store")),
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


def category_from_google_types(types: Sequence[str] | None) -> tuple[str | None, float]:
    """The category Google's types imply, and how much that is worth."""
    if not types:
        return None, 0.0
    present = {str(t).strip().lower() for t in types if t}
    if not present:
        return None, 0.0

    for category, rule_types in GOOGLE_TYPE_RULES:
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


def _build_pipeline() -> Pipeline:
    """Word n-grams for the phrases, character n-grams for the misspellings."""
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
                                min_df=1,
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
                                min_df=1,
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
                                min_df=1,
                                preprocessor=squash,
                            ),
                        ),
                    ]
                ),
            ),
            (
                "clf",
                LogisticRegression(
                    max_iter=2000,
                    # Multinomial with balanced weights: the catalogue is not
                    # evenly split across the four categories, and without this
                    # the largest category absorbs every uncertain name.
                    class_weight="balanced",
                    C=4.0,
                ),
            ),
        ]
    )


@dataclass
class TrainingReport:
    kind: str
    rows: int
    real_rows: int
    synthetic_rows: int
    classes: list[str]
    holdout_accuracy: float | None


class CategoryModel:
    """One trained classifier plus the metadata needed to explain an answer."""

    def __init__(self, kind: str, pipeline: Pipeline, report: TrainingReport):
        self.kind = kind
        self.pipeline = pipeline
        self.report = report

    # ── training ───────────────────────────────────────────────────────────
    @classmethod
    def train(
        cls,
        kind: str,
        real_rows: Iterable[tuple[str, str]],
        holdout: bool = True,
    ) -> "CategoryModel":
        """
        `real_rows` are `(text, category)` pairs read from the database.
        Seed phrases for this `kind` are always mixed in underneath them.
        """
        seeds = [(text, cat) for text, cat, row_kind in synthetic_rows() if row_kind == kind]

        real = [
            (normalize(text), cat)
            for text, cat in real_rows
            if text and cat in CATEGORIES and normalize(text)
        ]
        synthetic = [(normalize(text), cat) for text, cat in seeds]

        texts = [t for t, _ in synthetic + real]
        labels = [c for _, c in synthetic + real]
        weights = np.array(
            [SYNTHETIC_ROW_WEIGHT] * len(synthetic) + [REAL_ROW_WEIGHT] * len(real)
        )

        if len(set(labels)) < 2:
            raise ValueError(
                f"{kind}: need at least two categories to train, got {sorted(set(labels))}"
            )

        accuracy: float | None = None
        if holdout and len(real) >= 40:
            # Held out from the REAL rows only. Scoring against seed phrases
            # would measure whether the model memorised the lexicon, which is
            # not a question anyone needs answered.
            rng = np.random.default_rng(20260923)
            order = rng.permutation(len(real))
            cut = max(1, len(real) // 5)
            test_idx = set(order[:cut].tolist())

            train_pairs = synthetic + [r for i, r in enumerate(real) if i not in test_idx]
            test_pairs = [r for i, r in enumerate(real) if i in test_idx]
            train_weights = np.array(
                [SYNTHETIC_ROW_WEIGHT] * len(synthetic)
                + [REAL_ROW_WEIGHT] * (len(real) - len(test_idx))
            )

            probe = _build_pipeline()
            probe.fit(
                [t for t, _ in train_pairs],
                [c for _, c in train_pairs],
                clf__sample_weight=train_weights,
            )
            predicted = probe.predict([t for t, _ in test_pairs])
            actual = [c for _, c in test_pairs]
            accuracy = float(np.mean([p == a for p, a in zip(predicted, actual)]))

        pipeline = _build_pipeline()
        pipeline.fit(texts, labels, clf__sample_weight=weights)

        report = TrainingReport(
            kind=kind,
            rows=len(texts),
            real_rows=len(real),
            synthetic_rows=len(synthetic),
            classes=sorted(set(labels)),
            holdout_accuracy=accuracy,
        )
        return cls(kind, pipeline, report)

    # ── prediction ─────────────────────────────────────────────────────────
    def _name_scores(self, text: str) -> dict[str, float]:
        cleaned = normalize(text)
        if not cleaned:
            return {}
        proba = self.pipeline.predict_proba([cleaned])[0]
        classes = list(self.pipeline.named_steps["clf"].classes_)
        return {cls_name: float(p) for cls_name, p in zip(classes, proba)}

    def predict(
        self,
        text: str,
        google_types: Sequence[str] | None = None,
        min_confidence: float = DEFAULT_MIN_CONFIDENCE,
    ) -> dict:
        """
        The category for one shop or item, or None when nothing is confident.

        Returns the runner-up as well. A dispatcher shown "Supermarket &
        Grocery (62%), or Retail (31%)" can correct it in one glance; one shown
        only the winner has to open the whole list to find out what else it
        nearly was.
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

        google_category, google_weight = category_from_google_types(google_types)
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
        return cls(kind, pipeline, TrainingReport(**raw))
