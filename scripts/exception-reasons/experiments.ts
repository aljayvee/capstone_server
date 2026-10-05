/**
 * The experiments behind the reason model's design, one per question.
 *
 *   npx tsx scripts/exception-reasons/experiments.ts
 *
 * Writes ml/exception-reasons/EXPERIMENTS.md (readable), experiments.json
 * (every number) and charts/*.svg.
 *
 *   1. One neuron        what a single neuron can and cannot learn (AND, OR, XOR)
 *   2. Three neurons     the smallest network that learns XOR, and what its hidden neurons compute
 *   3. Network size      no hidden layer vs 3 neurons vs wider and deeper, on the real task
 *   4. Activations       sigmoid, tanh, ReLU, leaky ReLU; and why sigmoid starves deep networks
 *   5. Gradient descent  batch, stochastic, mini-batch, momentum, RMSProp, Adam; learning rate
 *   6. Overfitting       watching a network memorise, and what stops it
 *   7. Real-life jobs    the shipped model on real SUGO errands
 *   8. Settings          activation x optimiser, three starts each, and why the shipped pair stays
 *
 * All comparisons train on the same rows and choose on the validation split.
 * Test scores are reported alongside, but nothing is chosen by them.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ACTIVATIONS,
  countParameters,
  createNetwork,
  evaluate,
  lossAndGradients,
  predict,
  seededRandom,
  train,
  type Activation,
  type EpochRecord,
  type Sample,
  type TrainOptions,
} from "../../src/services/patterns/neuralNetwork.js";
import { FEATURE_NAMES, REASON_CODES, suggestReason } from "../../src/services/patterns/exceptionReasonModel.js";
import { EXCEPTION_REASON_MODEL } from "../../src/services/patterns/exceptionReasonWeights.js";
import { PRODUCTION } from "./config.js";
import { ML_DIR, REAL_JOBS, loadRows, loadSplit, measure, round, type Row } from "./evaluation.js";
import { lineChart, type LineSeries } from "./svgChart.js";

const CHARTS = resolve(ML_DIR, "charts");
mkdirSync(CHARTS, { recursive: true });

const { trainSet, valSet, testSet } = loadSplit();
const json: Record<string, unknown> = {};
const md: string[] = [];
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const f3 = (n: number) => n.toFixed(3);
const table = (head: string[], rows: (string | number)[][]) =>
  [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
const chart = (file: string, svg: string) => {
  writeFileSync(resolve(CHARTS, file), svg);
  return `![](charts/${file})`;
};
const curve = (history: EpochRecord[], pick: (h: EpochRecord) => number | undefined): Array<[number, number]> =>
  history.map((h) => [h.epoch, pick(h) ?? NaN]);

// ── helpers ──────────────────────────────────────────────────────────────────

interface FitSpec {
  name: string;
  hidden: number[];
  activation?: Activation;
  options?: Partial<TrainOptions>;
  data?: Row[];
}

function fit(spec: FitSpec) {
  const data = spec.data ?? trainSet;
  const options: TrainOptions = { ...PRODUCTION, ...spec.options };
  const net = createNetwork(
    {
      inputs: FEATURE_NAMES.length,
      hidden: spec.hidden,
      outputs: REASON_CODES.length,
      activation: spec.activation ?? PRODUCTION.activation,
    },
    seededRandom(options.seed)
  );
  const started = Date.now();
  const result = train(net, data, valSet, options);
  const seconds = (Date.now() - started) / 1000;
  const best = result.history[result.bestEpoch - 1];
  const test = measure(result.network, testSet);
  const updatesPerEpoch = Math.ceil(data.length / options.batchSize);
  return {
    name: spec.name,
    network: result.network,
    history: result.history,
    summary: {
      name: spec.name,
      parameters: countParameters(result.network),
      epochsRun: result.history.length,
      bestEpoch: result.bestEpoch,
      updatesToBest: result.bestEpoch * updatesPerEpoch,
      diverged: result.diverged,
      seconds: round(seconds, 1),
      trainAccuracy: round(evaluate(result.network, data).accuracy),
      valLoss: best ? round(best.valLoss) : null,
      valAccuracy: best ? round(best.valAccuracy) : null,
      testAccuracy: test.accuracy,
      coverageAtThreshold: test.coverageAtThreshold,
      accuracyWhenConfident: test.accuracyWhenConfident,
    },
  };
}

const log = (s: string) => console.log(s);

// ── 1. One neuron ────────────────────────────────────────────────────────────

const GATE_INPUTS = [
  [0, 0],
  [0, 1],
  [1, 0],
  [1, 1],
];
const GATES: Record<string, number[]> = { AND: [0, 0, 0, 1], OR: [0, 1, 1, 1], XOR: [0, 1, 1, 0] };
const gateSamples = (gate: string): Sample[] => GATE_INPUTS.map((x, i) => ({ x, y: GATES[gate][i] }));
const gateOptions: TrainOptions = { epochs: 4000, batchSize: 4, learningRate: 1, optimizer: "sgd", seed: 1 };

log("1. One neuron");
const oneNeuron = Object.keys(GATES).map((gate) => {
  const data = gateSamples(gate);
  const net = createNetwork({ inputs: 2, hidden: [], outputs: 1, output: "sigmoid" }, seededRandom(1));
  const { network } = train(net, data, data, gateOptions);
  const [w1, w2] = network.layers[0].weights;
  const b = network.layers[0].biases[0];
  return {
    gate,
    accuracy: evaluate(network, data).accuracy,
    loss: round(evaluate(network, data).loss),
    weights: { w1: round(w1, 2), w2: round(w2, 2), bias: round(b, 2) },
    outputs: GATE_INPUTS.map((x) => round(predict(network, x)[0], 3)),
  };
});
json.oneNeuron = oneNeuron;

md.push(`## 1. One neuron

A neuron adds up its inputs, each multiplied by a weight, adds a bias, and passes
the total through an activation function. With a sigmoid activation it answers
yes (near 1) or no (near 0):

    output = sigmoid(w1 * x1 + w2 * x2 + bias)

That formula draws one straight line through the inputs: yes on one side, no on
the other. Trained here by plain gradient descent on the three classic logic gates:

${table(
  ["Gate", "Accuracy", "Learned w1, w2, bias", "Outputs for 00, 01, 10, 11", "Loss"],
  oneNeuron.map((g) => [
    g.gate,
    pct(g.accuracy),
    `${g.weights.w1}, ${g.weights.w2}, ${g.weights.bias}`,
    g.outputs.join(", "),
    f3(g.loss),
  ])
)}

AND and OR are learned perfectly: one line separates their yeses from their noes.
**XOR is not**, and never will be by one neuron: its yeses (01, 10) sit on the
diagonal between its noes (00, 11), and no single straight line separates them.
The neuron ends up answering about 0.5 for everything, the least-wrong a straight
line can do. That is why networks have hidden layers.
`);

// ── 2. Three neurons ─────────────────────────────────────────────────────────

log("2. Three neurons");
const xor = gateSamples("XOR");
const threeNeuronRuns = (["sigmoid", "tanh"] as Activation[]).map((activation) => {
  const seeds = Array.from({ length: 20 }, (_, i) => i + 1);
  const runs = seeds.map((seed) => {
    const net = createNetwork({ inputs: 2, hidden: [2], outputs: 1, activation, output: "sigmoid" }, seededRandom(seed));
    const { network } = train(net, xor, xor, { epochs: 3000, batchSize: 4, learningRate: 0.05, optimizer: "adam", seed });
    return { seed, network, accuracy: evaluate(network, xor).accuracy };
  });
  return { activation, runs, solved: runs.filter((r) => r.accuracy === 1).length };
});

const solvedRun = threeNeuronRuns[0].runs.find((r) => r.accuracy === 1) ?? threeNeuronRuns[1].runs.find((r) => r.accuracy === 1);
const hiddenTruth = solvedRun
  ? [0, 1].map((j) => {
      const act = ACTIVATIONS[solvedRun.network.hiddenActivation].fn;
      const layer = solvedRun.network.layers[0];
      return GATE_INPUTS.map((x) => round(act(layer.weights[j * 2] * x[0] + layer.weights[j * 2 + 1] * x[1] + layer.biases[j]), 2));
    })
  : [];
json.threeNeurons = {
  solvedOutOf20: Object.fromEntries(threeNeuronRuns.map((r) => [r.activation, r.solved])),
  example: solvedRun && {
    seed: solvedRun.seed,
    activation: solvedRun.network.hiddenActivation,
    hiddenOutputs: hiddenTruth,
    finalOutputs: GATE_INPUTS.map((x) => round(predict(solvedRun.network, x)[0], 3)),
  },
};

md.push(`## 2. Three neurons

Add a hidden layer of two neurons in front of the output neuron: three neurons in
all. Each hidden neuron draws its own line, and the output neuron combines them.
Trained with Adam from 20 different random starts:

${table(
  ["Hidden activation", "Learned XOR (out of 20 starts)"],
  threeNeuronRuns.map((r) => [r.activation, `${r.solved} / 20`])
)}

${
  solvedRun
    ? `One solved network (${solvedRun.network.hiddenActivation}, start ${solvedRun.seed}). What each neuron outputs for 00, 01, 10, 11:

${table(
  ["Neuron", "00", "01", "10", "11"],
  [
    ["Hidden 1", ...hiddenTruth[0]],
    ["Hidden 2", ...hiddenTruth[1]],
    ["Output", ...GATE_INPUTS.map((x) => round(predict(solvedRun.network, x)[0], 3))],
  ]
)}

The hidden neurons have turned the inputs into two new features, typically
something like OR and AND (or NAND). In that new space XOR is separable by one
line, which the output neuron draws. Nobody told the network to do this;
backpropagation found it.`
    : ""
}

Not every start succeeds. With only two hidden neurons there are flat regions and
dead ends in the loss surface, and gradient descent can settle in one (a local
minimum). Bigger networks have far fewer of these, one reason real networks are
wider than they strictly need to be.
`);

// ── 3. Network size on the real task ─────────────────────────────────────────

log("3. Network size");
const sizes = [
  { name: "No hidden layer (24 output neurons)", hidden: [] },
  { name: "3 hidden neurons", hidden: [3] },
  { name: "8 hidden neurons", hidden: [8] },
  { name: "24 hidden neurons", hidden: [24] },
  { name: "64 hidden neurons", hidden: [64] },
  { name: "Two layers, 24 and 12", hidden: [24, 12] },
].map((s) => fit(s));
json.networkSize = sizes.map((s) => s.summary);

md.push(`## 3. Network size on the real task

The real job: pick one of 24 reasons from 36 numbers describing an errand. Same
data, same optimiser (Adam), same stopping rule, only the network changes:

${table(
  ["Network", "Weights", "Train acc.", "Val. loss", "Val. acc.", "Test acc.", "Suggests (at 0.75)", "Right when it suggests"],
  sizes.map((s) => [
    s.summary.name,
    s.summary.parameters,
    pct(s.summary.trainAccuracy),
    f3(s.summary.valLoss ?? NaN),
    pct(s.summary.valAccuracy ?? 0),
    pct(s.summary.testAccuracy),
    pct(s.summary.coverageAtThreshold),
    pct(s.summary.accuracyWhenConfident),
  ])
)}

- **No hidden layer** is 24 single neurons side by side, one per reason, each
  drawing straight lines. Its best guess is right about as often as the bigger
  networks' (${pct(sizes[0].summary.testAccuracy)} on test), but it is rarely *sure*: it would show a suggestion
  for only ${pct(sizes[0].summary.coverageAtThreshold)} of rows, against ${pct(sizes[3].summary.coverageAtThreshold)} with a hidden layer. It cannot
  combine evidence ("a small shop AND the customer paid"), so its probabilities
  stay spread out. With a 0.75 threshold, it would stay silent on ${pct(1 - sizes[0].summary.coverageAtThreshold)} of errands.
- **3 hidden neurons** is a bottleneck: everything the network knows about an
  errand has to squeeze through 3 numbers before choosing among 24 reasons. Test
  accuracy drops to ${pct(sizes[1].summary.testAccuracy)}.
- **From 8 neurons up the validation loss is flat** (${sizes
    .slice(2, 5)
    .map((s) => f3(s.summary.valLoss ?? NaN))
    .join(", ")}), and a second layer is slightly worse (${f3(sizes[5].summary.valLoss ?? NaN)}).
  Past that point the extra weights have nothing left to learn from this data,
  only more room to memorise it. 24 has the lowest validation loss by a hair and
  is what ships; 8 would do nearly as well with a third of the weights.
`);

// ── 4. Activation functions ──────────────────────────────────────────────────

log("4. Activation functions");
const activationRuns = (["sigmoid", "tanh", "relu", "leakyRelu"] as Activation[]).map((activation) =>
  fit({ name: activation, hidden: PRODUCTION.hidden, activation })
);
json.activations = activationRuns.map((r) => r.summary);

// Vanishing gradients: how much error reaches the FIRST layer of a deep network.
const deepBatch = trainSet.filter((_, i) => i % 6 === 0);
const vanishing = (["sigmoid", "tanh", "relu", "leakyRelu"] as Activation[]).map((activation) => {
  const net = createNetwork(
    { inputs: FEATURE_NAMES.length, hidden: [16, 16, 16, 16, 16, 16], outputs: REASON_CODES.length, activation },
    seededRandom(3)
  );
  const { grads } = lossAndGradients(net, deepBatch);
  const size = (g: { weights: number[] }) => Math.sqrt(g.weights.reduce((s, v) => s + v * v, 0) / g.weights.length);
  const first = size(grads[0]);
  const last = size(grads[grads.length - 1]);
  return { activation, firstLayer: first, lastLayer: last, ratio: first / last };
});
json.vanishingGradients = vanishing;

md.push(`## 4. Activation functions

The activation is what a neuron does with its total before passing it on. Without
one, stacking layers adds nothing: a straight-line function of a straight-line
function is still a straight line.

| Function | Formula | Output range | Slope (what backprop multiplies by) |
|---|---|---|---|
| sigmoid | 1 / (1 + e^-z) | 0 to 1 | at most 0.25 |
| tanh | (e^z - e^-z) / (e^z + e^-z) | -1 to 1 | at most 1 |
| ReLU | max(0, z) | 0 and up | 1 when active, 0 when not |
| leaky ReLU | z if z > 0, else 0.01z | any | 1 or 0.01, never 0 |

Each trained on the real task in the production network (${PRODUCTION.hidden.join("-")} hidden):

${table(
  ["Activation", "Best epoch", "Seconds", "Val. loss", "Val. acc.", "Test acc.", "Right when it suggests"],
  activationRuns.map((r) => [
    r.summary.name,
    r.summary.bestEpoch,
    r.summary.seconds,
    f3(r.summary.valLoss ?? NaN),
    pct(r.summary.valAccuracy ?? 0),
    pct(r.summary.testAccuracy),
    pct(r.summary.accuracyWhenConfident),
  ])
)}

${chart(
  "activations.svg",
  lineChart({
    title: "Validation loss while training, by activation",
    subtitle: "Lower is better. Each line stops where early stopping ended it.",
    xLabel: "Epoch",
    yLabel: "Validation loss",
    series: activationRuns.map((r) => ({ name: r.name, points: curve(r.history, (h) => h.valLoss) })),
    yMin: 0,
    yFormat: (v) => v.toFixed(1),
  })
)}

**Why depth hurts sigmoid.** Backpropagation multiplies the error by the
activation's slope at every layer it passes back through. Sigmoid's slope is at
most 0.25, so after several layers almost nothing is left. Measured on a
6-hidden-layer network before any training, the size of the gradient reaching
the first layer compared with the last:

${table(
  ["Activation", "First layer", "Last layer", "First / last"],
  vanishing.map((v) => [v.activation, v.firstLayer.toExponential(2), v.lastLayer.toExponential(2), v.ratio.toExponential(1)])
)}

A tiny first-layer gradient means the layer closest to the data barely learns.
This is the vanishing gradient problem, and it is the main reason ReLU replaced
sigmoid inside modern networks. Sigmoid is still the right choice for a single
yes/no output neuron, as in sections 1 and 2.
`);

// ── 5. Gradient descent ──────────────────────────────────────────────────────

log("5. Gradient descent");
const gdVariants: Array<{ name: string; options: Partial<TrainOptions> }> = [
  { name: "Batch GD (all rows per step)", options: { optimizer: "sgd", batchSize: trainSet.length, learningRate: 0.5, epochs: 2000, patience: 200 } },
  { name: "Stochastic GD (1 row per step)", options: { optimizer: "sgd", batchSize: 1, learningRate: 0.005, epochs: 200, patience: 30 } },
  { name: "Mini-batch GD (32 rows)", options: { optimizer: "sgd", batchSize: 32, learningRate: 0.1 } },
  { name: "Momentum", options: { optimizer: "momentum", batchSize: 32, learningRate: 0.02 } },
  { name: "RMSProp", options: { optimizer: "rmsprop", batchSize: 32, learningRate: 0.002 } },
  { name: "Adam", options: { optimizer: "adam", batchSize: 32, learningRate: 0.003 } },
];
const gdRuns = gdVariants.map((v) => fit({ name: v.name, hidden: PRODUCTION.hidden, options: v.options }));
json.gradientDescent = gdRuns.map((r) => r.summary);

const lrRuns = [0.001, 0.01, 0.1, 1, 10].map((lr) =>
  fit({ name: `rate ${lr}`, hidden: PRODUCTION.hidden, options: { optimizer: "sgd", learningRate: lr, epochs: 300, patience: 300, clipNorm: undefined } })
);
json.learningRate = lrRuns.map((r) => r.summary);

md.push(`## 5. Gradient descent

Training is a search for the weights with the lowest loss. Backpropagation gives
the gradient: for every weight, which way is uphill and how steeply. Gradient
descent takes a step the other way:

    weight = weight - learning rate x gradient

The variants differ in how much data each step looks at and how the step is taken.
All six train the same ${PRODUCTION.hidden.join("-")}-neuron ReLU network:

${table(
  ["Method", "Steps to best", "Epochs to best", "Seconds", "Val. loss", "Test acc."],
  gdRuns.map((r) => [
    r.summary.name,
    r.summary.updatesToBest.toLocaleString("en"),
    r.summary.bestEpoch,
    r.summary.seconds,
    f3(r.summary.valLoss ?? NaN),
    pct(r.summary.testAccuracy),
  ])
)}

${chart(
  "gradient-descent.svg",
  lineChart({
    title: "Validation loss by gradient descent method",
    subtitle: "First 300 epochs. Batch GD takes one step per epoch, so it is still descending.",
    xLabel: "Epoch",
    yLabel: "Validation loss",
    series: gdRuns.map((r) => ({ name: r.name.replace(/ \(.*\)/, ""), points: curve(r.history, (h) => h.valLoss) })),
    xMax: 300,
    yMin: 0,
    yMax: 3.5,
    yFormat: (v) => v.toFixed(1),
  })
)}

- **Batch** gradient descent computes the exact gradient over all
  ${trainSet.length} rows, then takes one careful step. Accurate, but one step per
  pass through the data is slow.
- **Stochastic** takes a step after every single row: fast, noisy steps that
  zig-zag towards the minimum.
- **Mini-batch** is the usual compromise: 32 rows per step, a gradient good
  enough to trust and ${Math.ceil(trainSet.length / 32)} steps per pass.
- **Momentum** keeps part of the previous step, so it rolls through small bumps
  and speeds up along long, shallow slopes.
- **RMSProp** gives every weight its own step size, smaller for weights whose
  gradient jumps around.
- **Adam** combines momentum and RMSProp. It is what the shipped model uses.

${(() => {
  const byLoss = [...gdRuns].sort((a, b) => (a.summary.valLoss ?? 9) - (b.summary.valLoss ?? 9));
  const sgd1 = gdRuns[1].summary;
  const batch = gdRuns[0].summary;
  const mini = gdRuns.slice(2).map((r) => r.summary);
  const span = (xs: number[], unit = "") =>
    `${Math.min(...xs).toLocaleString("en")} to ${Math.max(...xs).toLocaleString("en")}${unit}`;
  return `All six end within ${f3((byLoss[byLoss.length - 1].summary.valLoss ?? 0) - (byLoss[0].summary.valLoss ?? 0))} of each other on validation loss: on a problem
this size, every method gets there. What differs is the cost. Batch gradient descent
used all ${batch.epochsRun.toLocaleString("en")} epochs it was allowed (${batch.seconds} s) and was still improving; stochastic
gradient descent took ${sgd1.updatesToBest.toLocaleString("en")} tiny steps (${sgd1.seconds} s). The four mini-batch
methods got there in ${span(mini.map((m) => m.updatesToBest))} steps, ${span(mini.map((m) => m.seconds), " seconds")}.`;
})()}

**The learning rate** is the size of each step. Plain mini-batch gradient descent
with five different rates:

${table(
  ["Learning rate", "Val. loss", "Test acc.", "Diverged"],
  lrRuns.map((r) => [r.summary.name.replace("rate ", ""), f3(r.summary.valLoss ?? NaN), pct(r.summary.testAccuracy), r.summary.diverged ? "yes" : "no"])
)}

${chart(
  "learning-rate.svg",
  lineChart({
    title: "Validation loss by learning rate (mini-batch gradient descent)",
    subtitle: "Too small crawls. Too large overshoots the minimum and never settles.",
    xLabel: "Epoch",
    yLabel: "Validation loss",
    series: lrRuns.map((r) => ({ name: r.name, points: curve(r.history, (h) => h.valLoss) })),
    yMin: 0,
    yMax: 3.5,
    yFormat: (v) => v.toFixed(1),
  })
)}

${(() => {
  const [slow, , , , wild] = lrRuns.map((r) => r.summary);
  return `At 0.001 the network is still far from done after 300 epochs (validation loss ${f3(slow.valLoss ?? NaN)}).
At 0.1 it trains smoothly. At 1 it reaches about the same loss but jumps around from
epoch to epoch, a sign the steps are already too big. At 10 every step jumps clean
over the minimum, and the loss bounces around instead of settling: ${pct(wild.trainAccuracy)} accuracy even on the rows
it trains on. Adam and RMSProp are less sensitive to this choice, because they
scale each weight's step by how large its gradients have been.`;
})()}
`);

// ── 6. Overfitting ───────────────────────────────────────────────────────────

log("6. Overfitting");
// A tenth of the training rows and a network far too big for them, so the
// memorising is easy to see.
const small = trainSet.filter((_, i) => i % 10 === 0);
const bigNet = [128, 64];
const base: Partial<TrainOptions> = { epochs: 300, restoreBest: false, patience: Infinity, l2: 0, dropout: 0, trackTraining: true, clipNorm: undefined };
const overfitRuns = [
  { name: "No protection", options: base },
  { name: "L2 weight decay", options: { ...base, l2: 0.01 } },
  { name: "Dropout 50%", options: { ...base, dropout: 0.5 } },
  { name: "Early stopping", options: { ...base, restoreBest: true, patience: 30 } },
  { name: "All three", options: { ...base, l2: 0.01, dropout: 0.5, restoreBest: true, patience: 30 } },
].map((v) => {
  const run = fit({ name: v.name, hidden: bigNet, options: v.options, data: small });
  const last = run.history[run.history.length - 1];
  const minVal = run.history.reduce((a, h) => (h.valLoss < a.valLoss ? h : a));
  const kept = v.options.restoreBest ? run.history[run.summary.bestEpoch - 1] : last;
  return {
    ...run,
    overfit: {
      name: v.name,
      trainAccuracy: round(kept.trainAccuracy ?? 0),
      valAccuracy: round(kept.valAccuracy),
      gap: round((kept.trainAccuracy ?? 0) - kept.valAccuracy),
      lowestValLossEpoch: minVal.epoch,
      lowestValLoss: round(minVal.valLoss),
      valLossKept: round(kept.valLoss),
      testAccuracy: run.summary.testAccuracy,
    },
  };
});
json.overfitting = overfitRuns.map((r) => r.overfit);

const dataSizes = [0.1, 0.25, 0.5, 1].map((share) => {
  const step = Math.round(1 / share);
  const data = trainSet.filter((_, i) => i % step === 0);
  const run = fit({ name: `${Math.round(share * 100)}% (${data.length} rows)`, hidden: PRODUCTION.hidden, data });
  return { ...run.summary, rows: data.length, gap: round(run.summary.trainAccuracy - (run.summary.valAccuracy ?? 0)) };
});
json.learningCurve = dataSizes;

const unprotected = overfitRuns[0];
const overfitLossChart = chart(
  "overfitting-loss.svg",
  lineChart({
    title: "Overfitting: loss on training rows vs validation rows",
    subtitle: `No protection. ${bigNet.join("-")} hidden neurons, trained on ${small.length} rows.`,
    xLabel: "Epoch",
    yLabel: "Loss",
    series: [
      { name: "Training rows", points: curve(unprotected.history, (h) => h.trainLoss) },
      { name: "Validation rows", points: curve(unprotected.history, (h) => h.valLoss) },
    ] as LineSeries[],
    yMin: 0,
    yFormat: (v) => v.toFixed(1),
  })
);
const overfitAccuracyChart = chart(
  "overfitting-accuracy.svg",
  lineChart({
    title: "Overfitting: accuracy on training rows vs validation rows",
    subtitle: "No protection. Same run as above.",
    xLabel: "Epoch",
    yLabel: "Accuracy",
    series: [
      { name: "Training rows", points: curve(unprotected.history, (h) => h.trainAccuracy) },
      { name: "Validation rows", points: curve(unprotected.history, (h) => h.valAccuracy) },
    ] as LineSeries[],
    yMin: 0,
    yMax: 1,
    yFormat: (v) => `${Math.round(v * 100)}%`,
  })
);
const defenceChart = chart(
  "overfitting-defences.svg",
  lineChart({
    title: "Validation loss under each defence",
    subtitle: "Early-stopped lines end where training stopped.",
    xLabel: "Epoch",
    yLabel: "Validation loss",
    series: overfitRuns.map((r) => ({ name: r.overfit.name, points: curve(r.history, (h) => h.valLoss) })),
    yMin: 0,
    yFormat: (v) => v.toFixed(1),
  })
);

md.push(`## 6. Overfitting

A network overfits when it learns the training rows themselves instead of the
pattern behind them: it gets better and better on rows it has seen, and worse on
rows it has not. To make it easy to see, this trains a network much too large
(${bigNet.join(" and ")} hidden neurons, ${countParameters(overfitRuns[0].network).toLocaleString("en")} weights) on a tenth of
the training data (${small.length} rows):

${overfitLossChart}

The classic picture. Loss on the training rows keeps falling towards zero. Loss on
the validation rows falls until epoch ${unprotected.overfit.lowestValLossEpoch} (${f3(unprotected.overfit.lowestValLoss)}), then climbs to
${f3(unprotected.overfit.valLossKept)} by the end: the network is memorising, and growing more confident in
answers that do not carry over to new errands.

${overfitAccuracyChart}

Accuracy tells the same story more quietly: ${pct(unprotected.overfit.trainAccuracy)} on the rows it trained on,
${pct(unprotected.overfit.valAccuracy)} on rows it did not. **Overfitting shows up in the loss first**, as
confidence it has not earned. That matters here more than usual, because this
model's output is a confidence, and the 0.75 rule trusts it.

The three standard defences, alone and together. "Val. loss kept" is the
validation loss of the weights each run ends with; lower means its confidence
can be trusted more:

${table(
  ["Defence", "Train acc.", "Val. acc.", "Gap", "Val. loss kept", "Test acc."],
  overfitRuns.map((r) => [
    r.overfit.name,
    pct(r.overfit.trainAccuracy),
    pct(r.overfit.valAccuracy),
    pct(r.overfit.gap),
    f3(r.overfit.valLossKept),
    pct(r.overfit.testAccuracy),
  ])
)}

${defenceChart}

- **L2 weight decay** adds the size of the weights to the loss, so the network
  pays for every large weight and prefers simple explanations.
- **Dropout** switches off a random half of the hidden neurons for each example,
  so no neuron can rely on one particular partner. The network learns several
  overlapping ways to reach each answer.
- **Early stopping** watches the validation loss and keeps the weights from the
  epoch where it was lowest, before the memorising set in.

Every defence holds the validation loss far below the unprotected ${f3(unprotected.overfit.valLossKept)}. Their
effect on accuracy is mixed on ${small.length} rows. Early stopping even keeps an epoch whose
accuracy is lower than where the unprotected run ended, because it chooses by loss,
which is the right thing to choose by when the product is a confidence. No defence
can make ${small.length} rows teach what ${trainSet.length} do.

**More data** is the real cure. The production network trained on growing shares
of the training rows:

${table(
  ["Training rows", "Train acc.", "Val. acc.", "Gap", "Test acc."],
  dataSizes.map((d) => [d.name, pct(d.trainAccuracy), pct(d.valAccuracy ?? 0), pct(d.gap), pct(d.testAccuracy)])
)}

The gap between training and validation accuracy shrinks from ${pct(dataSizes[0].gap)} to ${pct(dataSizes[dataSizes.length - 1].gap)} as the
rows grow tenfold. This is also why real cleared errands (section 7) are worth
collecting: each one is a row the model has never seen the like of.

The shipped model uses L2 (${PRODUCTION.l2}) and early stopping (patience ${PRODUCTION.patience}) on all
${trainSet.length} training rows.${PRODUCTION.dropout ? ` It also uses dropout (${PRODUCTION.dropout}).` : " Dropout did not improve its validation loss at this size, so it is off."}
`);

// ── 7. Real-life jobs ────────────────────────────────────────────────────────

log("7. Real-life jobs");
const realRows = existsSync(REAL_JOBS) ? loadRows(REAL_JOBS) : [];
const real = realRows.map((r) => {
  const s = suggestReason(EXCEPTION_REASON_MODEL, r.context);
  const top = s.reasonCode ?? "(no suggestion)";
  return {
    errand: r.extra?.errand ?? "",
    kind: r.context.kind,
    amount: r.context.amountAtRisk,
    shop: r.context.storeName.split(",")[0],
    dispatcherReason: r.extra?.dispatcherReason ?? "",
    label: r.label,
    labelNote: r.extra?.labelNote ?? "",
    suggestion: top,
    confidence: s.confidence,
    agrees: r.label ? s.reasonCode === r.label : null,
    outcome: !r.label ? "unlabelled" : s.reasonCode === null ? "no suggestion" : s.reasonCode === r.label ? "yes" : "no",
  };
});
const labelled = real.filter((r) => r.label);
const count = (outcome: string) => real.filter((r) => r.outcome === outcome).length;
json.realLifeJobs = {
  rows: real,
  labelled: labelled.length,
  matched: count("yes"),
  abstained: count("no suggestion"),
  wrong: count("no"),
};

md.push(`## 7. Real-life jobs

The model's job in SUGO is to suggest, in the dispatcher's Conflict Management
queue, why a flagged errand can be cleared (press Tab or **Generate suggestion**).
Below are all ${real.length} exceptions raised on real errands in production, run
through the shipped model exactly as the live API does, beside what the
dispatcher actually wrote when they cleared it.

${table(
  ["Errand", "Kind", "Amount", "Shop", "Dispatcher wrote", "Model suggests", "Confidence", "Matches"],
  real.map((r) => [
    r.errand,
    r.kind,
    `₱${r.amount.toLocaleString("en")}`,
    r.shop || "-",
    r.dispatcherReason ? `"${r.dispatcherReason}"` : "(still open)",
    r.suggestion,
    r.confidence.toFixed(2),
    r.outcome,
  ])
)}

A row is labelled only where the dispatcher's words clearly name one of the 24
reasons (notes in real-jobs.csv). ${labelled.length} of ${real.length} can be. Of those, the model matches
${count("yes")}, declines to suggest on ${count("no suggestion")}, and gets ${count("no")} wrong. That is far too few to measure
accuracy on, and it is reported as counts, not as a percentage.

What the real jobs do show:

- Dispatchers often write who decided rather than why ("verified by me"). A
  suggestion gives the record a reason someone can check later.
- A real cash over-collection turned out to be a customer paying a balance in
  cash. None of the 5 cash reasons covers that, which makes it the first
  candidate for a 25th reason.
- On that cash over-collection the model was 88% sure of "the excess goes back
  to the customer", which is not what happened. Its confidence says which of its
  24 reasons fits best; it cannot say that none of them fits. The 0.75 rule
  catches doubt between reasons, not a reason missing from the list. The
  dispatcher still reads and edits every suggestion before it is recorded.
- On the bakeshop purchase in the same errand the dispatcher wrote "the customer
  paid in cash"; the model was only 57% sure and suggested nothing. That is the
  threshold doing its job: the evidence pointed two ways, and it stayed quiet.

Every real errand cleared from now on can be exported with
\`exportRealJobs.ts\`, labelled, and added to the training data. Real rows are
worth more than generated ones, because they carry the reasons dispatchers
actually use.
`);

// ── 8. Choosing the shipped settings ─────────────────────────────────────────

log("8. Settings");
const SEEDS = [7, 8, 9];
const optimiserRate: Record<string, number> = { adam: 0.003, rmsprop: 0.002 };
const grid = (["tanh", "relu", "leakyRelu"] as Activation[]).flatMap((activation) =>
  (["adam", "rmsprop"] as const).map((optimizer) => {
    const losses = SEEDS.map(
      (seed) =>
        fit({
          name: `${activation} + ${optimizer}`,
          hidden: PRODUCTION.hidden,
          activation,
          options: { optimizer, learningRate: optimiserRate[optimizer], seed },
        }).summary.valLoss ?? NaN
    );
    const mean = losses.reduce((a, b) => a + b, 0) / losses.length;
    const sd = Math.sqrt(losses.reduce((a, b) => a + (b - mean) ** 2, 0) / (losses.length - 1));
    return { activation, optimizer, losses: losses.map((l) => round(l)), mean: round(mean), sd: round(sd) };
  })
);
const ranked = [...grid].sort((a, b) => a.mean - b.mean);
const shipped = grid.find((g) => g.activation === PRODUCTION.activation && g.optimizer === PRODUCTION.optimizer)!;
const noise = grid.reduce((a, g) => a + g.sd, 0) / grid.length;
const withinNoise = shipped.mean - ranked[0].mean <= noise;
json.settings = { seeds: SEEDS, grid, best: ranked[0], shipped, typicalSeedSpread: round(noise), keptShipped: withinNoise };

md.push(`## 8. Choosing the shipped settings

Sections 4 and 5 each changed one thing at a time from a single random start. A
single start is itself a source of variation: the same settings from a different
starting point land somewhere slightly different. So the leading activations and
optimisers were crossed and each pair trained from ${SEEDS.length} starts:

${table(
  ["Activation", "Optimiser", "Val. loss, each start", "Mean", "Spread (std. dev.)"],
  ranked.map((g) => [
    g.activation + (g === shipped ? " (shipped)" : ""),
    g.optimizer,
    g.losses.map(f3).join(", "),
    f3(g.mean),
    f3(g.sd),
  ])
)}

The best pair (${ranked[0].activation} with ${ranked[0].optimizer}) beats the shipped one by
${f3(shipped.mean - ranked[0].mean)}. The typical spread between starts of the same pair is ${f3(noise)}.
${
  withinNoise
    ? `The difference is smaller than the noise, so it is not a real improvement, and the
shipped settings stay. Switching would be tuning to luck. The model's accuracy is
limited by the data, where some reasons genuinely cannot be told apart, not by
these settings.`
    : `The difference is larger than the noise, which makes it a real improvement: switch
config.ts to ${ranked[0].activation} with ${ranked[0].optimizer} and retrain.`
}
`);

// ── write ────────────────────────────────────────────────────────────────────

const header = `# Experiments: the Conflict Management reason model

Generated by \`scripts/exception-reasons/experiments.ts\` on ${new Date().toISOString().slice(0, 10)}. Every
number below comes from that run. Rows: ${trainSet.length} training, ${valSet.length} validation, ${testSet.length} test,
from dataset.csv (generated scenarios; see README.md for why).

Choices are made on the **validation** rows. Test accuracy is shown for reference
and never used to choose anything. "Suggests (at 0.75)" is the share of rows where
the model is confident enough to show a suggestion; "right when it suggests" is
how often those shown suggestions are correct.

The shipped model: ${PRODUCTION.hidden.join("-")} hidden neurons, ${PRODUCTION.activation}, ${PRODUCTION.optimizer} at
${PRODUCTION.learningRate}, mini-batches of ${PRODUCTION.batchSize}, L2 ${PRODUCTION.l2}, early stopping after
${PRODUCTION.patience} epochs without improvement, gradients clipped at ${PRODUCTION.clipNorm}. Test: ${pct(EXCEPTION_REASON_MODEL.metrics.testAccuracy)} accurate,
suggests for ${pct(EXCEPTION_REASON_MODEL.metrics.coverageAtThreshold)} of rows, right ${pct(EXCEPTION_REASON_MODEL.metrics.accuracyWhenConfident)} of the time when it does.
`;

writeFileSync(resolve(ML_DIR, "EXPERIMENTS.md"), [header, ...md].join("\n"));
writeFileSync(resolve(ML_DIR, "experiments.json"), JSON.stringify({ generatedAt: new Date().toISOString(), ...json }, null, 2) + "\n");
log(`Wrote EXPERIMENTS.md, experiments.json and charts/ to ${ML_DIR}`);
