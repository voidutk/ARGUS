# ARGUS — API contract

Frozen on Day 0. **This is what lets the three lanes stop talking to each other.**
If you need a shape that is not here, change this file first and tell the other two.

Two services. The frontend only ever calls Express on `:4000`. Express proxies
graph and AI work to FastAPI on `:8000`. FastAPI is never reachable from the browser.

- All Express routes except `/health` and `/api/auth/login` require `Authorization: Bearer <jwt>`.
- All errors are `{ "error": "human readable string" }` with a real status code.
- All timestamps are ISO 8601 UTC.
- Money is a number of rupees, never a formatted string. The frontend formats.

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

`POST /api/complaints` is **the demo's Scene 2**. It is synchronous and does the
whole pipeline: insert → call `/extract` → upsert entities → call `/ingest` →
return what was found. It must complete in under 3 seconds.

`entities[]` item = `{id, entity_type, value, normalized_value, confidence, method, context_snippet, risk_score}`
`linked[]` item = `{complaint_id, complaint_ref, shared_entities[], strength}`

### Entities

| Method | Path | Returns |
|---|---|---|
| `GET` | `/api/entities/:id` | `{entity, complaints[], neighbors_count, cluster}` |
| `GET` | `/api/entities?type=WALLET&flagged=true&limit=20` | `{entities[], total}` |

### Graph — proxied to FastAPI

| Method | Path | Query | Returns |
|---|---|---|---|
| `GET` | `/api/graph/overview` | `?limit=150` | `{nodes[], edges[], stats}` |
| `GET` | `/api/graph/neighbors/:nodeId` | `?depth=1&limit=50` | `{nodes[], edges[]}` |
| `GET` | `/api/graph/cluster/:clusterKey` | — | `{nodes[], edges[], cluster}` |
| `POST` | `/api/graph/rebuild` | — | `{ingested, nodes, edges}` (ADMIN only) |

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

### Geo

| Method | Path | Returns |
|---|---|---|
| `GET` | `/api/geo/states` | `{states[]}` — `{state, complaint_count, total_amount_inr, dominant_category, risk_level}` |
| `GET` | `/api/geo/routes` | `{routes[]}` — `{from_state, to_state, count, cluster_key}` |

### Evidence

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/api/evidence` | `?complaint_id` | `{evidence[]}` |
| `POST` | `/api/evidence/upload` | multipart: `file`, `title`, `evidence_type`, `complaint_id` | `{evidence}` |
| `POST` | `/api/evidence/:id/verify` | — | `{is_valid, computed_hash, chain_hash, chain, history[]}` |
| `GET` | `/api/evidence/:id/download` | — | file stream |
| `GET` | `/api/evidence/:id/history` | — | `{history[]}` from `getEvidenceHistory` |

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
| `GET` | `/api/alerts` | `?severity&status&limit` → `{alerts[], counts}` |
| `PATCH` | `/api/alerts/:id` | `{status}` → `{alert}` |

### Dashboard + timeline

| Method | Path | Returns |
|---|---|---|
| `GET` | `/api/dashboard/summary` | see below |
| `GET` | `/api/timeline` | `?limit=80&case_ref` → `{events[]}` |

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
| `POST` | `/analytics/run` | — | `{clusters[], nodes_scored, duration_ms}` |
| `GET` | `/graph/overview` | `?limit=150` | `{nodes[], edges[], stats}` |
| `GET` | `/graph/neighbors/{node_id}` | `?depth=1&limit=50` | `{nodes[], edges[]}` |
| `GET` | `/graph/cluster/{cluster_key}` | — | `{nodes[], edges[], cluster}` |

`/analytics/run` returns cluster summaries; **Express writes them to Postgres.**
FastAPI never touches Postgres.

### Degradation rules — non-negotiable

| If this is down | Then |
|---|---|
| FastAPI | Express serves entities already in Postgres. Graph pages show the last-known cluster data with a "live analysis unavailable" banner. Nothing throws. |
| Neo4j | `/extract` still works (it is pure Python). Ingest queues and reports `degraded`. |
| Chain RPC | Uploads succeed, anchors stay `PENDING`, `/api/chain/status` reports `ready: false` with a reason. |
| spaCy model missing | Regex tier alone answers `/extract`. NER is strictly additive and never required. |
