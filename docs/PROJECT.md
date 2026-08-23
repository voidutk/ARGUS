# ARGUS — Complete Project Document

**AI-Powered Criminal Network Analysis System**
Smart India Hackathon 2026 · Problem Statement **SIH26189**
Theme: Blockchain & Cybersecurity · Organisation: **Ministry of Home Affairs (MHA)**

> This is the single source of truth for the project. Everything a new team
> member, mentor, or judge needs is in here. Read §A–§E for what we are building,
> §F–§L for how, §P to get it running, §Q–§S for the plan and the demo.

**Document status:** written Day 0. Sections marked 🔨 are built, ⏳ are planned.
**Companion docs:** `docs/API.md` (frozen API contract — the interface between the three lanes).

---

# PART 1 — WHAT WE ARE BUILDING

## §A. Identity

| | |
|---|---|
| **Name** | ARGUS |
| **Problem statement** | SIH26189 — AI-Powered Criminal Network Analysis System |
| **Theme** | Blockchain & Cybersecurity |
| **Organisation** | Ministry of Home Affairs, Government of India |
| **Team** | 3 developers |
| **Runway** | 5 days to demo |
| **Repo** | `SIH 21689/` (fresh; the earlier TRINETRA-X project is scrapped) |

ARGUS is named for the hundred-eyed watchman of Greek myth — the system sees
every complaint at once, which is exactly what a human investigator cannot do.

## §B. The problem

India's cybercrime reporting pipeline (NCRP / 1930 helpline) receives complaints
as **isolated records**. Each one arrives as a victim's free-text narrative plus
scattered metadata:

> phone numbers · UPI IDs · bank accounts · crypto wallets · IP addresses ·
> device IDs · email IDs · Telegram handles · locations · screenshots · transaction IDs

The evidence that links complaints to each other — a UPI ID reused across forty
filings, a device fingerprint seen in three states, a wallet that terminates
every laundering chain — is **buried in that free text**.

Today investigators correlate this by hand, one complaint at a time, across
hundreds of filings. The consequences:

1. **Organised networks look like unrelated petty crime.** A ₹48,500 UPI fraud
   is closed as a small local case when it is actually one node of a 42-complaint
   operation moving crores.
2. **Masterminds stay invisible.** The people arrested are mule account holders
   at the edge of the network. The coordinator, who never touches a victim
   directly, is never surfaced because no single complaint points at them.
3. **Correlation does not scale.** Complaint volume grows faster than
   investigator headcount, so the backlog compounds.
4. **Evidence integrity is unprovable.** A screenshot on a shared drive has no
   demonstrable chain of custody when it reaches court.

## §C. What ARGUS does

ARGUS reframes the unit of investigation from **the complaint** to **the network**.

```
   Complaint filed
        ↓
   AI extracts entities from the narrative        (spaCy + regex)
        ↓
   Entities are canonicalised and deduplicated    (the whole product hinges here)
        ↓
   Graph database links every complaint sharing an entity   (Neo4j)
        ↓
   Community detection names the criminal cluster           (Louvain)
        ↓
   Centrality ranks the likely mastermind                   (PageRank + betweenness)
        ↓
   Investigator explores the network visually
        ↓
   Evidence integrity anchored on-chain                     (EvidenceRegistry.sol)
```

**ARGUS is an intelligence and investigation platform, not a complaint
management portal.** Nothing in it exists to help a victim file a complaint;
everything in it exists to help an investigator find the organisation behind
a hundred of them.

**It is a demonstrator, not a production MHA system.** §S states plainly what
is genuinely live and what is computed from seeded data.

## §D. Users

| User | What they need from ARGUS |
|---|---|
| **Cyber Crime Police Investigator** | Find every complaint linked to the one on their desk; identify who to arrest first |
| **MHA Analyst** | National-level view of which networks are growing and where |
| **CERT-In / State Cyber Cell** | Cross-state correlation; early warning on emerging scam patterns |
| **Financial Intelligence Unit** | Trace laundering chains from victim account to cash-out |
| **Investigation Administrator** | Assign cases, manage access, prove audit integrity |

All five investigate **networks**, never isolated cases. That single fact drives
every UI decision in this project.

## §E. Feature catalogue

### 1. Login
Authentication gate. Dark, ambient India-at-night canvas background. Demo
accounts are seeded — see §P.

### 2. Dashboard — "Mission Control"
National cybercrime intelligence at a glance. Should feel like a cyber command
centre, not an admin panel.

- **National Threat Index** (0–100, computed from active cluster risk)
- **Active Scam Networks** count
- **High-Risk Wallet** count
- **Open Investigations** count
- **India Cybercrime Heatmap** — state choropleth
- **Live Threat Feed** — AI-generated alerts
- **Recent Complaints** — newest intake
- **Investigation Timeline** — condensed audit stream

### 3. Criminal Network Explorer ⭐
**The project's centrepiece.** Interactive force-directed graph of the entire
criminal network.

Node types: Phone · Wallet · Bank Account · UPI · IP · Device · Email ·
Location · Complaint · Person

- Click a node → detail rail opens
- Double-click → expand neighbours (live Cypher query)
- Node **size** = influence score · **colour** = cluster · **edge thickness** = link strength
- Filter chips toggle entity types
- "Highlight mastermind" pulses the top-ranked node

### 4. Complaint Intelligence
Complaint detail page. Victim info, scam category, the narrative with
**extracted entities highlighted inline**, linked complaints with shared-entity
counts, AI confidence per extraction, and the suggested criminal cluster.

### 5. Geo Intelligence
Interactive India map: crime hotspots, cluster density, state-wise statistics,
and interstate crime routes drawn as arcs.

### 6. Money Flow Analysis
Sankey diagram tracing the laundering chain:
**victim account → mule accounts → intermediate wallets → crypto exchange → cash-out.**
Explains visually what a spreadsheet cannot.

### 7. Threat Feed
Live AI-generated investigation alerts, severity-filtered.
Examples: *"New wallet linked to known scam ring"* · *"Same IP seen in 14
complaints"* · *"Device fingerprint reused across states"* · *"Telegram handle
matched previous investigation."*
Severity: `CRITICAL` · `HIGH` · `MEDIUM` · `LOW`

### 8. Investigation Timeline
Chronological audit of every investigation event — complaint received, evidence
uploaded, wallet linked, cluster recomputed, investigator assigned, evidence
verified. Reads directly off the append-only `audit_logs` table.

### 9. Evidence Locker
Blockchain-backed evidence verification. Files are stored encrypted off-chain;
the chain holds only the SHA-256 digest, timestamp, case reference, registrar
identity, and the full verification history.

### 10. Admin
User management, cluster recompute trigger, and live service health for all
four components.

---

# PART 2 — HOW IT IS BUILT

## §F. System architecture

Four services behind one React client. Two databases, each with **exactly one owner**.

```
                   ┌────────────────────────────────────────┐
                   │  React · Vite · Tailwind · Cytoscape   │
                   │  Dashboard · Network · Complaint       │
                   │  Geo · Money · Feed · Timeline · Locker│
                   └──────────────────┬─────────────────────┘
                                      │ REST + JWT  (single origin)
                   ┌──────────────────▼─────────────────────┐
                   │  Express Core API  :4000               │
                   │  auth · RBAC · complaints · evidence   │
                   │  audit · chain bridge · intel proxy    │
                   └───┬──────────────┬──────────────┬──────┘
                       │              │              │
              ┌────────▼──────┐  ┌────▼──────────┐  ┌▼──────────────────┐
              │ PostgreSQL    │  │ FastAPI       │  │ Hardhat (local)   │
              │ :5432         │  │ Intel :8000   │  │ → Polygon Amoy    │
              │ complaints    │  │ spaCy extract │  │ EvidenceRegistry  │
              │ entities      │  │ Neo4j writes  │  │ .sol              │
              │ evidence      │  │ Louvain       │  │ hash + meta only  │
              │ audit · users │  │ PageRank      │  └───────────────────┘
              └───────────────┘  └───────┬───────┘
                                         │ bolt://
                                 ┌───────▼────────┐
                                 │ Neo4j :7687    │
                                 │ criminal graph │
                                 └────────────────┘
```

### The five ownership rules

These are what let three people work in parallel without collisions. **Do not violate them.**

1. **Express owns Postgres and auth.** FastAPI never touches Postgres and never validates a JWT.
2. **FastAPI owns Neo4j and all analytics.** Express never speaks Cypher.
3. **The frontend only ever calls Express.** Graph reads are proxied through `/api/graph/*`, so there is one auth surface and one CORS origin. FastAPI is never reachable from a browser.
4. **The chain is optional at runtime.** If the RPC is dead, evidence still uploads and anchors stay `PENDING`. The chain being down must never take the platform down.
5. **Postgres is the source of truth; Neo4j is a derived index.** Neo4j can be dropped and rebuilt from Postgres at any time. This matters when a demo goes wrong.

### Degradation rules — non-negotiable

| If this is down | Then |
|---|---|
| FastAPI | Express serves entities already in Postgres; graph pages show last-known cluster data behind a "live analysis unavailable" banner. Nothing throws. |
| Neo4j | `/extract` still works (pure Python). Ingest queues and reports `degraded`. |
| Chain RPC | Uploads succeed, anchors stay `PENDING`, status reports `ready: false` with a reason. |
| spaCy model | Regex tier alone answers `/extract`. NER is strictly additive, never required. |

## §G. Tech stack

| Layer | Choice | Why |
|---|---|---|
| **Frontend** | React 19 · Vite · TailwindCSS · Framer Motion | Fast HMR, utility styling, cheap animation |
| **Graph viz** | **Cytoscape.js + fcose** | See note below |
| **Charts** | Recharts · d3-sankey | Sankey needs d3 control; everything else Recharts |
| **Maps** | d3-geo + topojson-client | Already proven in the prior codebase |
| **Core API** | Node.js · Express | Reuses working auth/RBAC/audit layer |
| **Intel service** | Python · FastAPI | spaCy and NetworkX are Python-native |
| **NLP** | spaCy `en_core_web_sm` + regex | Regex is deterministic and carries the demo |
| **Graph analytics** | NetworkX + python-louvain | See note below |
| **Relational DB** | PostgreSQL 16 | Source of truth |
| **Graph DB** | Neo4j 5 Community | Real graph traversal; Browser UI is a judging asset |
| **Blockchain** | Solidity 0.8.24 · Hardhat · OpenZeppelin · Polygon Amoy | Cheap testnet, mature tooling |
| **Chain client** | ethers v6 | Already used in the prior codebase |

> **Why Cytoscape.js and not React Flow.** React Flow is a node *editor* —
> manual positioning, DAG-shaped, and it degrades past a few hundred nodes. A
> criminal network needs force-directed layout over 200+ nodes with
> expand-on-click and community colouring, which is Cytoscape's core competency.

> **Why NetworkX and not Neo4j GDS.** The GDS plugin needs a heavier image and
> its own licence dance. `neo4j:5-community` plus NetworkX gives identical
> Louvain and PageRank results at this data scale, with an hour of setup instead
> of a day.

## §H. Data model

### H.1 PostgreSQL 🔨 built — `backend/src/db/migrations/001_init.sql`

| Table | Purpose |
|---|---|
| `units` | Cyber police units (code, state, location) |
| `users` | `ADMIN` · `SUPERVISOR` · `INVESTIGATOR` · `ANALYST`; bcrypt hashes |
| `complaints` | `complaint_ref`, victim details, **`narrative`** (what AI reads), category, `amount_inr`, state/district/lat/lon, status |
| `entities` | **Canonical, deduplicated identifiers.** `UNIQUE (entity_type, normalized_value)` |
| `complaint_entities` | Join table with `confidence`, `method` (`REGEX`/`NER`/`MANUAL`), `context_snippet` |
| `clusters` | Materialised by the analytics job: size, complaint count, total amount, risk, `mastermind_entity_id` |
| `transactions` | Money-flow spine: from/to entity, amount, `rail`, `hop_index` |
| `evidence` | Filename, SHA-256, AES-GCM `encrypted_path`/`iv`/`auth_tag`, uploader |
| `evidence_anchors` | `tx_hash`, `block_number`, `network`, `status` (`PENDING`/`ANCHORED`/`FAILED`) |
| `verifications` | Every integrity check, pass or fail |
| `investigations` | `case_ref`, assignee, cluster, status, priority |
| `alerts` | Threat feed: severity, type, `details JSONB` |
| `audit_logs` | **Append-only. This table IS the Investigation Timeline page.** |

**Entity types:** `PHONE` · `UPI` · `BANK_ACCOUNT` · `WALLET` · `EMAIL` · `IP` ·
`DEVICE` · `LOCATION` · `PERSON` · `TELEGRAM`

**Scam categories:** `UPI_FRAUD` · `INVESTMENT_SCAM` · `DIGITAL_ARREST` ·
`JOB_FRAUD` · `LOAN_APP` · `CRYPTO_FRAUD` · `SEXTORTION` · `PHISHING` ·
`MATRIMONIAL` · `OTP_FRAUD` · `OTHER`

> **The single most important constraint in the schema** is
> `entities UNIQUE (entity_type, normalized_value)`. Entity deduplication *is*
> the product. If the same UPI ID lands twice under two spellings, no network is
> ever found. Everything is normalised on write.

### H.2 Neo4j graph ⏳

**Nodes:** `Complaint` · `Person` · `Phone` · `BankAccount` · `Wallet` · `UPI` ·
`Email` · `IP` · `Device` · `Location`

**Relationships:** `USES` · `OWNS` · `TRANSFERRED_TO` · `CONNECTED_TO` ·
`REPORTED_IN` · `LOCATED_AT` · `COMMUNICATED_WITH`

Every node carries `pg_id` (its Postgres `entities.id`) so the two stores join
cleanly. The analytics job writes three derived properties back onto each node:
`cluster_id`, `influence` (0–100), `risk` (0–100).

**Ingest rule:** `MERGE`, never `CREATE`, keyed on `(label, normalized_value)`.

**Only five Cypher queries exist in the whole project.** Write them on Day 1 and
never expand the surface — that is how a team new to Neo4j ships in five days.

## §I. AI modules

### I.1 Entity Extraction — `POST /extract`
**In:** complaint narrative. **Out:** typed, normalised entities.

Two tiers, in order:

1. **Regex tier** (deterministic — *this is what actually carries the demo*)
   - Indian phone `(\+91[\-\s]?)?[6-9]\d{9}`
   - UPI `[\w.\-]{3,}@[a-z]{3,}`
   - IFSC, bank account numbers
   - BTC / ETH wallet addresses
   - IPv4, email, Telegram handles
2. **spaCy NER tier** (`en_core_web_sm`) for `PERSON`, `ORG`, `GPE` — strictly additive.

Each hit returns `{type, value, normalized_value, confidence, method, context_snippet}`.

> **Normalisation matters more than extraction.** Strip `+91`, lowercase UPI and
> email, checksum-case wallets. Two spellings of one identifier means a missed link.

### I.2 Relationship Builder — `POST /ingest`
`MERGE`s nodes and edges into Neo4j. Builds the edges that make a network:
`Phone → Wallet` · `Wallet → Complaint` · `Complaint → Bank` · `Bank → Device` · `Device → IP`.

### I.3 Community Detection
**Louvain** (`networkx.community.louvain_communities`) over the entity graph →
`cluster_id`. Connected-components and label-propagation are available as
cross-checks. Output: named clusters — **Alpha, Beta, Gamma**.

### I.4 Mastermind Prediction
**PageRank + betweenness centrality**, blended and normalised to an
**influence score 0–100**. The highest-influence node in a cluster is flagged
`is_mastermind`.

The logic that makes this credible: a coordinator sits at high betweenness
(everything routes through them) while holding *low* direct victim contact.
Mule accounts have the opposite profile — high degree, low betweenness.

### I.5 Risk Scoring
Weighted blend of complaint frequency · wallet reuse · device reuse ·
geographic spread · total amount involved.
Bucketed: `LOW` · `MEDIUM` · `HIGH` · `CRITICAL`.

## §J. Blockchain module 🔨 built

**Blockchain exists here for exactly one reason: evidence integrity and chain of
custody. Not document storage.** Be precise about this when judges ask — a vague
blockchain justification is the fastest way to lose marks on this theme.

**Contract:** `blockchain/contracts/EvidenceRegistry.sol` (Solidity 0.8.24,
OpenZeppelin `AccessControl` + `Pausable`)

**On-chain:** SHA-256 digest · timestamp · case ID · evidence type · unit code ·
registrar address · full verification history
**Never on-chain:** the file, ciphertext, encryption keys, storage pointers, victim PII

```solidity
registerEvidence(bytes32 digest, uint256 caseId, string evidenceType, string unitCode)
verifyEvidence(bytes32 digest) → (bool exists, Evidence record)
logVerification(bytes32 digest, bool matched, string note)
getEvidenceHistory(bytes32 digest) → Verification[]   // append-only
sealEvidence(bytes32 digest, string reason)           // withdraw, never delete
```

**Test suite: 17 cases, all passing** (`npm --prefix blockchain test`) — covering
registration, duplicate rejection, the custody trail, access control, sealing,
pause, and enumeration.

> **Gotcha already hit and fixed — do not reintroduce it.** The `Verification`
> struct's timestamp is named **`checkedAt`, not `at`**. ethers decodes structs
> into `Result` objects that inherit `Array.prototype`, so a field named `at` is
> shadowed by `Array.prototype.at` and reads back as a *function* on the client.
> The test caught it. Avoid any struct field that collides with an array method.

### The argument for blockchain here

A single anchor proves integrity at one instant. A court needs to see **who**
checked the exhibit, **when**, and whether it **still matched**.
`getEvidenceHistory()` returns that trail, and it is append-only —
**including the failures.** An exhibit that stopped matching is exactly the fact
a defence would try to bury, so it is recorded on the same terms as a pass.

That is a property a database with an admin account cannot offer, and it is the
whole justification for the chain in this system.

**Deployment:** local Hardhat throughout development; **Polygon Amoy** on Day 4,
with the localhost deployment kept wired as the live fallback (`CHAIN_NETWORK` flips it).

## §K. Frontend design system

**Design language:** Dark Intelligence Platform.
**Inspiration:** Palantir Gotham · CrowdStrike Falcon · Neo4j Bloom · Microsoft Defender.

### Palette

```
void    #080B12     deep  #0C111C     panel #111827     raise #1A2333
hair    #232F45     txt   #E6EDF7     dim   #8B9BB4     faint #556074

blue    #2E6FF2     blueHi #5B93FF    ← the ONE interactive colour
danger  #FF4757     emerald #10B981   amber #F5A623     purple #A855F7
```

**Typography:** **Inter** for UI · **JetBrains Mono** for hashes, IDs, and
amounts (with `font-variant-numeric: tabular-nums`).

**Rule:** cluster colours are categorical and must stay **stable across every
page** — Alpha is the same purple in the graph, the map, and the feed. Defined
once in `frontend/src/utils/format.js`.

### Component conventions (carried from the prior codebase)

- `.glass` — the panel surface treatment
- `.lbl` — uppercase tracked section labels
- `.mn` — tabular monospace numerals
- `.chip` — small bordered pill
- `<Panel>` · `<Stat>` · `<Dot>` · `<Severity>` · `<Empty>` · `<Spinner>` from `components/ui/Bits.jsx`

## §L. API contract

**Frozen on Day 0 in `docs/API.md`.** 🔨 That file is the interface between the
three lanes — if you need a shape that is not in it, change the doc first and
tell the other two.

Conventions:
- All routes except `/health` and `/api/auth/login` require `Authorization: Bearer <jwt>`
- Errors are always `{ "error": "human readable string" }` with a real status code
- Timestamps are ISO 8601 UTC
- Money is a **number of rupees**, never a formatted string — the frontend formats

Graph payloads are **Cytoscape-ready** and must not be reshaped on the client:

```jsonc
// node
{ "id": "wallet:0x4a2b...9f1c", "pg_id": 812, "label": "0x4A2b…9F1c",
  "type": "WALLET", "cluster": "ALPHA", "influence": 91, "risk": 88,
  "degree": 17, "is_mastermind": false }

// edge
{ "id": "e_4412", "source": "phone:9876543210", "target": "wallet:0x4a2b...9f1c",
  "type": "TRANSFERRED_TO", "weight": 4, "label": "4 complaints" }
```

`id` is `<lowercased type>:<normalized_value>` and is **stable across rebuilds**,
so the frontend may cache on it.

---

# PART 3 — THE REPOSITORY

## §M. Layout

```
SIH 21689/
├── docker-compose.yml          🔨 postgres + neo4j
├── docs/
│   ├── API.md                  🔨 frozen contract
│   └── PROJECT.md              🔨 this document, committed to the repo
├── backend/                    Express core API — :4000
│   ├── src/
│   │   ├── config/env.js       🔨
│   │   ├── db/
│   │   │   ├── pool.js         🔨  migrate.js 🔨
│   │   │   ├── migrations/001_init.sql   🔨
│   │   │   └── seed.js         ⏳ THE most important file — see §R
│   │   ├── middleware/         🔨 authJwt · rbac · errorHandler · rateLimit
│   │   ├── services/           🔨 hashService · cryptoService · storageService
│   │   │                       ⏳ chainService · intelClient · auditService · alertService
│   │   ├── controllers/        ⏳
│   │   └── routes/             ⏳
│   └── storage/evidence/       encrypted blobs, gitignored
├── intel-service/              FastAPI intelligence service — :8000
│   ├── requirements.txt        🔨
│   └── app/                    ⏳ main · extract · graph · analytics · schemas
├── blockchain/
│   ├── contracts/EvidenceRegistry.sol      🔨 compiles clean
│   ├── scripts/deploy.js                   🔨
│   ├── test/EvidenceRegistry.test.js       🔨 17 passing
│   └── hardhat.config.js                   🔨 localhost + amoy
└── frontend/                   React + Vite — :5173
    └── src/
        ├── api/                ⏳ client.js · index.js
        ├── context/AuthContext.jsx         🔨
        ├── components/
        │   ├── ui/Bits.jsx     ⏳   shell/Shell.jsx ⏳
        │   ├── graph/          ⏳ Cytoscape explorer
        │   ├── map/indiaNight.js           🔨 ambient canvas
        │   └── money/          ⏳ Sankey
        ├── pages/              ⏳ 10 pages
        └── assets/geo/         🔨 countries-110m.json · ⏳ india-states.json
```

## §N. Current status

**🔨 Built (Day 0 complete):**
- Directory scaffold and module copy pass from the prior codebase
- `backend/src/config/env.js` + `.env.example` — retargeted to ARGUS
- **Full Postgres schema** — 13 tables, constraints, indexes
- `docker-compose.yml` — Postgres 16 + Neo4j 5 Community, both with healthchecks
- **`docs/API.md`** — the frozen contract, all endpoints and payload shapes
- **`docs/PROJECT.md`** — this document, in the repo
- **`EvidenceRegistry.sol`** — complete, compiles clean, with the append-only custody trail
- `deploy.js` (localhost + Amoy) and a test suite: **17 cases, all passing**
- Reused as-is: `pool.js`, `migrate.js`, `authJwt`, `rbac`, `errorHandler`,
  `rateLimit`, `hashService`, `cryptoService`, `storageService`, `AuthContext.jsx`,
  `indiaNight.js`, Hardhat harness
- Blockchain dependencies installed (400 packages)

The contract test run has already earned its keep: it caught the `at` /
`checkedAt` struct-field collision described in §J before any client code was
written against it.

**⏳ Next, in priority order:**
1. **`backend/src/db/seed.js`** — the seeded dataset (§R); everything depends on it
2. Express routes + controllers per `docs/API.md`
3. FastAPI service — extract, ingest, analytics
4. Neo4j ingest and the five Cypher queries
5. Frontend theme, shell, and the 10 pages
6. `chainService.js` wiring to `EvidenceRegistry`
7. India-states TopoJSON (§V risk — source it Day 1)

**Immediate next step:** `backend/src/db/seed.js`. Nothing else can be
meaningfully tested until the seeded dataset exists.

## §O. What was reused from the scrapped project

The prior TRINETRA-X codebase (sibling folder `../SIH`) contributed roughly **35%**
of the foundation. This is a deliberate, defensible saving — not a shortcut.

| Reused | Change needed |
|---|---|
| `db/pool.js`, `db/migrate.js` | none |
| `authJwt`, `rbac`, `errorHandler`, `rateLimit` | none |
| `hashService`, `cryptoService`, `storageService` | key name + comments |
| `config/env.js` | retargeted vars |
| `chainService.js` structure | rewire to `EvidenceRegistry` — the async-anchor, never-throws, lazy-init discipline is already correct |
| `IntegrityLedger.sol` | ~80% of the shape of `EvidenceRegistry.sol` |
| Hardhat harness, deploy pattern | Amoy replaces Sepolia |
| `api/client.js`, `AuthContext.jsx` | storage key rename |
| `Bits.jsx`, `Shell.jsx`, `index.css`, `tailwind.config.js` | retheme tokens, keep structure |
| `indiaNight.js` + `countries-110m.json` | ambient background only |

**Deleted, not adapted:** all document-management, verify-flow, zero-trust,
clearance-policy, and IsolationForest modules. **No TRINETRA string survives
anywhere in this repo.**

---

# PART 4 — RUNNING IT

## §P. Getting started

### Prerequisites
Node 20+ · Python 3.11+ · Docker Desktop · Git

### First run

```bash
# 1. Databases
docker compose up -d
#    Postgres → localhost:5432   Neo4j Browser → localhost:7474

# 2. Core API
cd backend
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
#    paste that into EVIDENCE_ENCRYPTION_KEY in .env
npm install
npm run migrate
npm run seed
npm run dev                      # → :4000

# 3. Intelligence service
cd ../intel-service
python -m venv .venv
.venv\Scripts\activate           # Windows;  source .venv/bin/activate elsewhere
pip install -r requirements.txt
python -m spacy download en_core_web_sm
uvicorn app.main:app --reload    # → :8000

# 4. Blockchain (two terminals)
cd ../blockchain
npm install
npx hardhat node                 # terminal A, leave running
npm run deploy:local             # terminal B

# 5. Frontend
cd ../frontend
cp .env.example .env
npm install
npm run dev                      # → :5173
```

### Demo accounts (seeded)

| Email | Role |
|---|---|
| `admin@argus.gov.in` | ADMIN |
| `supervisor@argus.gov.in` | SUPERVISOR |
| `investigator@argus.gov.in` | INVESTIGATOR |
| `analyst@argus.gov.in` | ANALYST |

Password for all: set in `seed.js` — keep it simple for the demo, and say so.

### Environment variables

**`backend/.env`** — `DATABASE_URL` · `JWT_SECRET` · `EVIDENCE_ENCRYPTION_KEY`
(64 hex chars, required) · `CHAIN_NETWORK` · `CHAIN_RPC_URL` · `INTEL_SERVICE_URL`
**`blockchain/.env`** — only needed for Amoy: `AMOY_RPC_URL` · `DEPLOYER_PRIVATE_KEY`
(throwaway wallet, never a real one) · `POLYGONSCAN_API_KEY`
**`frontend/.env`** — `VITE_API_URL=http://localhost:4000`

## §Q. Five-day schedule

**Day 0 — all three together (half day):** repo init, module copy, **freeze
`docs/API.md`**, `docker compose up`. ✅ *Done.*

| | **Dev A — Core & Data** | **Dev B — AI & Graph** | **Dev C — Frontend** |
|---|---|---|---|
| **D1** | Schema, migrate, auth ported, **seeder v1** | FastAPI skeleton, regex extractor, Neo4j `MERGE` ingest | Theme, Shell, Login, routing, Bits kit |
| **D2** | Complaints + entities + clusters endpoints, intel proxy | spaCy NER, bulk ingest, Louvain + PageRank | Dashboard, stat tiles, threat feed |
| **D3** | Evidence upload, AES-GCM, SHA-256, anchor queue | Neighbors + cluster + money-trace endpoints, risk scoring | **Network Explorer** — full day, it earns it |
| **D4** | Contract tests, deploy local + Amoy, verify flow | Alert rules, analytics rerun, tune the plant | Complaint Intelligence, Money Flow, Geo |
| **D5** | Chain → UI, audit → timeline, health checks | Fallbacks for every AI path, rehearsal | Timeline, Evidence Locker, Admin, polish |

**Day 5 afternoon is frozen for demo rehearsal, not features.**

## §R. The seeder is the most important file in the repo

`backend/src/db/seed.js` — **build it Day 1, not Day 4.** Every page renders
seeded data, and the demo story requires the graph to show 42 linked complaints
and a mastermind that centrality genuinely ranks first.

Generate ~220 complaints across 18 states, then **plant three networks**:

| Cluster | Complaints | Shape |
|---|---|---|
| **Alpha** | ~42 | UPI investment scam. Shares 3 wallets, 2 device fingerprints, 4 IPs. One `Person` node sits two hops from everything and holds **no direct victim contact** — the mastermind. |
| **Beta** | ~28 | Digital-arrest scam, one shared VoIP range. |
| **Gamma** | ~15 | Crypto laundering, clean 5-hop `TRANSFERRED_TO` chain ending at an exchange. |

The remainder is **unclustered noise**, so the clustering has something to reject.

Narratives are written as realistic Hinglish complaint text with the identifiers
**inline**, so `/extract` has genuine work to do on stage.

> **Verify the plant before trusting it.** After seeding, run the analytics job
> and assert the intended mastermind is actually the top-ranked node. If the
> graph shape does not produce that result, **adjust the generated topology —
> not the algorithm.** Faking the ranking is the one thing that could sink the
> project under questioning.

## §S. What is real and what is seeded

At five days this scope only closes because most pages read from one well-built
dataset. **Judges will ask. Be straight about it — a confident honest answer
scores better than a hedge.**

| | |
|---|---|
| **Genuinely live** | Entity extraction on typed text · Neo4j ingest and neighbour expansion · Louvain clustering · PageRank ranking · SHA-256 hashing · on-chain anchoring and verification · the audit trail |
| **Computed from seeded data** | Threat index · heatmap densities · cluster summaries · money-flow chains · alert feed |
| **Static** | **Nothing user-facing.** If a number cannot be computed, cut the widget rather than fake it. |

The one demo moment that **must** be genuinely live is **Scene 2**: an
investigator types a fresh complaint on stage, entities pop out, and the graph
redraws with the new links. Everything else can be pre-seeded without embarrassment.

## §T. Demo script — 3 minutes, 8 scenes

| # | Scene | What the audience sees |
|---|---|---|
| 1 | **The complaint** | Victim reports a ₹48,500 UPI scam. One ordinary case. |
| 2 | **AI extraction** ⭐ | Typed live. Phone, UPI ID, wallet, IP pop out of the narrative with confidence scores. |
| 3 | **The network** ⭐ | Graph reveals **42 linked complaints** the investigator never knew were related. |
| 4 | **The mastermind** | AI highlights the highest-influence node — someone who never contacted a single victim. |
| 5 | **The money** | Sankey traces victim → 4 mules → exchange → cash-out. |
| 6 | **The evidence** | Blockchain verification succeeds; tamper the file, it fails loudly. |
| 7 | **The feed** | Threat Feed updates with the new correlation. |
| 8 | **The record** | Investigation Timeline shows the immutable audit trail. |

**Rehearse twice on Day 5** — once with everything up, once with FastAPI
deliberately killed, to confirm the frontend degrades to seeded data instead of
throwing.

---

# PART 5 — QUALITY & RISK

## §U. Verification

```bash
# Infrastructure
docker compose up -d
npm --prefix backend run migrate && npm --prefix backend run seed
curl localhost:4000/health          # {"status":"ok","service":"argus-core"}
curl localhost:8000/health          # spacy_loaded, neo4j_connected, node_count
# Neo4j Browser localhost:7474 → MATCH (n) RETURN count(n)   ≈ 3000+

# Extraction
curl -X POST localhost:8000/extract -H 'Content-Type: application/json' \
  -d '{"narrative":"Paid Rs 48500 to rahul.pay@okaxis from 9876543210, then to 0x4A2b...9F1c"}'
# must return the UPI, the phone AND the wallet, each with normalized_value set

# THE PLANT HOLDS — the single most important check
curl -X POST localhost:8000/analytics/run
curl localhost:8000/graph/cluster/alpha | jq '.nodes | length'           # ~120
curl localhost:8000/graph/cluster/alpha | jq 'max_by(.influence).label'  # the planted mastermind

# Chain
npx hardhat node                    # terminal 1
npm --prefix blockchain run deploy:local
npm --prefix blockchain test        # 17 passing: register · verify · history ·
                                    # access control · seal · pause · enumeration
```

**Manual end-to-end:** upload evidence in the UI → watch `PENDING → ANCHORED` →
hit Verify → confirm `getEvidenceHistory` grew by one → **edit one byte of the
file and confirm verification fails loudly.**

**Chain-down resilience:** kill the Hardhat node, upload evidence anyway. The
upload must succeed, the anchor must stay `PENDING`, and nothing may hang.

## §V. Risks

| Risk | Mitigation |
|---|---|
| **Entity dedup fails → no network appears** | Normalise on write, `MERGE` on a unique key. Assert entity counts after seeding on Day 1 |
| **India state geometry missing** | `countries-110m.json` has **country outlines only, no state boundaries**. Source an India-states TopoJSON (~150KB) into `src/assets/geo/` on **Day 1**, not Day 4 |
| Neo4j is new to the team | Only 5 Cypher queries exist in total. Write all 5 on Day 1, never expand |
| Cytoscape performance | Cap initial render at 150 nodes; expand on demand only |
| Amoy faucet dry on demo day | Local Hardhat deployment stays wired; `CHAIN_NETWORK` flips it |
| spaCy download fails at venue | Regex tier alone carries the demo; NER strictly additive |
| 10 pages in 5 days | Tier them. If Day 5 slips, Admin and Timeline degrade to plain tables over `audit_logs` and `users` — nearly free |
| Demo machine has no internet | Everything runs locally: Docker, Hardhat, vendored geo assets, local spaCy model |

## §W. Judging alignment

| SIH criterion | Where ARGUS answers it |
|---|---|
| **Novelty** | Network-first investigation instead of case-first; mastermind ranking from graph topology |
| **Technical depth** | Real graph DB, two-tier NLP, Louvain + PageRank, custom Solidity with append-only custody |
| **Practical usefulness** | Maps directly onto how NCRP complaints actually arrive and how cyber cells actually work |
| **Blockchain justification** | Tamper-evident custody trail including failed checks — a property a mutable DB cannot offer (§J) |
| **AI justification** | Extraction, correlation, clustering, and ranking are all doing real work, not decoration |
| **Completeness** | 10 working pages, four services, seeded national-scale dataset |
| **Presentation** | Command-centre UI; a rehearsed 3-minute story with a live moment (§T) |

**The question to prepare hardest for:** *"Why does this need a blockchain?"*
The answer is §J — not storage, but an append-only custody trail that records
failed integrity checks on the same terms as passes, which no admin can quietly
rewrite.

## §X. Glossary

| Term | Meaning |
|---|---|
| **Entity** | Any identifier extracted from a complaint — phone, UPI, wallet, IP, device |
| **Cluster** | A criminal network discovered by community detection (Alpha, Beta, Gamma) |
| **Influence score** | 0–100 from PageRank + betweenness; the mastermind signal |
| **Mule account** | Bank account rented to launder proceeds; high degree, low betweenness |
| **Anchor** | Writing an evidence digest on-chain |
| **Digest** | SHA-256 of the plaintext exhibit — the only thing that goes on-chain |
| **NCRP** | National Cybercrime Reporting Portal |
| **The plant** | The deliberately-designed network structure in the seeded data (§R) |
| **Amoy** | Polygon's test network (chainId 80002) |

## §Y. Open decisions

- [ ] Source and vendor the India-states TopoJSON (**Day 1**, blocks Geo page)
- [ ] Fix the seeded demo password and record it here
- [ ] Confirm an Amoy faucet works from the team's network before Day 4
- [ ] Decide whether investigator wallets get `REGISTRAR_ROLE` or the relayer signs everything (relayer is simpler; recommended)
- [ ] Name the three clusters something more evocative than Alpha/Beta/Gamma for the demo

## §Z. Working conventions

1. **`docs/API.md` is frozen.** Change the doc first, then the code, then tell the other two.
2. **Never violate the five ownership rules** (§F).
3. **Never fake a number in the UI.** Cut the widget instead (§S).
4. **Normalise every identifier on write.** Dedup is the product (§H).
5. **Nothing may be a single point of failure.** Every service degrades (§F).
6. **Match the surrounding code's style.** Comments explain *why*, not *what* — the existing files set the standard.
7. **Commit messages say what changed and why.** The audit trail habit starts with us.
