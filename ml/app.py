"""
The SUGO category service.

A small FastAPI app with two jobs: say what kind of shop a name refers to, and
say what kind of shop an item is bought at. The dispatcher console calls it
through the Node API when a store is pinned in stage 2 or an item is added in
stage 3.

It is deliberately dull. It holds no state, writes nothing, needs no database at
runtime, and answers from models baked into the image at build time. That is
what makes it safe to put in front of a live dispatch flow: the worst thing a
broken deploy of this service can do is fail to answer, and the API server
treats no answer exactly as it treated the whole feature before this service
existed — fall back to the TypeScript rules and let the dispatcher choose.

SECURITY: like the OSRM sidecar beside it, this has no authentication. Bind it
to loopback or a private interface and let the API server be the only thing that
can reach it. See docker-compose.category.yml.
"""

from __future__ import annotations

import os
import time
from pathlib import Path

from fastapi import FastAPI
from pydantic import BaseModel, Field

from sugo_category.model import (
    DEFAULT_MIN_CONFIDENCE,
    MODEL_VERSION,
    CategoryModel,
)

MODEL_DIR = Path(os.environ.get("SUGO_MODEL_DIR", Path(__file__).parent / "models"))

app = FastAPI(
    title="SUGO Category Service",
    version=str(MODEL_VERSION),
    docs_url="/docs",
)

_models: dict[str, CategoryModel] = {}
_loaded_at: float | None = None
_load_error: str | None = None


def _load() -> None:
    """Load both models, remembering the failure rather than crashing on it."""
    global _loaded_at, _load_error
    try:
        _models["store"] = CategoryModel.load(MODEL_DIR, "store")
        _models["item"] = CategoryModel.load(MODEL_DIR, "item")
        _loaded_at = time.time()
        _load_error = None
    except Exception as exc:  # noqa: BLE001 — reported through /health
        # Staying up with a clear /health failure beats exiting: the API server
        # already treats a non-200 as "fall back to the rules", and a container
        # that boot-loops tells whoever is on the VPS far less than one that
        # says exactly which file it could not read.
        _load_error = f"{type(exc).__name__}: {exc}"


@app.on_event("startup")
def startup() -> None:
    _load()


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
        "models": {
            kind: {
                "rows": model.report.rows,
                "real_rows": model.report.real_rows,
                "holdout_accuracy": model.report.holdout_accuracy,
                "classes": model.report.classes,
            }
            for kind, model in _models.items()
        },
    }


@app.post("/reload")
def reload_models() -> dict:
    """Pick up a freshly trained model without restarting the container."""
    _load()
    return health()


@app.post("/categorize-store")
def categorize_store(req: StoreRequest) -> dict:
    model = _models.get("store")
    if model is None:
        return _unavailable()
    return model.predict(
        req.name,
        google_types=req.google_types,
        min_confidence=req.min_confidence,
    )


@app.post("/categorize-item")
def categorize_item(req: ItemRequest) -> dict:
    model = _models.get("item")
    if model is None:
        return _unavailable()
    return model.predict(req.name, min_confidence=req.min_confidence)


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
    return {
        "results": [
            {"name": name, **model.predict(name, min_confidence=req.min_confidence)}
            for name in req.names
        ]
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
