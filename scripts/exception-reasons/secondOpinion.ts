/**
 * What the second opinion (Gemini, Gemma behind it) adds to the exception
 * reason network, measured with the API server's own code.
 *
 *   npx tsx scripts/exception-reasons/secondOpinion.ts export
 *   ml/.venv/Scripts/python -m sugo_category.advice_eval \
 *     ml/exception-reasons/second-opinion-requests.json ml/exception-reasons/second-opinion-answers.json
 *   npx tsx scripts/exception-reasons/secondOpinion.ts score
 *
 * export writes the questions: adviceRequest for each row, as the live service
 * would send it, beside the row's label. The Python step asks the model with
 * the prompt POST /advise uses. score pools each answer with the network by
 * suggestReason, the live code, at several weights, chooses the weight on the
 * validation rows and writes GEMINI.md.
 *
 * Three sets of rows:
 *   scenario  generated rows (dataset.csv), 4 per reason from each of the
 *             training script's validation and test splits. Their notes use
 *             the network's own word lists, so this is where a second opinion
 *             must at least do no harm.
 *   hard      the same errands with the rider's note in Hiligaynon, Cebuano or
 *             Taglish that none of the word lists catch, and errands no reason
 *             fits (label NONE). Half choose, half test.
 *   real      production's labelled exceptions from real-jobs.csv.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CONFIDENCE_THRESHOLD,
  REASON_CODES,
  adviceRequest,
  encodeReasonContext,
  maskForKind,
  noteUnread,
  SECOND_OPINION_WEIGHT,
  SECOND_OPINION_WEIGHT_UNREAD_NOTE,
  suggestReason,
  type AdviceRequest,
  type ReasonContext,
  type SecondOpinion,
} from "../../src/services/patterns/exceptionReasonModel.js";
import { predict, seededRandom } from "../../src/services/patterns/neuralNetwork.js";
import { EXCEPTION_REASON_MODEL } from "../../src/services/patterns/exceptionReasonWeights.js";
import { ML_DIR, REAL_JOBS, loadRows, loadSplit, round, type Row } from "./evaluation.js";

const REQUESTS = resolve(ML_DIR, "second-opinion-requests.json");
const ANSWERS = resolve(ML_DIR, "second-opinion-answers.json");
const RESULTS = resolve(ML_DIR, "second-opinion.json");
const REPORT = resolve(ML_DIR, "GEMINI.md");
const PER_REASON = 4;
const READ_WEIGHTS = [0, 0.3, 0.4, 0.5, 0.6, 0.7];
const UNREAD_WEIGHTS = [0, 0.5, 0.6, 0.7, 0.8, 0.9];
const NONE = "NONE";

interface Question {
  id: string;
  set: "scenario" | "hard" | "real";
  split: "validation" | "test" | "real";
  label: string;
  context: ReasonContext;
  request: AdviceRequest;
}

// ── the hard rows ──────────────────────────────────────────────────────────

/**
 * Riders' notes the network's word lists do not catch, four per reason whose
 * answer turns on the note. Written for this; none contains change, sukli,
 * barya, panukli, exact, gcash, maya, transfer, bank, online or tip.
 */
const PARAPHRASES: Record<string, string[]> = {
  CASH_NO_EXACT_CHANGE: [
    "wala sinsilyo si customer",
    "wala sila baryang gamay, gin-round off ko na lang",
    "puro 1000 ang kwarta ni ate, wala gamay",
    "no coins daw, kulang 20",
  ],
  CASH_PAID_BY_TRANSFER: [
    "gin-send na lang niya sa e-wallet ang kulang",
    "nagpadala siya sa GoTyme ang kulang",
    "ipadala daw sa app, na-send na",
    "binayad thru QR ang kulang",
  ],
  CASH_RIDER_TO_REMIT: [
    "ako na bahala, remit ko ugma ang kulang",
    "nahulog ko ang kwarta sa dalan, bayaran ko",
    "akon sala, ibawas na lang sa sweldo ko",
    "kulang akon dala, ihatag ko bukas sa office",
  ],
  CASH_OVER_TIP: [
    "para sa imo na lang daw ang sobra",
    "sa akin na daw ang sobra, pang-merienda",
    "ginhatag sa akon ang sobra ni sir",
    "sobra, pero ayaw na daw kuhaon, salamat daw",
  ],
  CASH_OVER_TO_RETURN: [
    "iuli ko ang sobra sa customer mamaya",
    "sobra ang bayad, isauli ko bukas",
    "nasobrahan ang bayad niya, ihatid ko ang sobra",
    "dapat 500 lang, 600 ang gin-hatag, balik ko ang 100",
  ],
};

const WORD_LISTS = /\b(change|sukli|barya|panukli|exact|gcash|g-cash|maya|paymaya|transfer|bank|online|tip|keep the change)\b/i;

const base = (over: Partial<ReasonContext>): ReasonContext => ({
  kind: "CASH_VARIANCE",
  amountAtRisk: 0,
  billTotal: 420,
  basket: 350,
  plan: "COD",
  cashDirection: "NONE",
  riderNote: "",
  receiptPhotos: 1,
  noReceiptPhotos: 0,
  hasCashPhoto: true,
  hasDeliveryPhoto: true,
  transferProofs: 0,
  hasRiderBalanceProof: false,
  settledInFull: false,
  paidUpFront: 0,
  scannedTotal: 0,
  confirmedTotal: 0,
  storeName: "",
  observedName: "",
  itemsAtStop: 0,
  receiptsCoverBasket: 1,
  dwellMinutes: 0,
  ...over,
});

/** Cash that came back wrong for a reason none of the five cash reasons describes. */
const NONE_FITS: ReasonContext[] = [
  base({ cashDirection: "SHORT", amountAtRisk: 60, riderNote: "may nabuong itlog, gin-bawasan ang bayad" }),
  base({ cashDirection: "SHORT", amountAtRisk: 45, riderNote: "gin-refund sang tindahan ang isa ka item direkta sa customer" }),
  base({ cashDirection: "OVER", amountAtRisk: 150, riderNote: "ginbayaran man niya ang utang sa previous order" }),
  base({ cashDirection: "SHORT", amountAtRisk: 80, riderNote: "ayaw magbayad sang delivery fee kay late daw kami" }),
  base({ cashDirection: "SHORT", amountAtRisk: 30, plan: "DOWNPAYMENT", paidUpFront: 200, transferProofs: 1, riderNote: "nag-discount ang tindahan pero wala na-update ang total" }),
];

function hardRows(testSet: Row[]): Array<{ label: string; context: ReasonContext }> {
  const rows: Array<{ label: string; context: ReasonContext }> = [];
  for (const [code, notes] of Object.entries(PARAPHRASES)) {
    const y = REASON_CODES.indexOf(code);
    const from = testSet.filter((r) => r.y === y);
    notes.forEach((note, i) => {
      if (WORD_LISTS.test(note)) throw new Error(`"${note}" is caught by a word list; it would not test anything.`);
      rows.push({ label: code, context: { ...from[i % from.length].source.context, riderNote: note } });
    });
  }
  for (const context of NONE_FITS) rows.push({ label: NONE, context });
  return rows;
}

// ── export ─────────────────────────────────────────────────────────────────

function sample(rows: Row[], seed: number): Row[] {
  const rand = seededRandom(seed);
  const out: Row[] = [];
  for (let y = 0; y < REASON_CODES.length; y++) {
    const group = rows.filter((r) => r.y === y);
    for (let i = group.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [group[i], group[j]] = [group[j], group[i]];
    }
    out.push(...group.slice(0, PER_REASON));
  }
  return out;
}

function exportQuestions() {
  const { valSet, testSet } = loadSplit();
  const questions: Question[] = [];
  const add = (set: Question["set"], split: Question["split"], label: string, context: ReasonContext) =>
    questions.push({ id: `${set}-${split}-${questions.length}`, set, split, label, context, request: adviceRequest(context) });

  for (const r of sample(valSet, 101)) add("scenario", "validation", REASON_CODES[r.y], r.source.context);
  for (const r of sample(testSet, 202)) add("scenario", "test", REASON_CODES[r.y], r.source.context);
  hardRows(testSet).forEach((r, i) => add("hard", i % 2 === 0 ? "validation" : "test", r.label, r.context));

  if (existsSync(REAL_JOBS)) {
    for (const row of loadRows(REAL_JOBS)) {
      // The dispatcher's words name a reason, or say that none of the reasons fits.
      const none = /none of the/i.test(row.extra?.labelNote ?? "");
      if (REASON_CODES.includes(row.label) || none) add("real", "real", none ? NONE : row.label, row.context);
    }
  }
  writeFileSync(REQUESTS, JSON.stringify({ exportedAt: new Date().toISOString(), rows: questions }, null, 1));
  const by = (set: string) => questions.filter((q) => q.set === set).length;
  console.log(`${questions.length} questions (${by("scenario")} scenario, ${by("hard")} hard, ${by("real")} real) -> ${REQUESTS}`);
}

// ── score ──────────────────────────────────────────────────────────────────

type Outcome = "right" | "wrong" | "silent" | "rightly-silent";

function outcome(label: string, reasonCode: string | null): Outcome {
  if (reasonCode === null) return label === NONE ? "rightly-silent" : "silent";
  return reasonCode === label ? "right" : "wrong";
}

interface Tally {
  rows: number;
  right: number;
  wrong: number;
  silent: number;
  rightlySilent: number;
  /** Rows where the model alone named the right reason, or rightly said none fits. */
  modelAloneRight?: number;
}

const blank = (): Tally => ({ rows: 0, right: 0, wrong: 0, silent: 0, rightlySilent: 0 });

/** A wrong suggestion costs twice a missing one: a busy dispatcher accepts what is in the box. */
const utility = (t: Tally) => t.right + t.rightlySilent - 2 * t.wrong;

type Answer = { code?: string | null; confidence?: number; unusable?: boolean };

/** Both weights: where the network read the note (or there is none), and where it could not. */
const pair = (read: number, unread: number) => `${read}/${unread}`;

function tallyAt(questions: Question[], answers: Record<string, Answer>, model: string, read: number, unread: number) {
  const tallies: Record<string, Tally> = {};
  const rows: Record<string, unknown>[] = [];
  for (const q of questions) {
    const a = answers[q.id];
    const weight = noteUnread(q.context) ? unread : read;
    const opinion: SecondOpinion | null =
      weight > 0 && a && !a.unusable && typeof a.confidence === "number"
        ? { reasonCode: a.code ?? null, confidence: a.confidence, model, label: model }
        : null;
    const s = suggestReason(EXCEPTION_REASON_MODEL, q.context, opinion, weight);
    const o = outcome(q.label, s.confident ? s.reasonCode : null);
    for (const key of [`${q.set}/${q.split}`, `all/${q.split}`]) {
      const t = (tallies[key] ??= blank());
      t.rows++;
      t[o === "rightly-silent" ? "rightlySilent" : o]++;
      if (a && !a.unusable && (a.code ?? NONE) === q.label) t.modelAloneRight = (t.modelAloneRight ?? 0) + 1;
    }
    if (q.set !== "scenario") {
      const local = predict(EXCEPTION_REASON_MODEL.network, encodeReasonContext(q.context), maskForKind(q.context.kind));
      const top = local.indexOf(Math.max(...local));
      rows.push({
        id: q.id,
        label: q.label,
        note: q.context.riderNote,
        unread: noteUnread(q.context),
        network: `${REASON_CODES[top]} ${round(local[top], 2)}`,
        model: a ? `${a.code ?? NONE} ${round(a.confidence ?? 0, 2)}` : "no answer",
        shown: s.confident ? s.reasonCode : null,
        outcome: o,
      });
    }
  }
  return { tallies, rows };
}

function score() {
  const answersFile = process.argv[3] ? resolve(process.argv[3]) : ANSWERS;
  const questions: Question[] = JSON.parse(readFileSync(REQUESTS, "utf8")).rows;
  const all = JSON.parse(readFileSync(answersFile, "utf8"));
  const models = Object.keys(all).filter((k) => !k.startsWith("_"));
  const results: Record<string, any> = {
    measuredAt: new Date().toISOString(),
    threshold: CONFIDENCE_THRESHOLD,
    answers: answersFile,
    models: {},
  };

  for (const model of models) {
    const answers = all[model] as Record<string, Answer>;
    const perWeight: Record<string, Record<string, Tally>> = {};
    for (const read of READ_WEIGHTS) {
      for (const unread of UNREAD_WEIGHTS) perWeight[pair(read, unread)] = tallyAt(questions, answers, model, read, unread).tallies;
    }
    // Chosen on the validation rows, generated and hard together; a tie goes
    // to less weight on the model, the network being the one with a record.
    let chosen = { read: 0, unread: 0 };
    for (const read of READ_WEIGHTS) {
      for (const unread of UNREAD_WEIGHTS) {
        const u = utility(perWeight[pair(read, unread)]["all/validation"]);
        const best = utility(perWeight[pair(chosen.read, chosen.unread)]["all/validation"]);
        if (u > best || (u === best && read + unread < chosen.read + chosen.unread)) chosen = { read, unread };
      }
    }
    const detail = tallyAt(questions, answers, model, SECOND_OPINION_WEIGHT, SECOND_OPINION_WEIGHT_UNREAD_NOTE).rows;
    results.models[model] = { perWeight, chosen, detail, latency: all._latency?.[model] ?? null };
  }
  const out = process.argv[4] ? resolve(process.argv[4]) : null;
  writeFileSync(out ? `${out}.json` : RESULTS, JSON.stringify(results, null, 1));
  writeFileSync(out ? `${out}.md` : REPORT, render(results));
  console.log(`wrote ${out ? `${out}.md` : REPORT}`);
  for (const [model, r] of Object.entries<any>(results.models)) {
    const at = (key: string, w: string) => JSON.stringify(r.perWeight[w][key]);
    const c = pair(r.chosen.read, r.chosen.unread);
    console.log(`${model}: chosen ${c}`);
    for (const key of ["all/validation", "scenario/test", "hard/test", "real/real"]) {
      console.log(`  ${key.padEnd(15)} network ${at(key, "0/0")}\n  ${"".padEnd(15)} pooled  ${at(key, c)}`);
    }
  }
}

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "n/a");

function render(results: any): string {
  const out = [
    "# A second opinion on exception reasons",
    "",
    `Measured ${results.measuredAt} by \`scripts/exception-reasons/secondOpinion.ts\`. The network`,
    "(README.md) picks a reason from the errand's figures; the second opinion is a large model reading the",
    "same figures and the rider's note, choosing among the same filled-in reasons or saying none fits",
    "(`ml/sugo_category/gemma.py`, `POST /advise`). The two are pooled; a reason is suggested at",
    `${results.threshold} or above, as before.`,
    "",
    "Two weights on the model's answer: one where the network read the rider's note through its word",
    "lists (or there was none), one where there is a note none of them catches, which the network cannot",
    "read at all. Both are chosen on the validation rows by right + rightly silent - 2 x wrong: a wrong",
    "suggestion is the costly outcome, because a busy dispatcher accepts what is in the box.",
    "",
  ];
  for (const [model, r] of Object.entries<any>(results.models)) {
    // The tables show the shipped weights, the ones exceptionReasonModel.ts
    // uses whichever model answers; each model's own best pair is noted.
    const c = pair(SECOND_OPINION_WEIGHT, SECOND_OPINION_WEIGHT_UNREAD_NOTE);
    out.push(
      `## ${model}`,
      "",
      `At the shipped weights: ${SECOND_OPINION_WEIGHT} where the network read the note (or there is none), ` +
        `${SECOND_OPINION_WEIGHT_UNREAD_NOTE} where it could not. This model's own best pair on validation: ` +
        `${r.chosen.read} and ${r.chosen.unread}.`,
      ""
    );
    for (const key of ["scenario/test", "hard/test", "real/real", "all/validation"]) {
      const title = {
        "scenario/test": "Generated rows, test split",
        "hard/test": "Notes the word lists miss, and cases no reason fits (test half)",
        "real/real": "Production's labelled exceptions",
        "all/validation": "Validation rows (chose the weights)",
      }[key];
      const net = r.perWeight["0/0"][key];
      const pooled = r.perWeight[c][key];
      if (!net) continue;
      out.push(
        `### ${title} (${net.rows} rows)`,
        "",
        "| | Right suggestion | Wrong suggestion | Silent, a reason fits | Rightly silent |",
        "|---|---|---|---|---|",
        `| Network alone | ${net.right} | ${net.wrong} | ${net.silent} | ${net.rightlySilent} |`,
        `| Network + ${model} | ${pooled.right} | ${pooled.wrong} | ${pooled.silent} | ${pooled.rightlySilent} |`,
        "",
        `${model} alone named the right reason (or rightly said none fits) on ${pooled.modelAloneRight ?? 0} of ${pooled.rows} (${pct(pooled.modelAloneRight ?? 0, pooled.rows)}).`,
        ""
      );
    }
    out.push(
      "### Validation utility at every pair of weights",
      "",
      `| Read note \\ unread note | ${UNREAD_WEIGHTS.join(" | ")} |`,
      `|---|${UNREAD_WEIGHTS.map(() => "---").join("|")}|`
    );
    for (const read of READ_WEIGHTS) {
      out.push(`| ${read} | ${UNREAD_WEIGHTS.map((u) => utility(r.perWeight[pair(read, u)]["all/validation"])).join(" | ")} |`);
    }
    out.push(
      "",
      `### The hard and real rows one by one, at the shipped weights`,
      "",
      "| Row | Label | Rider's note | Note unread | Network | Model | Suggested |",
      "|---|---|---|---|---|---|---|"
    );
    for (const d of r.detail) {
      out.push(
        `| ${d.id} | ${d.label} | ${d.note || "(none)"} | ${d.unread ? "yes" : "no"} | ${d.network} | ${d.model} | ${d.shown ?? "nothing"} |`
      );
    }
    if (r.latency) out.push("", `One question: median ${r.latency.median_ms} ms, 90th percentile ${r.latency.p90_ms} ms.`);
    out.push("");
  }
  return out.join("\n");
}

const command = process.argv[2];
if (command === "export") exportQuestions();
else if (command === "score") score();
else {
  console.error("usage: secondOpinion.ts export | score [answers.json] [out-prefix]");
  process.exit(1);
}
