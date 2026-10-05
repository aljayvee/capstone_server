"""
Defensive item name cleaner and normalizer.
Cleans raw text extracted from menus, flyers, and merchant pages.
"""

from __future__ import annotations
import re

# Strip noisy characters while preserving common food/grocery units and punctuation
NOISE_PATTERN = re.compile(r"[\t\r\n]+|\s{2,}|[^\w\s\-\.\(\)\/&,]", re.UNICODE)

# Strip trailing price patterns if an OCR scan mixed price into the item string
PRICE_TRAIL_PATTERN = re.compile(
    r"\s*(?:(?:php|p|₱)\s*)?[0-9]{1,4}(?:\.[0-9]{1,2})?\s*(?:only|each|pc|order)?\s*$",
    re.IGNORECASE,
)

# Canonical brand and item spelling overrides
CANONICAL_REPLACEMENTS = [
    (re.compile(r"\bcoca[\s\-]?cola\b", re.IGNORECASE), "Coca-Cola"),
    (re.compile(r"\bchknjoy\b|\bchicken\s+joy\b", re.IGNORECASE), "Chickenjoy"),
    (re.compile(r"\byum\s+burger\b", re.IGNORECASE), "Yumburger"),
    (re.compile(r"\bparacetamol\s+biogesic\b", re.IGNORECASE), "Biogesic Paracetamol"),
]


def clean_item_name(raw_name: str) -> str:
    """
    Cleans raw item strings from menus and flyers.
    Returns empty string if string is gibberish or too short (< 2 chars).
    """
    if not raw_name or not isinstance(raw_name, str):
        return ""

    # Strip trailing price artifacts
    text = PRICE_TRAIL_PATTERN.sub("", raw_name.strip())

    # Remove non-text noise and collapse whitespace
    text = NOISE_PATTERN.sub(" ", text).strip()

    if len(text) < 2:
        return ""

    # Clean capitalization: Title Case for words, preserving known acronyms
    words = text.split()
    capitalized = []
    unit_pattern = re.compile(r"^([0-9]+(?:\.[0-9]+)?)([a-zA-Z]+)$")
    for w in words:
        if w.upper() in {"BLT", "BBQ", "KFC", "HD", "XL", "XXL", "ML", "L", "KG", "G", "PC", "PCS"}:
            capitalized.append(w.upper())
        elif w.lower() in {"w/", "w", "with", "and", "ng", "sa", "at", "de", "of", "in", "on"}:
            capitalized.append(w.lower())
        else:
            m = unit_pattern.match(w)
            if m:
                unit = m.group(2).lower() if m.group(2).lower() in {"pc", "pcs"} else m.group(2).upper()
                capitalized.append(f"{m.group(1)}{unit}")
            elif "-" in w:
                capitalized.append("-".join(part.capitalize() for part in w.split("-")))
            else:
                capitalized.append(w.capitalize())

    text = " ".join(capitalized)

    # Apply canonical brand normalization last so overrides stay intact
    for pattern, replacement in CANONICAL_REPLACEMENTS:
        text = pattern.sub(replacement, text)

    return text
