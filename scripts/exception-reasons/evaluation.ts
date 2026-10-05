/**
 * Loading, splitting and scoring, shared by train.ts and experiments.ts so a
 * number in one report means exactly what it means in the other.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { argmax, predict, seededRandom, type Network, type Sample } from "../../src/services/patterns/neuralNetwork.js";
import {
  CONFIDENCE_THRESHOLD,
  EXCEPTION_KIND_ORDER,
  REASONS,
  REASON_CODES,
  encodeReasonContext,
  maskForKind,
} from "../../src/services/patterns/exceptionReasonModel.js";
import { fromCsv, type LabelledRow } from "./dataset.js";

const here = dirname(fileURLToPath(import.meta.url));
export const ML_DIR = resolve(here, "../../ml/exception-reasons");
export const DATASET = resolve(ML_DIR, "dataset.csv");
export const REAL_JOBS = resolve(ML_DIR, "real-jobs.csv");

/** The split seed. Fixed, so every experiment trains and tests on the same rows. */
export const SPLIT_SEED = 7;

export interface Row extends Sample {
  source: LabelledRow;
}

export function toSample(row: LabelledRow): Row {
  const y = REASON_CODES.indexOf(row.label);
  if (y < 0) throw new Error(`Unknown reason "${row.label}".`);
  if (REASONS[y].kind !== row.context.kind) {
    throw new Error(`Row labelled ${row.label} is a ${row.context.kind}, not a ${REASONS[y].kind}.`);
  }
  return { x: encodeReasonContext(row.context), y, allowed: maskForKind(row.context.kind), source: row };
}

export function loadRows(file = DATASET): LabelledRow[] {
  return fromCsv(readFileSync(file, "utf8"));
}

/** 70/15/15 within each reason, so a rare reason cannot land entirely in one part. */
export function stratifiedSplit(rows: Row[], seed = SPLIT_SEED) {
  const rand = seededRandom(seed);
  const trainSet: Row[] = [];
  const valSet: Row[] = [];
  const testSet: Row[] = [];
  for (let y = 0; y < REASON_CODES.length; y++) {
    const group = rows.filter((r) => r.y === y);
    for (let i = group.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [group[i], group[j]] = [group[j], group[i]];
    }
    const nTrain = Math.round(group.length * 0.7);
    const nVal = Math.round(group.length * 0.15);
    trainSet.push(...group.slice(0, nTrain));
    valSet.push(...group.slice(nTrain, nTrain + nVal));
    testSet.push(...group.slice(nTrain + nVal));
  }
  return { trainSet, valSet, testSet };
}

export function loadSplit() {
  return stratifiedSplit(loadRows().map(toSample));
}

export const round = (n: number, places = 4) => Math.round(n * 10 ** places) / 10 ** places;

/**
 * Accuracy, plus what the 0.75 rule does to it: how many rows would get a
 * suggestion, and how often a suggestion that is shown is right.
 */
export function measure(net: Network, rows: Row[]) {
  const scored = rows.map((r) => {
    const probs = predict(net, r.x, r.allowed);
    const best = argmax(probs);
    return { row: r, best, confidence: probs[best], correct: best === r.y };
  });
  const confident = scored.filter((s) => s.confidence >= CONFIDENCE_THRESHOLD);

  const byKind = EXCEPTION_KIND_ORDER.map((kind) => {
    const mine = scored.filter((s) => s.row.source.context.kind === kind);
    const sure = mine.filter((s) => s.confidence >= CONFIDENCE_THRESHOLD);
    return {
      kind,
      rows: mine.length,
      accuracy: round(mine.filter((s) => s.correct).length / Math.max(mine.length, 1)),
      coverageAtThreshold: round(sure.length / Math.max(mine.length, 1)),
      accuracyWhenConfident: round(sure.filter((s) => s.correct).length / Math.max(sure.length, 1)),
    };
  });

  // Reliability: within each confidence band, how often was it actually right?
  // A well-behaved model is right about 80% of the time when it says 0.8.
  const bands = [0, 0.5, 0.75, 0.9, 1.0001];
  const reliability = bands.slice(0, -1).map((lo, i) => {
    const hi = bands[i + 1];
    const inBand = scored.filter((s) => s.confidence >= lo && s.confidence < hi);
    return {
      band: `${lo.toFixed(2)}-${Math.min(hi, 1).toFixed(2)}`,
      rows: inBand.length,
      meanConfidence: round(inBand.reduce((a, s) => a + s.confidence, 0) / Math.max(inBand.length, 1)),
      accuracy: round(inBand.filter((s) => s.correct).length / Math.max(inBand.length, 1)),
    };
  });

  return {
    accuracy: round(scored.filter((s) => s.correct).length / Math.max(scored.length, 1)),
    coverageAtThreshold: round(confident.length / Math.max(scored.length, 1)),
    accuracyWhenConfident: round(confident.filter((s) => s.correct).length / Math.max(confident.length, 1)),
    byKind,
    reliability,
  };
}

/** What you would get by always answering the commonest reason for the kind. */
export function majorityBaseline(trainSet: Row[], testSet: Row[]): number {
  const commonest = new Map<string, number>();
  for (const kind of EXCEPTION_KIND_ORDER) {
    const counts = new Map<number, number>();
    for (const r of trainSet) {
      if (r.source.context.kind === kind) counts.set(r.y, (counts.get(r.y) ?? 0) + 1);
    }
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best) commonest.set(kind, best[0]);
  }
  const right = testSet.filter((r) => commonest.get(r.source.context.kind) === r.y).length;
  return round(right / testSet.length);
}
