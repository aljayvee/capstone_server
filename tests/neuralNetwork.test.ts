import { describe, expect, it } from "vitest";
import {
  ACTIVATIONS,
  createNetwork,
  evaluate,
  lossAndGradients,
  maskedSoftmax,
  predict,
  seededRandom,
  train,
  type Activation,
  type Network,
  type OptimizerName,
  type Sample,
} from "../src/services/patterns/neuralNetwork.js";

const ALL_ACTIVATIONS: Activation[] = ["sigmoid", "tanh", "relu", "leakyRelu"];

/**
 * Nudge every weight a hair up and down, measure how the loss actually moves,
 * and compare with what backpropagation claimed. If the chain rule is wrong
 * anywhere, in any layer, for any activation, this is where it shows.
 */
function worstGradientError(net: Network, batch: Sample[], l2: number): number {
  const { grads } = lossAndGradients(net, batch, l2);
  const h = 1e-5;
  let worst = 0;
  net.layers.forEach((layer, l) => {
    for (const key of ["weights", "biases"] as const) {
      for (let q = 0; q < layer[key].length; q++) {
        const original = layer[key][q];
        layer[key][q] = original + h;
        const up = lossAndGradients(net, batch, l2).loss;
        layer[key][q] = original - h;
        const down = lossAndGradients(net, batch, l2).loss;
        layer[key][q] = original;
        const numeric = (up - down) / (2 * h);
        const analytic = grads[l][key][q];
        const relative = Math.abs(numeric - analytic) / Math.max(1e-7, Math.abs(numeric) + Math.abs(analytic));
        worst = Math.max(worst, relative);
      }
    }
  });
  return worst;
}

const randomBatch = (rand: () => number, inputs: number, count: number, classes: number): Sample[] =>
  Array.from({ length: count }, (_, i) => ({
    x: Array.from({ length: inputs }, () => rand() * 2 - 1),
    y: i % classes,
  }));

describe("backpropagation", () => {
  for (const activation of ALL_ACTIVATIONS) {
    it(`agrees with the numerical gradient through two ${activation} layers`, () => {
      const rand = seededRandom(11);
      const net = createNetwork({ inputs: 4, hidden: [5, 3], outputs: 3, activation }, rand);
      const batch = randomBatch(rand, 4, 6, 3);
      // One sample with a class masked off, which must pass no gradient back.
      batch[5] = { ...batch[5], y: 2, allowed: [true, false, true] };
      expect(worstGradientError(net, batch, 0.01)).toBeLessThan(1e-4);
    });
  }

  it("agrees with the numerical gradient for a single sigmoid output neuron", () => {
    const rand = seededRandom(5);
    const net = createNetwork({ inputs: 3, hidden: [4], outputs: 1, activation: "tanh", output: "sigmoid" }, rand);
    const batch = randomBatch(rand, 3, 6, 2);
    expect(worstGradientError(net, batch, 0)).toBeLessThan(1e-4);
  });

  it("agrees with the numerical gradient with no hidden layer at all", () => {
    const rand = seededRandom(9);
    const net = createNetwork({ inputs: 3, hidden: [], outputs: 4 }, rand);
    expect(worstGradientError(net, randomBatch(rand, 3, 8, 4), 0.001)).toBeLessThan(1e-4);
  });
});

describe("one neuron and three neurons", () => {
  const inputs = [
    [0, 0],
    [0, 1],
    [1, 0],
    [1, 1],
  ];
  const gate = (outputs: number[]): Sample[] => inputs.map((x, i) => ({ x, y: outputs[i] }));
  const learn = (data: Sample[], hidden: number[], seed: number) =>
    train(
      createNetwork({ inputs: 2, hidden, outputs: 1, activation: "tanh", output: "sigmoid" }, seededRandom(seed)),
      data,
      data,
      { epochs: 3000, batchSize: 4, learningRate: 0.05, optimizer: "adam", seed }
    ).network;

  it("one neuron learns AND and OR", () => {
    expect(evaluate(learn(gate([0, 0, 0, 1]), [], 1), gate([0, 0, 0, 1])).accuracy).toBe(1);
    expect(evaluate(learn(gate([0, 1, 1, 1]), [], 1), gate([0, 1, 1, 1])).accuracy).toBe(1);
  });

  it("one neuron cannot learn XOR: no straight line separates it", () => {
    const xor = gate([0, 1, 1, 0]);
    expect(evaluate(learn(xor, [], 1), xor).accuracy).toBeLessThan(1);
  });

  it("three neurons (two hidden, one output) learn XOR", () => {
    const xor = gate([0, 1, 1, 0]);
    const solved = [1, 2, 3, 4, 5].some((seed) => evaluate(learn(xor, [2], seed), xor).accuracy === 1);
    expect(solved).toBe(true);
  });
});

describe("gradient descent", () => {
  // Two blobs of points, one per class: every method should get there.
  const rand = seededRandom(21);
  const blobs: Sample[] = Array.from({ length: 80 }, (_, i) => {
    const y = i % 2;
    return { x: [y * 2 - 1 + (rand() - 0.5), -(y * 2 - 1) + (rand() - 0.5)], y };
  });

  const settings: Record<OptimizerName, number> = { sgd: 0.1, momentum: 0.05, rmsprop: 0.01, adam: 0.01 };
  for (const [optimizer, learningRate] of Object.entries(settings) as [OptimizerName, number][]) {
    it(`${optimizer} lowers the loss`, () => {
      const net = createNetwork({ inputs: 2, hidden: [4], outputs: 2 }, seededRandom(2));
      const before = evaluate(net, blobs).loss;
      const { network } = train(net, blobs, blobs, { epochs: 60, batchSize: 8, learningRate, optimizer, seed: 2 });
      expect(evaluate(network, blobs).loss).toBeLessThan(before * 0.5);
    });
  }

  it("reports divergence instead of returning weights that are not numbers", () => {
    const net = createNetwork({ inputs: 2, hidden: [8], outputs: 2 }, seededRandom(2));
    const huge = blobs.map((s) => ({ ...s, x: s.x.map((v) => v * 1e3) }));
    const result = train(net, huge, huge, { epochs: 50, batchSize: 8, learningRate: 1e6, optimizer: "sgd", seed: 2 });
    expect(result.diverged).toBe(true);
    expect(result.network.layers.every((l) => l.weights.every(Number.isFinite))).toBe(true);
  });

  it("trains to the same weights from the same seed", () => {
    const run = () =>
      train(createNetwork({ inputs: 2, hidden: [3], outputs: 2 }, seededRandom(5)), blobs, blobs, {
        epochs: 10,
        batchSize: 4,
        learningRate: 0.01,
        dropout: 0.3,
        seed: 5,
      }).network;
    expect(run().layers[0].weights).toEqual(run().layers[0].weights);
  });
});

describe("overfitting defences", () => {
  it("dropout acts only while training: predictions are repeatable", () => {
    const net = createNetwork({ inputs: 3, hidden: [16], outputs: 2 }, seededRandom(4));
    expect(predict(net, [0.2, -0.4, 0.9])).toEqual(predict(net, [0.2, -0.4, 0.9]));
  });

  it("early stopping keeps the best validation epoch, not the last", () => {
    const rand = seededRandom(8);
    const noisy: Sample[] = Array.from({ length: 30 }, () => ({ x: [rand(), rand(), rand()], y: rand() < 0.5 ? 1 : 0 }));
    const held: Sample[] = Array.from({ length: 30 }, () => ({ x: [rand(), rand(), rand()], y: rand() < 0.5 ? 1 : 0 }));
    const result = train(createNetwork({ inputs: 3, hidden: [32], outputs: 2 }, rand), noisy, held, {
      epochs: 300,
      batchSize: 5,
      learningRate: 0.01,
      patience: 20,
      seed: 8,
    });
    expect(result.stoppedEarly).toBe(true);
    expect(evaluate(result.network, held).loss).toBeCloseTo(result.history[result.bestEpoch - 1].valLoss, 10);
  });

  it("L2 keeps the weights smaller", () => {
    const rand = seededRandom(6);
    const data = randomBatch(rand, 4, 40, 2);
    const size = (l2: number) => {
      const { network } = train(createNetwork({ inputs: 4, hidden: [8], outputs: 2 }, seededRandom(6)), data, data, {
        epochs: 200,
        batchSize: 8,
        learningRate: 0.01,
        l2,
        seed: 6,
        restoreBest: false,
      });
      return network.layers[0].weights.reduce((s, w) => s + w * w, 0);
    };
    expect(size(0.05)).toBeLessThan(size(0));
  });
});

describe("activation functions", () => {
  it("each slope matches the function it belongs to", () => {
    for (const activation of ALL_ACTIVATIONS) {
      const { fn, slope } = ACTIVATIONS[activation];
      for (const z of [-2.3, -0.4, 0.7, 1.9]) {
        const numeric = (fn(z + 1e-6) - fn(z - 1e-6)) / 2e-6;
        expect(slope(z)).toBeCloseTo(numeric, 5);
      }
    }
  });

  it("sigmoid stays finite and exact at extreme inputs", () => {
    expect(ACTIVATIONS.sigmoid.fn(-1000)).toBe(0);
    expect(ACTIVATIONS.sigmoid.fn(1000)).toBe(1);
  });
});

describe("the masked output", () => {
  it("gives a forbidden class no probability at all", () => {
    const probs = maskedSoftmax([5, 1, 1], [false, true, true]);
    expect(probs[0]).toBe(0);
    expect(probs[1] + probs[2]).toBeCloseTo(1, 12);
  });

  it("refuses a sample labelled with a class its own mask forbids", () => {
    const net = createNetwork({ inputs: 2, hidden: [2], outputs: 2 }, seededRandom(1));
    expect(() => lossAndGradients(net, [{ x: [0, 0], y: 0, allowed: [false, true] }])).toThrow();
  });

  it("rejects an input of the wrong length rather than reading past it", () => {
    const net = createNetwork({ inputs: 3, hidden: [2], outputs: 2 }, seededRandom(1));
    expect(() => predict(net, [1, 2])).toThrow(/Expected 3 inputs/);
  });

  it("refuses a sigmoid output wider than one neuron", () => {
    expect(() => createNetwork({ inputs: 2, hidden: [], outputs: 3, output: "sigmoid" }, seededRandom(1))).toThrow();
  });
});
