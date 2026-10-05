"""
Ask the large models the Conflict Management questions the API server wrote out.

    python -m sugo_category.advice_eval requests.json answers.json [--model gemini-3.8-flash]

The middle step of scripts/exception-reasons/secondOpinion.ts, which exports
the questions (with the network's own probabilities) and scores the answers
with the API server's real pooling code. This step only asks: the same prompt
and schema POST /advise uses (gemma.choice_prompt, gemma.ask_choice), one model,
waiting out a quota pause instead of skipping. Answers already in the output
file are kept, so an interrupted run picks up where it stopped.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from .evaluation import ML_DIR
from .gemma import DEFAULT_MODEL, GemmaError, GemmaSettings, ask_choice, choice_prompt


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("requests", type=Path)
    parser.add_argument("answers", type=Path)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    args = parser.parse_args(argv)

    base = GemmaSettings.from_env(dotenv=ML_DIR / ".env")
    if not base.api_key:
        parser.error("GEMMA_API_KEY is not set (environment or ml/.env)")
    settings = GemmaSettings(api_key=base.api_key, model=args.model, timeout_seconds=60.0)

    rows = json.loads(args.requests.read_text(encoding="utf-8"))["rows"]
    answers: dict = json.loads(args.answers.read_text(encoding="utf-8")) if args.answers.exists() else {}
    key = f"{args.model}"
    done = answers.setdefault(key, {})
    seconds: list[float] = []
    for i, row in enumerate(rows, 1):
        if row["id"] in done:
            continue
        request = row["request"]
        options = {o["code"]: o["text"] for o in request["options"]}
        prompt = choice_prompt(request["question"], request["facts"], request["note"], options)
        for attempt in range(6):
            began = time.perf_counter()
            try:
                parsed = ask_choice(settings, args.model, prompt, list(options))
            except GemmaError as exc:
                if exc.status in (429, 500, 503) or exc.status is None:
                    wait = exc.retry_after or 15 * (attempt + 1)
                    print(f"  {row['id']}: {exc} ({exc.status}); waiting {wait:.0f} s", flush=True)
                    time.sleep(wait)
                    continue
                raise
            seconds.append(time.perf_counter() - began)
            done[row["id"]] = (
                {"code": parsed[0], "confidence": parsed[1], "model": args.model}
                if parsed
                else {"unusable": True, "model": args.model}
            )
            break
        if i % 20 == 0:
            args.answers.write_text(json.dumps(answers, indent=1), encoding="utf-8")
            print(f"  {i}/{len(rows)}", flush=True)
    if seconds:
        ordered = sorted(seconds)
        answers.setdefault("_latency", {})[key] = {
            "samples": len(ordered),
            "median_ms": round(ordered[len(ordered) // 2] * 1000),
            "p90_ms": round(ordered[max(0, int(len(ordered) * 0.9) - 1)] * 1000),
        }
    args.answers.write_text(json.dumps(answers, indent=1), encoding="utf-8")
    print(f"{len(done)} answers from {args.model} in {args.answers}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
