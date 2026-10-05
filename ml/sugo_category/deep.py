"""
A character-level convolutional neural network for shop and item names.

    text ──► characters ──► Embedding ──► Conv1D x5 widths ──► ReLU ──► global max-pool
                                                                            │
                         softmax ◄── Dense ◄── Dropout ◄── ReLU ◄── Dense ◄──┘ (Dropout)

This is the TextCNN of Kim (2014), "Convolutional Neural Networks for Sentence
Classification", run over characters as in Zhang, Zhao & LeCun (2015),
"Character-level Convolutional Networks for Text Classification": the standard
deep architecture for short, noisy text. A shop name is a few words, often
misspelt, often Filipino, and the words that decide it are fragments inside
longer words ("PANADERIA de Tacurong", "Julie's BAKEshop", "ube PANDESAL"). Each
convolution filter is a learned detector for one such fragment, 2 to 6
characters wide, and max-pooling asks only whether it appears anywhere. That
is what the TF-IDF model does with fixed n-grams, except that here the
fragments, and how they combine, are learned: "pan de" and "bread" can end up
pointing the same way without either being written down.

Training follows current industry practice for a network of this size:

  - He (Kaiming) initialisation for ReLU layers, so signals neither vanish nor
    explode at the start.
  - AdamW: Adam with decoupled weight decay (Loshchilov & Hutter, 2019).
  - A learning-rate schedule: linear warm-up, then cosine decay.
  - Global-norm gradient clipping, so one bad batch cannot throw the weights.
  - Inverted dropout after pooling and after the hidden layer.
  - Label smoothing (Szegedy et al., 2016): the target is 95% the right answer
    and 5% spread across the rest, which keeps the network from becoming
    certain of labels that are themselves a little noisy.
  - Class-balanced loss weights, the same "balanced" rule the linear model uses.
  - Typo augmentation: each epoch a share of names is re-typed with one
    deletion, swap, doubled letter or dropped space, because that is what
    dispatchers and customers actually type.
  - Early stopping on validation loss, restoring the best weights.
  - Transfer learning (`pretrained=`): a network trained on the 85,000 map shop
    names starts the item network, which then fine-tunes with the transferred
    layers learning more slowly than the new ones (discriminative learning
    rates, Howard & Ruder 2018). From scratch, 700 item phrases seen once
    each are too few for a network; the shop names already taught it that
    "pandesal", "bread" and "bake" mean Bakery.

Numpy only, like sugo_category.neural. PyTorch would roughly double the
image and its memory, and this container retrains itself nightly inside a
1.5 GB limit. Every gradient below is checked against a numerical derivative in
tests/test_deep.py, which is the test a hand-written layer has to pass.
"""

from __future__ import annotations

import math
import time
from collections import Counter
from typing import Sequence

import numpy as np
from sklearn.base import BaseEstimator, ClassifierMixin

PAD = 0
UNK = 1


def _augment(text: str, rng: np.random.Generator) -> str:
    """One realistic typing slip: a dropped, swapped or doubled letter, or a lost space."""
    if len(text) < 4:
        return text
    op = rng.integers(4)
    i = int(rng.integers(1, len(text) - 1))
    if op == 0:  # dropped letter: "pandsal"
        return text[:i] + text[i + 1 :]
    if op == 1:  # swapped neighbours: "pnadesal"
        return text[: i - 1] + text[i] + text[i - 1] + text[i + 1 :]
    if op == 2:  # doubled letter: "pandessal"
        return text[:i] + text[i] + text[i:]
    # the spaces taken out, as in "milktea" for "milk tea"
    return text.replace(" ", "") if " " in text else text[:i] + text[i + 1 :]


class CharCNNClassifier(ClassifierMixin, BaseEstimator):
    """
    TextCNN over characters. Fits on raw (already normalised) strings, not on
    a feature matrix: the network learns its own features.

    `fit(texts, labels, sample_weight, eval_set=(texts, labels))` watches the
    validation loss each epoch, stops when it has not improved for `patience`
    epochs, and keeps the best epoch's weights. `history_` records every epoch.
    """

    def __init__(
        self,
        embed_dim: int = 32,
        widths: tuple[int, ...] = (2, 3, 4, 5, 6),
        filters: int = 48,
        hidden: int = 128,
        dropout: float = 0.3,
        max_len: int = 40,
        epochs: int = 12,
        batch_size: int = 128,
        learning_rate: float = 2e-3,
        weight_decay: float = 1e-4,
        warmup: float = 0.05,
        clip_norm: float = 5.0,
        label_smoothing: float = 0.05,
        augment: float = 0.15,
        patience: int = 3,
        class_weight: str | None = "balanced",
        min_char_count: int = 2,
        max_seconds: float | None = None,
        pretrained: "CharCNNClassifier | None" = None,
        pretrained_lr_scale: float = 0.3,
        seed: int = 7,
        verbose: bool = False,
    ):
        self.embed_dim = embed_dim
        self.widths = widths
        self.filters = filters
        self.hidden = hidden
        self.dropout = dropout
        self.max_len = max_len
        self.epochs = epochs
        self.batch_size = batch_size
        self.learning_rate = learning_rate
        self.weight_decay = weight_decay
        self.warmup = warmup
        self.clip_norm = clip_norm
        self.label_smoothing = label_smoothing
        self.augment = augment
        self.patience = patience
        self.class_weight = class_weight
        self.min_char_count = min_char_count
        self.max_seconds = max_seconds
        self.pretrained = pretrained
        self.pretrained_lr_scale = pretrained_lr_scale
        self.seed = seed
        self.verbose = verbose

    # ── text to numbers ────────────────────────────────────────────────────
    def _build_vocab(self, texts: Sequence[str]) -> None:
        counts = Counter(ch for text in texts for ch in f" {text} ")
        chars = sorted(ch for ch, n in counts.items() if n >= self.min_char_count)
        # A pretrained network's characters keep their ids, so its embedding
        # rows carry over; characters it never saw are added after them.
        base = dict(self.pretrained.vocab_) if self.pretrained is not None else {}
        for ch in chars:
            if ch not in base:
                base[ch] = len(base) + 2
        self.vocab_ = base

    def _encode(self, texts: Sequence[str]) -> tuple[np.ndarray, np.ndarray]:
        """Ids padded to the longest text in this batch (at least the widest filter)."""
        # A space either side marks where the name starts and ends, as
        # TF-IDF's char_wb does, so a filter can learn "starts with pan".
        framed = [f" {text[: self.max_len - 2]} " for text in texts]
        length = max(max(self.widths), max((len(t) for t in framed), default=0))
        ids = np.zeros((len(framed), length), dtype=np.int32)
        lengths = np.zeros(len(framed), dtype=np.int32)
        get = self.vocab_.get
        for row, text in enumerate(framed):
            ids[row, : len(text)] = [get(ch, UNK) for ch in text]
            lengths[row] = len(text)
        return ids, lengths

    # ── parameters ─────────────────────────────────────────────────────────
    def _init_params(self, n_chars: int, n_classes: int, rng: np.random.Generator) -> dict:
        d, f = self.embed_dim, self.filters
        params: dict[str, np.ndarray] = {}
        emb = rng.normal(0.0, 1.0, (n_chars, d)).astype(np.float32)
        emb[PAD] = 0.0
        params["E"] = emb
        for k in self.widths:
            # He initialisation: variance 2 / fan_in for a ReLU layer. One
            # (D x F) slice per character position in the window.
            params[f"conv{k}.W"] = rng.normal(0.0, math.sqrt(2.0 / (k * d)), (k, d, f)).astype(np.float32)
            params[f"conv{k}.b"] = np.zeros(f, dtype=np.float32)
        pooled = f * len(self.widths)
        if self.hidden:
            params["hidden.W"] = rng.normal(0.0, math.sqrt(2.0 / pooled), (pooled, self.hidden)).astype(np.float32)
            params["hidden.b"] = np.zeros(self.hidden, dtype=np.float32)
            last = self.hidden
        else:
            last = pooled
        # Glorot for the softmax layer, which has no ReLU after it.
        params["out.W"] = rng.normal(0.0, math.sqrt(1.0 / last), (last, n_classes)).astype(np.float32)
        params["out.b"] = np.zeros(n_classes, dtype=np.float32)
        return params

    # ── the network ────────────────────────────────────────────────────────
    def _stacked_kernels(self, params) -> np.ndarray:
        """(D, sum of k*F): each width's (k, D, F) kernel laid side by side, offset-major."""
        d = self.embed_dim
        return np.concatenate(
            [params[f"conv{k}.W"].transpose(1, 0, 2).reshape(d, k * self.filters) for k in self.widths],
            axis=1,
        )

    def _forward(self, params, ids, lengths, rng: np.random.Generator | None):
        """Logits, and everything backward() needs. `rng` None means inference (no dropout)."""
        cache: dict = {"ids": ids}
        x = params["E"][ids]  # (B, L, D)
        b, length, d = x.shape
        cache["x_shape"] = x.shape
        # Every width's every offset in ONE matrix multiply: project each
        # character through all the (D x F) slices at once, then a window's
        # response is the sum of its characters' projections, each shifted to
        # line up. Same arithmetic as copying out every window (im2col), none
        # of the copying, and one large GEMM is what BLAS is fastest at.
        stacked = self._stacked_kernels(params)
        xf = x.reshape(b * length, d)
        projected = (xf @ stacked).reshape(b, length, -1)
        cache["xf"], cache["stacked"] = xf, stacked
        pooled_parts = []
        column = 0
        for k in self.widths:
            f = self.filters
            steps = length - k + 1
            block = projected[:, :, column : column + k * f].reshape(b, length, k, f)
            column += k * f
            z = block[:, 0:steps, 0, :].copy()
            for offset in range(1, k):
                z += block[:, offset : offset + steps, offset, :]
            z += params[f"conv{k}.b"]
            a = np.maximum(z, 0.0)
            # Windows that run past the end of the name only see padding.
            # Masked with -1 so they are never the maximum of a ReLU output;
            # position 0 always counts, so a very short name still pools.
            valid = np.arange(steps)[None, :] <= np.maximum(lengths[:, None] - k, 0)
            a_masked = np.where(valid[:, :, None], a, -1.0)
            where = a_masked.argmax(axis=1)  # (B, F)
            pooled_parts.append(np.take_along_axis(a, where[:, None, :], axis=1)[:, 0, :])
            cache[k] = (z, where, steps)
        h0 = np.concatenate(pooled_parts, axis=1)
        h0, cache["m0"] = self._dropout(h0, rng)
        cache["h0"] = h0
        if self.hidden:
            z1 = h0 @ params["hidden.W"] + params["hidden.b"]
            h1 = np.maximum(z1, 0.0)
            h1, cache["m1"] = self._dropout(h1, rng)
            cache["z1"], cache["h1"] = z1, h1
            last = h1
        else:
            last = h0
        logits = last @ params["out.W"] + params["out.b"]
        return logits, cache

    def _dropout(self, h: np.ndarray, rng: np.random.Generator | None):
        if rng is None or self.dropout <= 0:
            return h, None
        keep = 1.0 - self.dropout
        # Inverted dropout: scaled at training time so inference needs nothing.
        mask = (rng.random(h.shape) < keep).astype(np.float32) / keep
        return h * mask, mask

    def _backward(self, params, cache, dlogits) -> dict:
        grads: dict[str, np.ndarray] = {}
        last = cache["h1"] if self.hidden else cache["h0"]
        grads["out.W"] = last.T @ dlogits
        grads["out.b"] = dlogits.sum(axis=0)
        dlast = dlogits @ params["out.W"].T
        if self.hidden:
            if cache["m1"] is not None:
                dlast = dlast * cache["m1"]
            dz1 = dlast * (cache["z1"] > 0)
            grads["hidden.W"] = cache["h0"].T @ dz1
            grads["hidden.b"] = dz1.sum(axis=0)
            dh0 = dz1 @ params["hidden.W"].T
        else:
            dh0 = dlast
        if cache["m0"] is not None:
            dh0 = dh0 * cache["m0"]

        b, length, d = cache["x_shape"]
        f = self.filters
        dprojected = np.zeros((b, length, sum(k * f for k in self.widths)), dtype=dh0.dtype)
        column = 0
        for j, k in enumerate(self.widths):
            z, where, steps = cache[k]
            dpooled = dh0[:, j * f : (j + 1) * f]
            dz = np.zeros_like(z)
            np.put_along_axis(dz, where[:, None, :], dpooled[:, None, :], axis=1)
            dz *= z > 0  # ReLU
            grads[f"conv{k}.b"] = dz.sum(axis=(0, 1))
            block = dprojected[:, :, column : column + k * f].reshape(b, length, k, f)
            for offset in range(k):
                block[:, offset : offset + steps, offset, :] += dz
            dprojected[:, :, column : column + k * f] = block.reshape(b, length, k * f)
            column += k * f
        dflat = dprojected.reshape(b * length, -1)
        dstacked = cache["xf"].T @ dflat  # (D, sum k*F)
        dx = (dflat @ cache["stacked"].T).reshape(b, length, d)
        column = 0
        for k in self.widths:
            grads[f"conv{k}.W"] = dstacked[:, column : column + k * f].reshape(d, k, f).transpose(1, 0, 2)
            column += k * f
        demb = np.zeros_like(params["E"])
        np.add.at(demb, cache["ids"], dx)
        demb[PAD] = 0.0  # padding stays exactly zero
        grads["E"] = demb
        return grads

    def _loss_and_dlogits(self, logits, y, weights):
        """Label-smoothed, weighted cross-entropy and its gradient with respect to the logits."""
        n_classes = logits.shape[1]
        shifted = logits - logits.max(axis=1, keepdims=True)
        logp = shifted - np.log(np.exp(shifted).sum(axis=1, keepdims=True))
        target = np.full(logits.shape, self.label_smoothing / n_classes, dtype=np.float32)
        target[np.arange(len(y)), y] += 1.0 - self.label_smoothing
        total = weights.sum()
        loss = float(-(weights[:, None] * target * logp).sum() / total)
        dlogits = (np.exp(logp) - target) * (weights[:, None] / total)
        return loss, dlogits.astype(np.float32)

    # ── training ───────────────────────────────────────────────────────────
    def fit(self, texts, labels, sample_weight=None, eval_set=None):
        texts = list(texts)
        labels = np.asarray(labels)
        rng = np.random.default_rng(self.seed)
        self.classes_ = np.array(sorted(set(labels.tolist())))
        index = {c: i for i, c in enumerate(self.classes_)}
        y = np.array([index[c] for c in labels], dtype=np.int64)

        weights = np.ones(len(y), dtype=np.float64) if sample_weight is None else np.asarray(sample_weight, float)
        if self.class_weight == "balanced":
            counts = np.bincount(y, weights=weights, minlength=len(self.classes_))
            balance = weights.sum() / (len(self.classes_) * np.maximum(counts, 1e-9))
            weights = weights * balance[y]
        weights = (weights / weights.mean()).astype(np.float32)

        self._build_vocab(texts)
        params = self._init_params(len(self.vocab_) + 2, len(self.classes_), rng)
        self.transferred_ = self._transfer(params) if self.pretrained is not None else []
        lr_scale = {name: (self.pretrained_lr_scale if name in self.transferred_ else 1.0) for name in params}
        moments = {name: (np.zeros_like(p), np.zeros_like(p)) for name, p in params.items()}

        eval_data = None
        if eval_set is not None and len(eval_set[0]):
            ev_texts, ev_labels = eval_set
            keep = [i for i, c in enumerate(ev_labels) if c in index]
            if keep:
                eval_data = ([ev_texts[i] for i in keep], np.array([index[ev_labels[i]] for i in keep]))

        steps_per_epoch = max(1, math.ceil(len(texts) / self.batch_size))
        total_steps = steps_per_epoch * self.epochs
        warmup_steps = max(1, int(self.warmup * total_steps))
        step = 0
        best = (math.inf, None, 0)
        stale = 0
        self.history_ = []
        fit_started = time.time()

        for epoch in range(1, self.epochs + 1):
            started = time.time()
            epoch_texts = texts
            if self.augment > 0:
                epoch_texts = [
                    _augment(t, rng) if rng.random() < self.augment else t for t in texts
                ]
            # Length bucketing: batches of names of similar length, in random
            # order, so a batch of short names is not padded out to the one
            # 40-character name that happened to land in it.
            sizes = np.minimum([len(t) for t in epoch_texts], self.max_len)
            order = np.lexsort((rng.random(len(texts)), sizes))
            batches = [order[i : i + self.batch_size] for i in range(0, len(order), self.batch_size)]
            rng.shuffle(batches)
            running, seen = 0.0, 0
            for batch in batches:
                ids, lengths = self._encode([epoch_texts[i] for i in batch])
                logits, cache = self._forward(params, ids, lengths, rng)
                loss, dlogits = self._loss_and_dlogits(logits, y[batch], weights[batch])
                grads = self._backward(params, cache, dlogits)

                norm = math.sqrt(sum(float((g.astype(np.float64) ** 2).sum()) for g in grads.values()))
                if not math.isfinite(norm):
                    raise FloatingPointError("the gradient became infinite; lower the learning rate")
                scale = min(1.0, self.clip_norm / (norm + 1e-12))

                step += 1
                if step <= warmup_steps:
                    lr = self.learning_rate * step / warmup_steps
                else:
                    progress = (step - warmup_steps) / max(1, total_steps - warmup_steps)
                    lr = self.learning_rate * max(0.05, 0.5 * (1.0 + math.cos(math.pi * min(1.0, progress))))
                self._adamw(params, grads, moments, lr, scale, step, lr_scale)
                running += loss * len(batch)
                seen += len(batch)

            record = {"epoch": epoch, "train_loss": round(running / seen, 4), "lr": round(lr, 6)}
            if eval_data is not None:
                val_loss, val_acc = self._evaluate(params, *eval_data)
                record.update(val_loss=round(val_loss, 4), val_accuracy=round(val_acc, 4))
                if val_loss < best[0] - 1e-4:
                    best = (val_loss, {k: v.copy() for k, v in params.items()}, epoch)
                    stale = 0
                else:
                    stale += 1
            record["seconds"] = round(time.time() - started, 1)
            self.history_.append(record)
            if self.verbose:
                print(f"  cnn epoch {record}")
            if eval_data is not None and stale >= self.patience:
                break
            if self.max_seconds and time.time() - fit_started >= self.max_seconds:
                self.stopped_by_budget_ = True
                break

        if best[1] is not None:
            params = best[1]
            self.best_epoch_ = best[2]
        else:
            self.best_epoch_ = len(self.history_)
        self.params_ = params
        # The weights are copied in; keeping the source network too would save
        # a whole second model inside this one.
        self.pretrained_classes_ = None if self.pretrained is None else list(self.pretrained.classes_)
        self.pretrained = None
        return self

    def _adamw(self, params, grads, moments, lr, scale, step, lr_scale=None, beta1=0.9, beta2=0.999, eps=1e-8):
        c1 = 1.0 - beta1**step
        c2 = 1.0 - beta2**step
        for name, p in params.items():
            layer_lr = lr * (lr_scale[name] if lr_scale else 1.0)
            g = grads[name] * scale
            m, v = moments[name]
            m *= beta1
            m += (1.0 - beta1) * g
            v *= beta2
            v += (1.0 - beta2) * g * g
            update = (m / c1) / (np.sqrt(v / c2) + eps)
            if name.endswith(".W") and self.weight_decay:
                # Decoupled: shrinks the weight directly, not through the gradient.
                update = update + self.weight_decay * p
            p -= (layer_lr * update).astype(np.float32)
        params["E"][PAD] = 0.0

    def _evaluate(self, params, texts, y) -> tuple[float, float]:
        proba = self._proba(params, texts)
        loss = float(-np.mean(np.log(np.clip(proba[np.arange(len(y)), y], 1e-12, None))))
        return loss, float(np.mean(proba.argmax(axis=1) == y))

    def _transfer(self, params) -> list[str]:
        """
        Copy what fits from `self.pretrained` into freshly initialised `params`.
        Returns the names of the layers that were transferred.

        Embedding rows for shared characters, every convolution and the hidden
        layer when their shapes match, and the softmax columns of the classes
        both networks know (the store and item models share one catalogue).
        """
        source = self.pretrained.params_
        moved: list[str] = []
        emb = params["E"]
        for ch, i in self.pretrained.vocab_.items():
            if i < emb.shape[0] and source["E"].shape[1] == emb.shape[1]:
                emb[i] = source["E"][i]
        if source["E"].shape[1] == emb.shape[1]:
            moved.append("E")
        for name in params:
            if name in ("E", "out.W", "out.b"):
                continue
            if name in source and source[name].shape == params[name].shape:
                params[name][...] = source[name]
                moved.append(name)
        if "out.W" in source and source["out.W"].shape[0] == params["out.W"].shape[0]:
            old = {c: j for j, c in enumerate(self.pretrained.classes_)}
            for j, c in enumerate(self.classes_):
                if c in old:
                    params["out.W"][:, j] = source["out.W"][:, old[c]]
                    params["out.b"][j] = source["out.b"][old[c]]
            moved += ["out.W", "out.b"]
        return moved

    # ── inference ──────────────────────────────────────────────────────────
    def _proba(self, params, texts, chunk: int = 1024) -> np.ndarray:
        texts = list(texts)
        out = []
        for start in range(0, len(texts), chunk):
            ids, lengths = self._encode(texts[start : start + chunk])
            logits, _ = self._forward(params, ids, lengths, None)
            shifted = logits - logits.max(axis=1, keepdims=True)
            e = np.exp(shifted)
            out.append(e / e.sum(axis=1, keepdims=True))
        if not out:
            return np.zeros((0, len(self.classes_)))
        return np.vstack(out).astype(np.float64)

    def predict_proba(self, texts) -> np.ndarray:
        return self._proba(self.params_, texts)

    def predict(self, texts) -> np.ndarray:
        return self.classes_[self.predict_proba(texts).argmax(axis=1)]

    @property
    def parameter_count(self) -> int:
        return int(sum(p.size for p in self.params_.values()))


class LinearDeepEnsemble:
    """
    The TF-IDF logistic regression and the CharCNN, their probabilities averaged.

    The "wide and deep" pairing (Cheng et al., 2016): the linear model memorises
    exact phrases and rare brand names it has seen once; the network generalises
    from fragments to names it has never seen. Averaging two models that fail
    differently is the most reliable accuracy gain in applied machine learning,
    and `weight` (the linear model's share) is chosen on validation names, never
    on test names. Weight 1.0 is the linear model alone, 0.0 the network alone.
    """

    def __init__(self, linear, deep, weight: float):
        self.linear = linear
        self.deep = deep
        self.weight = float(weight)
        self.classes_ = np.array(sorted(set(linear.classes_) | set(deep.classes_)))

    def _aligned(self, model, texts) -> np.ndarray:
        proba = model.predict_proba(texts)
        out = np.zeros((proba.shape[0], len(self.classes_)))
        position = {c: i for i, c in enumerate(self.classes_)}
        for j, c in enumerate(model.classes_):
            out[:, position[c]] = proba[:, j]
        return out

    def member_proba(self, texts) -> tuple[np.ndarray, np.ndarray]:
        texts = list(texts)
        return self._aligned(self.linear, texts), self._aligned(self.deep, texts)

    def predict_proba(self, texts) -> np.ndarray:
        linear, deep = self.member_proba(texts)
        return self.weight * linear + (1.0 - self.weight) * deep

    def predict(self, texts) -> np.ndarray:
        return self.classes_[self.predict_proba(texts).argmax(axis=1)]


def choose_ensemble_weight(linear: np.ndarray, deep: np.ndarray, y_idx: np.ndarray) -> float:
    """The linear model's share, 0 to 1 in tenths, with the lowest validation log loss."""

    def nll(w: float) -> float:
        p = w * linear + (1.0 - w) * deep
        return float(-np.mean(np.log(np.clip(p[np.arange(len(y_idx)), y_idx], 1e-12, None))))

    return float(min(np.round(np.linspace(0.0, 1.0, 11), 1), key=nll))
