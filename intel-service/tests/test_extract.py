"""
The regex extraction tier.

Deliberately the SAME fixtures as backend/test/extract.test.js. Two
implementations of one set of patterns can drift, and the failure mode of drift
is silent: Python finds an identifier JavaScript misses, so a complaint filed
while FastAPI is up links to more cases than the identical complaint filed a
minute later while it is down. Shared fixtures turn that into a failing test
rather than a mystery nobody reproduces.

Run with:  .venv/Scripts/python -m pytest tests/ -q
or with:   .venv/Scripts/python tests/test_extract.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.extract import extract  # noqa: E402
from app import normalize  # noqa: E402

# A verbatim narrative from the seeded corpus — the exact shape the demo runs.
REAL_NARRATIVE = (
    "I was contacted on WhatsApp from +91 9334825546 regarding a crypto arbitrage "
    "opportunity. They asked me to first send ₹42,500 to Axis Bank account 32118638954, "
    "and later told me to buy USDT and transfer to wallet address "
    "0xf3cBd2C5295dcDD0dEbC810f9ABF6eB8f0BEb32a. The dashboard showed my balance growing "
    "but withdrawal never worked. Their telegram was @nifty_vip_signals. I also paid "
    "2,85,000 via UPI imran@okhdfcbank as \"gas fee\"."
)


def types_of(text: str) -> list[str]:
    return sorted(e["type"] for e in extract(text)["entities"])


def value_of(text: str, entity_type: str) -> str | None:
    for e in extract(text)["entities"]:
        if e["type"] == entity_type:
            return e["normalized_value"]
    return None


# ---------------------------------------------------------------------------
# The happy path
# ---------------------------------------------------------------------------


def test_extracts_every_identifier_from_a_real_narrative():
    assert types_of(REAL_NARRATIVE) == [
        "BANK_ACCOUNT", "PHONE", "TELEGRAM", "UPI", "WALLET",
    ]
    assert value_of(REAL_NARRATIVE, "PHONE") == "9334825546"
    assert value_of(REAL_NARRATIVE, "BANK_ACCOUNT") == "32118638954"
    assert value_of(REAL_NARRATIVE, "UPI") == "imran@okhdfcbank"
    assert value_of(REAL_NARRATIVE, "TELEGRAM") == "nifty_vip_signals"
    # Checksum casing is not identity — 0xAbC and 0xabc are one account.
    assert value_of(REAL_NARRATIVE, "WALLET") == "0xf3cbd2c5295dcdd0debc810f9abf6eb8f0beb32a"
    assert all(e["context_snippet"] for e in extract(REAL_NARRATIVE)["entities"])


# ---------------------------------------------------------------------------
# What must NOT be extracted
# ---------------------------------------------------------------------------


def test_rupee_amounts_never_become_bank_accounts():
    # The most dangerous false positive available: a narrative is full of
    # amounts, and reading one as an account invents a suspect account.
    amounts = (
        "I paid Rs. 48,500 then 2,85,000 and finally 12,34,567 rupees. "
        "Total loss 15,68,067. Also 500000 and 2000000 rupees."
    )
    assert extract(amounts)["entities"] == []


def test_ifsc_does_not_leak_as_a_bank_account():
    text = "Sent to account 50112233445 of HDFC Bank, IFSC HDFC0123456."
    accounts = [e for e in extract(text)["entities"] if e["type"] == "BANK_ACCOUNT"]
    assert len(accounts) == 1
    assert accounts[0]["normalized_value"] == "50112233445"


def test_phone_is_not_carved_out_of_a_longer_account():
    # Eleven digits starting with 9. A pattern without digit boundaries would
    # take the first ten and invent a suspect phone number.
    text = "Account 98765432101 is eleven digits starting with nine."
    assert types_of(text) == ["BANK_ACCOUNT"]
    assert value_of(text, "BANK_ACCOUNT") == "98765432101"


def test_upi_and_email_are_not_confused():
    text = "Paid to rahul123@okaxis and got mail from priya.sharma42@gmail.com."
    assert types_of(text) == ["EMAIL", "UPI"]
    assert value_of(text, "UPI") == "rahul123@okaxis"
    assert value_of(text, "EMAIL") == "priya.sharma42@gmail.com"


def test_email_at_sign_does_not_become_a_telegram_handle():
    assert types_of("Mail came from scamdesk91@gmail.com only.") == ["EMAIL"]


# ---------------------------------------------------------------------------
# Format tolerance
# ---------------------------------------------------------------------------


def test_every_phone_format_normalises_to_ten_digits():
    for written in [
        "+91 9876543210", "+919876543210", "09876543210",
        "9876543210", "98765-43210", "+91 98765 43210",
    ]:
        assert value_of(f"Called from {written} yesterday.", "PHONE") == "9876543210", written


def test_shouted_upi_matches_its_lowercase_twin():
    # The generator uppercases a quarter of them. Two spellings that fail to
    # converge means the network is never found.
    assert value_of("Paid RAHUL@OKAXIS today.", "UPI") == "rahul@okaxis"


def test_repeated_mentions_are_one_entity():
    text = "Paid rahul@okaxis twice. Again rahul@okaxis. And RAHUL@OKAXIS once more."
    upis = [e for e in extract(text)["entities"] if e["type"] == "UPI"]
    assert len(upis) == 1, "three mentions must not inflate that node's graph degree"


# ---------------------------------------------------------------------------
# Robustness and contract
# ---------------------------------------------------------------------------


def test_repeated_calls_are_stable():
    counts = {len(extract(REAL_NARRATIVE)["entities"]) for _ in range(3)}
    assert len(counts) == 1
    assert counts.pop() > 0


def test_empty_and_junk_input_return_nothing():
    for value in ["", "   ", None, "no identifiers here at all"]:
        assert extract(value)["entities"] == []


def test_response_matches_the_documented_shape():
    result = extract(REAL_NARRATIVE)
    assert isinstance(result["entities"], list)
    assert isinstance(result["duration_ms"], float)
    assert result["tiers"]["regex"] + result["tiers"]["ner"] == len(result["entities"])
    for entity in result["entities"]:
        assert entity["method"] in ("REGEX", "NER")
        assert 0 < entity["confidence"] <= 1
        assert entity["normalized_value"]


# ---------------------------------------------------------------------------
# Normalisation parity with backend/src/services/normalize.js
# ---------------------------------------------------------------------------


def test_normalisation_matches_the_javascript_rules():
    assert normalize.phone("+91 98765 43210") == "9876543210"
    assert normalize.phone("09876543210") == "9876543210"
    assert normalize.phone("919876543210") == "9876543210"
    assert normalize.upi("Rahul@OKAXIS") == "rahul@okaxis"
    assert normalize.wallet("0xAbC123") == "0xabc123"
    assert normalize.email("  Victim@Gmail.COM ") == "victim@gmail.com"
    assert normalize.bank_account("5011 2233-4455") == "501122334455"
    assert normalize.handle("@ScamDesk") == "scamdesk"
    assert normalize.text("  Vikram   Rathore ") == "vikram rathore"
    # Unknown types must still produce something matchable, never None.
    assert normalize.normalize("SOMETHING_NEW", "  Mixed Case ") == "mixed case"


if __name__ == "__main__":
    # Runnable without pytest, so a demo machine needs no extra dependency.
    failures = 0
    for name, fn in sorted(globals().items()):
        if not name.startswith("test_") or not callable(fn):
            continue
        try:
            fn()
            print(f"  ok    {name}")
        except AssertionError as exc:
            failures += 1
            print(f"  FAIL  {name} — {exc}")
    print()
    if failures:
        print(f"{failures} failed")
        sys.exit(1)
    print("All extraction tests passed.")
