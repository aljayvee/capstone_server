"""
A feed-forward neural network trained by backpropagation, written out in numpy.

The same algorithm as the API server's src/services/patterns/neuralNetwork.ts
(the Conflict Management reason model), rebuilt for this service's input: a
TF-IDF vector with a few hundred thousand columns of which one shop name lights
up about sixty. Written out rather than taken from a library so every step of
the learning can be shown, tested against numerical gradients, and changed.

What it does:

  - Any number of hidden layers, including none. With no hidden layer it is
    softmax regression: one neuron per category, the same model family as the
    logistic regression this service shipped with.
  - Hidden activations: sigmoid, tanh, ReLU, leaky ReLU. Softmax output with
    cross-entropy loss, weighted per row.
  - Gradient descent in four forms: plain SGD, momentum, RMSProp and Adam, over
    mini-batches of any size (the whole set is batch gradient descent, 1 is
    stochastic), with learning-rate decay and global-norm gradient clipping.
  - Overfitting defences: L2 weight decay, inverted dropout on hidden layers,
    early stopping on a validation set with the best epoch restored.

Two changes to textbook backpropagation, both forced by sparse text input:

  1. Sparse first layer. The gradient of the first weight matrix is X^T @ delta,
     and X is almost all zeros, so only the rows for n-grams present in the
     batch are computed and updated ("lazy" updates: an absent n-gram's weights
     and optimiser state wait untouched, and its L2 decay is applied when it
     next appears). Updating the full matrix every step would make an epoch
     over 60,000 names take minutes instead of seconds, and change nothing:
     an absent n-gram's gradient is exactly zero.
  2. Initialisation by input energy, not column count. He and Glorot set the
     weight variance from fan-in because they assume every input is on. Here
     fan-in is 300,000 but a row carries ~60 non-zeros, so fan-in scaling
     starts every neuron at almost exactly zero and the first epochs are
     wasted. The variance of a pre-activation is E[||x||^2] * Var(w), so the
     first layer's variance is set from the measured mean squared row norm.
     On dense inputs with unit-variance features that is fan-in again.
"""

from __future__ import annotations

import time

import numpy as np
import scipy.sparse as sp
from sklearn.base import BaseEstimator, ClassifierMixin

ACTIVATIONS = ("sigmoid", "tanh", "relu", "leaky_relu")
OPTIMIZERS = ("sgd", "momentum", "rmsprop", "adam")
LEAK = 0.01
MOMENTUM = 0.9
RMS_DECAY = 0.9
ADAM_B1, ADAM_B2 = 0.9, 0.999
EPS = 1e-8


def activate(name: str, z: np.ndarray) -> np.ndarray:
    if name == "sigmoid":
        # 0.5 * (1 + tanh(z / 2)) is the logistic function without exp(-z)
        # overflowing for large negative z.
        return 0.5 * (1.0 + np.tanh(0.5 * z))
    if name == "tanh":
        return np.tanh(z)
    if name == "relu":
        return np.maximum(z, 0.0)
    if name == "leaky_relu":
        return np.where(z > 0, z, LEAK * z)
    raise ValueError(f"unknown activation {name!r}")


def slope(name: str, z: np.ndarray, a: np.ndarray) -> np.ndarray:
    """d activation / dz, from the pre-activation z and the activation a."""
    if name == "sigmoid":
        return a * (1.0 - a)
    if name == "tanh":
        return 1.0 - a * a
    if name == "relu":
        return (z > 0).astype(z.dtype)
    if name == "leaky_relu":
        return np.where(z > 0, 1.0, LEAK).astype(z.dtype)
    raise ValueError(f"unknown activation {name!r}")


def softmax(z: np.ndarray) -> np.ndarray:
    shifted = z - z.max(axis=1, keepdims=True)
    e = np.exp(shifted)
    return e / e.sum(axis=1, keepdims=True)


class NeuralClassifier(ClassifierMixin, BaseEstimator):
    """
    scikit-learn compatible, so it drops into the same Pipeline as the TF-IDF
    features and pickles with joblib like any other estimator.

    `eval_set=(X, y)` on fit gives early stopping a validation set chosen by the
    caller (the experiments hold out whole shop names). Without it,
    `validation_fraction` of the training rows are held out at random.
    """

    def __init__(
        self,
        hidden: tuple[int, ...] = (64,),
        activation: str = "relu",
        optimizer: str = "adam",
        learning_rate: float = 0.003,
        batch_size: int = 128,
        epochs: int = 30,
        l2: float = 1e-6,
        dropout: float = 0.0,
        patience: int = 4,
        restore_best: bool = True,
        validation_fraction: float = 0.1,
        clip_norm: float = 5.0,
        lr_decay: float = 0.0,
        class_weight: str | None = "balanced",
        seed: int = 7,
        track_training: bool = False,
        dtype: str = "float32",
    ):
        self.hidden = hidden
        self.activation = activation
        self.optimizer = optimizer
        self.learning_rate = learning_rate
        self.batch_size = batch_size
        self.epochs = epochs
        self.l2 = l2
        self.dropout = dropout
        self.patience = patience
        self.restore_best = restore_best
        self.validation_fraction = validation_fraction
        self.clip_norm = clip_norm
        self.lr_decay = lr_decay
        self.class_weight = class_weight
        self.seed = seed
        self.track_training = track_training
        self.dtype = dtype

    # ── set-up ─────────────────────────────────────────────────────────────

    def _prepare(self, X):
        if sp.issparse(X):
            return sp.csr_matrix(X, dtype=self.dtype)
        return np.asarray(X, dtype=self.dtype)

    def _init_layers(self, X, n_out: int, rng: np.random.Generator) -> None:
        sizes = [X.shape[1], *self.hidden, n_out]
        if sp.issparse(X):
            energy = float(np.mean(np.asarray(X.multiply(X).sum(axis=1)).ravel()))
        else:
            energy = float(np.mean(np.sum(X * X, axis=1)))
        energy = max(energy, 1e-6)
        self.layers_ = []
        for i, (n_in, n_out_i) in enumerate(zip(sizes[:-1], sizes[1:])):
            is_output = i == len(sizes) - 2
            # He (gain 2) for ReLU-family hidden layers, LeCun (gain 1) for
            # sigmoid, tanh and the softmax layer.
            gain = 2.0 if (not is_output and self.activation in ("relu", "leaky_relu")) else 1.0
            fan = energy if i == 0 else n_in
            W = rng.normal(0.0, np.sqrt(gain / fan), size=(n_in, n_out_i)).astype(self.dtype)
            b = np.zeros(n_out_i, dtype=self.dtype)
            self.layers_.append([W, b])

    # ── forward and backward ───────────────────────────────────────────────

    def _forward(self, X, rng: np.random.Generator | None = None):
        """Probabilities, plus what backprop needs when `rng` (training) is given."""
        h = X
        cache = []
        last = len(self.layers_) - 1
        for i, (W, b) in enumerate(self.layers_):
            z = np.asarray(h @ W) + b
            if i == last:
                return softmax(z), cache
            a = activate(self.activation, z)
            mask = None
            if rng is not None and self.dropout > 0:
                # Inverted dropout: scale survivors by 1/(1-p) now, so nothing
                # has to change at prediction time.
                mask = (rng.random(a.shape) >= self.dropout).astype(a.dtype) / (1.0 - self.dropout)
            cache.append((h, z, a, mask))
            h = a if mask is None else a * mask
        raise AssertionError("unreachable")

    def loss_and_gradients(self, X, Y: np.ndarray, w: np.ndarray, rng=None):
        """
        Mean weighted cross-entropy (plus L2) and its gradient for every layer.

        Returns (loss, grads, rows): grads[i] = (dW, db); for a sparse first
        layer dW holds only the rows listed in `rows`, the n-grams in this batch.
        Public so the tests can check it against numerical differentiation.
        """
        P, cache = self._forward(X, rng if rng is not None else np.random.default_rng(0))
        wsum = float(w.sum()) or 1.0
        picked = np.clip(np.sum(P * Y, axis=1), 1e-12, None)
        loss = float(-(w * np.log(picked)).sum() / wsum)

        rows = None
        grads: list[tuple[np.ndarray, np.ndarray]] = [None] * len(self.layers_)  # type: ignore[list-item]
        # softmax + cross-entropy: dL/dz = p - y. The row weights are cast to
        # the network's dtype, or float64 weights would silently promote the
        # whole backward pass to float64 and double its cost.
        delta = (P - Y) * (w / wsum).astype(P.dtype)[:, None]
        for i in range(len(self.layers_) - 1, -1, -1):
            W, _ = self.layers_[i]
            prev = X if i == 0 else (cache[i - 1][2] if cache[i - 1][3] is None else cache[i - 1][2] * cache[i - 1][3])
            if i == 0 and sp.issparse(prev):
                rows = np.unique(prev.indices)
                # The batch re-indexed onto just its own columns, in O(nnz).
                # prev[:, rows] computes the same matrix through scipy's general
                # fancy indexing, and was most of an epoch's time.
                narrow = sp.csr_matrix(
                    (prev.data, np.searchsorted(rows, prev.indices), prev.indptr),
                    shape=(prev.shape[0], len(rows)),
                )
                dW = np.asarray(narrow.T @ delta)
                if self.l2:
                    present = W[rows]  # one gather, used twice
                    dW += self.l2 * present
                    loss += 0.5 * self.l2 * float(np.sum(present * present))
            else:
                dW = np.asarray(prev.T @ delta)
                if self.l2:
                    dW = dW + self.l2 * W
                    loss += 0.5 * self.l2 * float(np.sum(W * W))
            grads[i] = (dW.astype(W.dtype), delta.sum(axis=0).astype(W.dtype))
            if i > 0:
                _, z, a, mask = cache[i - 1]
                upstream = delta @ W.T
                if mask is not None:
                    upstream = upstream * mask
                delta = upstream * slope(self.activation, z, a)
        return loss, grads, rows

    # ── optimisation ───────────────────────────────────────────────────────

    def _update(self, param, grad, state, rows, lr: float, t: int) -> None:
        """
        One optimiser step. With `rows`, only those rows of a sparse first
        layer move: each is gathered once, updated in place, and scattered
        back once. Fancy indexing copies, so re-reading m[rows] for the bias
        correction was a second gather of every array on every step, and the
        gathers were most of an epoch.
        """
        if rows is None:
            p, st = param, state
        else:
            p, st = param[rows], [a[rows] for a in state]
        if self.optimizer == "sgd":
            p -= lr * grad
        elif self.optimizer == "momentum":
            v = st[0]
            v *= MOMENTUM
            v -= lr * grad
            p += v
        elif self.optimizer == "rmsprop":
            sq = st[0]
            sq *= RMS_DECAY
            sq += (1 - RMS_DECAY) * grad * grad
            p -= lr * grad / (np.sqrt(sq) + EPS)
        elif self.optimizer == "adam":
            m, v = st
            m *= ADAM_B1
            m += (1 - ADAM_B1) * grad
            v *= ADAM_B2
            v += (1 - ADAM_B2) * grad * grad
            # Bias correction folded into the step size: the same update as
            # m_hat / (sqrt(v_hat) + eps) up to where eps sits, one array less.
            step = lr * np.sqrt(1 - ADAM_B2**t) / (1 - ADAM_B1**t)
            p -= step * m / (np.sqrt(v) + EPS)
        else:
            raise ValueError(f"unknown optimizer {self.optimizer!r}")
        if rows is not None:
            param[rows] = p
            for full, part in zip(state, st):
                full[rows] = part

    def _mean_loss(self, X, yi: np.ndarray, w: np.ndarray) -> tuple[float, float]:
        P = self._proba(X)
        picked = np.clip(P[np.arange(len(yi)), yi], 1e-12, None)
        loss = float(-(w * np.log(picked)).sum() / (w.sum() or 1.0))
        return loss, float(np.mean(P.argmax(axis=1) == yi))

    def fit(self, X, y, sample_weight=None, eval_set=None):
        if self.activation not in ACTIVATIONS:
            raise ValueError(f"activation must be one of {ACTIVATIONS}")
        if self.optimizer not in OPTIMIZERS:
            raise ValueError(f"optimizer must be one of {OPTIMIZERS}")
        rng = np.random.default_rng(self.seed)
        X = self._prepare(X)
        y = np.asarray(y)
        self.classes_, yi = np.unique(y, return_inverse=True)
        k = len(self.classes_)
        w = np.ones(len(yi)) if sample_weight is None else np.asarray(sample_weight, dtype=float)
        if self.class_weight == "balanced":
            # sklearn's rule: n / (k * count), so a small category's rows
            # count for as much in total as a large one's.
            counts = np.bincount(yi, minlength=k)
            w = w * (len(yi) / (k * np.maximum(counts, 1)))[yi]

        if eval_set is not None:
            Xv = self._prepare(eval_set[0])
            index = {c: i for i, c in enumerate(self.classes_)}
            yv = np.array([index.get(c, -1) for c in np.asarray(eval_set[1])])
            keep = yv >= 0
            Xv, yv = Xv[keep], yv[keep]
            wv = np.ones(len(yv))
            train_idx = np.arange(len(yi))
        elif self.validation_fraction > 0 and self.patience:
            order = rng.permutation(len(yi))
            cut = int(len(yi) * self.validation_fraction)
            val_idx, train_idx = order[:cut], order[cut:]
            Xv, yv, wv = X[val_idx], yi[val_idx], np.ones(cut)
        else:
            Xv = None
            train_idx = np.arange(len(yi))

        Xt, yt, wt = X[train_idx], yi[train_idx], w[train_idx]
        eye = np.eye(k, dtype=self.dtype)
        self._init_layers(Xt, k, rng)
        states = [
            [[np.zeros_like(p) for _ in range(2 if self.optimizer == "adam" else 1)] for p in layer]
            for layer in self.layers_
        ]

        self.history_: list[dict] = []
        self.best_epoch_ = 0
        self.stopped_early_ = False
        self.diverged_ = False
        best_loss = np.inf
        best_layers = [[p.copy() for p in layer] for layer in self.layers_]
        stale = 0
        t = 0
        started = time.time()
        batch = max(1, min(self.batch_size, len(yt)))

        for epoch in range(1, self.epochs + 1):
            lr = self.learning_rate / (1.0 + self.lr_decay * (epoch - 1))
            order = rng.permutation(len(yt))
            for start in range(0, len(yt), batch):
                idx = order[start : start + batch]
                loss, grads, rows = self.loss_and_gradients(Xt[idx], eye[yt[idx]], wt[idx], rng)
                if not np.isfinite(loss):
                    self.diverged_ = True
                    break
                if self.clip_norm:
                    norm = np.sqrt(sum(float(np.sum(g * g)) for pair in grads for g in pair))
                    if norm > self.clip_norm:
                        scale = self.clip_norm / norm
                        grads = [(dW * scale, db * scale) for dW, db in grads]
                t += 1
                for i, (dW, db) in enumerate(grads):
                    W, b = self.layers_[i]
                    self._update(W, dW, states[i][0], rows if i == 0 else None, lr, t)
                    self._update(b, db, states[i][1], None, lr, t)
            if not self.diverged_ and not all(np.isfinite(p).all() for layer in self.layers_ for p in layer):
                # The loss is clipped at log(1e-12), so it can stay finite while
                # the weights themselves have overflowed. Checked once an epoch.
                self.diverged_ = True
            if self.diverged_:
                break

            record = {"epoch": epoch, "updates": t, "seconds": round(time.time() - started, 2)}
            if self.track_training:
                record["train_loss"], record["train_accuracy"] = self._mean_loss(Xt, yt, np.ones(len(yt)))
            if Xv is not None and len(yv):
                val_loss, val_acc = self._mean_loss(Xv, yv, wv)
                record["val_loss"], record["val_accuracy"] = val_loss, val_acc
                if not np.isfinite(val_loss):
                    self.diverged_ = True
                    self.history_.append(record)
                    break
                if val_loss < best_loss - 1e-6:
                    best_loss, stale, self.best_epoch_ = val_loss, 0, epoch
                    best_layers = [[p.copy() for p in layer] for layer in self.layers_]
                else:
                    stale += 1
            else:
                self.best_epoch_ = epoch
            self.history_.append(record)
            if Xv is not None and self.patience and stale >= self.patience:
                self.stopped_early_ = True
                break

        if Xv is not None and self.best_epoch_ and self.restore_best:
            self.layers_ = best_layers
        return self

    # ── prediction ─────────────────────────────────────────────────────────

    def _proba(self, X) -> np.ndarray:
        out = []
        for start in range(0, X.shape[0], 4096):
            P, _ = self._forward(X[start : start + 4096])
            out.append(P)
        return np.vstack(out) if out else np.zeros((0, len(self.classes_)))

    def predict_proba(self, X) -> np.ndarray:
        return self._proba(self._prepare(X)).astype(float)

    def predict(self, X) -> np.ndarray:
        return self.classes_[self.predict_proba(X).argmax(axis=1)]

    def parameter_count(self) -> int:
        return int(sum(W.size + b.size for W, b in self.layers_))
