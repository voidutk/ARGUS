"""
Identifier normalisation — the Python mirror of backend/src/services/normalize.js.

These two files MUST agree, character for character, on what any given
identifier reduces to. Two complaints only link when the same identifier
normalises to the same string, and `entities` has UNIQUE (entity_type,
normalized_value) as the backstop — but the backstop only helps if the value
arriving is already canonical.

If a rule changes here, change it there too, and re-run the seed. The JS file
carries the same warning pointing back at this one.
"""

import re

_NON_DIGIT = re.compile(r"\D")
_WHITESPACE = re.compile(r"\s+")


def phone(raw: str) -> str:
    """Indian mobile: drop +91/0 prefixes, punctuation and spaces down to 10 digits."""
    digits = _NON_DIGIT.sub("", str(raw))
    if len(digits) > 10 and digits.startswith("91"):
        return digits[-10:]
    if len(digits) == 11 and digits.startswith("0"):
        return digits[1:]
    return digits[-10:]


def upi(raw: str) -> str:
    """UPI handles are case-insensitive; banks hand them out in mixed case."""
    return str(raw).strip().lower()


def email(raw: str) -> str:
    return str(raw).strip().lower()


def wallet(raw: str) -> str:
    """
    Wallets: lowercase. EVM addresses are checksum-CASED, not checksum-valued —
    0xAbC and 0xabc are the same account, and treating them as two entities
    would split a laundering chain in half.
    """
    return str(raw).strip().lower()


def bank_account(raw: str) -> str:
    """Account numbers arrive with spaces and dashes from statements."""
    return _NON_DIGIT.sub("", str(raw))


def ip(raw: str) -> str:
    return str(raw).strip()


def device(raw: str) -> str:
    return str(raw).strip().lower()


def handle(raw: str) -> str:
    """Telegram/social handles: strip the leading @, lowercase."""
    return str(raw).strip().lstrip("@").lower()


def text(raw: str) -> str:
    """Names and places: lowercase, collapse internal whitespace."""
    return _WHITESPACE.sub(" ", str(raw).strip().lower())


BY_TYPE = {
    "PHONE": phone,
    "UPI": upi,
    "EMAIL": email,
    "WALLET": wallet,
    "BANK_ACCOUNT": bank_account,
    "IP": ip,
    "DEVICE": device,
    "TELEGRAM": handle,
    "PERSON": text,
    "LOCATION": text,
}


def normalize(entity_type: str, value: str) -> str:
    """Normalise by entity type. Unknown types fall back to trimmed lowercase."""
    return BY_TYPE.get(entity_type, text)(value)
