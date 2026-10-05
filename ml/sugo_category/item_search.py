"""
Searching the items the item model knows, for the dispatcher's Catalog Helper.

The helper in stage 3 used to search only crawled menus, a table nothing had
filled, so every search came back empty. This is one of the three sources it
searches now (the API server merges them, see catalogSuggestionService.ts): the
item lexicon, about 600 things people ask a rider to buy, each filed under the
kind of shop that sells it. It says where an item is usually bought, never that
a particular shop stocks it; the order history is what says that.

Only phrases that are items in the lexicon are offered. The lexicon's other
rows (shop names moved by CONTESTED_CONCEPTS, generate_dynamic_seeds' guesses
such as "pet supplies item") are training data, not things a customer orders.
"""

from __future__ import annotations

from typing import Iterable

from .lexicon import ITEM_PHRASES, synthetic_rows
from .model import normalize

# Kept lower case inside a name, as people write them: "3 in 1 Coffee".
_SMALL_WORDS = {"in", "of", "and", "ng", "sa", "con", "with", "at", "de", "na", "y"}
# Written in capitals: "AA Battery", not "Aa Battery".
_UPPER_WORDS = {"aa", "aaa", "bp", "led", "usb", "gi", "pvc", "kfc", "eq", "rtw", "a4"}
_ITEM_TEXTS = {phrase for phrases in ITEM_PHRASES.values() for phrase in phrases}


def display_name(phrase: str) -> str:
    words = phrase.split()
    return " ".join(
        w.upper() if w in _UPPER_WORDS
        else w if (i and w in _SMALL_WORDS)
        else w[:1].upper() + w[1:]
        for i, w in enumerate(words)
    )


class ItemCatalogue:
    """The lexicon's items, filed under the categories one trained model has."""

    def __init__(self, classes: Iterable[str]):
        classes = set(classes)
        seen: dict[str, tuple[str, str]] = {}
        # synthetic_rows resolves contested concepts against the catalogue, so
        # "pandesal" is Bakery where a Bakery category exists, as it was trained.
        for text, category, kind in synthetic_rows(classes):
            if kind != "item" or category not in classes or text not in _ITEM_TEXTS:
                continue
            key = normalize(text)
            if key:
                seen.setdefault(key, (text, category))
        self._entries = [(key, key.replace(" ", ""), text, cat) for key, (text, cat) in seen.items()]

    def __len__(self) -> int:
        return len(self._entries)

    def search(self, query: str, limit: int = 8) -> list[dict]:
        """
        Best matches first: the exact name, then names that start with the
        query, then names with a word starting with each query word
        ("bio" finds Biogesic, "chick" finds Chickenjoy and Fried Chicken),
        then run-together spellings ("milktea" finds Milk Tea), then known items
        named inside a longer query. Shorter names first within a rank, so
        "Rice" comes before "Jasmine Rice".
        """
        q = normalize(query)
        if len(q) < 2:
            return []
        tokens, squashed = q.split(), q.replace(" ", "")
        query_words = set(tokens)
        scored = []
        for key, key_squashed, text, category in self._entries:
            words = key.split()
            if key == q:
                rank = 0
            elif key.startswith(q):
                rank = 1
            elif all(any(w.startswith(t) for w in words) for t in tokens):
                rank = 2
            elif squashed in key_squashed:
                rank = 3
            elif set(words) <= query_words:
                # A known item inside a longer name: "Biogesic" for
                # "biogesic 500mg", "Chickenjoy" for "2pc chickenjoy with rice".
                rank = 4
            else:
                continue
            scored.append((rank, len(key), key, text, category))
        scored.sort()
        return [{"name": display_name(text), "category": category} for *_, text, category in scored[:limit]]
