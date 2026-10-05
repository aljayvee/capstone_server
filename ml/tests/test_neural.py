"""
The backpropagation network in sugo_category/neural.py.

The gradient checks are the ones that matter: every other test here would still
pass on a network whose gradients were slightly wrong, because a wrong gradient
still usually lowers the loss a little. Numerical differentiation does not care.
"""

from __future__ import annotations

import pickle

import numpy as np
import pytest
import scipy.sparse as sp

from sugo_category.neural import ACTIVATIONS, OPTIMIZERS, NeuralClassifier, activate, slope

GATES_X = np.array([[0, 0], [0, 1], [1, 0], [1, 1]], dtype=float)
AND = np.array([0, 0, 0, 1])
OR = np.array([0, 1, 1, 1])
XOR = np.array([0, 1, 1, 0])


def _numerical_check(net: NeuralClassifier, X, Y, w, eps=1e-5) -> float:
    """Largest relative error between backprop and central differences."""
    _, grads, rows = net.loss_and_gradients(X, Y, w)
    worst = 0.0
    for li, (W, b) in enumerate(net.layers_):
        for param, analytic, param_rows in ((W, grads[li][0], rows if li == 0 else None), (b, grads[li][1], None)):
            flat_rows = range(param.shape[0]) if param_rows is None else param_rows
            for r_pos, r in enumerate(flat_rows):
                cols = range(param.shape[1]) if param.ndim == 2 else [None]
                for c in cols:
                    index = (r, c) if c is not None else (r,)
                    old = param[index]
                    param[index] = old + eps
                    up, _, _ = net.loss_and_gradients(X, Y, w)
                    param[index] = old - eps
                    down, _, _ = net.loss_and_gradients(X, Y, w)
                    param[index] = old
                    numeric = (up - down) / (2 * eps)
                    a_index = (r_pos, c) if (c is not None and param_rows is not None) else index
                    got = analytic[a_index]
                    worst = max(worst, abs(numeric - got) / max(1e-6, abs(numeric) + abs(got)))
    return worst


def _tiny_net(activation: str, hidden=(4, 3), l2=0.01, n_in=5, k=3) -> NeuralClassifier:
    net = NeuralClassifier(hidden=hidden, activation=activation, l2=l2, dtype="float64", seed=3)
    net.classes_ = np.arange(k)
    rng = np.random.default_rng(1)
    net._init_layers(rng.normal(size=(6, n_in)), k, rng)
    # Move biases off zero so a ReLU kink is not sitting exactly on a probe.
    for layer in net.layers_:
        layer[1] += rng.normal(scale=0.3, size=layer[1].shape)
    return net


@pytest.mark.parametrize("activation", ACTIVATIONS)
def test_backprop_matches_numerical_gradients_dense(activation):
    rng = np.random.default_rng(5)
    X = rng.normal(size=(6, 5))
    Y = np.eye(3)[rng.integers(0, 3, size=6)]
    w = rng.uniform(0.5, 2.0, size=6)
    net = _tiny_net(activation)
    assert _numerical_check(net, X, Y, w) < 1e-5


@pytest.mark.parametrize("activation", ACTIVATIONS)
def test_backprop_matches_numerical_gradients_sparse_first_layer(activation):
    # Column 2 is empty in this batch, so its row must be absent from the
    # gradient and every other row must still be exact.
    rng = np.random.default_rng(9)
    dense = rng.normal(size=(6, 5))
    dense[:, 2] = 0.0
    dense[rng.random(size=dense.shape) < 0.3] = 0.0
    X = sp.csr_matrix(dense)
    Y = np.eye(3)[rng.integers(0, 3, size=6)]
    w = np.ones(6)
    net = _tiny_net(activation)
    _, _, rows = net.loss_and_gradients(X, Y, w)
    assert 2 not in set(rows.tolist())
    # L2 is applied lazily to present rows only, so compare without it here.
    net.l2 = 0.0
    assert _numerical_check(net, X, Y, w) < 1e-5


def test_backprop_without_hidden_layer_is_softmax_regression():
    rng = np.random.default_rng(2)
    X = rng.normal(size=(6, 4))
    Y = np.eye(3)[rng.integers(0, 3, size=6)]
    net = _tiny_net("relu", hidden=(), n_in=4)
    assert len(net.layers_) == 1
    assert _numerical_check(net, X, Y, np.ones(6)) < 1e-5


@pytest.mark.parametrize("activation", ACTIVATIONS)
def test_slope_is_the_derivative_of_the_activation(activation):
    z = np.linspace(-3, 3, 13) + 0.05  # avoid the ReLU kink at exactly 0
    eps = 1e-6
    numeric = (activate(activation, z + eps) - activate(activation, z - eps)) / (2 * eps)
    assert np.allclose(slope(activation, z, activate(activation, z)), numeric, atol=1e-5)


def _gate(target, hidden, seed=0, activation="tanh") -> float:
    net = NeuralClassifier(
        hidden=hidden, activation=activation, optimizer="adam", learning_rate=0.1,
        batch_size=4, epochs=800, l2=0.0, patience=0, validation_fraction=0.0,
        clip_norm=0.0, class_weight=None, seed=seed, dtype="float64",
    )
    net.fit(GATES_X, target)
    return float(np.mean(net.predict(GATES_X) == target))


def test_one_neuron_learns_and_and_or_but_not_xor():
    assert _gate(AND, hidden=()) == 1.0
    assert _gate(OR, hidden=()) == 1.0
    # A single linear boundary can get at most 3 of the 4 XOR rows right.
    assert _gate(XOR, hidden=()) <= 0.75


def test_three_neurons_learn_xor():
    # Two hidden neurons and an output, the smallest network that can. Not
    # every start finds it (see EXPERIMENTS.md), so at least one of five must.
    assert max(_gate(XOR, hidden=(2,), seed=s) for s in range(5)) == 1.0


@pytest.mark.parametrize("optimizer", OPTIMIZERS)
def test_every_optimizer_lowers_the_loss(optimizer):
    rng = np.random.default_rng(4)
    X = rng.normal(size=(120, 6))
    y = (X[:, 0] + X[:, 1] > 0).astype(int) + (X[:, 2] > 1).astype(int)
    net = NeuralClassifier(
        hidden=(8,), optimizer=optimizer, learning_rate=0.05 if optimizer in ("sgd", "momentum") else 0.01,
        epochs=15, batch_size=16, patience=0, validation_fraction=0.0, track_training=True,
        class_weight=None, dtype="float64",
    )
    net.fit(X, y)
    losses = [h["train_loss"] for h in net.history_]
    assert losses[-1] < losses[0] * 0.8


def test_divergence_is_reported_not_hidden():
    rng = np.random.default_rng(4)
    X = rng.normal(size=(60, 4)) * 50
    y = (X[:, 0] > 0).astype(int)
    net = NeuralClassifier(
        hidden=(16,), optimizer="sgd", learning_rate=1e25, epochs=20, clip_norm=0.0,
        patience=0, validation_fraction=0.0, activation="relu",
    )
    with np.errstate(all="ignore"):
        net.fit(X, y)
    assert net.diverged_
    assert len(net.history_) < 20


def test_training_is_deterministic_for_a_seed():
    rng = np.random.default_rng(4)
    X = sp.random(80, 30, density=0.2, random_state=1, format="csr")
    y = rng.integers(0, 3, size=80)
    a = NeuralClassifier(hidden=(5,), epochs=5, seed=11).fit(X, y)
    b = NeuralClassifier(hidden=(5,), epochs=5, seed=11).fit(X, y)
    assert np.array_equal(a.predict_proba(X), b.predict_proba(X))


def test_dropout_only_applies_while_training():
    rng = np.random.default_rng(4)
    X = rng.normal(size=(40, 5))
    y = (X[:, 0] > 0).astype(int)
    net = NeuralClassifier(hidden=(16,), dropout=0.5, epochs=3, patience=0, validation_fraction=0.0).fit(X, y)
    assert np.array_equal(net.predict_proba(X), net.predict_proba(X))


def test_early_stopping_restores_the_best_epoch():
    rng = np.random.default_rng(0)
    # Pure noise labels: validation loss can only get worse as it memorises.
    X = rng.normal(size=(200, 40))
    y = rng.integers(0, 2, size=200)
    Xv = rng.normal(size=(100, 40))
    yv = rng.integers(0, 2, size=100)
    net = NeuralClassifier(
        hidden=(64,), learning_rate=0.01, epochs=60, patience=5, l2=0.0,
        class_weight=None, dtype="float64",
    ).fit(X, y, eval_set=(Xv, yv))
    assert net.stopped_early_
    best = min(h["val_loss"] for h in net.history_)
    P = net.predict_proba(Xv)
    restored = float(-np.mean(np.log(P[np.arange(100), yv])))
    assert restored == pytest.approx(best, rel=1e-6)


def test_l2_shrinks_the_weights():
    rng = np.random.default_rng(3)
    X = rng.normal(size=(150, 10))
    y = (X[:, 0] > 0).astype(int)
    kwargs = dict(hidden=(12,), epochs=30, patience=0, validation_fraction=0.0, dtype="float64")
    free = NeuralClassifier(l2=0.0, **kwargs).fit(X, y)
    decayed = NeuralClassifier(l2=0.05, **kwargs).fit(X, y)
    norm = lambda n: sum(float(np.sum(W * W)) for W, _ in n.layers_)  # noqa: E731
    assert norm(decayed) < norm(free)


def test_pickles_and_keeps_its_answers():
    rng = np.random.default_rng(4)
    X = sp.random(50, 20, density=0.3, random_state=2, format="csr")
    y = np.array(["food", "drug"])[rng.integers(0, 2, size=50)]
    net = NeuralClassifier(hidden=(4,), epochs=3).fit(X, y)
    clone = pickle.loads(pickle.dumps(net))
    assert np.array_equal(clone.predict_proba(X), net.predict_proba(X))
    assert set(clone.predict(X)) <= {"food", "drug"}


def test_sample_weights_change_what_it_learns():
    # Identical inputs, conflicting labels: the weights decide the answer.
    X = np.zeros((20, 3))
    y = np.array([0] * 10 + [1] * 10)
    w = np.array([5.0] * 10 + [1.0] * 10)
    net = NeuralClassifier(
        hidden=(), epochs=200, learning_rate=0.05, patience=0, validation_fraction=0.0,
        class_weight=None, dtype="float64",
    ).fit(X, y, sample_weight=w)
    assert net.predict_proba(X[:1])[0, 0] == pytest.approx(5 / 6, abs=0.02)
