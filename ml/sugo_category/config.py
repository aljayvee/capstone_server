"""
The shipped training settings for both category models.

Chosen on validation data in category/EXPERIMENTS.md (sugo_category.experiments),
never on the test rows, which are read once to report the result. Change a value
here and rerun the experiments; the report says what each alternative scored.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ModelSettings:
    # "logistic": scikit-learn's LogisticRegression (L-BFGS, full batch).
    # "neural": sugo_category.neural, the backpropagation network.
    classifier: str = "logistic"
    C: float = 4.0  # logistic: inverse L2 strength

    # neural only
    hidden: tuple[int, ...] = ()
    activation: str = "relu"
    optimizer: str = "adam"
    learning_rate: float = 0.003
    batch_size: int = 256
    epochs: int = 40
    l2: float = 1e-6
    dropout: float = 0.0
    patience: int = 3

    # Features: an n-gram must appear in this many names to become a column.
    # 2 drops one-off spellings, which the model cannot learn from anyway.
    min_df: int = 1

    # How much one row of each source counts.
    seed_weight: float = 1.0  # a lexicon phrase
    osm_weight: float = 1.0  # an OpenStreetMap shop name and its mapper's tag
    real_weight: float = 6.0  # an owner's catalogue entry or a dispatcher's choice
    # A name Gemma 4 filed with confidence >= 0.9 (sugo_category.gemma):
    # surer than a seed phrase, never as sure as a person who saw the errand.
    teacher_weight: float = 2.0

    # Temperature scaling on held-out names, so 0.55 and 0.75 mean what they say.
    calibrate: bool = True
    seed: int = 7

    # The deep model (sugo_category.deep.CharCNNClassifier), used when
    # `classifier` is "charcnn" (the network alone) or "ensemble" (the network
    # and the logistic regression, averaged with a weight chosen on validation).
    cnn_embed_dim: int = 32
    cnn_widths: tuple[int, ...] = (2, 3, 4, 5, 6)
    cnn_filters: int = 32
    cnn_hidden: int = 128
    cnn_dropout: float = 0.3
    cnn_epochs: int = 12
    cnn_batch_size: int = 128
    cnn_learning_rate: float = 2e-3
    cnn_weight_decay: float = 1e-4
    cnn_label_smoothing: float = 0.05
    cnn_augment: float = 0.15
    cnn_patience: int = 3
    # Stop starting new epochs after this many seconds of training. The
    # container retrains itself; a budget keeps a busy night from running on.
    cnn_max_seconds: float | None = None
    # After early stopping has chosen the epoch count, train again on every
    # row for that many epochs. Right for small data, where the validation
    # phrases are lexicon entries the shipped model must also know.
    cnn_refit: bool = True
    # Start the network from the store model's (transfer learning, see
    # sugo_category.deep). Only the item model can: the store model trains first.
    cnn_transfer_from_store: bool = False
    cnn_pretrained_lr_scale: float = 0.3


# The shipped choices are measured in category/DEEP_LEARNING.md
# (sugo_category.deep_report): the logistic regression and the CharCNN,
# averaged with a weight chosen on validation names.
#
# Stores: 85,000 map names are plenty, so the early-stopped network ships
# rather than being trained a second time, and a 20-minute cap keeps the
# container's own nightly retrain bounded.
STORE = ModelSettings(min_df=2, classifier="ensemble", cnn_refit=False, cnn_max_seconds=1200)

# Items have no OpenStreetMap equivalent (maps list shops, not what they sell),
# so this model learns from the lexicon and production's own rows only: about
# 700 phrases. Too few to train a network from nothing, so its network starts
# from the store model's (transfer learning) and is refitted on every phrase.
ITEM = ModelSettings(classifier="ensemble", cnn_transfer_from_store=True)

SETTINGS = {"store": STORE, "item": ITEM}
