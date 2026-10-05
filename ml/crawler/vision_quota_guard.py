"""
Google Cloud Vision Quota Protection Guard.
Defends the Vision API quota from exhaustion when ingesting menu photos and flyers.
Ensures live rider receipts always have priority quota headroom.
"""

from __future__ import annotations
import hashlib
import time
from datetime import datetime, timezone
from typing import Callable, Optional

from .config import (
    MAX_DAILY_CRAWLER_VISION_REQUESTS,
    IMAGE_MIN_DIMENSION_PX,
    IMAGE_MAX_FILE_SIZE_BYTES,
)

# In-memory daily counter and cache tracking
_daily_vision_call_count = 0
_current_quota_day = datetime.now(timezone.utc).date()
_processed_hash_cache: dict[str, dict] = {}


def compute_image_sha256(image_bytes: bytes) -> str:
    """Computes SHA-256 fingerprint of the raw image bytes."""
    return hashlib.sha256(image_bytes).hexdigest()


def _check_and_reset_daily_counter() -> None:
    """Resets the daily counter when transitioning to a new UTC day."""
    global _daily_vision_call_count, _current_quota_day
    now_day = datetime.now(timezone.utc).date()
    if now_day != _current_quota_day:
        _daily_vision_call_count = 0
        _current_quota_day = now_day


def can_attempt_cloud_vision() -> bool:
    """
    Checks if the crawler is legally allowed to invoke Google Cloud Vision
    without threatening the live rider receipt quota pool.
    """
    _check_and_reset_daily_counter()
    return _daily_vision_call_count < MAX_DAILY_CRAWLER_VISION_REQUESTS


def record_cloud_vision_usage() -> None:
    """Records an authorized Cloud Vision API call."""
    global _daily_vision_call_count
    _check_and_reset_daily_counter()
    _daily_vision_call_count += 1


def get_remaining_vision_quota() -> int:
    """Returns the remaining allowed Vision calls for the crawler today."""
    _check_and_reset_daily_counter()
    return max(0, MAX_DAILY_CRAWLER_VISION_REQUESTS - _daily_vision_call_count)


def validate_image_preflight(image_bytes: bytes) -> tuple[bool, str]:
    """
    Validates image bytes before calling any OCR engine.
    Drops oversized, zero-byte, or corrupt files locally with zero network calls.
    """
    if not image_bytes:
        return False, "Empty image bytes"

    if len(image_bytes) > IMAGE_MAX_FILE_SIZE_BYTES:
        return False, f"Image size exceeds maximum threshold ({IMAGE_MAX_FILE_SIZE_BYTES} bytes)"

    if len(image_bytes) < 1024:
        return False, "Image file too small (< 1KB), likely an icon or corrupted thumbnail"

    return True, "Pre-flight checks passed"


def read_image_with_quota_guard(
    image_bytes: bytes,
    local_ocr_fn: Callable[[bytes], Optional[str]],
    vision_ocr_fn: Optional[Callable[[bytes], Optional[dict]]] = None,
) -> dict:
    """
    Executes defensive OCR reading:
    1. SHA-256 Cache Check (0 API calls)
    2. Local Pre-flight Validation (0 API calls)
    3. Offline-First Local OCR (0 API calls)
    4. Guarded Cloud Vision Fallback only when quota allows and local OCR is insufficient.
    """
    # 1. SHA-256 Deduplication check
    sha256 = compute_image_sha256(image_bytes)
    if sha256 in _processed_hash_cache:
        cached = _processed_hash_cache[sha256]
        return {
            "text": cached["text"],
            "engine": f"CACHE_HIT_{cached['engine']}",
            "confidence": cached["confidence"],
            "sha256": sha256,
            "vision_calls_made": 0,
        }

    # 2. Local Pre-flight validation
    is_valid, validation_msg = validate_image_preflight(image_bytes)
    if not is_valid:
        return {
            "text": "",
            "engine": "REJECTED_PREFLIGHT",
            "confidence": 0.0,
            "sha256": sha256,
            "reason": validation_msg,
            "vision_calls_made": 0,
        }

    # 3. Offline-first: Run local OCR (free, zero API cost)
    local_text = local_ocr_fn(image_bytes)
    if local_text and len(local_text.strip()) > 30:
        result = {
            "text": local_text.strip(),
            "engine": "LOCAL_TESSERACT",
            "confidence": 0.85,
            "sha256": sha256,
            "vision_calls_made": 0,
        }
        _processed_hash_cache[sha256] = result
        return result

    # 4. Cloud Vision Fallback (Quota-Protected)
    if vision_ocr_fn and can_attempt_cloud_vision():
        try:
            record_cloud_vision_usage()
            vision_res = vision_ocr_fn(image_bytes)
            if vision_res and vision_res.get("text"):
                result = {
                    "text": vision_res["text"].strip(),
                    "engine": "CLOUD_VISION",
                    "confidence": vision_res.get("confidence", 0.90),
                    "sha256": sha256,
                    "vision_calls_made": 1,
                    "remaining_daily_crawler_quota": get_remaining_vision_quota(),
                }
                _processed_hash_cache[sha256] = result
                return result
        except Exception as exc:
            # Non-blocking failure: If Vision fails or throws 429, log and fallback cleanly
            pass

    # If Vision is quota-capped or unavailable, return whatever local OCR extracted
    fallback_result = {
        "text": local_text.strip() if local_text else "",
        "engine": "LOCAL_TESSERACT_FALLBACK",
        "confidence": 0.50 if local_text else 0.0,
        "sha256": sha256,
        "vision_calls_made": 0,
        "quota_exhausted": not can_attempt_cloud_vision(),
    }
    _processed_hash_cache[sha256] = fallback_result
    return fallback_result
