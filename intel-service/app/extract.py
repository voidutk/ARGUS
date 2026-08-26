"""
Entity extraction from a complaint narrative.

This is the demo's Scene 2 (docs/PROJECT.md §T) and the one moment that must be
genuinely live. It is also the module most likely to embarrass us, because a
false positive is not a missing feature — it is an invented link between two
unrelated victims, drawn on a graph, in front of judges.

Two tiers, per §I:

  REGEX  deterministic, high confidence, carries the demo on its own.
  NER    spaCy, strictly additive, for PERSON and LOCATION only. If the model
         is absent the regex tier answers alone and nothing degrades except
         the two soft types.

The ordering below is load-bearing. Patterns are applied most-specific first
and every match CLAIMS its character span, so a later pattern cannot re-match
inside it. Without that, three things go wrong immediately:

  - `imran@okhdfcbank` matches both EMAIL and UPI
  - `+919334825546` (12 digits) matches BANK_ACCOUNT
  - the hex inside `0xf3cBd2...` matches nothing sensible at all

Amounts are the other hazard. A narrative is full of them — "₹42,500",
"2,85,000", "Rs. 48500" — and a naive digit-run pattern turns every rupee
figure into a bank account. Digit boundaries plus a minimum length of 11 keep
them apart: Indian account numbers are 11+ digits, and a seeded amount tops out
at seven.
"""

import re
import time
from typing import Iterable

from . import normalize

# ---------------------------------------------------------------------------
# Patterns
# ---------------------------------------------------------------------------

# An EVM address. Fixed length, so this is unambiguous and goes first.
WALLET_RE = re.compile(r"\b0x[a-fA-F0-9]{40}\b")

# Email before UPI, because both contain '@'. The distinguishing feature is the
# domain: an email domain always has a dot (a TLD), a UPI handle never does
# (okaxis, oksbi, ybl, paytm). That rule holds for real handles, not just ours.
EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b")

# UPI: a local part, '@', then a handle with NO dot in it.
UPI_RE = re.compile(r"\b[A-Za-z0-9._\-]{2,}@[A-Za-z][A-Za-z0-9]{1,}\b")

# A Telegram handle as written in a narrative: '@' then the name. Requires the
# preceding character not to be alphanumeric, so it cannot fire on the '@'
# inside an email or UPI id that survived the earlier passes.
TELEGRAM_RE = re.compile(r"(?<![A-Za-z0-9._%+\-])@([A-Za-z][A-Za-z0-9_]{3,31})\b")

IPV4_RE = re.compile(
    r"\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b"
)

# Indian mobile, optionally +91/0 prefixed, and tolerant of separators INSIDE
# the number — "+91 98765 43210" and "98765-43210" are how people actually type
# a phone number into a complaint form, even though our generator writes them
# unspaced. Requiring ten contiguous digits silently missed those.
#
# The digit lookarounds are what stop this matching the first ten digits of an
# eleven-digit account number: a trailing digit fails `(?!\d)`, so the run is
# rejected here and picked up by ACCOUNT_RE instead.
PHONE_RE = re.compile(r"(?<!\d)(?:\+?91[\s\-]?|0)?([6-9](?:[\s\-]?\d){9})(?!\d)")

# Bank account: 11 to 18 digits, not embedded in a longer digit run.
#
# The boundaries are on DIGITS only, deliberately. An earlier version also
# excluded a neighbouring comma, to keep comma-grouped amounts out — but that
# rejected "account 32118638954," in ordinary prose, which is how the seeded
# narratives actually write it. The exclusion was never needed: commas are not
# consumed by \d, so "2,85,000" reaches this pattern as runs of 1, 2 and 3
# digits, and the 11-digit minimum already puts every rupee figure in this
# corpus (largest: 20,00,000 — seven digits) out of reach.
ACCOUNT_RE = re.compile(r"(?<!\d)(\d{11,18})(?!\d)")

# IFSC is recognised only so its trailing digits cannot be mistaken for an
# account number. It is NOT emitted — `entities.entity_type` has no IFSC member,
# and inventing one to hold a bank branch code would be modelling a routing
# detail as a suspect.
IFSC_RE = re.compile(r"\b[A-Z]{4}0[A-Z0-9]{6}\b")

CONTEXT_CHARS = 60


def _snippet(text: str, start: int, end: int) -> str:
    """
    The words around a match, for the UI's "found here" highlight.

    Trimmed to whole-ish words and collapsed onto one line so it renders in a
    single row without a newline blowing up the layout.
    """
    left = max(0, start - CONTEXT_CHARS)
    right = min(len(text), end + CONTEXT_CHARS)
    fragment = text[left:right].replace("\n", " ").strip()
    fragment = re.sub(r"\s+", " ", fragment)
    prefix = "…" if left > 0 else ""
    suffix = "…" if right < len(text) else ""
    return f"{prefix}{fragment}{suffix}"


class _Claims:
    """Character spans already taken by a higher-priority pattern."""

    def __init__(self) -> None:
        self._spans: list[tuple[int, int]] = []

    def overlaps(self, start: int, end: int) -> bool:
        return any(start < s_end and end > s_start for s_start, s_end in self._spans)

    def take(self, start: int, end: int) -> None:
        self._spans.append((start, end))


def _scan(
    text: str,
    claims: _Claims,
    pattern: re.Pattern,
    entity_type: str | None,
    confidence: float,
    group: int = 0,
) -> list[dict]:
    """
    Applies one pattern, skipping anything already claimed.

    `entity_type=None` means "claim the span but emit nothing" — how IFSC is
    handled: recognised so it cannot be misread, never reported as an entity.
    """
    found: list[dict] = []
    for match in pattern.finditer(text):
        start, end = match.span()
        if claims.overlaps(start, end):
            continue
        claims.take(start, end)
        if entity_type is None:
            continue

        raw = match.group(group)
        normalized = normalize.normalize(entity_type, raw)
        if not normalized:
            continue

        found.append(
            {
                "type": entity_type,
                "value": raw.strip(),
                "normalized_value": normalized,
                "confidence": confidence,
                "method": "REGEX",
                "context_snippet": _snippet(text, start, end),
            }
        )
    return found


# Order is priority. See the module docstring for why each step sits where it does.
_PIPELINE: list[tuple[re.Pattern, str | None, float, int]] = [
    (WALLET_RE, "WALLET", 0.99, 0),
    (IFSC_RE, None, 0.0, 0),          # claimed, never emitted
    (EMAIL_RE, "EMAIL", 0.98, 0),
    (UPI_RE, "UPI", 0.97, 0),
    (TELEGRAM_RE, "TELEGRAM", 0.94, 1),
    (IPV4_RE, "IP", 0.96, 0),
    (PHONE_RE, "PHONE", 0.97, 1),
    (ACCOUNT_RE, "BANK_ACCOUNT", 0.95, 1),
]


def _dedupe(entities: Iterable[dict]) -> list[dict]:
    """
    One row per (type, normalized_value).

    A narrative naming the same UPI id three times is one entity mentioned three
    times, not three entities — and inserting it three times would inflate the
    graph's degree for that node and skew every centrality score computed from
    it. The first occurrence wins, so the snippet points at the earliest mention.
    """
    seen: set[tuple[str, str]] = set()
    unique: list[dict] = []
    for entity in entities:
        key = (entity["type"], entity["normalized_value"])
        if key in seen:
            continue
        seen.add(key)
        unique.append(entity)
    return unique


# ---------------------------------------------------------------------------
# spaCy — additive, never required
# ---------------------------------------------------------------------------

_nlp = None
_spacy_state = "not-loaded"


def load_spacy() -> bool:
    """
    Attempts to load en_core_web_sm once.

    Failure is recorded and reported through /health rather than raised. §4 is
    explicit that regex carries the demo and NER is additive: a machine without
    the model must still extract every identifier that matters.
    """
    global _nlp, _spacy_state
    if _nlp is not None:
        return True
    if _spacy_state.startswith("unavailable"):
        return False

    try:
        import spacy  # noqa: PLC0415 — optional dependency, imported on demand
    except ImportError:
        _spacy_state = "unavailable: spacy is not installed"
        return False

    try:
        _nlp = spacy.load("en_core_web_sm", disable=["lemmatizer", "tagger"])
        _spacy_state = "loaded"
        return True
    except OSError:
        _spacy_state = "unavailable: en_core_web_sm is not downloaded"
        return False


def spacy_state() -> str:
    return _spacy_state


def _ner(text: str, claims: _Claims) -> list[dict]:
    """
    PERSON and LOCATION only.

    Deliberately narrow. spaCy's ORG and MONEY labels would fire on "CBI",
    "Axis Bank" and every rupee figure in the narrative — none of which are
    suspects, and all of which would clutter the graph with nodes an
    investigator cannot act on. Confidence is fixed at 0.75 because the model
    does not expose a per-entity score, and claiming a precise one would be
    inventing a number.
    """
    if not load_spacy():
        return []

    found: list[dict] = []
    for ent in _nlp(text).ents:
        if ent.label_ not in ("PERSON", "GPE", "LOC"):
            continue
        if claims.overlaps(ent.start_char, ent.end_char):
            continue

        entity_type = "PERSON" if ent.label_ == "PERSON" else "LOCATION"
        value = ent.text.strip()
        # Single tokens under three characters are almost always a parse slip.
        if len(value) < 3:
            continue

        claims.take(ent.start_char, ent.end_char)
        found.append(
            {
                "type": entity_type,
                "value": value,
                "normalized_value": normalize.normalize(entity_type, value),
                "confidence": 0.75,
                "method": "NER",
                "context_snippet": _snippet(text, ent.start_char, ent.end_char),
            }
        )
    return found


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def extract(narrative: str) -> dict:
    """
    Every identifier in one narrative.

    Returns the payload docs/API.md specifies for POST /extract:
    `{ entities[], duration_ms }`, plus the tier breakdown so the UI can be
    honest about which entities came from a deterministic rule and which came
    from a model.
    """
    started = time.perf_counter()
    text = str(narrative or "")

    claims = _Claims()
    entities: list[dict] = []
    for pattern, entity_type, confidence, group in _PIPELINE:
        entities.extend(_scan(text, claims, pattern, entity_type, confidence, group))

    ner_entities = _ner(text, claims)
    entities.extend(ner_entities)

    unique = _dedupe(entities)
    return {
        "entities": unique,
        "duration_ms": round((time.perf_counter() - started) * 1000, 2),
        "tiers": {
            "regex": sum(1 for e in unique if e["method"] == "REGEX"),
            "ner": sum(1 for e in unique if e["method"] == "NER"),
        },
        "spacy": _spacy_state,
    }
