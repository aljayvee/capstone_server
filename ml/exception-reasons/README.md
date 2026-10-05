# Exception reason suggestions

The model behind **Generate suggestion** (or **Tab** in an empty reason box) in the
dispatcher's Conflict Management queue. It reads the evidence on an errand and
suggests why an exception can be cleared.

Not part of the Python category service in this folder. This model is TypeScript,
runs inside the Node API, and is not copied into that Docker image.

## How it works

1. `exceptionReasonService.toReasonContext` reads the errand's evidence: settlement,
   photos by kind, payments, the stop, dwell time.
2. `exceptionReasonModel.encodeReasonContext` turns that into 36 numbers.
3. A 36-24-24 neural network (one ReLU hidden layer, softmax output) scores the 24
   reasons in `REASONS`. The softmax is masked to the exception's kind, so a cash
   reason is never offered for a wrong-branch visit.
4. **Below 0.75 it suggests nothing.** The API returns `confident: false` and the
   UI tells the dispatcher to write the reason themselves.
5. At 0.75 or above, the chosen reason's template is filled with this errand's own
   figures (amount, shop, minutes). The model picks a reason. It never writes free
   text, so it cannot make up a number.

The network is trained by backpropagation with Adam, written out in
`src/services/patterns/neuralNetwork.ts`: any number of layers, sigmoid, tanh, ReLU
or leaky ReLU, four forms of gradient descent, L2, dropout, early stopping and
gradient clipping. `tests/neuralNetwork.test.ts` checks the backprop gradients against
numerical ones for every parameter and every activation.

**[EXPERIMENTS.md](EXPERIMENTS.md)** shows why each setting was chosen: one neuron and
three neurons on logic gates, network size, activation functions, gradient descent
methods and learning rates, overfitting and its defences, and the model on real
SUGO errands. The shipped settings are in `scripts/exception-reasons/config.ts`.

## The data

`dataset.csv`: 2,160 rows, 90 per reason. **The rows are generated scenarios, not
real history.** On 2026-09-24 production had 4 cleared exceptions across 17 errands,
which is far too few to train on. Each scenario describes the evidence an errand
cleared for that reason usually carries, such as a sari-sari store, "walang barya"
in the rider's note, or a second GCash screenshot.

The data is deliberately not clean. Where the evidence can't tell two reasons
apart (₱40 short with no note: missing change, or a rider who will pay it back?),
rows appear under both labels, and 3% of labels are switched to a related reason
of the same kind. The network learns to be unsure where a person would be, and
that is what gives the 0.75 cut-off its meaning.

What this means: the model knows what the scenarios describe, nothing more. Its
value grows as real cleared exceptions are exported (`exportRealJobs.ts`, which
writes `real-jobs.csv`), labelled, and added to the training rows.

## Results (held-out test, 322 rows it never saw)

| | |
|---|---|
| Accuracy (best reason, any confidence) | 89.4% |
| Always guessing the commonest reason for the kind | 34.8% |
| Rows at or above 0.75 (a suggestion is shown) | 86.0% |
| Accuracy of the suggestions that are shown | 95.0% |

Confidence against actual accuracy on the test rows:

| Confidence | Rows | Right |
|---|---|---|
| 0.50 to 0.75 (hidden) | 41 | 54% |
| 0.75 to 0.90 | 116 | 92% |
| 0.90 to 1.00 | 161 | 97% |

Weakest kind: long stops, where the suggestions shown are right 81% of the time. A long
queue and a large order look alike on the errand. Full figures, per-kind breakdown and
training settings are in `report.json`.

On production's 7 real exceptions (2026-09-24), see section 7 of EXPERIMENTS.md and
`real-jobs.csv`: 812843d3, a ₱57 bakeshop purchase, gets the small-shop reason at
0.85, matching the dispatcher. Where the evidence points two ways it stays quiet.
One real case (a customer paying a balance in cash) fits none of the 24 reasons,
and the model picked the nearest with 0.88 confidence: it can rank its reasons,
but cannot say that none of them fits.

## Second opinion: Gemini 3.8 Flash, Gemma 4 behind it

The network reads the rider's note through three word lists ("sukli", "gcash",
"tip"). A note none of them catches, "wala sinsilyo si customer" or "remit ko
ugma", is invisible to it, and it picks from the figures alone, often
confidently and wrongly.

For such a note, and only then, the API server also asks a large model
(`exceptionReasonService.askSecondOpinion`, which goes through the category
service's `POST /advise`, which holds the key). The model reads the same
figures and the note, and chooses among this kind's reasons, already filled with
the errand's figures, or answers NONE. It never writes the text: whatever it
picks is still one of the templates, so no figure can be made up. The two
answers are pooled at weight 0.8 on the model's, and a reason is suggested at
0.75 or above, as before. Where the network read the note, or there is none,
the model is not asked: on validation, any weight there cost right suggestions
(0.3 lost 18 of 84) for no fewer wrong ones.

On the test rows (full figures in [GEMINI.md](GEMINI.md), from
`scripts/exception-reasons/secondOpinion.ts`):

| | Right suggestion | Wrong | Silent, a reason fits | Rightly silent |
|---|---|---|---|---|
| Hard notes and no-fit cases, network alone (12) | 4 | 4 | 3 | 1 |
| Hard notes and no-fit cases, with Gemini 3.8 Flash (12) | 9 | 0 | 1 | 2 |
| Hard notes and no-fit cases, with Gemma 4 (the fallback) (12) | 9 | 2 | 1 | 0 |
| Generated rows, network alone (96) | 81 | 3 | 12 | 0 |
| Generated rows, with Gemini 3.8 Flash (96) | 80 | 3 | 13 | 0 |

One question takes Gemini 3.8 Flash 2.0 s at the median and 3.5 s at the 90th
percentile; the API server gives each model 4.75 s and the whole request 10 s
(`CATEGORY_ADVICE_TIMEOUT_MS`), so the dispatcher's spinner usually runs about
2 s longer than before, and only for notes the network cannot read.

The first prompt told the model to answer NONE "when none of them fits"; it
did so for 84 of the 192 generated rows, where the evidence is only
suggestive. Told to pick the likelier reason with a lower confidence and to
keep NONE for records that show something no reason describes, it said NONE
on 17. That is the prompt in `gemma.choice_prompt`.

Not caught yet: production's balance-paid-in-cash case (fb2b0b0a). It has no
note, so the model is not asked, and when asked with this prompt it agrees with
the network. That needs a reason for it in `REASONS`, not a model.

## Retraining

```bash
npx tsx scripts/exception-reasons/generateDataset.ts   # rewrite dataset.csv (seeded)
npx tsx scripts/exception-reasons/train.ts             # retrain; writes the weights and report.json
npx tsx scripts/exception-reasons/experiments.ts      # optional, about 12 min: rerun every comparison, rewrite EXPERIMENTS.md
npx vitest run tests/neuralNetwork.test.ts tests/exceptionReasonSuggestion.test.ts
```

To refresh the real jobs, run this where the database is (production), then fill in
the `label` column by hand wherever the dispatcher's words clearly name a reason:

```bash
npx tsx scripts/exception-reasons/exportRealJobs.ts ml/exception-reasons/real-jobs.csv
```

Training takes a few seconds. It writes `src/services/patterns/exceptionReasonWeights.ts`,
which the API serves after the next build.

If you add a feature or add, remove or reorder a reason, you must retrain. The
shipped model records the feature names and reasons it was trained on, and the API
refuses a model that doesn't match (503) rather than answering confidently and
wrongly.
