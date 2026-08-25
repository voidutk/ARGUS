"""Configuration, read once from the environment."""

import os


def _int(key: str, default: int) -> int:
    raw = os.environ.get(key)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


SERVICE_NAME = "argus-intel"
PORT = _int("INTEL_PORT", 8000)

NEO4J_URI = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = os.environ.get("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "argus_dev_pw")

# The browser NEVER reaches this service — Express is the only client, and the
# contract in docs/API.md says so explicitly ("Internal. CORS is locked to the
# Express origin. No JWT — network-isolated"). Keeping the list this tight means
# a misconfigured frontend fails loudly rather than quietly bypassing auth.
ALLOWED_ORIGINS = [
    o.strip()
    for o in os.environ.get("INTEL_ALLOWED_ORIGINS", "http://localhost:4000,http://127.0.0.1:4000").split(",")
    if o.strip()
]

# A narrative longer than this is not a complaint, it is a paste accident.
MAX_NARRATIVE_CHARS = _int("MAX_NARRATIVE_CHARS", 20_000)
