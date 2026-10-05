import type { Activation, OptimizerName } from "../../src/services/patterns/neuralNetwork.js";

/**
 * The configuration the shipped model is trained with.
 *
 * Every choice here was made on the VALIDATION split, by the comparisons in
 * experiments.ts (see EXPERIMENTS.md), never on the test split. Choosing on
 * test rows would make the test score a measure of the choosing, not of the
 * model.
 */
export const PRODUCTION = {
  hidden: [24] as number[],
  activation: "relu" as Activation,
  optimizer: "adam" as OptimizerName,
  learningRate: 0.003,
  batchSize: 32,
  l2: 1e-3,
  dropout: 0,
  epochs: 600,
  patience: 60,
  clipNorm: 5,
  /** Seeds the starting weights, the shuffling and the dropout masks. */
  seed: 7,
};
