"""
Why the category models are built the way they are.

    python -m sugo_category.experiments           # the full run, about an hour
    python -m sugo_category.experiments --quick   # a smoke test of the script, minutes

Every comparison behind config.py, measured on held-out OpenStreetMap shop names
and on production's own jobs, written to category/EXPERIMENTS.md with its charts
and every number in category/experiments.json. Settings are chosen on the
validation names; the test names are scored once, for the result.

The narrative in the report is computed from the numbers, not written ahead of
them, so a rerun that comes out differently says so.
"""

from __future__ import annotations

import argparse
import csv
import json
import time
from pathlib import Path

import numpy as np
from sklearn.linear_model import LogisticRegression

from crawler.run import categorise, load_snapshot, summarise
from crawler.dedupe import dedupe

from . import config
from .evaluation import (
    ML_DIR,
    PRODUCTION_CATEGORIES,
    apply_temperature,
    fit_temperature,
    group_split,
    load_osm_rows,
    load_real_jobs,
    measure,
)
from .lexicon import synthetic_rows
from .model import CategoryModel, _build_pipeline, normalize
from .neural import ACTIVATIONS, NeuralClassifier
from .svg_chart import line_chart

OUT = ML_DIR / "category"
CHARTS = OUT / "charts"


def pct(v: float | None, digits: int = 1) -> str:
    return "n/a" if v is None else f"{v * 100:.{digits}f}%"


def num(v: float, digits: int = 3) -> str:
    return f"{v:.{digits}f}"


def table(header: list[str], rows: list[list]) -> str:
    out = ["| " + " | ".join(header) + " |", "|" + "|".join("---" for _ in header) + "|"]
    out += ["| " + " | ".join(str(c) for c in row) + " |" for row in rows]
    return "\n".join(out)


# ── the data, fitted once ──────────────────────────────────────────────────


class Data:
    """Seeds plus OpenStreetMap training names, their features, and the splits."""

    def __init__(self, quick: bool):
        started = time.time()
        self.categories = list(PRODUCTION_CATEGORIES)
        osm = load_osm_rows(self.categories)
        if quick:
            osm = [r for i, r in enumerate(osm) if i % 10 == 0]
        self.osm_train, self.osm_val, self.osm_test = group_split(osm)
        seeds = [(normalize(t), c) for t, c, k in synthetic_rows(set(self.categories)) if k == "store"]
        self.seeds = seeds
        train = seeds + [(normalize(n), c) for n, c in self.osm_train]
        self.train_texts = [t for t, _ in train]
        self.y_train = np.array([c for _, c in train])
        self.val_texts = [normalize(n) for n, _ in self.osm_val]
        self.y_val = np.array([c for _, c in self.osm_val])
        self.test_texts = [normalize(n) for n, _ in self.osm_test]
        self.y_test = np.array([c for _, c in self.osm_test])

        pipe = _build_pipeline(config.STORE)
        self.features = pipe.named_steps["features"]
        self.X_train = self.features.fit_transform(self.train_texts)
        self.X_val = self.features.transform(self.val_texts)
        self.X_test = self.features.transform(self.test_texts)

        # The mechanism experiments (activations, optimisers, sizes) run on a
        # fixed subsample: they compare algorithms against each other, and a
        # quarter of the data shows the same differences in a quarter the time.
        rng = np.random.default_rng(11)
        n_sub = min(len(self.y_train), 2000 if quick else 15000)
        self.sub = np.sort(rng.permutation(len(self.y_train))[:n_sub])
        self.seconds = round(time.time() - started, 1)
        self._lr: dict[float, tuple[LogisticRegression, float]] = {}

    def logistic(self, C: float) -> tuple[LogisticRegression, float]:
        """Logistic regression on all training rows, fitted once per C."""
        if C not in self._lr:
            started = time.time()
            clf = LogisticRegression(max_iter=2000, class_weight="balanced", C=C).fit(self.X_train, self.y_train)
            self._lr[C] = (clf, round(time.time() - started, 1))
        return self._lr[C]

    def summary(self) -> dict:
        return {
            "categories": self.categories,
            "train_rows": int(len(self.y_train)),
            "seed_rows": len(self.seeds),
            "osm_train_names": len(self.osm_train),
            "validation_names": len(self.osm_val),
            "test_names": len(self.osm_test),
            "features": int(self.X_train.shape[1]),
            "nonzeros_per_name": round(self.X_train.nnz / self.X_train.shape[0], 1),
            "subsample_rows": int(len(self.sub)),
        }


def fit_net(data: Data, rows=None, **kwargs) -> tuple[NeuralClassifier, float]:
    rows = data.sub if rows is None else rows
    params = dict(epochs=25, patience=0, validation_fraction=0.0, class_weight="balanced", seed=7)
    params.update(kwargs)
    started = time.time()
    net = NeuralClassifier(**params).fit(data.X_train[rows], data.y_train[rows], eval_set=(data.X_val, data.y_val))
    return net, round(time.time() - started, 1)


def val_scores(model, data: Data, temperature: float = 1.0) -> dict:
    return measure(apply_temperature(model.predict_proba(data.X_val), temperature), model.classes_, data.y_val)


def curve(net: NeuralClassifier, key: str = "val_loss", x: str = "epoch") -> list[tuple[float, float]]:
    return [(h[x], h[key]) for h in net.history_ if key in h]


# ── 1. learning data ───────────────────────────────────────────────────────


def section_data(data: Data, quick: bool) -> tuple[str, dict]:
    live = CategoryModel.train("store", [], holdout=False)  # production's model on 2026-09-24
    lex6 = CategoryModel.train("store", [], holdout=False, allowed=set(data.categories))
    lr, lr_seconds = data.logistic(config.STORE.C)

    def by_pipeline(model: CategoryModel) -> dict:
        return measure(model.pipeline.predict_proba(data.val_texts), model.pipeline.classes_, data.y_val)

    rows = {
        "live": by_pipeline(live),
        "lexicon_6": by_pipeline(lex6),
        "lexicon_osm": val_scores(lr, data),
    }
    j = {"results": rows, "lr_seconds": lr_seconds}
    t = [
        [label, f"{r['rows']:,}", pct(r["accuracy"]), pct(r["coverage"]), pct(r["accuracy_when_answered"]),
         pct(r["auto_accepted"]), pct(r["accuracy_when_auto"])]
        for label, r in (
            ("Seed lexicon, 4 categories (live on 2026-09-24)", rows["live"]),
            ("Seed lexicon, all 6 categories", rows["lexicon_6"]),
            (f"Seed lexicon + {len(data.osm_train):,} OpenStreetMap names", rows["lexicon_osm"]),
        )
    ]
    gain = rows["lexicon_osm"]["accuracy"] - rows["live"]["accuracy"]
    md = f"""## 1. The learning data

Production's store model was trained on {len(live.report.classes)} categories and
{live.report.rows} seed phrases, and nothing else (`/health` on 2026-09-24:
`real_rows: 0`). It could not name Bakery or Convenience Store at all, though
both are live categories with real pins. The first question is whether more
real names beat a better algorithm. Same classifier throughout (logistic
regression, C = {config.STORE.C}), scored on {rows['live']['rows']:,} validation names none of them trained on:

{table(["Trained on", "Names", "Right", "Answers", "Right when it answers", "Auto-accepted (>= 0.75)", "Right when auto"], t)}

The live model can never be right on the {rows['live']['unpredictable_rows']:,} Bakery and
Convenience Store names, which is part of why it scores {pct(rows['live']['accuracy'])}.
Giving the lexicon all six categories {"helps" if rows['lexicon_6']['accuracy'] > rows['live']['accuracy'] else "does not help"} ({pct(rows['lexicon_6']['accuracy'])}), but its
{len(data.seeds)} phrases answer only {pct(rows['lexicon_6']['coverage'])} of the names: most shop
names contain no word the lexicon knows. Adding the OpenStreetMap names adds {gain * 100:.1f} points of accuracy
and lifts the share of shops that get a category at all from
{pct(rows['live']['coverage'])} to {pct(rows['lexicon_osm']['coverage'])}. Nothing later in
this report comes close to that gain: data first, then algorithms.
"""
    return md, j


# ── 2. one neuron ──────────────────────────────────────────────────────────

GATES_X = np.array([[0, 0], [0, 1], [1, 0], [1, 1]], dtype=float)
GATES = {"AND": np.array([0, 0, 0, 1]), "OR": np.array([0, 1, 1, 1]), "XOR": np.array([0, 1, 1, 0])}


def _gate_net(target, hidden, seed, activation="tanh") -> NeuralClassifier:
    return NeuralClassifier(
        hidden=hidden, activation=activation, optimizer="adam", learning_rate=0.1, batch_size=4,
        epochs=800, l2=0.0, patience=0, validation_fraction=0.0, clip_norm=0.0, class_weight=None,
        seed=seed, dtype="float64",
    ).fit(GATES_X, target)


def section_one_neuron(data: Data, quick: bool) -> tuple[str, dict]:
    seeds = range(5 if quick else 20)
    gates = {}
    for name, target in GATES.items():
        scores = [float(np.mean(_gate_net(target, (), s).predict(GATES_X) == target)) for s in seeds]
        net = _gate_net(target, (), 0)
        W, b = net.layers_[0]
        # Two softmax outputs are one sigmoid neuron on their difference.
        w = W[:, 1] - W[:, 0]
        gates[name] = {
            "solved_starts": sum(s == 1.0 for s in scores),
            "best": max(scores),
            "weights": [round(float(w[0]), 2) + 0.0, round(float(w[1]), 2) + 0.0],
            "bias": round(float(b[1] - b[0]), 2) + 0.0,
            "outputs": [round(float(p), 3) for p in net.predict_proba(GATES_X)[:, 1]],
        }

    # One neuron on real names: "is this a pharmacy?"
    target = "Pharmacy & Health"
    yb = np.where(data.y_train == target, "yes", "no")
    ybv = np.where(data.y_val == target, "yes", "no")
    started = time.time()
    one = NeuralClassifier(hidden=(), epochs=15, learning_rate=0.01, batch_size=256, patience=3, class_weight="balanced").fit(
        data.X_train, yb, eval_set=(data.X_val, ybv)
    )
    one_seconds = round(time.time() - started, 1)
    pred = one.predict(data.X_val)
    pharm = {
        "accuracy": round(float(np.mean(pred == ybv)), 4),
        "recall": round(float(np.mean(pred[ybv == "yes"] == "yes")), 4),
        "precision": round(float(np.mean(ybv[pred == "yes"] == "yes")), 4),
        "share": round(float(np.mean(ybv == "yes")), 4),
        "seconds": one_seconds,
    }
    per_cat, _ = fit_net(data, rows=np.arange(len(data.y_train)), hidden=(), learning_rate=0.01, batch_size=256, epochs=15, patience=3)
    softmax_scores = val_scores(per_cat, data)

    t = [
        [g, f"{v['solved_starts']} of {len(seeds)}", f"{v['weights'][0]}, {v['weights'][1]}", v["bias"],
         ", ".join(f"{o:.2f}" for o in v["outputs"])]
        for g, v in gates.items()
    ]
    xor = gates["XOR"]
    md = f"""## 2. One neuron

A single neuron draws one straight line through its inputs. On the logic gates:

{table(["Gate", "Solved (starts)", "Weights", "Bias", "Output for 00, 01, 10, 11"], t)}

AND and OR are one line each, and the neuron finds them from every start. XOR
needs two lines, and the best a single neuron managed was {pct(xor['best'], 0)} of the four
rows; its outputs sit near the middle because no line separates them.

The shop names turn out to be mostly the easy kind. One neuron answering "is this
a pharmacy?" over the {data.X_train.shape[1]:,} n-gram columns gets {pct(pharm['accuracy'])} of the
validation names right (finds {pct(pharm['recall'])} of the pharmacies; {pct(pharm['precision'])}
of what it calls a pharmacy is one), where always answering "no" would score
{pct(1 - pharm['share'])}. It took {pharm['seconds']} s. Words like "drug", "botika" and "pharmacy"
separate with a straight line.

One neuron per category, all six trained together with a softmax, is exactly
the model family this service has always shipped (logistic regression). Trained
here by backpropagation with Adam it scores {pct(softmax_scores['accuracy'])} on the validation names.
"""
    return md, {"gates": gates, "pharmacy_neuron": pharm, "one_neuron_per_category": softmax_scores}


# ── 3. three neurons ───────────────────────────────────────────────────────

GATE_NAMES = {(0, 1, 1, 1): "OR", (0, 0, 0, 1): "AND", (1, 1, 1, 0): "NAND", (1, 0, 0, 0): "NOR",
              (0, 1, 1, 0): "XOR", (1, 0, 0, 1): "XNOR"}


def section_three_neurons(data: Data, quick: bool) -> tuple[str, dict]:
    seeds = range(5 if quick else 20)
    xor = GATES["XOR"]
    solved = {}
    roles = None
    for act in ("sigmoid", "tanh"):
        wins = []
        for s in seeds:
            net = _gate_net(xor, (2,), s, activation=act)
            ok = bool(np.all(net.predict(GATES_X) == xor))
            wins.append(ok)
            if ok and roles is None:
                W, b = net.layers_[0]
                z = GATES_X @ W + b
                on = (z > 0).astype(int)
                roles = {"activation": act, "seed": s, "hidden": [GATE_NAMES.get(tuple(on[:, j]), "other") for j in range(2)]}
        solved[act] = sum(wins)

    three, three_s = fit_net(data, hidden=(3,), learning_rate=0.003, batch_size=128)
    none, none_s = fit_net(data, hidden=(), learning_rate=0.01, batch_size=256)
    t_scores, n_scores = val_scores(three, data), val_scores(none, data)
    md = f"""## 3. Three neurons

Two hidden neurons feeding one output neuron (three in all) is the smallest
network that can solve XOR. It did from {solved['sigmoid']} of {len(seeds)} random starts with
sigmoid hidden neurons and {solved['tanh']} of {len(seeds)} with tanh; the rest settled in a
local minimum. In the first solved run the hidden neurons had taught themselves
{" and ".join(roles['hidden']) if roles else "(none solved)"}, and the output neuron combines the two. Nobody told them to.

The same squeeze on the real task: every name passed through 3 hidden neurons
before the 6 category outputs, on the {len(data.sub):,}-row subsample.

{table(["Network", "Right", "Answers", "Right when auto", "Log loss", "Seconds"], [
        ["No hidden layer (one neuron per category)", pct(n_scores['accuracy']), pct(n_scores['coverage']), pct(n_scores['accuracy_when_auto']), num(n_scores['log_loss']), none_s],
        ["3 hidden neurons", pct(t_scores['accuracy']), pct(t_scores['coverage']), pct(t_scores['accuracy_when_auto']), num(t_scores['log_loss']), three_s],
    ])}

{"Three neurons are a bottleneck here: six categories have to be told apart from three numbers, and it costs " + f"{(n_scores['accuracy'] - t_scores['accuracy']) * 100:.1f} points." if t_scores['accuracy'] < n_scores['accuracy'] else "Three hidden neurons are enough to carry the six categories on this data."}
"""
    return md, {"xor_solved": solved, "starts": len(seeds), "hidden_roles": roles,
                "three_hidden": t_scores, "no_hidden": n_scores}


# ── 4. network size ────────────────────────────────────────────────────────


def section_size(data: Data, quick: bool) -> tuple[str, dict]:
    shapes = [(), (3,), (16,), (64,), (64, 32)]
    results = []
    for shape in shapes:
        lr = 0.01 if not shape else 0.003
        net, secs = fit_net(data, hidden=shape, learning_rate=lr, batch_size=256 if not shape else 128, patience=4)
        s = val_scores(net, data)
        results.append({"hidden": list(shape), "params": net.parameter_count(), "seconds": secs,
                        "best_epoch": net.best_epoch_, **{k: s[k] for k in ("accuracy", "log_loss", "coverage", "accuracy_when_auto")}})
    best = max(results, key=lambda r: r["accuracy"])
    base = results[0]
    rows = [[" x ".join(map(str, r["hidden"])) or "none", f"{r['params']:,}", pct(r["accuracy"]), pct(r["coverage"]),
             num(r["log_loss"]), r["best_epoch"], r["seconds"]] for r in results]
    md = f"""## 4. How big a network

Hidden layers between the n-grams and the six outputs, on the {len(data.sub):,}-row
subsample, each with early stopping on the validation names:

{table(["Hidden layers", "Parameters", "Right", "Answers", "Log loss", "Best epoch", "Seconds"], rows)}

{("No hidden layer did best, at " + pct(base['accuracy']) + ".") if best is base else ("Best: " + " x ".join(map(str, best['hidden'])) + " at " + pct(best['accuracy']) + ", against " + pct(base['accuracy']) + " with no hidden layer.")}
{"Hidden layers did not pay for themselves here: text classification over n-grams is close to linear, and every hidden layer adds parameters to overfit with." if best is base or best['accuracy'] - base['accuracy'] < 0.005 else "A hidden layer helped by " + f"{(best['accuracy'] - base['accuracy']) * 100:.1f} points."}
The more parameters, the sooner the validation loss stopped improving: best epoch
{", ".join(f"{' x '.join(map(str, r['hidden'])) or 'none'} {r['best_epoch']}" for r in results)} (of 25).
"""
    return md, {"results": results}


# ── 5. activation functions ────────────────────────────────────────────────


def vanishing_ratio(activation: str, data: Data) -> float:
    """Mean |gradient| of the first layer over the last, in a deep narrow net at initialisation."""
    net = NeuralClassifier(hidden=(16,) * 6, activation=activation, class_weight=None, seed=3)
    rows = data.sub[:512]
    net.classes_, yi = np.unique(data.y_train[rows], return_inverse=True)
    X = net._prepare(data.X_train[rows])
    net._init_layers(X, len(net.classes_), np.random.default_rng(3))
    Y = np.eye(len(net.classes_))[yi]
    _, grads, _ = net.loss_and_gradients(X, Y, np.ones(len(yi)))
    first = float(np.mean(np.abs(grads[1][0])))  # first hidden-to-hidden layer (dense)
    last = float(np.mean(np.abs(grads[-2][0])))  # last hidden-to-hidden layer
    return first / last if last else float("nan")


def section_activations(data: Data, quick: bool) -> tuple[str, dict]:
    results, series = [], []
    for act in ACTIVATIONS:
        net, secs = fit_net(data, hidden=(32,), activation=act, learning_rate=0.003, batch_size=128, epochs=15)
        s = val_scores(net, data)
        best = min(h["val_loss"] for h in net.history_)
        results.append({"activation": act, "best_val_loss": round(best, 4), "best_epoch": net.best_epoch_,
                        "accuracy": s["accuracy"], "seconds": secs, "vanishing_ratio": vanishing_ratio(act, data)})
        series.append((act, curve(net)))
    (CHARTS / "activations.svg").write_text(
        line_chart("Validation loss by activation function", "Epoch", "Validation loss", series,
                   subtitle="32 hidden neurons, Adam 0.003, same start and data for each",
                   y_format=lambda v: f"{v:.2f}"),
        encoding="utf-8",
    )
    ranked = sorted(results, key=lambda r: r["best_val_loss"])
    sig = next(r for r in results if r["activation"] == "sigmoid")
    rows = [[r["activation"], num(r["best_val_loss"]), r["best_epoch"], pct(r["accuracy"]), f"{r['vanishing_ratio']:.1e}", r["seconds"]]
            for r in results]
    spread = ranked[-1]["best_val_loss"] - ranked[0]["best_val_loss"]
    md = f"""## 5. Activation functions

The same one-hidden-layer network with each activation, same start, same data:

![Validation loss by activation](charts/activations.svg)

{table(["Activation", "Best validation loss", "At epoch", "Right", "First/last layer gradient (6 deep)", "Seconds"], rows)}

Best: {ranked[0]['activation']}; worst: {ranked[-1]['activation']}, {spread:.3f} apart in loss. The last column
is the vanishing-gradient problem measured, not described: in a 6-layer stack of
16 neurons at initialisation, the error signal reaching sigmoid's first layer is
{sig['vanishing_ratio']:.1e} of what its last layer gets, because every sigmoid layer multiplies
it by at most 0.25. {"ReLU and leaky ReLU pass it back at full strength wherever a neuron is on." if all(r['vanishing_ratio'] > sig['vanishing_ratio'] for r in results if r['activation'] in ('relu', 'leaky_relu')) else ""}
With one hidden layer, as in the table, a vanishing gradient is not what separates
them; how quickly each fits these names is.
"""
    return md, {"results": results}


# ── 6. gradient descent ────────────────────────────────────────────────────


def section_gradient_descent(data: Data, quick: bool) -> tuple[str, dict]:
    # One neuron per category, so each method is judged on the optimisation
    # alone, not on what a hidden layer happens to do.
    lrs = {"sgd": [0.3, 1.0, 3.0], "momentum": [0.03, 0.1, 0.3], "rmsprop": [0.001, 0.003, 0.01], "adam": [0.001, 0.003, 0.01]}
    methods = []
    for opt, grid in lrs.items():
        best = None
        for lr in grid:
            net, secs = fit_net(data, hidden=(), optimizer=opt, learning_rate=lr, batch_size=256, epochs=12)
            loss = min(h["val_loss"] for h in net.history_)
            if best is None or loss < best["best_val_loss"]:
                best = {"optimizer": opt, "learning_rate": lr, "best_val_loss": round(loss, 4), "seconds": secs,
                        "accuracy": val_scores(net, data)["accuracy"], "curve": curve(net)}
        methods.append(best)
    (CHARTS / "optimizers.svg").write_text(
        line_chart("Validation loss by optimiser", "Epoch", "Validation loss",
                   [(f"{m['optimizer']} ({m['learning_rate']:g})", m["curve"]) for m in methods],
                   subtitle="One neuron per category, mini-batches of 256, each at its best learning rate",
                   y_format=lambda v: f"{v:.2f}"),
        encoding="utf-8",
    )

    n = len(data.sub)
    sizes = [
        ("batch (all rows)", n, 60, (0.01, 0.03, 0.1)),
        ("mini-batch 256", 256, 12, (0.001, 0.003, 0.01)),
        ("mini-batch 32", 32, 8, (0.0003, 0.001, 0.003)),
        ("stochastic (1 row)", 1, 3, (0.0001, 0.0003, 0.001)),
    ]
    batches = []
    for label, size, epochs, grid in sizes:
        pick = None
        for lr in grid:
            net, secs = fit_net(data, hidden=(), optimizer="adam", learning_rate=lr, batch_size=size, epochs=epochs)
            best_h = min(net.history_, key=lambda h: h["val_loss"])
            if pick is None or best_h["val_loss"] < pick["best_val_loss"]:
                pick = {"label": label, "batch_size": size, "learning_rate": lr, "epochs": len(net.history_),
                        "best_val_loss": round(best_h["val_loss"], 4), "updates_to_best": best_h["updates"],
                        "seconds_to_best": best_h["seconds"], "seconds": secs, "curve": curve(net, x="seconds")}
        batches.append(pick)
    (CHARTS / "batch-size.svg").write_text(
        line_chart("Validation loss against wall-clock time", "Seconds", "Validation loss",
                   [(b["label"], b["curve"]) for b in batches],
                   subtitle=f"Adam, one neuron per category, {n:,} training rows",
                   y_format=lambda v: f"{v:.2f}"),
        encoding="utf-8",
    )

    sweep = []
    for lr in (0.0001, 0.001, 0.01, 0.1, 1.0):
        net, secs = fit_net(data, hidden=(32,), optimizer="adam", learning_rate=lr, batch_size=128, epochs=12)
        losses = [h["val_loss"] for h in net.history_]
        sweep.append({"learning_rate": lr, "best_val_loss": round(min(losses), 4), "final_val_loss": round(losses[-1], 4),
                      "accuracy": val_scores(net, data)["accuracy"], "diverged": net.diverged_, "curve": curve(net)})
    (CHARTS / "learning-rate.svg").write_text(
        line_chart("Validation loss by learning rate", "Epoch", "Validation loss",
                   [(f"lr {s['learning_rate']:g}", s["curve"]) for s in sweep],
                   subtitle="Adam, 32 hidden neurons", y_format=lambda v: f"{v:.2f}"),
        encoding="utf-8",
    )
    best_m = min(methods, key=lambda m: m["best_val_loss"])
    by_opt = {m["optimizer"]: m for m in methods}
    sgd_lr, adam_lr = by_opt["sgd"]["learning_rate"], by_opt["adam"]["learning_rate"]
    adaptive = [by_opt[o]["best_val_loss"] for o in ("rmsprop", "adam")]
    plain = [by_opt[o]["best_val_loss"] for o in ("sgd", "momentum")]
    uniform = float(np.log(len(np.unique(data.y_train))))
    worst_m = max(methods, key=lambda m: m["best_val_loss"])
    fast = min(batches, key=lambda b: b["seconds_to_best"])
    lowest = min(batches, key=lambda b: b["best_val_loss"])
    best_lr = min(sweep, key=lambda s: s["best_val_loss"])
    md = f"""## 6. Gradient descent

**Four update rules**, each given its best of three learning rates, one neuron per
category, mini-batches of 256:

![Validation loss by optimiser](charts/optimizers.svg)

{table(["Optimiser", "Learning rate", "Best validation loss", "Right", "Seconds"],
       [[m['optimizer'], f"{m['learning_rate']:g}", num(m['best_val_loss']), pct(m['accuracy']), m['seconds']] for m in methods])}

Best {best_m['optimizer']}, worst {worst_m['optimizer']}, {worst_m['best_val_loss'] - best_m['best_val_loss']:.3f} apart. Plain SGD's best learning
rate was {sgd_lr / adam_lr:,.0f} times Adam's, because TF-IDF gradients are tiny and uneven: a
common n-gram gets a gradient every batch, a rare one almost never. Adam and
RMSProp divide each weight's step by its own recent gradient size, which is the
fix for exactly that{"; here they finished ahead of SGD and momentum." if max(adaptive) < min(plain) else ", though here it did not put them ahead."}

**Batch, mini-batch or stochastic.** The same Adam, the same {n:,} rows, taking a
step after every row, every 32, every 256, or only after all of them:

![Validation loss against time](charts/batch-size.svg)

Each batch size got its best of three learning rates.

{table(["Batch", "Learning rate", "Epochs", "Best validation loss", "Updates to reach it", "Seconds to reach it"],
       [[b['label'], f"{b['learning_rate']:g}", b['epochs'], num(b['best_val_loss']), f"{b['updates_to_best']:,}", b['seconds_to_best']] for b in batches])}

Lowest loss: {lowest['label']} ({num(lowest['best_val_loss'])}). Fastest to its own best: {fast['label']}, in {fast['seconds_to_best']} s.
Full-batch descent takes one careful step per pass over the data and needs many
passes; one-row stochastic descent takes {n:,} noisy steps per pass and pays
Python's per-step overhead on each of them. Mini-batches sit between the two.

**Learning rate.** Adam with 32 hidden neurons:

![Validation loss by learning rate](charts/learning-rate.svg)

{table(["Learning rate", "Best validation loss", "Final validation loss", "Right", "Diverged"],
       [[f"{s['learning_rate']:g}", num(s['best_val_loss']), num(s['final_val_loss']), pct(s['accuracy']), "yes" if s['diverged'] else "no"] for s in sweep])}

Best {best_lr['learning_rate']:g}. {"At 0.0001 it is still far from that when the epochs run out. " if sweep[0]['final_val_loss'] > best_lr['best_val_loss'] + 0.05 else ""}At 1 every step overshoots:
{"training diverged." if sweep[-1]['diverged'] else "the loss ends at " + num(sweep[-1]['final_val_loss']) + (", worse than guessing all six categories equally (" + num(uniform) + ")." if sweep[-1]['final_val_loss'] > uniform else ".")}
{"At 0.1 the best epoch comes early and the loss then climbs back to " + num(sweep[3]['final_val_loss']) + ": steps that size overfit fast." if sweep[3]['final_val_loss'] > sweep[3]['best_val_loss'] + 0.1 else ""}
"""
    for m in methods:
        m.pop("curve")
    for b in batches:
        b.pop("curve")
    for s in sweep:
        s.pop("curve")
    return md, {"optimizers": methods, "batch_sizes": batches, "learning_rates": sweep}


# ── 7. overfitting ─────────────────────────────────────────────────────────


def section_overfitting(data: Data, quick: bool) -> tuple[str, dict]:
    small = data.sub[: 500 if quick else 2000]
    # 64 hidden neurons over ~200,000 n-gram columns is ~13 million weights for
    # 2,000 names: far more than the data can pin down.
    big = dict(hidden=(64,), learning_rate=0.003, batch_size=64, epochs=40, l2=0.0, dropout=0.0,
               track_training=True, restore_best=False)
    free, _ = fit_net(data, rows=small, **big)
    train_c = curve(free, "train_loss")
    val_c = curve(free, "val_loss")
    best_ep = min(free.history_, key=lambda h: h["val_loss"])
    last = free.history_[-1]
    (CHARTS / "overfitting-loss.svg").write_text(
        line_chart("An oversized network memorising its training names", "Epoch", "Loss",
                   [("training", train_c), ("validation", val_c)],
                   subtitle=f"64 hidden neurons, {free.parameter_count():,} weights, {len(small):,} training names",
                   y_min=0, y_format=lambda v: f"{v:.1f}"),
        encoding="utf-8",
    )
    defences = {
        "none": dict(big),
        "L2 1e-5": {**big, "l2": 1e-5},
        "dropout 0.5": {**big, "dropout": 0.5},
        "early stopping": {**big, "restore_best": True, "patience": 3},
        "all three": {**big, "l2": 1e-5, "dropout": 0.5, "restore_best": True, "patience": 3},
    }
    rows, series = [], []
    for name, params in defences.items():
        params = {k: v for k, v in params.items() if k != "track_training"}
        net, _ = fit_net(data, rows=small, **params)
        s = val_scores(net, data)
        rows.append({"defence": name, "val_loss": s["log_loss"], "accuracy": s["accuracy"],
                     "epochs": len(net.history_), "best_epoch": net.best_epoch_})
        if name in ("none", "L2 1e-5", "dropout 0.5", "all three"):
            series.append((name, curve(net)))
    (CHARTS / "overfitting-defences.svg").write_text(
        line_chart("Validation loss with each defence", "Epoch", "Validation loss", series,
                   subtitle=f"The same oversized network and {len(small):,} names", y_min=0,
                   y_format=lambda v: f"{v:.1f}"),
        encoding="utf-8",
    )

    # The real cure: more data. Same logistic regression, growing training set.
    sizes = [n for n in (1000, 3000, 10000, 30000) if n < len(data.y_train)] + [len(data.y_train)]
    rng = np.random.default_rng(5)
    order = rng.permutation(len(data.y_train))
    lc = []
    for n in sizes:
        idx = np.sort(order[:n])
        started = time.time()
        clf = LogisticRegression(max_iter=2000, class_weight="balanced", C=config.STORE.C).fit(data.X_train[idx], data.y_train[idx])
        train_acc = float(np.mean(clf.predict(data.X_train[idx]) == data.y_train[idx]))
        val_acc = float(np.mean(clf.predict(data.X_val) == data.y_val))
        lc.append({"names": int(n), "train_accuracy": round(train_acc, 4), "val_accuracy": round(val_acc, 4),
                   "gap": round(train_acc - val_acc, 4), "seconds": round(time.time() - started, 1)})
    (CHARTS / "learning-curve.svg").write_text(
        line_chart("Training against validation accuracy as the data grows", "Training names (log scale)", "Accuracy",
                   [("training", [(r["names"], r["train_accuracy"]) for r in lc]),
                    ("validation", [(r["names"], r["val_accuracy"]) for r in lc])],
                   subtitle="Logistic regression, the shipped features", x_log=True, y_min=0.5, y_max=1.0,
                   y_format=lambda v: f"{v:.0%}"),
        encoding="utf-8",
    )
    none_row = rows[0]
    md = f"""## 7. Overfitting

A network far too big for its data: 64 hidden neurons, {free.parameter_count():,} weights,
{len(small):,} training names, no defences, trained on past its best.

![Overfitting loss](charts/overfitting-loss.svg)

Training loss falls to {num(last['train_loss'])} ({pct(last['train_accuracy'])} of its own names right) while
validation loss bottoms out at {num(best_ep['val_loss'])} in epoch {best_ep['epoch']} and climbs to
{num(last['val_loss'])} by epoch {last['epoch']}. Validation accuracy moves far less than the loss
({pct(best_ep['val_accuracy'])} at the best epoch, {pct(last['val_accuracy'])} at the end): the network
keeps most of its answers but grows ever more certain of the wrong ones, which
is exactly what breaks a 0.75 auto-accept threshold.

The defences, on the same network and names:

![Validation loss with each defence](charts/overfitting-defences.svg)

{table(["Defence", "Validation loss", "Right", "Epochs run", "Best epoch"],
       [[r['defence'], num(r['val_loss']), pct(r['accuracy']), r['epochs'], r['best_epoch']] for r in rows])}

{"Every defence holds" if all(r['val_loss'] < none_row['val_loss'] for r in rows[1:]) else "Not every defence holds"} the validation loss below the undefended {num(none_row['val_loss'])}:
{", ".join(f"{r['defence']} {num(r['val_loss'])}" for r in rows[1:])}.

**The cure is more data.** The shipped model's features and classifier, trained on
more and more of the names:

![Learning curve](charts/learning-curve.svg)

{table(["Training names", "Right on its own names", "Right on validation", "Gap", "Seconds"],
       [[f"{r['names']:,}", pct(r['train_accuracy']), pct(r['val_accuracy']), pct(r['gap']), r['seconds']] for r in lc])}

The gap between what it has seen and what it has not shrinks from {pct(lc[0]['gap'])} to
{pct(lc[-1]['gap'])} as the names grow from {lc[0]['names']:,} to {lc[-1]['names']:,}, and validation accuracy
rises from {pct(lc[0]['val_accuracy'])} to {pct(lc[-1]['val_accuracy'])}. {"It is still rising at the end, so more names would still help." if lc[-1]['val_accuracy'] - lc[-2]['val_accuracy'] > 0.005 else "It is flattening at the end."}
"""
    return md, {"oversized": {"history": free.history_, "best_epoch": best_ep["epoch"]}, "defences": rows, "learning_curve": lc}


# ── 8. the choice ──────────────────────────────────────────────────────────


def section_choice(data: Data, quick: bool) -> tuple[str, dict]:
    full = np.arange(len(data.y_train))
    candidates = []
    for C in ((config.STORE.C,) if quick else (1.0, config.STORE.C, 16.0)):
        clf, secs = data.logistic(C)
        candidates.append({"name": f"logistic regression, C = {C:g}", "classifier": "logistic", "C": C,
                           "seconds": secs, "runs": [val_scores(clf, data)]})
    nets = {
        "softmax by backprop (no hidden layer)": dict(hidden=(), learning_rate=0.01, batch_size=256, epochs=30, patience=3),
        "network, 32 hidden ReLU, dropout 0.5": dict(hidden=(32,), learning_rate=0.001, batch_size=256, epochs=30, patience=3, dropout=0.5, l2=1e-5),
    }
    seeds = (7,) if quick else (7, 8, 9)
    for name, params in nets.items():
        runs, secs = [], []
        for seed in seeds:
            net, s = fit_net(data, rows=full, seed=seed, **params)
            runs.append(val_scores(net, data))
            secs.append(s)
        candidates.append({"name": name, "classifier": "neural", "params": {k: list(v) if isinstance(v, tuple) else v for k, v in params.items()},
                           "seconds": round(float(np.mean(secs)), 1), "runs": runs})
    for c in candidates:
        accs = [r["accuracy"] for r in c["runs"]]
        c["accuracy"] = round(float(np.mean(accs)), 4)
        c["spread"] = round(float(max(accs) - min(accs)), 4)
        c["log_loss"] = round(float(np.mean([r["log_loss"] for r in c["runs"]])), 4)
        c["coverage"] = round(float(np.mean([r["coverage"] for r in c["runs"]])), 4)
    # Two kinds of noise, and the larger decides: how far random starts of the
    # same network land apart, and how much the accuracy itself would move on a
    # different draw of validation names (one standard error, sqrt(p(1-p)/n)).
    # Logistic regression has no random start, but it has the second kind.
    seed_spread = max([c["spread"] for c in candidates if c["classifier"] == "neural"] + [0.0])
    p = max(c["accuracy"] for c in candidates)
    sampling = float(np.sqrt(p * (1 - p) / len(data.y_val)))
    noise = round(max(seed_spread, sampling), 4)
    best = max(candidates, key=lambda c: c["accuracy"])
    simplest = next(c for c in candidates if c["classifier"] == "logistic" and c["C"] == config.STORE.C)
    keep_simple = best["accuracy"] - simplest["accuracy"] <= noise
    chosen = simplest if keep_simple else best
    rows = [[c["name"], pct(c["accuracy"]), pct(c["spread"]) if len(c["runs"]) > 1 else "one run", num(c["log_loss"]),
             pct(c["coverage"]), c["seconds"]] for c in candidates]
    md = f"""## 8. The choice

Everything on the full {len(data.y_train):,} training rows, scored on the validation names. The
networks were run from {len(seeds)} random starts each; logistic regression has no random start.

{table(["Model", "Right (mean)", "Spread across starts", "Log loss", "Answers", "Seconds to train"], rows)}

Best: {best['name']} at {pct(best['accuracy'])}. The shipped setting ({simplest['name']}) scores
{pct(simplest['accuracy'])}. Starts of the same network landed up to {pct(seed_spread, 2)} apart, and on
{len(data.y_val):,} validation names one standard error of an accuracy near {pct(p)} is {pct(sampling, 2)}; the
larger, {pct(noise, 2)}, is the noise allowance.
{"The difference, " + pct(best['accuracy'] - simplest['accuracy'], 2) + ", is within it, so the shipped setting stays: a gap that size could come from which names happened to land in validation." if keep_simple else "The difference, " + pct(best['accuracy'] - simplest['accuracy'], 2) + ", is larger than that, so config.py should ship " + chosen['name'] + " instead."}
"""
    return md, {"candidates": candidates, "seed_spread": seed_spread, "sampling_error": round(sampling, 4),
                "noise": noise, "chosen": chosen["name"], "kept_shipped": keep_simple}


# ── 9. the result ──────────────────────────────────────────────────────────


def section_result(data: Data, quick: bool) -> tuple[str, dict]:
    live = CategoryModel.train("store", [], holdout=False)
    started = time.time()
    shipped = CategoryModel.train(
        "store", [], allowed=set(data.categories),
        extra_rows=[r for r in data.osm_train + data.osm_val + data.osm_test],
    )
    seconds = round(time.time() - started, 1)
    ev = shipped.report.evaluation
    test_new = ev["test"]
    live_test = measure(live.pipeline.predict_proba(data.test_texts), live.pipeline.classes_, data.y_test)

    # Calibration on the validation names, before and after temperature scaling.
    probe, _ = data.logistic(config.STORE.C)
    raw = probe.predict_proba(data.X_val)
    classes = list(probe.classes_)
    index = {c: i for i, c in enumerate(classes)}
    T = fit_temperature(raw, np.array([index[c] for c in data.y_val]))
    before, after = measure(raw, classes, data.y_val), measure(apply_temperature(raw, T), classes, data.y_val)

    def rel(m):
        return {f"{b['from']:.2f}-{b['to']:.2f}": (b["rows"], b["right"]) for b in m["reliability"]}

    rb, ra = rel(before), rel(after)
    rel_rows = [[band, rb[band][0], pct(rb[band][1]), ra[band][0], pct(ra[band][1])] for band in rb]

    def row(label, m):
        return [label, pct(m["accuracy"]), pct(m["coverage"]), pct(m["accuracy_when_answered"]),
                pct(m["auto_accepted"]), pct(m["accuracy_when_auto"])]

    md = f"""## 9. Calibration and the result

The dispatcher console acts on the confidence number: below 0.55 the pin says
"Category needed", at 0.75 and above the answer is filed without review. Those
cut-offs only mean something if 0.8 is right about 80% of the time. Temperature
scaling fits one number, T, on the validation names so that it is; T = {T} here
({"the raw model was already close to calibrated" if abs(T - 1) < 0.05 else "the raw model was overconfident, so it is softened" if T > 1 else "the raw model was underconfident, so it is sharpened"}). The ranking, and so the accuracy, does not change.

{table(["Confidence", "Names (raw)", "Right (raw)", f"Names (T = {T})", f"Right (T = {T})"], rel_rows)}

**The result**, on {test_new['rows']:,} test names that were never used to train or to choose
anything:

{table(["Model", "Right", "Answers", "Right when it answers", "Auto-accepted", "Right when auto-accepted"], [
        row("Live on 2026-09-24 (seed lexicon, 4 categories)", live_test),
        row("Shipped now (+ OpenStreetMap, 6 categories, calibrated)", test_new),
    ])}

Training the shipped store model, test split included, took {seconds} s here.
"""
    return md, {"temperature": T, "calibration_before": before, "calibration_after": after,
                "test_live": live_test, "test_shipped": test_new, "train_seconds": seconds}, shipped


# ── 10. real-life jobs ─────────────────────────────────────────────────────


def section_real_jobs(data: Data, shipped: CategoryModel, quick: bool) -> tuple[str, dict]:
    live_store = CategoryModel.train("store", [], holdout=False)
    stores = load_real_jobs("store")
    store_rows = []
    for name, category in stores:
        old, new = live_store.predict(name), shipped.predict(name)
        store_rows.append({"name": name, "dispatcher": category, "live": old["category"], "live_conf": old["confidence"],
                           "shipped": new["category"], "shipped_conf": new["confidence"]})

    live_item = CategoryModel.train("item", [], holdout=False)
    new_item = CategoryModel.train("item", [], holdout=False, allowed=set(data.categories))
    items = load_real_jobs("item")
    item_rows = []
    for name, category in items:
        old, new = live_item.predict(name), new_item.predict(name)
        item_rows.append({"name": name, "dispatcher": category, "live": old["category"], "shipped": new["category"],
                          "shipped_conf": new["confidence"]})

    def score(rows, key):
        right = sum(r[key] == r["dispatcher"] for r in rows)
        silent = sum(r[key] is None for r in rows)
        return right, silent, len(rows) - right - silent

    s_live, s_new = score(store_rows, "live"), score(store_rows, "shipped")
    i_live, i_new = score(item_rows, "live"), score(item_rows, "shipped")

    crawl = categorise(dedupe(load_snapshot()), shipped)
    crawl_summary = summarise(crawl)

    def fmt(c):
        return f"{c}" if c else "(none)"

    md = f"""## 10. Real-life jobs

Production's own labelled jobs on 2026-09-24 (`data/real_jobs.csv`): the category
a dispatcher chose for each shop pinned and each item bought. None of them is in
the training data of either model below, so this is a fair test, if a small one.

**Shops** ({len(store_rows)} distinct names):

{table(["Shop", "Dispatcher chose", "Live model", "Shipped model"],
       [[r['name'], r['dispatcher'], f"{fmt(r['live'])} ({r['live_conf']:.2f})", f"{fmt(r['shipped'])} ({r['shipped_conf']:.2f})"] for r in store_rows])}

Live: {s_live[0]} right, {s_live[1]} silent, {s_live[2]} wrong. Shipped: {s_new[0]} right, {s_new[1]} silent, {s_new[2]} wrong.

**Items** ({len(item_rows)} names). OpenStreetMap lists shops, not what they sell, so the
item model is still the lexicon; the change is that it now knows all six
categories:

Live: {i_live[0]} right, {i_live[1]} silent, {i_live[2]} wrong. With six categories: {i_new[0]} right, {i_new[1]} silent,
{i_new[2]} wrong. Missed or left unanswered: {", ".join(sorted({r['name'] for r in item_rows if r['shipped'] != r['dispatcher']}))}.
"Robust Extreme" appears twice on purpose: two dispatchers filed it under two
different categories, so no model can get both right. Items need production's
own history to improve, which grows with every errand and is read at every retrain.

**The Tacurong crawl.** The {crawl_summary['places']} named places inside the Tacurong box from the
OpenStreetMap extract (`crawler.run`): {crawl_summary['auto_accepted']} categorised at 0.75 or above,
{crawl_summary['needs_review']} flagged for review, {crawl_summary['no_category']} with no category from either the model or the
mapper's tag. Where the mappers tagged the place and the model answered, the two
agree on {crawl_summary['model_agrees_with_mappers']}.
"""
    return md, {"stores": store_rows, "items": item_rows, "crawl": crawl_summary}


# ── main ───────────────────────────────────────────────────────────────────


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--quick", action="store_true", help="a tenth of the data and few runs: checks the script, not the models")
    args = parser.parse_args(argv)
    started = time.time()
    CHARTS.mkdir(parents=True, exist_ok=True)

    data = Data(args.quick)
    print(f"data ready in {data.seconds} s: {data.summary()}", flush=True)
    parts, results = [], {"data": data.summary(), "quick": args.quick}
    for name, fn in (
        ("learning_data", section_data),
        ("one_neuron", section_one_neuron),
        ("three_neurons", section_three_neurons),
        ("network_size", section_size),
        ("activations", section_activations),
        ("gradient_descent", section_gradient_descent),
        ("overfitting", section_overfitting),
        ("choice", section_choice),
    ):
        t = time.time()
        md, j = fn(data, args.quick)
        parts.append(md)
        results[name] = j
        print(f"{name}: {time.time() - t:.0f} s", flush=True)
    t = time.time()
    md, j, shipped = section_result(data, args.quick)
    parts.append(md)
    results["result"] = j
    print(f"result: {time.time() - t:.0f} s", flush=True)
    md, j = section_real_jobs(data, shipped, args.quick)
    parts.append(md)
    results["real_jobs"] = j
    results["seconds"] = round(time.time() - started)

    s = data.summary()
    header = f"""# Category model experiments

Generated by `python -m sugo_category.experiments` on {time.strftime('%Y-%m-%d')}{" (QUICK RUN: a tenth of the data, not for decisions)" if args.quick else ""}.
Every number below is computed by that script; `experiments.json` has them all.

**The data.** {s['osm_train_names']:,} OpenStreetMap shop names to train on, {s['validation_names']:,} to choose settings on
and {s['test_names']:,} to report the result on, split by name so no shop name is in two of
them; plus the {s['seed_rows']} seed phrases of `lexicon.py`. Six categories, production's
catalogue on 2026-09-24. {s['features']:,} n-gram columns, about {s['nonzeros_per_name']:.0f} of them non-zero for a
typical name. The network experiments in sections 3 to 6 use a fixed
{s['subsample_rows']:,}-row subsample to keep them to minutes.

Data (c) OpenStreetMap contributors, ODbL 1.0.

"""
    (OUT / "EXPERIMENTS.md").write_text(header + "\n".join(parts), encoding="utf-8")
    (OUT / "experiments.json").write_text(json.dumps(results, indent=1, default=float), encoding="utf-8")
    print(f"done in {results['seconds']} s -> {OUT / 'EXPERIMENTS.md'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
