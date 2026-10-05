"""
Location-aware establishment categorizer and merchant category matcher for Tacurong City.
Fuses name signals, local barangay/landmark priors, and category ML models.
"""

from __future__ import annotations
import re
from dataclasses import dataclass
from typing import Optional

from .config import TACURONG_BOUNDS

# Minimum confidence required before automatic acceptance without human review
MIN_AUTO_ACCEPT_CONFIDENCE = 0.75

# Local Tacurong commercial zones and their category priors
ZONE_PRIORS: list[tuple[re.Pattern, str, float]] = [
    # Public Market / Palengke area carries strong grocery and eatery priors
    (re.compile(r"\b(?:public\s+market|palengke|bagsakan|talipapa)\b", re.IGNORECASE), "Supermarket & Grocery", 0.20),
    # Commercial plaza / mall centers
    (re.compile(r"\b(?:nccc|mall|plaza|commercial\s+center)\b", re.IGNORECASE), "Retail & General Merchandise", 0.15),
    # Hospital / clinic districts
    (re.compile(r"\b(?:hospital|medical\s+center|clinic|health\s+center)\b", re.IGNORECASE), "Pharmacy & Health", 0.25),
]


@dataclass
class MatchResult:
    predicted_category: Optional[str]
    confidence: float
    needs_review: bool
    is_within_bounds: bool
    matched_zone: Optional[str]
    reason: str


def is_in_tacurong(latitude: Optional[float], longitude: Optional[float]) -> bool:
    """Verifies that coordinates are physically situated within Tacurong City."""
    if latitude is None or longitude is None:
        return True  # If coordinates are missing, let address string drive the match
    return (
        TACURONG_BOUNDS["min_latitude"] <= latitude <= TACURONG_BOUNDS["max_latitude"]
        and TACURONG_BOUNDS["min_longitude"] <= longitude <= TACURONG_BOUNDS["max_longitude"]
    )


def match_establishment_category(
    store_name: str,
    address: str = "",
    barangay: Optional[str] = None,
    latitude: Optional[float] = None,
    longitude: Optional[float] = None,
    model_prediction: Optional[dict] = None,
) -> MatchResult:
    """
    Fuses model prediction with location signals to match an establishment
    to its MerchantCategory.
    Enforces the >= 0.75 confidence threshold for automated acceptance.
    """
    within_bounds = is_in_tacurong(latitude, longitude)
    combined_location_text = f"{address} {barangay or ''}".strip()

    # Base category and confidence from the ML model
    base_category = model_prediction.get("category") if model_prediction else None
    base_confidence = float(model_prediction.get("confidence", 0.0)) if model_prediction else 0.0

    # Zone prior adjustments
    matched_zone: Optional[str] = None
    adjusted_category = base_category
    adjusted_confidence = base_confidence

    for pattern, prior_category, boost in ZONE_PRIORS:
        if pattern.search(combined_location_text) or pattern.search(store_name):
            matched_zone = prior_category
            if base_category == prior_category:
                adjusted_confidence = min(1.0, adjusted_confidence + boost)
            elif base_confidence < 0.40:
                adjusted_category = prior_category
                adjusted_confidence = boost
            break

    # Confidence evaluation: below 0.75 requires dispatcher/owner review
    needs_review = (adjusted_confidence < MIN_AUTO_ACCEPT_CONFIDENCE) or (not within_bounds)

    reason = (
        f"Confidence {adjusted_confidence:.2f} satisfies auto-acceptance threshold (>= {MIN_AUTO_ACCEPT_CONFIDENCE})"
        if not needs_review
        else f"Confidence {adjusted_confidence:.2f} is below {MIN_AUTO_ACCEPT_CONFIDENCE} or location out of bounds; flagged for human review"
    )

    return MatchResult(
        predicted_category=adjusted_category,
        confidence=round(adjusted_confidence, 3),
        needs_review=needs_review,
        is_within_bounds=within_bounds,
        matched_zone=matched_zone,
        reason=reason,
    )
