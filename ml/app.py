"""
The SUGO category service.

A small FastAPI app with two jobs: say what kind of shop a name refers to, and
say what kind of shop an item is bought at. The dispatcher console calls it
through the Node API when a store is pinned in stage 2 or an item is added in
stage 3.

It is deliberately dull. It needs no database at runtime and answers from
models baked into the image at build time. That is what makes it safe to put in
front of a live dispatch flow: the worst thing a broken deploy of this service
can do is fail to answer, and the API server treats no answer exactly as it
treated the whole feature before this service existed — fall back to the
TypeScript rules and let the dispatcher choose.

The one thing it writes is a retrained model. POST /retrain carries the
catalogue and production's labelled rows (the API server reads them; this
container still never touches the database), trains in a separate process so
answering never waits on it, and swaps the new models in only once they have
loaded. A failed retrain leaves the old models answering. A rebuilt image starts
again from the models baked into it.

SECURITY: like the OSRM sidecar beside it, this has no authentication. Bind it
to loopback or a private interface and let the API server be the only thing that
can reach it. See docker-compose.category.yml.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from sugo_category.gemma import MAX_NORMALIZE_CHARS, GemmaAdvisor, GemmaSettings, context_for, model_label
from sugo_category.item_search import ItemCatalogue
from sugo_category.model import (
    DEFAULT_MIN_CONFIDENCE,
    MODEL_VERSION,
    CategoryModel,
    SecondOpinion,
)
from sugo_category.training_quality import prepare_training_quality

MODEL_DIR = Path(os.environ.get("SUGO_MODEL_DIR", Path(__file__).parent / "models"))
# Retrained models go in runs/<stamp>/, and `current` names the one in use, so a
# container restart keeps serving the latest retrain rather than the baked one.
RUNS_DIR = MODEL_DIR / "runs"
CURRENT = MODEL_DIR / "current"
KEEP_RUNS = 2
RETRAIN_TIMEOUT_SECONDS = 30 * 60

app = FastAPI(
    title="SUGO Category Service",
    version=str(MODEL_VERSION),
    docs_url="/docs",
)

_models: dict[str, CategoryModel] = {}
_loaded_at: float | None = None
_load_error: str | None = None
_loaded_from: str | None = None

# Gemma 4, asked about the names the local model is unsure of (sugo_category.gemma).
# The key comes from the environment, or ml/.env when run by hand; without one
# this does nothing and every answer is the local model's, as before.
_gemma = GemmaAdvisor(GemmaSettings.from_env(dotenv=Path(__file__).with_name(".env"), cache_dir=MODEL_DIR))

_train_lock = threading.Lock()
_pending: dict | None = None
_worker_running = False
_training: dict = {"state": "idle"}


def _current_dir() -> Path:
    """The newest retrain that loaded, or the models baked into the image."""
    try:
        run = RUNS_DIR / CURRENT.read_text(encoding="utf-8").strip()
        if (run / "store.joblib").exists() and (run / "item.joblib").exists():
            return run
    except OSError:
        pass
    return MODEL_DIR


def _load(directory: Path | None = None) -> bool:
    """Load both models, remembering the failure rather than crashing on it."""
    global _loaded_at, _load_error, _loaded_from
    directory = directory or _current_dir()
    try:
        # Both loaded before either is swapped in: a half-written run must not
        # leave the store model new and the item model old.
        store = CategoryModel.load(directory, "store")
        item = CategoryModel.load(directory, "item")
        _models["store"], _models["item"] = store, item
        _loaded_at = time.time()
        _load_error = None
        _loaded_from = str(directory)
        return True
    except Exception as exc:  # noqa: BLE001 — reported through /health
        # Staying up with a clear /health failure beats exiting: the API server
        # already treats a non-200 as "fall back to the rules", and a container
        # that boot-loops tells whoever is on the VPS far less than one that
        # says exactly which file it could not read.
        _load_error = f"{type(exc).__name__}: {exc}"
        return False


@app.on_event("startup")
def startup() -> None:
    # A retrained run that no longer loads falls back to the baked models.
    if not _load() and _loaded_from != str(MODEL_DIR):
        _load(MODEL_DIR)


# ── request/response shapes ────────────────────────────────────────────────


class StoreRequest(BaseModel):
    name: str = Field(..., description="The shop name as it will be shown to the rider.")
    google_types: list[str] | None = Field(
        default=None,
        description="Google Places `types` for this result, when the caller has them.",
    )
    min_confidence: float = Field(
        default=DEFAULT_MIN_CONFIDENCE,
        ge=0.0,
        le=1.0,
        description="Below this the service returns no category rather than a guess.",
    )


class ItemRequest(BaseModel):
    name: str = Field(..., description="The item as the customer or dispatcher typed it.")
    min_confidence: float = Field(default=DEFAULT_MIN_CONFIDENCE, ge=0.0, le=1.0)


class BatchItemRequest(BaseModel):
    names: list[str] = Field(..., max_length=100)
    min_confidence: float = Field(default=DEFAULT_MIN_CONFIDENCE, ge=0.0, le=1.0)


class WarmRequest(BaseModel):
    names: list[str] = Field(..., max_length=100)
    kind: Literal["item", "store"] = "item"


class AdviseOption(BaseModel):
    code: str = Field(..., min_length=1, max_length=64)
    text: str = Field(..., min_length=1, max_length=400)


class AdviseRequest(BaseModel):
    """One question for the models: which of these statements the evidence supports."""

    question: str = Field(..., min_length=1, max_length=400)
    facts: list[str] = Field(default_factory=list, max_length=40)
    note: str = Field(default="", max_length=500)
    options: list[AdviseOption] = Field(..., min_length=1, max_length=30)
    timeout_ms: int = Field(default=8000, ge=500, le=20_000)


class NormalizeRequest(BaseModel):
    """A customer's shopping lines the app's own rules would not touch."""

    # One batch: the API server sends at most GEMMA_BATCH_SIZE lines.
    lines: list[str] = Field(..., min_length=1, max_length=20)
    # The whole answer's budget, shared down the model chain (GemmaAdvisor.normalize).
    timeout_ms: int = Field(default=9000, ge=500, le=20_000)


class ItemSearchRequest(BaseModel):
    query: str = Field(..., max_length=100)
    limit: int = Field(default=8, ge=1, le=25)


class RetrainRequest(BaseModel):
    """What sugo_category.train --export writes, sent by the API server instead."""

    categories: list[str] = Field(..., min_length=2, max_length=200)
    # Each category's description, which teaches a category the owner created
    # its items and shops (sugo_category.catalogue). Optional: older API servers send none.
    descriptions: dict[str, str] = Field(default_factory=dict)
    stores: list[tuple[str, str]] = Field(default_factory=list, max_length=200_000)
    items: list[tuple[str, str]] = Field(default_factory=list, max_length=200_000)
    reasons: list[str] = Field(default_factory=list, max_length=50)
    # False only in tests: the OpenStreetMap names make a retrain minutes long.
    include_osm: bool = True


# ── routes ─────────────────────────────────────────────────────────────────


@app.get("/health")
def health() -> dict:
    """
    Whether this service can actually answer, and what it was trained on.

    The API server's circuit breaker reads the status code; a person debugging
    a bad guess reads the body, which says how many real rows each model saw.
    A model trained on seed phrases alone is not broken, but it explains a lot.
    """
    ready = len(_models) == 2 and _load_error is None
    return {
        "status": "ok" if ready else "degraded",
        "ready": ready,
        "error": _load_error,
        "model_version": MODEL_VERSION,
        "loaded_at": _loaded_at,
        "loaded_from": "retrain" if _loaded_from and _loaded_from != str(MODEL_DIR) else "image",
        "training": dict(_training),
        # Whether Gemma is being asked, and how that is going. Never the key.
        "gemma": _gemma.status(),
        "models": {
            kind: {
                "rows": model.report.rows,
                "real_rows": model.report.real_rows,
                "osm_rows": model.report.osm_rows,
                "holdout_accuracy": model.report.holdout_accuracy,
                "temperature": model.report.temperature,
                "classes": model.report.classes,
                # Which model answers: "logistic", "charcnn" or "ensemble"
                # (sugo_category.deep), and the linear model's share of the
                # ensemble, chosen on validation names.
                "classifier": model.report.classifier,
                "ensemble_weight": model.report.ensemble_weight,
                "deep": None
                if not model.report.deep
                else {k: model.report.deep.get(k) for k in ("parameters", "epochs_run", "best_epoch", "transferred_from")},
                "excluded_as_mislabelled": model.report.excluded_as_mislabelled,
                "teacher_rows": model.report.teacher_rows,
                "training_quality": model.report.training_quality,
            }
            for kind, model in _models.items()
        },
    }


@app.post("/reload")
def reload_models() -> dict:
    """Pick up a freshly trained model without restarting the container."""
    _load()
    return health()


def _predict_all(
    kind: str,
    model: CategoryModel,
    names: list[str],
    ask_gemma: bool = True,
    wait_seconds: float | None = None,
    **options,
) -> list[dict]:
    """
    The local model's answer for each name, with Gemma's pooled in where the
    local model was unsure and Gemma has answered (sugo_category.gemma).

    `ask_gemma=False` uses answers already cached and asks nothing new: for
    search-as-you-type, where every keystroke would otherwise be a call.
    """
    answers = [model.predict(name, **options) for name in names]
    unsure = [
        name
        for name, answer in zip(names, answers)
        if answer.get("source") != "empty" and answer.get("confidence", 0.0) < _gemma.settings.consult_below
    ]
    if not unsure:
        return answers
    context = context_for(model.report)
    verdicts = (
        _gemma.consult(kind, unsure, context, wait=wait_seconds)
        if ask_gemma
        else _gemma.lookup(kind, unsure, sorted(context))
    )
    if not verdicts:
        return answers
    def opinion(verdict) -> SecondOpinion:
        # Named for the model that actually answered: Gemini, or Gemma behind it.
        source, label = model_label(verdict.model)
        return SecondOpinion(verdict.category, verdict.confidence, _gemma.settings.weight, source=source, label=label)

    return [
        model.predict(name, second_opinion=opinion(verdicts[name]), **options) if name in verdicts else answer
        for name, answer in zip(names, answers)
    ]


@app.post("/categorize-store")
def categorize_store(req: StoreRequest) -> dict:
    model = _models.get("store")
    if model is None:
        return _unavailable()
    return _predict_all(
        "store",
        model,
        [req.name],
        google_types=req.google_types,
        min_confidence=req.min_confidence,
    )[0]


@app.post("/categorize-item")
def categorize_item(req: ItemRequest) -> dict:
    model = _models.get("item")
    if model is None:
        return _unavailable()
    return _predict_all("item", model, [req.name], min_confidence=req.min_confidence)[0]


@app.post("/categorize-items")
def categorize_items(req: BatchItemRequest) -> dict:
    """
    Several items in one call.

    Stage 3 can add a row at a time, but it also reloads a whole basket when a
    dispatcher opens the editor, and one round trip for eleven items beats
    eleven round trips inside a panel the dispatcher is looking at.
    """
    model = _models.get("item")
    if model is None:
        return _unavailable()
    # One Gemma call for every unsure name in the basket, not one each.
    answers = _predict_all("item", model, list(req.names), min_confidence=req.min_confidence)
    return {"results": [{"name": name, **answer} for name, answer in zip(req.names, answers)]}


@app.post("/warm", status_code=202)
def warm(req: WarmRequest) -> dict:
    """
    Ask Gemma now about the unsure names in a new order, and return at once.

    The API server sends a customer's items here when the order is placed.
    Gemma takes seconds, longer than a dispatcher's request waits; asked now,
    its answers are in the cache by the time a dispatcher opens the order.
    """
    model = _models.get(req.kind)
    if model is None or not _gemma.settings.active:
        return {"unsure": 0}
    unsure = [
        name
        for name in dict.fromkeys(req.names)
        if model.predict(name).get("confidence", 1.0) < _gemma.settings.consult_below
    ]
    if unsure:
        _gemma.consult(req.kind, unsure, context_for(model.report), wait=0)
    return {"unsure": len(unsure)}


@app.post("/advise")
def advise(req: AdviseRequest) -> dict:
    """
    Which of the caller's statements the facts and the rider's note support,
    or none of them, per the model chain (Gemini, then Gemma).

    For the API server's Conflict Management suggestions
    (exceptionReasonService.ts): its own network picks a reason from the
    errand's figures, and this reads the same figures, and the rider's note in
    whatever language it was typed, as a second opinion. The statements are the
    API server's own templates filled with the errand's figures, so an answer
    here is only ever a choice among them: nothing written here reaches the
    record. Here rather than in the API server so the key, the quota and the
    pauses live in one place.
    """
    options = {o.code: o.text for o in req.options}
    choice = _gemma.choose(req.question, req.facts, req.note, options, timeout=req.timeout_ms / 1000)
    if choice is None:
        status = _gemma.status()
        return {"available": False, "reason": status["last_error"] or f"No model could answer ({status['state']})."}
    return {
        "available": True,
        # Null: the model said none of the statements fits.
        "code": choice.code,
        "confidence": round(choice.confidence, 4),
        "model": choice.model,
        "label": model_label(choice.model)[1],
    }


@app.post("/normalize-items")
def normalize_items(req: NormalizeRequest) -> dict:
    """
    A customer's messy shopping lines, each read into name, size and count:
    "5 Kilo of Chicken 2qty" is Chicken, 5 kg, two of them. One line may be
    several items ("chicken 2, rice 5kg").

    For the customer app's Review screen (itemTidyService.ts on the API
    server). An answer that drops or invents a word is discarded here
    (gemma.parse_normalized), so a line comes back either faithfully
    rearranged or not at all, and a line not answered is sent as typed.
    """
    # Never silently remove the end of a customer's instruction.
    if any(not line.strip() or len(line) > MAX_NORMALIZE_CHARS for line in req.lines):
        raise HTTPException(status_code=422, detail="Each shopping line must contain 1 to 500 characters.")
    lines = [" ".join(line.split()) for line in req.lines]
    found = _gemma.normalize(lines, timeout=req.timeout_ms / 1000)
    if found is None:
        status = _gemma.status()
        return {
            "available": False,
            "results": [],
            "reason": status["last_error"] or f"No model could answer ({status['state']}).",
        }
    models = {line.model for line in found.values()}
    model = next(iter(models)) if len(models) == 1 else None
    return {
        "available": True,
        "results": [
            {
                "n": n,
                "items": [{"name": i.name, "quantity": i.quantity, "size": i.size, "note": i.note} for i in line.items],
                "confident": line.confident,
            }
            for n, line in sorted(found.items())
        ],
        **({"model": model, "label": model_label(model)[1]} if model else {}),
    }


# The item catalogue for whichever item model is loaded, rebuilt when a retrain
# swaps the model (its categories may have changed with it).
_catalogue: tuple[int, ItemCatalogue] | None = None


@app.post("/search-items")
def search_items(req: ItemSearchRequest) -> dict:
    """
    Items the lexicon knows that match what the dispatcher typed, each with the
    kind of shop it is usually bought at, plus the item model's own guess for
    the text as typed (for a name the lexicon has never seen).

    For stage 3's Catalog Helper, which merges this with crawled menus and the
    order history on the API server.
    """
    global _catalogue
    model = _models.get("item")
    if model is None:
        return {"results": [], "prediction": None}
    if _catalogue is None or _catalogue[0] != id(model):
        _catalogue = (id(model), ItemCatalogue(model.report.classes))
    results = _catalogue[1].search(req.query, req.limit)
    ask_live = len(results) == 0 and len(req.query.strip()) >= 3
    guess = _predict_all(
        "item",
        model,
        [req.query],
        ask_gemma=ask_live,
        wait_seconds=2.5 if ask_live else None,
    )[0]
    prediction = (
        {
            "name": " ".join(req.query.split()),
            "category": guess["category"],
            "confidence": guess["confidence"],
            "source": guess.get("source"),
        }
        if guess.get("category")
        else None
    )
    return {"results": results, "prediction": prediction}


class SuggestSubstitutesRequest(BaseModel):
    item_name: str = Field(..., min_length=1, max_length=160)
    store_name: str = Field(default="", max_length=160)
    store_category: str = Field(default="", max_length=120)
    customer_name: str = Field(default="", max_length=120)


@app.post("/suggest-substitutes")
def suggest_substitutes_endpoint(req: SuggestSubstitutesRequest) -> dict:
    """
    Suggest 2-3 realistic Philippine/Tacurong store substitutes for an
    out-of-stock item plus a ready-to-send customer chat message.
    """
    global _catalogue
    model = _models.get("item")
    catalog_candidates: list[str] = []
    if model is not None:
        if _catalogue is None or _catalogue[0] != id(model):
            _catalogue = (id(model), ItemCatalogue(model.report.classes))
        first_word = req.item_name.split()[0] if req.item_name.split() else req.item_name
        hits = _catalogue[1].search(first_word, 10)
        catalog_candidates = [str(h.get("name", "")) for h in hits if h.get("name")]
    return _gemma.suggest_substitutes(
        item_name=req.item_name,
        store_name=req.store_name,
        store_category=req.store_category,
        customer_name=req.customer_name,
        catalog_candidates=catalog_candidates,
    )


@app.post("/retrain", status_code=202)
def retrain(req: RetrainRequest) -> dict:
    """
    Retrain both models on the catalogue and rows sent, then swap them in.

    Returns at once. A retrain already running finishes first, and the newest
    request waiting behind it runs next (older waiting ones are dropped: the
    newest carries every row they did, and more). GET /health says how it went.
    """
    global _pending, _worker_running
    with _train_lock:
        _pending = req.model_dump()
        busy = _worker_running
        if not busy:
            # One worker at a time; it drains _pending until nothing is left.
            _worker_running = True
            threading.Thread(target=_training_loop, name="retrain", daemon=True).start()
    return {"accepted": True, "queued_behind_running": busy, "training": dict(_training)}


def _training_loop() -> None:
    global _pending, _worker_running
    while True:
        with _train_lock:
            job, _pending = _pending, None
            if job is None:
                _worker_running = False
                return
            _training.clear()
            _training.update({"state": "training", "started_at": time.time(), "reasons": job.get("reasons", [])})
        outcome = _train_once(job)
        with _train_lock:
            _training.clear()
            _training.update(outcome)


def _train_once(job: dict) -> dict:
    started = time.time()
    stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    run = RUNS_DIR / stamp
    run.mkdir(parents=True, exist_ok=True)
    export = run / "production.json"
    # Gemma's surest cached answers, taught to the local model (distillation):
    # the names it had to ask about last time, it knows by itself next time.
    teacher = {kind: _gemma.teacher_rows(kind, job["categories"]) for kind in ("store", "item")}
    # Review new names before training, separately from category predictions.
    # Persist review decisions beside the existing external-model cache so a
    # container replacement does not spend quota reviewing the same names.
    quality_cache = (_gemma.settings.cache_path.parent / "training-quality.jsonl"
                     if _gemma.settings.cache_path else MODEL_DIR / "training-quality.jsonl")
    quality = prepare_training_quality(
        job["stores"], job["items"], job["categories"], job.get("descriptions") or {},
        _gemma, quality_cache,
        enabled=os.environ.get("TRAINING_QUALITY_ENABLED", "0").lower() in ("1", "true", "on"),
    )
    (run / "quality-audit.json").write_text(json.dumps(quality, ensure_ascii=False, indent=2), encoding="utf-8")
    export.write_text(
        json.dumps({"exported_at": stamp, "categories": job["categories"], "descriptions": job.get("descriptions") or {},
                    "stores": job["stores"], "items": job["items"], "teacher": teacher,
                    "training_quality": quality},
                   ensure_ascii=False),
        encoding="utf-8",
    )
    command = [sys.executable, "-m", "sugo_category.train", "--from-export", str(export), "--out", str(run)]
    if not job.get("include_osm", True):
        command.append("--no-osm")
    try:
        # A separate process at a lower priority: training is minutes of CPU,
        # and the dispatcher waiting on a category answer comes first.
        result = subprocess.run(
            command, cwd=Path(__file__).parent, capture_output=True, text=True,
            timeout=RETRAIN_TIMEOUT_SECONDS,
            preexec_fn=(lambda: os.nice(10)) if hasattr(os, "nice") else None,
        )
    except subprocess.TimeoutExpired:
        shutil.rmtree(run, ignore_errors=True)
        return {"state": "failed", "error": f"timed out after {RETRAIN_TIMEOUT_SECONDS} s", "finished_at": time.time()}
    loaded = result.returncode == 0 and _load(run)
    if not loaded:
        tail = (result.stderr or result.stdout or "")[-600:]
        error = tail if result.returncode != 0 else _load_error
        shutil.rmtree(run, ignore_errors=True)
        _load()  # whatever was current before keeps answering
        return {"state": "failed", "error": error, "finished_at": time.time()}

    CURRENT.write_text(stamp, encoding="utf-8")
    for old in sorted(p for p in RUNS_DIR.iterdir() if p.is_dir())[:-KEEP_RUNS]:
        shutil.rmtree(old, ignore_errors=True)
    return {
        "state": "done",
        "run": stamp,
        "seconds": round(time.time() - started, 1),
        "finished_at": time.time(),
        "rows": {"stores": len(job["stores"]), "items": len(job["items"])},
        "training_quality": quality["summary"],
        "log": result.stdout[-1200:],
    }


def _unavailable() -> dict:
    """Shaped like a real answer so a caller needs no special case for it."""
    return {
        "category": None,
        "confidence": 0.0,
        "source": "unavailable",
        "alternatives": [],
        "reason": _load_error or "The model is not loaded.",
    }
