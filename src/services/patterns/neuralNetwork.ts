/**
 * A feed-forward neural network, trained by backpropagation.
 *
 * Written out by hand rather than pulled from a library. The networks this
 * server trains are small (a few thousand weights), training takes seconds, and
 * keeping every step in one readable file is what lets a test prove the
 * gradients are right (tests/neuralNetwork.test.ts checks them against
 * numerically measured slopes) instead of taking a dependency's word for it.
 *
 * What it covers:
 *   - Any number of layers of any width, including none: `hidden: []` is one
 *     layer of output neurons, `hidden: [2]` with one sigmoid output is the
 *     three-neuron network that solves XOR.
 *   - Four activation functions for the hidden layers: sigmoid, tanh, ReLU and
 *     leaky ReLU.
 *   - Two kinds of output: a softmax over many classes (optionally masked per
 *     sample), or a single sigmoid neuron answering yes or no.
 *   - Gradient descent in four forms: plain, with momentum, RMSProp and Adam.
 *     Batch size decides batch, mini-batch or stochastic.
 *   - Protection against overfitting: L2 weight decay, dropout and early
 *     stopping on a validation set.
 *   - Protection against blowing up: gradient-norm clipping, and training stops
 *     and reports it when the loss stops being a number.
 *
 * Pure: no database, no clock, no Math.random. Every random draw comes from a
 * seeded generator, so the same data and seed always produce the same weights.
 */

export type Activation = "sigmoid" | "tanh" | "relu" | "leakyRelu";
export type OutputKind = "softmax" | "sigmoid";
export type OptimizerName = "sgd" | "momentum" | "rmsprop" | "adam";

export interface Layer {
  inputSize: number;
  outputSize: number;
  /** outputSize x inputSize, row-major: weights[j * inputSize + i] carries input i into neuron j. */
  weights: number[];
  biases: number[];
}

export interface Network {
  layers: Layer[];
  /** Applied to every layer's output except the last. */
  hiddenActivation: Activation;
  /** How the last layer's sums become an answer. */
  output: OutputKind;
}

export interface Sample {
  x: number[];
  /** Softmax: index of the correct class. Sigmoid: 1 for yes, 0 for no. */
  y: number;
  /** Softmax only: classes this sample may take. Undefined means every class. */
  allowed?: boolean[];
}

// ── activation functions ─────────────────────────────────────────────────────

const LEAK = 0.01;

const sigmoid = (z: number) => {
  // Split by sign so exp never sees a large positive number and overflows.
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
};

/**
 * Each activation, its derivative, and how to initialise the weights feeding it.
 *
 * The derivative is what backpropagation multiplies the error by on its way
 * back through a neuron. It is why sigmoid trains slowly in deep networks (its
 * slope is never more than 0.25, so the error shrinks at every layer) and why
 * ReLU trains fast (a slope of exactly 1 wherever the neuron is active).
 */
export const ACTIVATIONS: Record<
  Activation,
  { fn: (z: number) => number; slope: (z: number) => number; init: "he" | "xavier" }
> = {
  sigmoid: { fn: sigmoid, slope: (z) => sigmoid(z) * (1 - sigmoid(z)), init: "xavier" },
  tanh: { fn: Math.tanh, slope: (z) => 1 - Math.tanh(z) ** 2, init: "xavier" },
  relu: { fn: (z) => (z > 0 ? z : 0), slope: (z) => (z > 0 ? 1 : 0), init: "he" },
  // A small slope below zero, so a neuron pushed negative can still learn its
  // way back instead of going silent for good (a "dead" ReLU).
  leakyRelu: { fn: (z) => (z > 0 ? z : LEAK * z), slope: (z) => (z > 0 ? 1 : LEAK), init: "he" },
};

// ── randomness ───────────────────────────────────────────────────────────────

/** mulberry32: small, fast, and good enough to shuffle and initialise with. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number): number {
  // Box-Muller. 1 - rand() keeps log away from zero.
  const u = 1 - rand();
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ── building a network ───────────────────────────────────────────────────────

export interface NetworkSpec {
  inputs: number;
  /** Width of each hidden layer, in order. Empty for no hidden layer. */
  hidden: number[];
  outputs: number;
  activation?: Activation;
  output?: OutputKind;
}

/**
 * Random starting weights, scaled to the activation they feed.
 *
 * He initialisation (variance 2 / inputs) for the ReLU family, Glorot
 * (2 / (inputs + outputs)) for sigmoid, tanh and the output layer. The wrong
 * scale makes signals shrink or grow layer by layer before training starts.
 * Starting from zeros would be worse still: every neuron in a layer would get
 * the same gradient and stay identical forever.
 */
export function createNetwork(spec: NetworkSpec, rand: () => number): Network {
  const activation = spec.activation ?? "relu";
  const output = spec.output ?? "softmax";
  if (output === "sigmoid" && spec.outputs !== 1) {
    throw new Error("A sigmoid output is one neuron answering yes or no; use softmax for several classes.");
  }

  const sizes = [spec.inputs, ...spec.hidden, spec.outputs];
  const layers: Layer[] = [];
  for (let l = 0; l < sizes.length - 1; l++) {
    const fanIn = sizes[l];
    const fanOut = sizes[l + 1];
    const isOutput = l === sizes.length - 2;
    const scheme = isOutput ? "xavier" : ACTIVATIONS[activation].init;
    const std = scheme === "he" ? Math.sqrt(2 / fanIn) : Math.sqrt(2 / (fanIn + fanOut));
    layers.push({
      inputSize: fanIn,
      outputSize: fanOut,
      weights: Array.from({ length: fanIn * fanOut }, () => gaussian(rand) * std),
      biases: new Array(fanOut).fill(0),
    });
  }
  return { layers, hiddenActivation: activation, output };
}

export function countParameters(net: Network): number {
  return net.layers.reduce((n, l) => n + l.weights.length + l.biases.length, 0);
}

/** "36-24-24, relu, softmax" */
export function describeNetwork(net: Network): string {
  const sizes = [net.layers[0].inputSize, ...net.layers.map((l) => l.outputSize)];
  return `${sizes.join("-")}, ${net.layers.length > 1 ? net.hiddenActivation : "no hidden layer"}, ${net.output}`;
}

// ── forward pass ─────────────────────────────────────────────────────────────

export function maskedSoftmax(logits: number[], allowed?: boolean[]): number[] {
  let max = -Infinity;
  for (let k = 0; k < logits.length; k++) {
    if (!allowed || allowed[k]) max = Math.max(max, logits[k]);
  }
  if (max === -Infinity) throw new Error("No output is allowed for this sample.");

  // Shifted by the max so exp never overflows; the shift cancels in the ratio.
  const exps = logits.map((z, k) => (!allowed || allowed[k] ? Math.exp(z - max) : 0));
  const sum = exps.reduce((s, e) => s + e, 0);
  return exps.map((e) => e / sum);
}

interface Trace {
  /** What entered each layer: activations[0] is the input itself. */
  activations: number[][];
  /** Each layer's weighted sums, before its activation. Backprop needs these. */
  sums: number[][];
  /** The dropout mask each hidden layer was multiplied by, if any. */
  masks: (number[] | null)[];
  probs: number[];
}

interface DropoutRun {
  rate: number;
  rand: () => number;
}

function run(net: Network, x: number[], allowed?: boolean[], dropout?: DropoutRun): Trace {
  if (x.length !== net.layers[0].inputSize) {
    throw new Error(`Expected ${net.layers[0].inputSize} inputs, got ${x.length}.`);
  }
  const act = ACTIVATIONS[net.hiddenActivation].fn;
  const activations: number[][] = [x];
  const sums: number[][] = [];
  const masks: (number[] | null)[] = [];
  let a = x;

  for (let l = 0; l < net.layers.length; l++) {
    const { inputSize: n, outputSize: m, weights, biases } = net.layers[l];
    const z = new Array<number>(m);
    for (let j = 0; j < m; j++) {
      let s = biases[j];
      for (let i = 0; i < n; i++) s += weights[j * n + i] * a[i];
      z[j] = s;
    }
    sums.push(z);

    if (l === net.layers.length - 1) {
      const probs = net.output === "sigmoid" ? [sigmoid(z[0])] : maskedSoftmax(z, allowed);
      return { activations, sums, masks, probs };
    }

    let next = z.map(act);
    if (dropout && dropout.rate > 0) {
      // Inverted dropout: silence a random share of neurons for this one
      // example and scale up the rest, so nothing changes at prediction time.
      const keep = 1 - dropout.rate;
      const mask = next.map(() => (dropout.rand() < keep ? 1 / keep : 0));
      next = next.map((v, j) => v * mask[j]);
      masks.push(mask);
    } else {
      masks.push(null);
    }
    activations.push(next);
    a = next;
  }
  throw new Error("A network needs at least one layer.");
}

/** The network's answer: class probabilities, or [P(yes)] for a sigmoid output. */
export function predict(net: Network, x: number[], allowed?: boolean[]): number[] {
  return run(net, x, allowed).probs;
}

export function argmax(values: number[]): number {
  let best = 0;
  for (let k = 1; k < values.length; k++) if (values[k] > values[best]) best = k;
  return best;
}

/** The class the network picks: argmax for softmax, yes at 0.5 or above for sigmoid. */
export function classify(net: Network, x: number[], allowed?: boolean[]): number {
  const probs = predict(net, x, allowed);
  return net.output === "sigmoid" ? (probs[0] >= 0.5 ? 1 : 0) : argmax(probs);
}

function sampleLoss(net: Network, probs: number[], y: number): number {
  if (net.output === "sigmoid") {
    const p = Math.min(Math.max(probs[0], 1e-12), 1 - 1e-12);
    return -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
  }
  return -Math.log(Math.max(probs[y], 1e-12));
}

// ── backpropagation ──────────────────────────────────────────────────────────

export type Gradients = Array<{ weights: number[]; biases: number[] }>;

function zerosLike(net: Network): Gradients {
  return net.layers.map((l) => ({
    weights: new Array(l.weights.length).fill(0),
    biases: new Array(l.biases.length).fill(0),
  }));
}

/**
 * Mean loss over a batch, plus L2 on the weights, and the gradient of that loss
 * with respect to every weight and bias.
 *
 * This is backpropagation. The error is measured at the output, then carried
 * backwards one layer at a time by the chain rule: each layer's error is the
 * next layer's error, sent back through the same weights, times the slope of
 * this layer's activation.
 */
export function lossAndGradients(
  net: Network,
  batch: Sample[],
  l2 = 0,
  dropout?: DropoutRun
): { loss: number; grads: Gradients } {
  const grads = zerosLike(net);
  const slope = ACTIVATIONS[net.hiddenActivation].slope;
  let loss = 0;

  for (const s of batch) {
    if (net.output === "softmax" && s.allowed && !s.allowed[s.y]) {
      throw new Error(`Sample labelled ${s.y}, which its own mask forbids.`);
    }
    const { activations, sums, masks, probs } = run(net, s.x, s.allowed, dropout);
    loss += sampleLoss(net, probs, s.y);

    // Output error. Softmax with cross-entropy, and sigmoid with binary
    // cross-entropy, both differentiate to (predicted - target): the maths is
    // chosen so the output layer's error is simply how wrong it was. A masked
    // class has both at zero and sends nothing back.
    let delta =
      net.output === "sigmoid" ? [probs[0] - s.y] : probs.map((p, k) => p - (k === s.y ? 1 : 0));

    for (let l = net.layers.length - 1; l >= 0; l--) {
      const { inputSize: n, outputSize: m, weights } = net.layers[l];
      const input = activations[l];
      const g = grads[l];

      for (let j = 0; j < m; j++) {
        if (delta[j] === 0) continue;
        g.biases[j] += delta[j];
        for (let i = 0; i < n; i++) g.weights[j * n + i] += delta[j] * input[i];
      }
      if (l === 0) break;

      // Send the error back through the same weights, then through the slope of
      // the previous layer's activation, and through its dropout mask: a neuron
      // that was switched off contributed nothing, so it is blamed for nothing.
      const back = new Array<number>(n).fill(0);
      for (let j = 0; j < m; j++) {
        if (delta[j] === 0) continue;
        for (let i = 0; i < n; i++) back[i] += weights[j * n + i] * delta[j];
      }
      const z = sums[l - 1];
      const mask = masks[l - 1];
      delta = back.map((b, i) => b * slope(z[i]) * (mask ? mask[i] : 1));
    }
  }

  const count = batch.length;
  let penalty = 0;
  net.layers.forEach((layer, l) => {
    const g = grads[l];
    for (let q = 0; q < g.weights.length; q++) {
      // Weight decay on weights only; penalising biases just shifts outputs.
      g.weights[q] = g.weights[q] / count + l2 * layer.weights[q];
      penalty += layer.weights[q] ** 2;
    }
    for (let q = 0; q < g.biases.length; q++) g.biases[q] /= count;
  });

  return { loss: loss / count + (l2 / 2) * penalty, grads };
}

export function evaluate(net: Network, samples: Sample[]): { loss: number; accuracy: number } {
  if (samples.length === 0) return { loss: 0, accuracy: 0 };
  let loss = 0;
  let correct = 0;
  for (const s of samples) {
    const probs = predict(net, s.x, s.allowed);
    loss += sampleLoss(net, probs, s.y);
    const picked = net.output === "sigmoid" ? (probs[0] >= 0.5 ? 1 : 0) : argmax(probs);
    if (picked === s.y) correct += 1;
  }
  return { loss: loss / samples.length, accuracy: correct / samples.length };
}

// ── gradient descent ─────────────────────────────────────────────────────────

export interface TrainOptions {
  epochs: number;
  /**
   * Examples per weight update. All of them is batch gradient descent, one is
   * stochastic gradient descent, anything between is mini-batch.
   */
  batchSize: number;
  learningRate: number;
  /**
   * How each update is taken. "sgd" steps straight down the gradient;
   * "momentum" keeps rolling in the direction it was already going; "rmsprop"
   * gives each weight its own step size from how noisy its gradient has been;
   * "adam" does both. Default adam.
   */
  optimizer?: OptimizerName;
  /** L2 weight decay. Pulls weights towards zero so no single input dominates. */
  l2?: number;
  /** Share of hidden neurons switched off per example while training (0 to 0.9). */
  dropout?: number;
  /** Stop after this many epochs without the validation loss improving. Default: never. */
  patience?: number;
  /** Return the weights from the best validation epoch, not the last one. Default true. */
  restoreBest?: boolean;
  /** Learning rate at epoch e is learningRate / (1 + lrDecay * e). Default 0. */
  lrDecay?: number;
  /** Rescale any gradient whose overall length exceeds this. Default: no clipping. */
  clipNorm?: number;
  /** Also measure the training set every epoch (slower), for overfitting curves. */
  trackTraining?: boolean;
  seed: number;
}

export interface EpochRecord {
  epoch: number;
  learningRate: number;
  /** Mean loss over the epoch's batches, as training saw them (with dropout). */
  trainLoss: number;
  /** Only with trackTraining: the training set measured afterwards, without dropout. */
  trainAccuracy?: number;
  valLoss: number;
  valAccuracy: number;
}

export interface TrainResult {
  network: Network;
  history: EpochRecord[];
  bestEpoch: number;
  stoppedEarly: boolean;
  /** The loss went to infinity or NaN: the learning rate was too large. */
  diverged: boolean;
}

function cloneNetwork(net: Network): Network {
  return {
    ...net,
    layers: net.layers.map((l) => ({ ...l, weights: [...l.weights], biases: [...l.biases] })),
  };
}

function shuffle<T>(items: T[], rand: () => number): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
}

export function train(initial: Network, trainSet: Sample[], valSet: Sample[], options: TrainOptions): TrainResult {
  const rand = seededRandom(options.seed);
  const optimizer = options.optimizer ?? "adam";
  const l2 = options.l2 ?? 0;
  const patience = options.patience ?? Infinity;
  const restoreBest = options.restoreBest ?? true;
  const dropout = options.dropout ? { rate: options.dropout, rand } : undefined;

  const net = cloneNetwork(initial);
  // Per-weight optimiser memory: velocity for momentum, running averages of the
  // gradient and its square for RMSProp and Adam.
  const first = zerosLike(net);
  const second = zerosLike(net);
  const [beta1, beta2, epsilon] = [0.9, 0.999, 1e-8];
  let step = 0;

  let best = cloneNetwork(net);
  let bestLoss = Infinity;
  let bestEpoch = 0;
  let stoppedEarly = false;
  let diverged = false;
  const history: EpochRecord[] = [];
  const order = trainSet.map((_, i) => i);

  for (let epoch = 1; epoch <= options.epochs; epoch++) {
    const lr = options.learningRate / (1 + (options.lrDecay ?? 0) * (epoch - 1));
    shuffle(order, rand);
    let epochLoss = 0;

    for (let start = 0; start < order.length; start += options.batchSize) {
      const batch = order.slice(start, start + options.batchSize).map((i) => trainSet[i]);
      const { loss, grads } = lossAndGradients(net, batch, l2, dropout);
      if (!Number.isFinite(loss)) {
        diverged = true;
        break;
      }
      epochLoss += loss * batch.length;
      step += 1;

      if (options.clipNorm) {
        let norm = 0;
        for (const g of grads) for (const arr of [g.weights, g.biases]) for (const v of arr) norm += v * v;
        norm = Math.sqrt(norm);
        if (norm > options.clipNorm) {
          const scale = options.clipNorm / norm;
          for (const g of grads) for (const arr of [g.weights, g.biases]) for (let q = 0; q < arr.length; q++) arr[q] *= scale;
        }
      }

      net.layers.forEach((layer, l) => {
        for (const key of ["weights", "biases"] as const) {
          const w = layer[key];
          const g = grads[l][key];
          const m1 = first[l][key];
          const m2 = second[l][key];
          for (let q = 0; q < w.length; q++) {
            switch (optimizer) {
              case "sgd":
                w[q] -= lr * g[q];
                break;
              case "momentum":
                m1[q] = 0.9 * m1[q] - lr * g[q];
                w[q] += m1[q];
                break;
              case "rmsprop":
                m2[q] = 0.9 * m2[q] + 0.1 * g[q] * g[q];
                w[q] -= (lr * g[q]) / (Math.sqrt(m2[q]) + epsilon);
                break;
              case "adam": {
                m1[q] = beta1 * m1[q] + (1 - beta1) * g[q];
                m2[q] = beta2 * m2[q] + (1 - beta2) * g[q] * g[q];
                const mHat = m1[q] / (1 - beta1 ** step);
                const vHat = m2[q] / (1 - beta2 ** step);
                w[q] -= (lr * mHat) / (Math.sqrt(vHat) + epsilon);
                break;
              }
            }
          }
        }
      });
    }
    if (diverged) break;

    const val = evaluate(net, valSet);
    if (!Number.isFinite(val.loss)) {
      diverged = true;
      break;
    }
    history.push({
      epoch,
      learningRate: lr,
      trainLoss: epochLoss / trainSet.length,
      trainAccuracy: options.trackTraining ? evaluate(net, trainSet).accuracy : undefined,
      valLoss: val.loss,
      valAccuracy: val.accuracy,
    });

    if (val.loss < bestLoss - 1e-6) {
      bestLoss = val.loss;
      best = cloneNetwork(net);
      bestEpoch = epoch;
    } else if (epoch - bestEpoch >= patience) {
      stoppedEarly = true;
      break;
    }
  }

  return { network: restoreBest ? best : net, history, bestEpoch, stoppedEarly, diverged };
}
