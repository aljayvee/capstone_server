"""
The CharCNN (sugo_category.deep): its gradients, that it learns, and that it
generalises from fragments to names it never saw.
"""

from __future__ import annotations

import pickle

import numpy as np
import pytest

from sugo_category.deep import CharCNNClassifier, LinearDeepEnsemble, _augment, choose_ensemble_weight


def _tiny(**overrides) -> CharCNNClassifier:
    settings = dict(
        embed_dim=5, widths=(2, 3), filters=4, hidden=6, dropout=0.0, max_len=12,
        label_smoothing=0.1, augment=0.0, seed=3,
    )
    settings.update(overrides)
    return CharCNNClassifier(**settings)


def _setup(model: CharCNNClassifier, texts, labels):
    model.classes_ = np.array(sorted(set(labels)))
    model._build_vocab(texts)
    rng = np.random.default_rng(0)
    params = model._init_params(len(model.vocab_) + 2, len(model.classes_), rng)
    # float64 for the check: float32 rounding would swamp a 1e-6 difference.
    params = {k: v.astype(np.float64) for k, v in params.items()}
    ids, lengths = model._encode(texts)
    index = {c: i for i, c in enumerate(model.classes_)}
    y = np.array([index[c] for c in labels])
    weights = np.array([1.0, 2.0, 0.5, 1.5][: len(texts)])
    return params, ids, lengths, y, weights


@pytest.mark.parametrize("hidden", [6, 0])
def test_every_gradient_matches_a_numerical_derivative(hidden):
    texts = ["pandesal", "jollibee", "ube", "bakeshop"]
    labels = ["bakery", "food", "bakery", "bakery"]
    model = _tiny(hidden=hidden)
    params, ids, lengths, y, weights = _setup(model, texts, labels)

    def loss_of(p):
        logits, _ = model._forward(p, ids, lengths, None)
        return model._loss_and_dlogits(logits, y, weights)[0]

    logits, cache = model._forward(params, ids, lengths, None)
    _, dlogits = model._loss_and_dlogits(logits, y, weights)
    grads = model._backward(params, cache, dlogits.astype(np.float64))

    eps = 1e-6
    rng = np.random.default_rng(1)
    for name, value in params.items():
        # A sample of entries per parameter; every entry of the small ones.
        flat_indices = rng.choice(value.size, size=min(value.size, 12), replace=False)
        for flat in flat_indices:
            idx = np.unravel_index(flat, value.shape)
            if name == "E" and idx[0] == 0:
                continue  # padding row is frozen at zero
            original = value[idx]
            value[idx] = original + eps
            up = loss_of(params)
            value[idx] = original - eps
            down = loss_of(params)
            value[idx] = original
            numeric = (up - down) / (2 * eps)
            assert grads[name][idx] == pytest.approx(numeric, rel=1e-4, abs=1e-7), (name, idx)


def test_padding_never_changes_the_answer():
    model = _tiny()
    texts = ["pandesal", "jollibee"]
    params, _, _, _, _ = _setup(model, texts, ["bakery", "food"])
    alone, _ = model._forward(params, *model._encode(["ube"]), None)
    # The same name in a batch padded out to a much longer neighbour.
    together, _ = model._forward(params, *model._encode(["ube", "a very long shop name indeed"]), None)
    np.testing.assert_allclose(alone[0], together[0], rtol=1e-6)


def test_it_learns_and_generalises_from_fragments():
    # Bakery words and food words, then names it never saw that share fragments.
    bakery = ["pandesal", "spanish bread", "bakeshop", "panaderia", "ube pandesal", "cheese bread",
              "julies bakeshop", "tuna bread", "pan de coco", "bakery", "garlic bread", "raisin bread"]
    food = ["chickenjoy", "burger", "fried chicken", "spaghetti meal", "jollibee", "chicken wings",
            "cheeseburger", "rice meal", "burger steak", "chicken inasal", "pork sisig", "beef tapa"]
    texts, labels = bakery + food, ["Bakery"] * len(bakery) + ["Food"] * len(food)
    model = CharCNNClassifier(
        embed_dim=16, filters=24, hidden=32, epochs=60, batch_size=8, dropout=0.1,
        learning_rate=5e-3, augment=0.1, seed=11,
    ).fit(texts, labels)

    assert np.mean(model.predict(texts) == np.array(labels)) == 1.0
    unseen = model.predict(["banana bread", "pandesal ube", "chicken burger", "tacurong bakeshop"])
    assert list(unseen) == ["Bakery", "Bakery", "Food", "Bakery"]
    assert model.history_[-1]["train_loss"] < model.history_[0]["train_loss"]


def test_early_stopping_keeps_the_best_epoch():
    texts = ["pandesal", "bakeshop", "burger", "chickenjoy"] * 5
    labels = ["Bakery", "Bakery", "Food", "Food"] * 5
    model = _tiny(epochs=30, patience=2, dropout=0.0, learning_rate=0.02).fit(
        texts, labels, eval_set=(["panaderia", "cheeseburger"], ["Bakery", "Food"])
    )
    losses = [h["val_loss"] for h in model.history_]
    assert model.best_epoch_ == int(np.argmin(losses)) + 1
    assert len(model.history_) <= 30


def test_unknown_characters_and_empty_names_do_not_break_it():
    model = _tiny(epochs=2).fit(["pandesal", "burger"], ["Bakery", "Food"])
    proba = model.predict_proba(["ñ¿€ unseen", "", "x"])
    assert proba.shape == (3, 2)
    np.testing.assert_allclose(proba.sum(axis=1), 1.0)


def test_it_survives_pickling():
    model = _tiny(epochs=2).fit(["pandesal", "burger"], ["Bakery", "Food"])
    clone = pickle.loads(pickle.dumps(model))
    np.testing.assert_allclose(clone.predict_proba(["pan"]), model.predict_proba(["pan"]))


def test_augmentation_makes_one_realistic_slip():
    rng = np.random.default_rng(0)
    for _ in range(50):
        slipped = _augment("spanish bread", rng)
        assert abs(len(slipped) - len("spanish bread")) <= 1
    assert _augment("ube", rng) == "ube"


class _Fixed:
    def __init__(self, classes, proba):
        self.classes_ = np.array(classes)
        self._proba = np.array(proba, dtype=float)

    def predict_proba(self, texts):
        return np.repeat(self._proba[None, :], len(list(texts)), axis=0)


def test_ensemble_aligns_class_orders_and_weights_its_members():
    linear = _Fixed(["Bakery", "Food"], [0.2, 0.8])
    deep = _Fixed(["Bakery", "Food", "Pharmacy"], [0.9, 0.05, 0.05])
    ensemble = LinearDeepEnsemble(linear, deep, weight=0.5)
    assert list(ensemble.classes_) == ["Bakery", "Food", "Pharmacy"]
    np.testing.assert_allclose(ensemble.predict_proba(["x"])[0], [0.55, 0.425, 0.025])


def test_ensemble_weight_is_chosen_by_validation_loss():
    y = np.array([0, 0, 1])
    good = np.array([[0.9, 0.1], [0.8, 0.2], [0.2, 0.8]])
    bad = np.array([[0.2, 0.8], [0.3, 0.7], [0.7, 0.3]])
    assert choose_ensemble_weight(good, bad, y) == 1.0
    assert choose_ensemble_weight(bad, good, y) == 0.0


def test_the_pipeline_trains_ships_and_reloads_an_ensemble_with_transfer(tmp_path):
    """End to end through CategoryModel: store ensemble, then an item ensemble started from its network."""
    from dataclasses import replace

    from sugo_category.config import ITEM, STORE
    from sugo_category.evaluation import PRODUCTION_CATEGORIES
    from sugo_category.lexicon import CATEGORIES
    from sugo_category.model import CategoryModel, _deep_member

    allowed = set(PRODUCTION_CATEGORIES) | set(CATEGORIES)
    # A small stand-in for the map names: enough for a split, quick to train.
    shops = [(f"{w} {i}", c) for i in range(40) for w, c in [
        ("Tacurong Bakeshop", "Bakery"), ("Panaderia", "Bakery"), ("Jollibee", "Fast Food & Restaurant"),
        ("Carinderia", "Fast Food & Restaurant"), ("Mercury Drug", "Pharmacy & Health"), ("Botika", "Pharmacy & Health"),
    ]]
    quick = dict(cnn_epochs=2, cnn_filters=8, cnn_hidden=16, cnn_widths=(2, 3))
    store = CategoryModel.train("store", [], allowed=allowed, extra_rows=shops, settings=replace(STORE, **quick))
    assert store.report.classifier == "ensemble"
    assert 0.0 <= store.report.ensemble_weight <= 1.0
    assert store.report.deep["epochs_run"] >= 1

    item = CategoryModel.train(
        "item", [("pandesal", "Bakery")] * 3, allowed=allowed, pretrained=store, settings=replace(ITEM, **quick)
    )
    assert item.report.deep["transferred_from"] == "store model"
    assert _deep_member(item.pipeline).pretrained is None  # the store network is not saved inside it

    item.save(tmp_path)
    reloaded = CategoryModel.load(tmp_path, "item")
    assert reloaded.predict("Pandesal", min_confidence=0)["category"] == item.predict("Pandesal", min_confidence=0)["category"]
    assert reloaded.predict("Spanish bread")["category"] == "Bakery"
