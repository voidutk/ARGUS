# ARGUS — intelligence service

FastAPI on `:8000`. Owns entity extraction and the Neo4j projection.

**Internal.** The browser never reaches it; Express on `:4000` is the only
client, and there is no JWT because the service is network-isolated. See
`docs/API.md`.

---

## Running it

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt     # Windows
# .venv/bin/python -m pip install -r requirements.txt       # macOS / Linux

.venv/Scripts/python -m uvicorn app.main:app --port 8000 --reload
```

Interactive docs at `http://127.0.0.1:8000/docs`.

Nothing else needs to be running. Neo4j missing costs the projection; spaCy
missing costs the NER tier; `/extract` works regardless, which is the only thing
the demo cannot do without.

## Testing

```bash
.venv/Scripts/python tests/test_extract.py
```

Runs without pytest, so a demo machine needs no extra dependency.

Those fixtures are **shared verbatim** with `backend/test/extract.test.js`. Two
implementations of one pattern set can drift, and the failure mode is silent: a
complaint filed while this service is up would link to more cases than the
identical complaint filed a minute later while it is down. Identical fixtures on
both sides turn that into a failing test instead of a mystery.

---

## What it implements, and what it deliberately does not

| Route | |
|---|---|
| `GET /health` | liveness + capability (spaCy loaded? Neo4j connected? node count) |
| `POST /extract` | **the demo-critical path** — every identifier in a narrative |
| `POST /ingest` | merge one complaint into Neo4j |
| `POST /ingest/bulk` | rebuild the projection from a batch |
| `POST /analytics/run` | **501** — delegated to Express |
| `GET /graph/*` | **501** — delegated to Express |

The 501s are a documented boundary, not an omission. Express already computes
PageRank, Brandes betweenness, connected components and label-propagation
communities over Postgres; that implementation is unit-tested and independently
verified by `scripts/verify-plant.js`, which proves centrality ranks the planted
coordinators first. A second NetworkX copy here would be two implementations of
the same maths that can silently disagree about **who the coordinator is** —
the single claim this whole project rests on.

`intelClient.js` reads 501 as a definitive capability answer rather than a
failure, so it falls back to the proven path and it never counts against the
circuit breaker. That distinction matters: without it, three dashboard loads
would trip the breaker and `/extract` — which this service *does* implement —
would start failing fast for a service that is perfectly healthy.

---

## Extraction

Two tiers, per §I:

- **REGEX** — deterministic, high confidence, carries the demo alone.
- **NER** — spaCy, `PERSON` and `LOCATION` only, strictly additive.

Pattern order is load-bearing. Each match **claims its character span** so a
later pattern cannot re-match inside it. Without that, three things break
immediately:

- `imran@okhdfcbank` matches both `EMAIL` and `UPI`
- `+919334825546` (12 digits) matches `BANK_ACCOUNT`
- the hex inside a wallet address matches nothing sensible

**Amounts are the real hazard.** A narrative is full of them — `₹42,500`,
`2,85,000`, `Rs. 48500` — and a naive digit-run pattern turns every rupee figure
into a bank account, inventing a suspect account from nothing. Digit boundaries
plus an 11-digit minimum keep them apart: Indian account numbers are 11+ digits,
and the largest amount in this corpus is seven. There is a test asserting
exactly this, because it is the most dangerous false positive available.

`NER` is narrow on purpose. spaCy's `ORG` and `MONEY` labels would fire on
"CBI", "Axis Bank" and every rupee figure in the narrative — none of which are
suspects, and all of which would clutter the graph with nodes an investigator
cannot act on.

## Scene 2 cannot break

`POST /api/complaints` tries this service first and falls back to a regex tier
inside Express (`backend/src/services/localExtract.js`) when it cannot answer.
The response says which tier ran:

```jsonc
"extraction": { "tier": "intel-service", "degraded": false, "count": 7 }
"extraction": { "tier": "express-regex", "degraded": true,
                "reason": "intel-service unreachable (ECONNREFUSED)", "count": 6 }
```

A regex-only result is never presented as though this service produced it.
Everything else in §F degrades into a staler picture; extraction is the one that
would degrade into an empty panel in front of judges, so it gets a second path.
