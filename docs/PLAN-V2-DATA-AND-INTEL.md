# ARGUS — Plan v2: Data Strategy & Intelligence Layer

Supplements `docs/PROJECT.md`. Written after auditing `crime-in-india-datasets/`
and reviewing an alternative architecture proposal. Everything in PROJECT.md
still stands; this document changes **where the data comes from** and **adds
four investigator features** that survived a feasibility pass.

---

## 1. The dataset audit — read this first

I checked every file in `crime-in-india-datasets/` for columns ARGUS could
correlate on. The result decides the whole data strategy.

| Dataset | Rows | What it actually is | Linkable identifiers |
|---|---|---|---|
| `crime_dataset_india.csv` | 40,160 | Incident records: City, Crime Description, Victim Age/Gender, Weapon, Domain, Police Deployed, Case Closed | **none** |
| `crime/01_District_wise_*IPC*` | 2001–2014 | NCRB **aggregate counts** per state/district/year across 93 IPC heads | **none** |
| `31_Serious_fraud.csv` | 2001–2010 | Fraud case counts bucketed by loss (₹1–10cr … ₹100cr+), per state/year | **none** |
| `42/43_*crime_against_women*` | aggregates | State/year counts | **none** |
| everything else | aggregates | Police strength, custodial deaths, trials, arrests | **none** |

**No file contains a phone number, UPI ID, bank account, wallet, email, IMEI, or
a named suspect.** Not one. That is not an oversight in the datasets — entity-level
crime records are not public anywhere in the world, for obvious legal reasons.

### What this means

> **These datasets cannot power the Criminal Network Explorer, mastermind
> detection, or money-flow tracing.** Those three features are ARGUS. They need
> identifiers that recur across complaints; there is nothing here to recur.

A second finding matters for honesty: `crime_dataset_india.csv` is **itself
synthetic**. Its 21 crime types appear 1,859–1,980 times each — a uniform draw,
not a crime distribution. It also assigns "Weapon Used: Poison" to a homicide
filed under domain "Other Crime". Presenting it to judges as real NCRB data
would be a factual error someone may well catch.

### What this means we should NOT do

Do not attempt to derive a criminal network from these files. Any network built
from aggregate counts would be fabricated — we would be inventing the edges and
then claiming the algorithm discovered them. That is the one failure mode that
would actually sink this project under questioning.

### The strategy this forces — and why it is stronger

Three labelled layers, each honest about what it is:

| Layer | Source | Powers | Label in UI |
|---|---|---|---|
| **1 — Official statistics** | NCRB 2001–2014, real | Geo Intelligence choropleth, district baselines, historical context | `NCRB · OFFICIAL` |
| **2 — Operational corpus** | Our generator, deterministic, topology-verified | Network Explorer, clusters, mastermind, money flow, complaints | `SYNTHETIC` |
| **3 — Live enrichment** | OSINT adapters (§4) | Geocoding, wallet lookups, breach checks | `LIVE` or `SIMULATED` |

**Every data surface in the UI carries its provenance badge.** This is not a
disclaimer we hide — it is a feature. When a judge asks "is this real?", the
answer is already on screen, and the follow-up writes itself:

> *"The national picture is real NCRB data. The network layer is synthetic
> because entity-level cybercrime data is not public — which is exactly why this
> system has to run inside MHA, on live NCRP and CCTNS feeds. Point it at real
> data and nothing about the architecture changes."*

That answer is better than any amount of pretending, and it converts the
limitation into the argument for deployment.

---

## 2. Layer 1 — wiring the real NCRB data

**New table** (`002_reference_data.sql`):

```sql
CREATE TABLE crime_reference (
  id SERIAL PRIMARY KEY,
  state VARCHAR(80) NOT NULL,
  district VARCHAR(80),
  year SMALLINT NOT NULL,
  metric VARCHAR(60) NOT NULL,     -- CHEATING | CRIMINAL_BREACH_OF_TRUST | FORGERY | TOTAL_IPC
  value INTEGER NOT NULL,
  source VARCHAR(40) NOT NULL DEFAULT 'NCRB',
  UNIQUE (state, district, year, metric)
);

CREATE TABLE fraud_reference (
  id SERIAL PRIMARY KEY,
  state VARCHAR(80) NOT NULL,
  year SMALLINT NOT NULL,
  loss_bracket VARCHAR(24) NOT NULL,   -- 1_10_CR … ABOVE_100_CR
  cases INTEGER NOT NULL
);
```

**Loader** — `backend/scripts/load-reference-data.js`:
- Parses `crime/01_District_wise_crimes_committed_IPC_{2001_2012,2013,2014}.csv`,
  keeping only the four financial-crime columns (`Cheating`,
  `Criminal Breach of Trust`, `Forgery`, `Total Cognizable IPC crimes`).
- Parses `31_Serious_fraud.csv` into `fraud_reference`.
- Normalises state names (NCRB uses `A&N Islands`, `Delhi UT`, `D&N Haveli`) to a
  single canonical list shared with the map's TopoJSON — **this normalisation is
  the whole job**; get it wrong and half the map renders blank.
- Skips `TOTAL (ALL-INDIA)` and `TOTAL (STATES)` rollup rows, which would
  otherwise double every figure.
- Ignores `crime_dataset_india.csv` entirely. It is synthetic and adds nothing
  our own generator does not do better and more honestly.

**New endpoints:**
- `GET /api/reference/states?metric=CHEATING&year=2014` → choropleth values
- `GET /api/reference/district/:state/:district` → the baseline panel
- `GET /api/reference/trend?state=X&metric=CHEATING` → 2001–2014 sparkline

**Where it shows up:** Geo Intelligence gets a **layer toggle** — *Live
complaints (synthetic)* vs *NCRB financial crime (official)*. Complaint
Intelligence gets a one-line baseline: *"Cheating cases in Bengaluru Urban,
2014: 1,247 (NCRB)."* Real, cited, and it makes the synthetic layer look more
credible by sitting next to something verifiable.

---

## 3. Adopted from the alternative proposal

Reviewed against our 5-day runway and our actual problem statement. These four
earn their place:

### 3.1 Explainability — "why is this person flagged?" ⭐ highest value
When ARGUS names a coordinator it must show its working. We already compute
betweenness; the paths that produce it are recoverable.

`GET /api/entities/:id/why` returns:
- the **bridge paths** — concrete routes between cells that pass through this
  node, rendered as `Caller B → [Vikram Rathore] → Cell C wallet`
- the count of node pairs whose shortest path they sit on
- **what breaks if you remove them**: recompute connected components without the
  node and report how many fragments the cluster falls into
- complaints they appear in: **0** — the line that lands

This directly answers the hardest judging question and costs about half a day.
Nothing else on this list beats it.

### 3.2 Shortest path & common connections
Two genuinely useful investigator tools, nearly free — the BFS already exists in
`graphAlgos.js`.
- `GET /api/graph/path?from=<nodeId>&to=<nodeId>` → *"these two complaints are
  four hops apart, through this mule account"*
- `GET /api/graph/common?a=<nodeId>&b=<nodeId>` → shared neighbours

### 3.3 Rule-based anomaly alerts (replaces the hand-written alert list)
Right now `alerts` is seeded prose. Make the threat feed **generated**, so it
updates when data changes:
- **Entity reuse** — identifier in ≥ N complaints across ≥ M states
- **Circular flow** — a cycle in `TRANSFERRED_TO` (classic layering)
- **Velocity** — an account receiving ≥ N transfers inside a window
- **Impossible travel** — same device, two states, implausible interval
- **New-link** — a filing that joins an existing cluster on submit

Each alert stores the query that produced it, so clicking it re-runs the check.

### 3.4 OSINT adapters — with a hard integrity rule
A `OsintConnector` interface with real and simulated implementations:

| Adapter | Status | Notes |
|---|---|---|
| Nominatim / OSM geocoding | **real** | free, no key, works offline-cached |
| Blockscout / Etherscan (Amoy) | **real, read-only** | wallet balance + first/last seen; doubles the blockchain story |
| Phone carrier/region lookup | **simulated** | Indian numbering-series mapping is deterministic and honest to derive |
| Breach check (HIBP-style) | **simulated** | no key in a hackathon |
| Social handle resolution | **simulated** | |

> **Non-negotiable:** every simulated adapter returns
> `{ simulated: true, note: "Illustrative — no live query made" }`, and the UI
> renders a visible `SIMULATED` chip. We demonstrate that the architecture
> supports OSINT fusion; we never imply we queried a service we did not. A judge
> who spots an undisclosed mock will discount the entire project, and they would
> be right to.

---

## 4. Deliberately NOT adopting

Stated with reasons, so the decisions are reviewable rather than silent.

| Suggestion | Why not |
|---|---|
| **Faker-generated random suspects with assigned "kingpin" roles** | Random edges do not produce a findable kingpin. We proved this today: our first two topologies failed `verify-plant` and ranked a mule account above the coordinator. A label saying "Kingpin" on a node that centrality does not surface is exactly the fabrication we must avoid. Our generator designs the topology and then **verifies** the algorithm finds it. |
| **`en_core_web_trf` / custom-trained NER** | ~500MB, slow, needs GPU to be pleasant, and a venue laptop may not download it. `en_core_web_sm` + regex covers every identifier we care about. Regex carries the demo; NER is additive. |
| **Neo4j Bloom** | Cytoscape.js already gives us the interaction model, and Bloom adds licensing friction for zero demo gain. |
| **Women-safety / trafficking module** | Real and important, but SIH26189 is a cybercrime problem statement under MHA. Adding a second domain in 5 days dilutes the one thing we do well. The datasets support it if a judge asks — say so, do not build it. |
| **General drug-trafficking / CDR framing** | The alternative proposal is written for a generic crime-network hackathon. Our PS is specifically cybercrime complaint correlation. Keep the focus. |
| **LLM-generated intelligence briefs** | Genuinely nice, but it is a day of work plus an API key plus a failure mode on stage. Park it as a stretch goal for after Day 5. |

---

## 5. Current build status

**Ports — resolved.** The scrapped TRINETRA stack has been shut down: backend
(:4000), risk engine (:8000), the `trinetra-postgres` container, and a stale
Hardhat node holding :8545. ARGUS now runs on the conventional ports — API
**:4000**, Postgres **:5432**, Neo4j **:7474 / :7687**, chain **:8545**. Nothing
was deleted; `docker start trinetra-postgres` restores that stack with its volume
intact if it is ever wanted again.

**Verified green, end to end:**

| Check | Command | Result |
|---|---|---|
| Seed determinism | two runs, content-hashed | **identical** — 220 / 962 / 1,211 / 71 / 292 |
| Planted topology | `npm run verify-plant` | **3/3 PASS** — coordinators rank #1, and are the top 3 nodes graph-wide |
| API surface | `npm run smoke` | **34/34** — asserts response shapes, not just status codes |
| Evidence + tamper | `npm run evidence-e2e` | **18/18** — tamper detected and permanently recorded on-chain |
| Contract | `npm --prefix blockchain test` | **17/17** |
| All three API suites | `npm run verify-all` | runs them in order |

**What is actually built:**

- Postgres schema — 14 tables, migrated, indexed
- Seeder — 220 complaints · 962 canonical entities · 1,211 complaint links ·
  71 intelligence edges · 292 transactions. Deterministic: two runs produce
  byte-identical data, verified by content hash over every narrative and every
  entity value. A demo that reshuffles itself cannot be rehearsed.
- `EvidenceRegistry.sol` deployed to the local chain
- Express API — auth, complaints, entities, graph, clusters, alerts, geo, money,
  timeline, evidence, chain, admin
- `graphService` — real PageRank and Brandes betweenness computed over Postgres,
  so the graph pages work **without Neo4j at all**. The §F degradation rule is
  not a plan; it is already satisfied and tested.

**Three real bugs caught by these suites, not by reading code:**

1. `Verification.at` in the contract collided with `Array.prototype.at` on
   ethers `Result` objects, so the timestamp read back as a function. Renamed to
   `checkedAt`.
2. `intelClient` treated any HTTP 200 on :8000 as "intel-service up" — and the
   leftover TRINETRA risk engine was answering there. ARGUS would have posted
   extraction requests to another project's service. It now verifies the
   reported service identity.
3. Two seeded topologies ranked a mule account above the coordinator.
   `verify-plant` refused both. Fixed by making the cells airtight and rotating
   operational assets — not by touching the scoring.

**The tamper test is the one that proves §J.** It substitutes *validly
encrypted* different content under the real key, so AES-GCM still decrypts
cleanly and only the digest comparison can catch it. It then asserts the
mismatch is appended to the on-chain custody trail beside the earlier pass:

```
1. MATCH     "integrity confirmed"
2. MISMATCH  "digest mismatch — exhibit altered at rest"
```

If that second line could be suppressed, the blockchain would be decoration.

**One blocker remains:** the frontend has not been started.


---

## 6. Revised schedule

| | Core & Data | AI & Graph | Frontend |
|---|---|---|---|
| **now** | resolve ports; smoke-test all endpoints | — | — |
| **D1** | NCRB loader + `crime_reference`; reference endpoints | FastAPI skeleton, regex extractor, Neo4j MERGE ingest | Theme, Shell, Login, routing, Bits kit, provenance badge |
| **D2** | generated alert rules (§3.3) | spaCy NER, bulk ingest, Louvain | Dashboard, stat tiles, threat feed |
| **D3** | evidence upload + anchor queue wiring | `/why` explainability (§3.1), path & common (§3.2) | **Network Explorer** — full day |
| **D4** | deploy contract local + Amoy; OSINT adapters | risk scoring, anomaly rules, re-verify plant | Complaint Intelligence, Money Flow, **Geo with NCRB layer** |
| **D5** | health checks, audit → timeline | fallbacks for every AI path | Timeline, Evidence Locker, Admin, polish |

Day 5 afternoon stays frozen for rehearsal.

---

## 7. Demo script changes

Two additions to the eight scenes in PROJECT.md §T:

- **Scene 4 becomes the strongest moment.** After ARGUS names the coordinator,
  click **"Why?"** — the bridge paths render, the removal test shows the cluster
  fragmenting into three, and the counter reads *named in 0 complaints*. That is
  explainable AI demonstrated, not asserted.
- **New Scene 3.5 — the honesty beat.** Toggle the Geo page to the NCRB layer.
  *"This layer is real: NCRB district cheating cases, 2014. The network layer is
  synthetic, because entity-level data is not public. Point ARGUS at NCRP and
  the architecture is unchanged."* Judges consistently reward a team that draws
  this line before being asked.

---

## 8. Immediate next steps

1. Decide the port question in §5 (one line from you).
2. Smoke-test every endpoint against the seeded database; fix what breaks.
3. Write `load-reference-data.js` and the state-name normaliser.
4. Start the frontend: theme tokens, Shell, Login, provenance badge component.
