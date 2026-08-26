# ARGUS — API contract

Frozen on Day 0. **This is what lets the three lanes stop talking to each other.**
If you need a shape that is not here, change this file first and tell the other two.

Two services. The frontend only ever calls Express on `:4000`. Express proxies
graph and AI work to FastAPI on `:8000`. FastAPI is never reachable from the browser.

- All Express routes except `/health*` and `/api/auth/login` require `Authorization: Bearer <jwt>`.
- All errors are `{ error, code, request_id }` with a real status code. `error` is
  the human-readable string the original contract promised and has not changed
  shape; `code` is a stable machine-readable slug (`NOT_FOUND`, `RATE_LIMITED`,
  `DB_UNAVAILABLE`…) and `request_id` matches the `X-Request-Id` response header,
  so a failure on screen can be found in the server log without guessing from
  timestamps. Validation failures add `details[]` naming each bad field.
- All timestamps are ISO 8601 UTC.
- Money is a number of rupees, never a formatted string. The frontend formats.
- List endpoints return `{ items[], total, limit, offset, has_more }`. `total` is
  the size of the whole result set, not of the page.
- **Empty query values mean "absent".** `?state=&category=UPI_FRAUD` is what a form
  sends with one filter cleared; the API ignores the empty one rather than
  rejecting the request.
- Every response carries `X-Request-Id`. Quote it in a bug report.

### Health

| Method | Path | Returns |
|---|---|---|
| `GET` | `/health` | `{status, service, env, version, uptime_s}` — liveness. Touches nothing, so a database blip cannot trigger a restart storm. |
| `GET` | `/health/ready` | `{ready, checks}` — readiness. 503 when Postgres is unreachable. intel-service and the chain are reported elsewhere but never gate readiness: §F forbids either being a single point of failure. |

---

## Express core API — `http://localhost:4000`

### Auth

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| `POST` | `/api/auth/login` | `{email, password}` | `{token, user}` |
| `GET` | `/api/auth/me` | — | `{user}` |

`user` = `{id, email, full_name, role, rank_title, unit_code, wallet_address}`
`role` ∈ `ADMIN` · `SUPERVISOR` · `INVESTIGATOR` · `ANALYST`

### Complaints

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| `GET` | `/api/complaints` | `?state&category&cluster&limit&offset` | `{complaints[], total}` |
| `GET` | `/api/complaints/:id` | — | `{complaint, entities[], linked[], cluster}` |
| `POST` | `/api/complaints` | `{victim_name, victim_phone, narrative, scam_category, amount_inr, state, district}` | `{complaint, entities[], cluster, linked_count}` |
| `PATCH` | `/api/complaints/:id` | `{status}` | `{complaint}` — triage. ADMIN/SUPERVISOR/INVESTIGATOR. |

`POST /api/complaints` is **the demo's Scene 2**. It is synchronous and does the
whole pipeline: insert → call `/extract` → upsert entities → call `/ingest` →
return what was found. It must complete in under 3 seconds.

`entities[]` item = `{id, entity_type, value, normalized_value, confidence, method, context_snippet, risk_score}`
`linked[]` item = `{complaint_id, complaint_ref, shared_entities[], strength}`

### Entities

| Method | Path | Returns |
|---|---|---|
| `GET` | `/api/entities/:id` | `{entity, complaints[], neighbors_count, cluster, node_id}` |
| `GET` | `/api/entities?type=WALLET&flagged=true&limit=20` | `{entities[], total, limit, offset, has_more}` |
| `GET` | `/api/entities/:id/why` | explainability, by database id — see **Explainability** below |
| `GET` | `/api/entities/:id/osint` | `{entity_type, value, results[], any_live, any_simulated}` |
| `GET` | `/api/osint/adapters` | `{adapters[], integrity_rule}` |

**OSINT provenance is not optional.** Every result carries `simulated: true|false`,
stamped by the framework rather than by the adapter, plus `note` and `available`.
A `simulated` result must render a visible `SIMULATED` chip. Two adapters are
genuinely live (Nominatim geocoding, Blockscout wallet lookup); the rest are
deterministic illustrations and say so.

### Graph — proxied to FastAPI

| Method | Path | Query | Returns |
|---|---|---|---|
| `GET` | `/api/graph/overview` | `?limit=150` | `{nodes[], edges[], stats}` |
| `GET` | `/api/graph/neighbors/:nodeId` | `?depth=1&limit=50` | `{nodes[], edges[]}` |
| `GET` | `/api/graph/cluster/:clusterKey` | — | `{nodes[], edges[], cluster}` |
| `POST` | `/api/graph/rebuild` | — | `{ingested, nodes, edges}` (ADMIN only) |
| `GET` | `/api/graph/why/:nodeId` | — | explainability — see below |
| `GET` | `/api/graph/path` | `?from=&to=` | `{found, hops, node_ids[], nodes[], edges[], narrative}` |
| `GET` | `/api/graph/common` | `?a=&b=` | `{a, b, shared[], count, directly_connected}` |

### Explainability — `/why`

Answers "why is this person flagged?" (PLAN-V2 §3.1). Always computed from
Postgres, never proxied: the explanation and the graph on screen must come from
the same source, or the explanation is worthless.

```jsonc
{ "node": { "id": "person:vikram rathore", "label": "Vikram Rathore",
            "influence": 100, "betweenness": 0.31, "degree": 25 },
  "bridge_paths": [
    { "from": {"label": "Caller A — Ritu Mehta"}, "to": {"label": "Cell C wallet"},
      "severs": true, "narrative": "Caller A — Ritu Mehta → [Vikram Rathore] → Cell C wallet" }
  ],
  "severing_pair_count": 3,
  "removal_test": { "component_size_before": 165, "fragments_after": 4,
                    "fragmenting": true,
                    "summary": "Removing this node splits a 165-node network into 4 fragments" },
  "rank": { "in_cluster": 1, "cluster_size": 112, "graph_wide": 1 },
  "appearances": { "complaint_count": 0, "never_named": true },
  "method": { "influence": "…", "removal_test": "…", "bridge_paths": "…" } }
```

`appearances.never_named` is the line that lands in §T scene 4: the most
important person in the network is the one no victim ever named. `method`
states how each figure was derived and must be shown, not hidden behind a
tooltip.

**Cytoscape-ready shapes. Do not reshape these on the client.**

```jsonc
// node
{ "id": "wallet:0x4a2b...9f1c", "pg_id": 812, "label": "0x4A2b…9F1c",
  "type": "WALLET", "cluster": "ALPHA", "influence": 91, "risk": 88,
  "degree": 17, "is_mastermind": false }

// edge
{ "id": "e_4412", "source": "phone:9876543210", "target": "wallet:0x4a2b...9f1c",
  "type": "TRANSFERRED_TO", "weight": 4, "label": "4 complaints" }
```

`id` is `<lowercased type>:<normalized_value>` and is stable across rebuilds —
the frontend may cache on it.

### Analytics

| Method | Path | Returns |
|---|---|---|
| `GET` | `/api/clusters` | `{clusters[]}` |
| `GET` | `/api/clusters/:key` | `{cluster, mastermind, top_entities[], complaints[], states[]}` |
| `POST` | `/api/analytics/run` | `{clusters, nodes_scored, duration_ms}` (ADMIN only) |

`cluster` = `{cluster_key, label, description, node_count, complaint_count, total_amount_inr, states_touched, risk_level, risk_score, mastermind}`

### Money flow

| Method | Path | Returns |
|---|---|---|
| `GET` | `/api/money/trace/:complaintId` | `{nodes[], links[], summary}` |

**d3-sankey shape**, already ordered by hop:

```jsonc
{ "nodes": [ { "id": "acct:4471", "label": "HDFC ••4471", "type": "BANK_ACCOUNT", "hop": 0, "role": "VICTIM" } ],
  "links": [ { "source": "acct:4471", "target": "acct:9982", "value": 48500, "rail": "UPI", "reference": "UTR3391..." } ],
  "summary": { "total_inr": 48500, "hops": 5, "terminal": "EXCHANGE", "recovered_inr": 0 } }
```

### Reference data — NCRB · OFFICIAL (PLAN-V2 §2)

Layer 1: the only genuinely official data in ARGUS. Aggregate case counts per
district per year, 2001–2014. **Every response carries `provenance: "NCRB · OFFICIAL"`
and a `source_note`, and the UI must render both.** These are counts of recorded
cases, not individuals; they name nobody and cannot be correlated. What they are
is verifiable — the district sums reconcile exactly with NCRB's own published
state totals.

| Method | Path | Query | Returns |
|---|---|---|---|
| `GET` | `/api/reference/meta` | — | `{loaded, metrics[], years[], states[], caveats[]}` |
| `GET` | `/api/reference/states` | `?metric=CHEATING&year=2014` | `{states[], max_value, provenance}` — choropleth |
| `GET` | `/api/reference/district/:state/:district` | — | `{latest, state_totals, share_of_state, series[]}` |
| `GET` | `/api/reference/trend` | `?state=&metric=&district=` | `{series[], national[], summary}` |
| `GET` | `/api/reference/fraud` | `?year=&state=` | `{rows[], totals_by_bracket}` |

`metric` ∈ `CHEATING` · `CRIMINAL_BREACH_OF_TRUST` · `FORGERY` · `TOTAL_IPC`.
`FORGERY` exists only in the 2014 schema. Telangana appears from 2014 onward;
earlier years count its districts under Andhra Pradesh, and are **not**
back-filled — moving historical counts into a state that did not yet exist
would falsify the source.

Build the year selector and layer toggle from `/api/reference/meta`, not from a
hardcoded range.

### Geo

| Method | Path | Returns |
|---|---|---|
| `GET` | `/api/geo/states` | `{states[], max_complaints, provenance: "SYNTHETIC"}` — `{state, complaint_count, total_amount_inr, dominant_category, risk_level, intensity}` |
| `GET` | `/api/geo/routes` | `{routes[], provenance: "SYNTHETIC"}` — `{from_state, to_state, count, cluster_key}` |

The Geo page toggles between this layer and `/api/reference/states`. Both carry
`provenance`; the badge is driven by that field, never hardcoded per page.

### Evidence

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/api/evidence` | `?complaint_id` | `{evidence[]}` |
| `POST` | `/api/evidence/upload` | multipart: `file`, `title`, `evidence_type`, `complaint_id` | `{evidence}` |
| `POST` | `/api/evidence/:id/verify` | — | `{is_valid, computed_hash, chain_hash, chain, history[]}` |
| `GET` | `/api/evidence/:id/download` | — | file stream |
| `GET` | `/api/evidence/:id/history` | — | `{history[]}` from `getEvidenceHistory` |
| `POST` | `/api/evidence/:id/anchor` | — | retry a FAILED or stuck-PENDING anchor (ADMIN/SUPERVISOR) |

`evidence` = `{id, title, filename, evidence_type, size_bytes, sha256_hash, complaint_ref, uploaded_by_name, created_at, anchor: {status, tx_hash, block_number, network, explorer_url, anchored_at}}`

Upload returns as soon as the file is stored and hashed. **Anchoring is async** —
the row starts `PENDING` and the UI polls. A dead RPC must never block an upload.

### Chain

| Method | Path | Returns |
|---|---|---|
| `GET` | `/api/chain/status` | `{ready, reason, network, chainId, contractAddress, relayer, total_anchored}` |
| `GET` | `/api/chain/transactions` | `{transactions[]}` |

### Alerts / threat feed

| Method | Path | Returns |
|---|---|---|
| `GET` | `/api/alerts` | `?severity&status&rule&limit` → `{alerts[], counts}` |
| `GET` | `/api/alerts/rules` | `{rules[], note}` — the catalogue with thresholds |
| `GET` | `/api/alerts/:id/explain` | `{alert, generated, query_sql, matched_row}` |
| `PATCH` | `/api/alerts/:id` | `{status}` → `{alert}` |
| `POST` | `/api/alerts/regenerate` | `{rules_run, created, updated, detail[]}` (ADMIN/ANALYST) |

**Alerts are generated, not seeded** (PLAN-V2 §3.3). Each carries `rule_key` and
stores the SQL that produced it, so `/explain` can show an investigator the
query and the row it matched. Re-running the rules updates existing findings
rather than duplicating them.

Four rules ship: `ENTITY_REUSE`, `CIRCULAR_FLOW`, `VELOCITY`,
`SHARED_INFRASTRUCTURE`, plus `NEW_LINK` fired from the intake path.

`IMPOSSIBLE_TRAVEL` from the plan was implemented as `SHARED_INFRASTRUCTURE`
instead. The timing version does not survive the data model: a complaint's only
timestamp is `filed_at` — when the VICTIM reported — which has no relationship
to when a suspect's device was used, so dividing a distance between two victims
by the gap between two filings produces a number that looks like a speed and
means nothing. The finding underneath (one device or IP behind complaints in
several states is shared operational infrastructure) needs no timing and is the
part that was actually useful.

### Dashboard + timeline

| Method | Path | Returns |
|---|---|---|
| `GET` | `/api/dashboard/summary` | see below |
| `GET` | `/api/timeline` | `?limit=80&offset&action&actor_id` → `{events[], total, has_more}` |

```jsonc
{ "threat_index": 74, "threat_level": "HIGH",
  "active_networks": 3, "high_risk_wallets": 18, "open_investigations": 7,
  "complaints_total": 220, "complaints_today": 12,
  "amount_at_risk_inr": 48200000,
  "top_clusters": [ /* cluster summaries */ ],
  "recent_complaints": [ /* 8 most recent */ ],
  "recent_alerts": [ /* 8 most recent */ ] }
```

`events[]` item = `{id, action, actor_name, entity_type, entity_id, metadata, created_at}` — straight off `audit_logs`.

### Admin

| Method | Path | Returns |
|---|---|---|
| `GET` | `/api/admin/users` | `{users[]}` |
| `GET` | `/api/admin/health` | `{postgres, neo4j, intel, chain}` — each `{ok, detail}` |

---

## FastAPI intelligence service — `http://localhost:8000`

Internal. CORS is locked to the Express origin. No JWT — network-isolated.

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/health` | — | `{status, service, spacy_loaded, neo4j_connected, node_count}` |
| `POST` | `/extract` | `{narrative, complaint_id?}` | `{entities[], duration_ms}` |
| `POST` | `/ingest` | `{complaint, entities[], transactions[]}` | `{nodes_merged, edges_merged}` |
| `POST` | `/ingest/bulk` | `{complaints[]}` | `{ingested, nodes, edges}` |
| `POST` | `/analytics/run` | — | **501 — delegated to Express** |
| `GET` | `/graph/overview` | `?limit=150` | **501 — delegated to Express** |
| `GET` | `/graph/neighbors/{node_id}` | `?depth=1&limit=50` | **501 — delegated to Express** |
| `GET` | `/graph/cluster/{cluster_key}` | — | **501 — delegated to Express** |

FastAPI never touches Postgres.

### The 501s are a boundary, not a gap

Express already computes PageRank, Brandes betweenness, connected components and
label-propagation communities over Postgres. That implementation is unit-tested
and independently verified by `scripts/verify-plant.js`, which proves centrality
ranks the planted coordinators first. A second NetworkX copy in FastAPI would be
two implementations of the same maths that can silently disagree about **who the
coordinator is** — the one claim this whole project rests on.

`intelClient.js` reads 501 as a definitive *capability* answer rather than a
failure: it falls back to the proven path and **does not count it against the
circuit breaker**. Without that distinction three dashboard loads would trip the
breaker, and `/extract` — which the service does implement — would start failing
fast for a service that is perfectly healthy.

### Extraction cannot break

`POST /api/complaints` tries FastAPI first and falls back to a regex tier inside
Express (`backend/src/services/localExtract.js`). §T scene 2 is the one moment
that must be genuinely live, and it is the only degradation that would produce
an *empty panel* rather than a staler picture. The response says which tier ran:

```jsonc
"extraction": { "tier": "intel-service", "degraded": false, "count": 7, "duration_ms": 23 }
"extraction": { "tier": "express-regex", "degraded": true, "count": 6,
                "reason": "intel-service unreachable (ECONNREFUSED)" }
```

**A regex-only result is never presented as though the AI service produced it.**
The UI must surface `degraded`. Both tiers share fixtures
(`backend/test/extract.test.js` ↔ `intel-service/tests/test_extract.py`) so the
two pattern sets cannot drift apart unnoticed.

### Degradation rules — non-negotiable

| If this is down | Then |
|---|---|
| FastAPI | Express serves entities already in Postgres. Graph pages show the last-known cluster data with a "live analysis unavailable" banner. Nothing throws. |
| Neo4j | `/extract` still works (it is pure Python). Ingest queues and reports `degraded`. |
| Chain RPC | Uploads succeed, anchors stay `PENDING`, `/api/chain/status` reports `ready: false` with a reason. |
| spaCy model missing | Regex tier alone answers `/extract`. NER is strictly additive and never required. |
