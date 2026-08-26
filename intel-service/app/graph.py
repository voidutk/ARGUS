"""
Neo4j — the derived graph index.

Postgres is the source of truth; this is a projection that can be dropped and
rebuilt from it at any time (migration 001's header says so, and nothing in the
platform depends on this being up). That is why every function here reports a
failure instead of raising: Express treats this whole service as advisory, and
Neo4j being down must degrade the graph, not the platform.

The node id scheme is shared with Express verbatim — `<lowercased type>:<normalized_value>`
for entities and `complaint:<id>` for complaints (docs/API.md). Both sides
computing the same id is what lets the Postgres fallback and the Neo4j path
return interchangeable payloads.
"""

import logging
from typing import Any

from neo4j import GraphDatabase
from neo4j.exceptions import Neo4jError, ServiceUnavailable

from . import config

log = logging.getLogger("argus.graph")

_driver = None
_last_error: str | None = None


def driver():
    """Lazily opens the driver. Never raises; returns None when unreachable."""
    global _driver, _last_error
    if _driver is not None:
        return _driver
    try:
        _driver = GraphDatabase.driver(
            config.NEO4J_URI,
            auth=(config.NEO4J_USER, config.NEO4J_PASSWORD),
            connection_timeout=4,
        )
        _driver.verify_connectivity()
        _last_error = None
    except Exception as exc:  # noqa: BLE001 — any failure here is "Neo4j is down"
        _driver = None
        _last_error = str(exc)
    return _driver


def status() -> dict:
    """What /health reports about the graph store."""
    d = driver()
    if d is None:
        return {"connected": False, "reason": _last_error, "node_count": None}
    try:
        with d.session() as session:
            count = session.run("MATCH (n) RETURN count(n) AS n").single()["n"]
        return {"connected": True, "reason": None, "node_count": count}
    except (Neo4jError, ServiceUnavailable) as exc:
        return {"connected": False, "reason": str(exc), "node_count": None}


# The constraints that make MERGE both correct and fast. Without a uniqueness
# constraint, two concurrent MERGEs on the same id can each create a node.
_SCHEMA = [
    "CREATE CONSTRAINT entity_id IF NOT EXISTS FOR (e:Entity) REQUIRE e.id IS UNIQUE",
    "CREATE CONSTRAINT complaint_id IF NOT EXISTS FOR (c:Complaint) REQUIRE c.id IS UNIQUE",
]


def ensure_schema() -> None:
    d = driver()
    if d is None:
        return
    try:
        with d.session() as session:
            for statement in _SCHEMA:
                session.run(statement)
    except (Neo4jError, ServiceUnavailable) as exc:
        log.warning("could not apply neo4j schema: %s", exc)


def _entity_node_id(entity_type: str, normalized: str) -> str:
    return f"{str(entity_type).lower()}:{normalized}"


_MERGE = """
MERGE (c:Complaint {id: $complaint_id})
  SET c.ref = $ref, c.category = $category, c.amount_inr = $amount,
      c.state = $state, c.district = $district, c.filed_at = $filed_at
WITH c
UNWIND $entities AS ent
  MERGE (e:Entity {id: ent.id})
    SET e.type = ent.type, e.value = ent.value,
        e.normalized_value = ent.normalized_value, e.pg_id = ent.pg_id
  MERGE (c)-[r:REPORTED_IN]->(e)
    SET r.role = ent.role, r.confidence = ent.confidence, r.method = ent.method
RETURN count(e) AS merged
"""


def ingest_complaint(complaint: dict[str, Any], entities: list[dict[str, Any]]) -> dict:
    """
    Merges one complaint and its entities.

    Idempotent by construction — MERGE on a deterministic id means re-ingesting
    the same complaint updates it rather than duplicating it, which matters
    because Express calls this fire-and-forget and may retry.
    """
    d = driver()
    if d is None:
        return {"ok": False, "degraded": True, "reason": _last_error or "neo4j unreachable"}

    payload = []
    for e in entities or []:
        normalized = e.get("normalized_value")
        entity_type = e.get("entity_type") or e.get("type")
        if not normalized or not entity_type:
            continue
        payload.append(
            {
                "id": _entity_node_id(entity_type, normalized),
                "type": entity_type,
                "value": e.get("value"),
                "normalized_value": normalized,
                "pg_id": e.get("id"),
                "role": e.get("role", "SUSPECT"),
                "confidence": e.get("confidence", 1.0),
                "method": e.get("method", "REGEX"),
            }
        )

    try:
        with d.session() as session:
            result = session.run(
                _MERGE,
                complaint_id=complaint.get("id"),
                ref=complaint.get("complaint_ref"),
                category=complaint.get("scam_category"),
                amount=float(complaint.get("amount_inr") or 0),
                state=complaint.get("state"),
                district=complaint.get("district"),
                filed_at=str(complaint.get("filed_at") or ""),
                entities=payload,
            ).single()
        return {
            "ok": True,
            "degraded": False,
            "nodes_merged": (result["merged"] if result else 0) + 1,
            "edges_merged": len(payload),
        }
    except (Neo4jError, ServiceUnavailable) as exc:
        return {"ok": False, "degraded": True, "reason": str(exc)}


def close() -> None:
    global _driver
    if _driver is not None:
        _driver.close()
        _driver = None
