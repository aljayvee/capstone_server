"""
The live merchant catalogue, and which built-in vocabulary each category carries.

Everything the models know is keyed by a category's NAME: the lexicon files
"pandesal" under "Bakery", OpenStreetMap's bakeries arrive as the concept
"bakery", and a dispatcher's filed item is stored as the text "Store 1 -
Julie's | Bakery". Category names are owner-editable, and until 2026-09-25 a
rename cut all of that loose:

  - Bakery renamed "Breads & Pastries": the bakery lexicon and the map's
    bakeries fell back to Fast Food, and pandesal went to Jollibee again.
  - "Fast Food & Restaurant" renamed "Restaurants": the trainer kept the old
    name as a class, the model kept answering it, and the API, which has no
    category by that name, returned no suggestion for Chickenjoy or Jollibee.

So the vocabulary is now bound to ROLES (roles.json), and each role to the live
category that carries it: by exact name first, then by the words in the
category's name and description. A rename that still says what the category
is ("Breads & Pastries", "Restaurants", "Drugstores") keeps everything it
learned. The same file is read by the Node store suggester, so the mapped
Tacurong shops follow the rename too.

A category no role binds is the owner's own ("Hardware & Construction"). It
learns from its name, and from its DESCRIPTION: each phrase in it ("nails,
cement, paint, plywood") becomes a seed, and lexicon phrases it names move to
it. Built-in categories do not take seeds from their descriptions, because
theirs describe neighbours too ("Fast food ... bakeries, and cafes").
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Iterable, Mapping

ROLES_FILE = Path(__file__).with_name("roles.json")

_NON_WORD = re.compile(r"[^a-z0-9ñ]+")


def words(text: str | None) -> str:
    """Lower case, punctuation to spaces, one space between words: the form keywords match in."""
    return " ".join(_NON_WORD.sub(" ", (text or "").lower()).split())


def _mentions(text: str, keyword: str) -> bool:
    return f" {keyword} " in f" {text} "


@dataclass(frozen=True)
class Role:
    key: str
    names: tuple[str, ...]
    keywords: tuple[str, ...]
    parent: str | None = None


@lru_cache(maxsize=1)
def load_roles() -> tuple[Role, ...]:
    raw = json.loads(ROLES_FILE.read_text(encoding="utf-8"))
    return tuple(
        Role(
            key=r["key"],
            names=tuple(r["names"]),
            keywords=tuple(words(k) for k in r["keywords"]),
            parent=r.get("parent"),
        )
        for r in raw["roles"]
    )


def role_for_label(label: str | None) -> Role | None:
    """The role a stored label names: a role key ("bakery") or one of its canonical names ("Bakery")."""
    if not label:
        return None
    key = words(label)
    for role in load_roles():
        if key == role.key or key in {words(n) for n in role.names}:
            return role
    return None


def role_score(role: Role, name: str, description: str = "") -> int:
    """Keyword mentions: twice for the name, once for the description."""
    n, d = words(name), words(description)
    return sum(2 * _mentions(n, k) + _mentions(d, k) for k in role.keywords)


def bind_roles(categories: Mapping[str, str]) -> tuple[dict[str, str], list[str]]:
    """
    `{role key: category name}` for a catalogue of `{name: description}`, and
    the roles left unbound because two categories matched them equally well.

    Exact names first. Then, repeatedly, the strongest remaining
    (role, category) match; a tie between two categories for one role binds
    neither, because guessing would file a whole vocabulary under the wrong
    shop. Each category carries at most one role.
    """
    roles = load_roles()
    binding: dict[str, str] = {}
    taken: set[str] = set()
    by_word = {words(name): name for name in categories}
    for role in roles:
        for canonical in role.names:
            name = by_word.get(words(canonical))
            if name and name not in taken:
                binding[role.key] = name
                taken.add(name)
                break

    while True:
        # The strongest remaining match. Strict ">" keeps the first role in
        # file order on a tie between roles, so base roles win over concepts.
        # A role whose best two categories tie sits this round out: another
        # role may yet claim one of them and settle it.
        best: tuple[int, str, str] | None = None
        tied: list[str] = []
        for role in roles:
            if role.key in binding:
                continue
            scores = sorted(
                ((role_score(role, name, desc), name) for name, desc in categories.items() if name not in taken),
                key=lambda s: -s[0],
            )
            if not scores or scores[0][0] <= 0:
                continue
            if len(scores) > 1 and scores[1][0] == scores[0][0]:
                tied.append(role.key)
                continue
            if best is None or scores[0][0] > best[0]:
                best = (scores[0][0], role.key, scores[0][1])
        if best is None:
            return binding, tied
        _, key, name = best
        binding[key] = name
        taken.add(name)


# Split on list punctuation and list words BEFORE punctuation is normalised
# away, or "nails, cement, paint" is one phrase.
_SPLIT = re.compile(r"[,;:/()\[\]\n.!?]|&|\band\b|\bor\b|\betc\b|\be\.?g\.?\b|\bsuch as\b|\blike\b|\bincluding\b", re.IGNORECASE)
_FILLER = {
    "this", "is", "it", "a", "an", "the", "for", "of", "to", "we", "our", "intended", "sells", "selling",
    "sell", "items", "item", "things", "other", "all", "kinds", "kind", "various", "etc",
}


def description_phrases(description: str | None) -> list[str]:
    """
    'Hardware, construction supplies: nails, cement, paint.' ->
    ['hardware', 'construction supplies', 'nails', 'cement', 'paint'].
    Filler words are trimmed from each end ("this is intended for ...").
    """
    out: list[str] = []
    for chunk in _SPLIT.split(description or ""):
        tokens = words(chunk).split()
        while tokens and tokens[0] in _FILLER:
            tokens.pop(0)
        while tokens and tokens[-1] in _FILLER:
            tokens.pop()
        phrase = " ".join(tokens)
        if len(phrase) < 3 or len(phrase) > 40 or phrase in out:
            continue
        out.append(phrase)
    return out


def _singular(phrase: str) -> str:
    return " ".join(w[:-1] if len(w) > 3 and w.endswith("s") and not w.endswith("ss") else w for w in phrase.split())


@dataclass
class Catalogue:
    """The active categories (with descriptions) and the role each one carries."""

    descriptions: dict[str, str]
    binding: dict[str, str] = field(init=False)
    ambiguous: list[str] = field(init=False)

    def __post_init__(self):
        self.binding, self.ambiguous = bind_roles(self.descriptions)
        self._role_of = {name: key for key, name in self.binding.items()}

    @classmethod
    def of(cls, categories: "Catalogue | Iterable[str] | None", descriptions: Mapping[str, str] | None = None) -> "Catalogue":
        """From names (and optional descriptions); None means the lexicon's own four."""
        if isinstance(categories, Catalogue):
            return categories
        if categories is None:
            categories = [r.names[0] for r in load_roles() if r.parent is None]
        names = [c.strip() for c in categories if c and c.strip()]
        return cls({n: (descriptions or {}).get(n, "") for n in names})

    @property
    def names(self) -> set[str]:
        return set(self.descriptions)

    def __contains__(self, name: object) -> bool:
        return name in self.descriptions

    def __iter__(self):
        return iter(sorted(self.descriptions))

    def role_of(self, category: str) -> str | None:
        return self._role_of.get(category)

    def category_for_role(self, key: str, fall_back: bool = True) -> str | None:
        """The live category carrying a role; with `fall_back`, its parent's when none does."""
        if key in self.binding:
            return self.binding[key]
        if not fall_back:
            return None
        role = next((r for r in load_roles() if r.key == key), None)
        return self.category_for_role(role.parent) if role and role.parent else None

    def resolve(self, label: str | None) -> str | None:
        """
        A stored label as a live category name, or None when it names nothing here.
        Live names pass through; old canonical names ("Bakery" after a rename)
        and concepts ("bakery") go to the category carrying their role.
        """
        if not label:
            return None
        if label in self.descriptions:
            return label
        role = role_for_label(label)
        return self.category_for_role(role.key) if role else None

    def custom(self) -> list[str]:
        """Categories no role binds: the owner's own, taught by their name and description."""
        return sorted(n for n in self.descriptions if n not in self._role_of)

    def describe(self) -> str:
        roles = ", ".join(f"{k}={v}" for k, v in sorted(self.binding.items()))
        extra = f"; ambiguous: {', '.join(self.ambiguous)}" if self.ambiguous else ""
        own = f"; own: {', '.join(self.custom())}" if self.custom() else ""
        return f"roles: {roles}{own}{extra}"


def singular(phrase: str) -> str:
    """'hammers' -> 'hammer', for matching a description's plural against the lexicon's singular."""
    return _singular(words(phrase))
