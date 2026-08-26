"""
ARGUS intelligence service — FastAPI on :8000.

Owns entity extraction and the Neo4j projection. Internal: the browser never
reaches it, Express is the only client, and there is no JWT because the service
is network-isolated (docs/API.md).

WHAT THIS SERVICE DOES AND DOES NOT DO
--------------------------------------
`/extract` and the Neo4j ingest paths are implemented here, because extraction
is genuinely this service's job and Scene 2 of the demo depends on it being
live.

`/analytics/run` and the `/graph/*` reads answer 501. That is a deliberate,
documented boundary rather than an omission: Express already computes PageRank,
Brandes betweenness, connected components and label-propagation communities over
Postgres, that implementation is covered by unit tests and by `verify-plant`,
and duplicating it here in NetworkX would mean two implementations of the same
maths that can silently disagree about who the coordinator is. A 501 tells
Express to use the path that is already proven, and `intelClient` treats it as a
definitive capability answer rather than a service failure — so it never counts
against the circuit breaker.
"""

import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import config, extract as extractor, graph
from .schemas import (
    BulkIngestRequest,
    ExtractRequest,
    ExtractResponse,
    IngestRequest,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-5s %(name)s %(message)s")
log = logging.getLogger("argus.intel")

STARTED_AT = time.time()


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Both are attempted and neither is required. spaCy missing costs the NER
    # tier; Neo4j missing costs the projection. Extraction works regardless,
    # which is the only thing the demo cannot do without.
    if extractor.load_spacy():
        log.info("spaCy en_core_web_sm loaded — NER tier active")
    else:
        log.warning("NER tier inactive (%s) — regex tier answers alone", extractor.spacy_state())

    graph.ensure_schema()
    state = graph.status()
    if state["connected"]:
        log.info("neo4j connected — %s nodes", state["node_count"])
    else:
        log.warning("neo4j unreachable (%s) — ingest will report degraded", state["reason"])

    yield
    graph.close()


app = FastAPI(
    title="ARGUS intelligence service",
    version="1.0.0",
    docs_url="/docs",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------


@app.get("/health")
def health():
    """
    Liveness and capability.

    `service` is checked by Express, not just the status code. A dev machine
    routinely has something else bound to :8000 — during this build it was a
    leftover FastAPI app from another project, which answered /health happily
    and would have received our complaint narratives. Identifying ourselves by
    name is what lets Express tell "our service" from "a stranger on the port".
    """
    neo = graph.status()
    return {
        "status": "ok",
        "service": config.SERVICE_NAME,
        "version": "1.0.0",
        "uptime_s": round(time.time() - STARTED_AT),
        "spacy_loaded": extractor.spacy_state() == "loaded",
        "spacy_detail": extractor.spacy_state(),
        "neo4j_connected": neo["connected"],
        "neo4j_reason": neo["reason"],
        "node_count": neo["node_count"],
    }


# ---------------------------------------------------------------------------
# Extraction — the demo-critical path
# ---------------------------------------------------------------------------


@app.post("/extract", response_model=ExtractResponse)
def post_extract(body: ExtractRequest):
    """
    Pulls every identifier out of one complaint narrative.

    Synchronous and fast — a few milliseconds for the regex tier — because
    Express calls this inline on the intake path and the whole request has a
    three-second budget (§T scene 2).
    """
    result = extractor.extract(body.narrative[: config.MAX_NARRATIVE_CHARS])
    log.info(
        "extract complaint=%s entities=%d regex=%d ner=%d %.1fms",
        body.complaint_id,
        len(result["entities"]),
        result["tiers"]["regex"],
        result["tiers"]["ner"],
        result["duration_ms"],
    )
    return result


# ---------------------------------------------------------------------------
# Neo4j projection
# ---------------------------------------------------------------------------


@app.post("/ingest")
def post_ingest(body: IngestRequest):
    """
    Merges one complaint and its entities into the graph.

    Reports `degraded` rather than failing when Neo4j is down: Express calls
    this fire-and-forget after the complaint is already durable in Postgres, so
    a graph write that cannot happen must never look like a filing that did not.
    """
    result = graph.ingest_complaint(body.complaint, body.entities)
    if not result["ok"]:
        return JSONResponse(status_code=status.HTTP_202_ACCEPTED, content=result)
    return result


@app.post("/ingest/bulk")
def post_ingest_bulk(body: BulkIngestRequest):
    """
    Rebuilds the projection from a batch.

    Express sends the whole Postgres corpus here on `POST /api/graph/rebuild`.
    Partial failure is reported per-complaint rather than aborting: a graph that
    is 90% rebuilt is more useful than one that gave up on the first bad row.
    """
    if not body.complaints:
        return {"ingested": 0, "nodes": 0, "edges": 0, "degraded": False}

    ingested = nodes = edges = 0
    failures: list[str] = []
    for item in body.complaints:
        result = graph.ingest_complaint(item.complaint, item.entities)
        if result["ok"]:
            ingested += 1
            nodes += result.get("nodes_merged", 0)
            edges += result.get("edges_merged", 0)
        else:
            failures.append(result.get("reason", "unknown"))

    return {
        "ingested": ingested,
        "nodes": nodes,
        "edges": edges,
        "degraded": bool(failures),
        "failed": len(failures),
        "reason": failures[0] if failures else None,
    }


# ---------------------------------------------------------------------------
# Analytics and graph reads — deliberately not implemented here
# ---------------------------------------------------------------------------

_DELEGATED = {
    "detail": (
        "Graph analytics run in the Express core API, over Postgres. That "
        "implementation is unit-tested and independently verified by "
        "scripts/verify-plant.js, which proves centrality ranks the planted "
        "coordinators first. Running the same maths again here in NetworkX "
        "would create two implementations that can disagree about who the "
        "coordinator is — so this service does not."
    ),
    "use_instead": "Express computes this itself; no action needed.",
}


def _delegated():
    # 501, not 404 or 503: this is a definitive statement about capability, not
    # a missing route or a transient outage. intelClient reads that distinction
    # and falls back without counting it against the circuit breaker.
    return JSONResponse(status_code=status.HTTP_501_NOT_IMPLEMENTED, content=_DELEGATED)


@app.post("/analytics/run")
def post_analytics_run():
    return _delegated()


@app.get("/graph/overview")
def get_graph_overview(limit: int = 150):  # noqa: ARG001 — signature mirrors the contract
    return _delegated()


@app.get("/graph/neighbors/{node_id:path}")
def get_graph_neighbors(node_id: str, depth: int = 1, limit: int = 50):  # noqa: ARG001
    return _delegated()


@app.get("/graph/cluster/{cluster_key}")
def get_graph_cluster(cluster_key: str):  # noqa: ARG001
    return _delegated()
