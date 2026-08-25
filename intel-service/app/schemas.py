"""
Request and response shapes.

These mirror docs/API.md's FastAPI table exactly. Pydantic validating them at
the edge means a malformed call from Express is a 422 naming the field, rather
than a TypeError halfway through an extraction.
"""

from typing import Any

from pydantic import BaseModel, Field


class ExtractRequest(BaseModel):
    narrative: str = Field(min_length=1)
    complaint_id: int | None = None


class ExtractedEntity(BaseModel):
    type: str
    value: str
    normalized_value: str
    confidence: float
    method: str
    context_snippet: str | None = None


class ExtractTiers(BaseModel):
    regex: int
    ner: int


class ExtractResponse(BaseModel):
    entities: list[ExtractedEntity]
    duration_ms: float
    tiers: ExtractTiers
    # Surfaced so Express — and ultimately the UI — can say whether the NER tier
    # was available, instead of quietly returning fewer entities than usual.
    spacy: str


class IngestRequest(BaseModel):
    # Loose on purpose: Express sends the Postgres row through unchanged, and
    # pinning every column here would mean editing this file for a migration
    # that has nothing to do with the graph.
    complaint: dict[str, Any]
    entities: list[dict[str, Any]] = []
    transactions: list[dict[str, Any]] = []


class BulkIngestItem(BaseModel):
    complaint: dict[str, Any]
    entities: list[dict[str, Any]] = []


class BulkIngestRequest(BaseModel):
    complaints: list[BulkIngestItem] = []
    source: str | None = None
