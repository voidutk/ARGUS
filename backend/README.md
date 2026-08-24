# ARGUS — core API

Express + Postgres. Owns records, auth, evidence and the chain bridge, and
proxies graph/AI work to the FastAPI intelligence service on `:8000`. The
frontend only ever talks to this service.

The API contract is `docs/API.md` and it is authoritative. If a shape needs to
change, change that file first.

---

## Running it

```bash
docker compose up -d          # postgres :5432, neo4j :7474/:7687   (repo root)
cp .env.example .env          # then fill in JWT_SECRET and EVIDENCE_ENCRYPTION_KEY
npm install
npm run setup                 # migrate + seed + load NCRB reference + generate alerts
npm run dev                   # http://localhost:4000
```

`npm run setup` is the whole cold start. Individually:

| Command | Does |
|---|---|
| `npm run migrate` | Applies pending migrations. Records what ran; refuses to replay. |
| `npm run seed` | Rebuilds the synthetic corpus — 220 complaints, 962 entities, 3 planted organisations. |
| `npm run load-reference` | Loads real NCRB statistics into `crime_reference` / `fraud_reference`. |
| `npm run generate-alerts` | Runs the alert rules over the live data. |
| `npm run db:reset -- --yes` | Drops everything and re-migrates. Development only. |

The chain is optional. With no Hardhat node running, uploads still succeed and
anchors stay `PENDING`; the same is true of the intelligence service, without
which graph pages fall back to Postgres. Neither can stop the API coming up.

---

## Verifying it

```bash
npm run verify-all
```

Six gates, ~119 assertions. Each answers a question the others do not:

| Gate | Proves |
|---|---|
| `test:unit` | Normalisation, graph algorithms, NCRB name mapping and the security helpers, in isolation. No database. |
| `verify-determinism` | Two seed runs produce byte-identical content. A demo that reshuffles cannot be rehearsed. |
| `verify-plant` | Centrality genuinely ranks the planted coordinators first — the §T scene 4 claim is earned, not asserted. |
| `smoke` | Every endpoint in `docs/API.md` answers with the right SHAPE, not just a 200. |
| `smoke-v2` | The Plan-V2 features, plus **the error paths** — that a bad `?limit=` is a 400 and not a 500. |
| `evidence-e2e` | Upload → anchor → verify → **tamper** → the failure is permanently on-chain. |

`verify-determinism` re-seeds, so it runs first and leaves the database in the
canonical state the rest of the suite expects. The API suites need a running
server; the rest do not.

---

## Layout

```
src/
  app.js            middleware assembly — the order is load-bearing, read it top to bottom
  server.js         lifecycle: dependency probes, graceful drain, crash policy
  config/env.js     every variable, validated at import. Bad config fails at boot, never at 3am
  lib/
    errors.js       ApiError + asyncHandler. Handlers throw; one place writes failures
    logger.js       structured logs, credentials redacted before serialisation
    validate.js     zod schemas + the empty-query-value rule
  middleware/       requestContext, errorHandler, authJwt, rbac, rateLimit
  db/
    pool.js         pooling, timeouts, the idle-error listener, withTransaction
    migrate.js      applied-once, checksummed, advisory-locked
    migrations/     001 schema · 002 reference data, generated alerts, indexes
    seed.js         the planted corpus (see its header — it is the most important file here)
  services/
    normalize.js    identifier canonicalisation. The correlation engine rests on this
    graphAlgos.js   PageRank, Brandes betweenness, components, bridge paths
    graphService.js the Postgres graph projection, cached and single-flighted
    alertRules.js   the threat feed, generated from rules that store their own SQL
    stateNames.js   NCRB ↔ our data ↔ TopoJSON name reconciliation
    osint.js        OSINT adapters and the provenance envelope
    chainService.js EvidenceRegistry bridge. Async anchoring, never blocks an upload
    cryptoService.js AES-256-GCM at rest · hashService.js SHA-256 of the plaintext
    intelClient.js  advisory FastAPI client with a circuit breaker. Never throws
  controllers/      one per API section
  routes/index.js   the whole route table with its validation schemas
scripts/            the verification gates and the data loaders
test/               node:test unit suite
```

---

## Things worth knowing before you change something

**Handlers throw, they never write failures.** Every async handler is wrapped in
`asyncHandler` and throws `ApiError`. `middleware/errorHandler.js` is the only
place a failure becomes a response — it maps Postgres SQLSTATEs, multer errors
and JSON parse failures onto real status codes, and replaces anything it does
not recognise with a generic 500. A driver message quoting a column name is
useful in a log and an information leak on the wire.

**Validation is in the route table, not in handlers.** A field that is not in
the schema is not on `req.valid`, so a handler cannot use unvalidated input by
accident. Empty query values are treated as absent — `?state=&category=UPI_FRAUD`
is what a form sends with one filter cleared, and rejecting it makes the UI look
broken for the most ordinary user action.

**Complaint references come from a sequence.** `SELECT max()+1` raced: two
intakes read the same maximum and one died on the UNIQUE constraint. Verified
with 12 concurrent filings.

**The pool has an `error` listener and it is not optional.** A `pg` Pool is an
EventEmitter; an idle client that loses its connection emits `error`, and an
EventEmitter with no listener throws. Without it, a Postgres restart takes the
API down for a fault the next query would have recovered from. Tested by
stopping the container: the process survived and recovered on its own.

**`/health` never touches the database.** Liveness failing tells an orchestrator
to restart the container, so a database blip must not trigger a restart storm.
`/health/ready` is the one that checks Postgres and returns 503.

**intel-service is advisory and behind a circuit breaker.** Every call returns
`{ ok, data, reason }` and never throws. After three consecutive failures the
breaker opens, so a dead service costs one timeout rather than one per request —
without it `POST /api/complaints` would take 8 seconds instead of 200ms while
FastAPI is stopped, and miss its 3-second budget for being *correctly* optional.

**Evidence downloads are always `application/octet-stream`.** Echoing the
uploader's declared MIME type would let an uploaded `.html` or `.svg` exhibit
render in an investigator's browser on this origin with their session — stored
XSS through the evidence locker. The filename is escaped per RFC 6266 for the
same reason: it is attacker-controlled and reaches a response header.

**Alerts are generated, never written.** `alertRules.js` runs five rules over
the live tables, fingerprints each finding so re-running refreshes rather than
duplicates, and stores the query behind every alert so `/api/alerts/:id/explain`
can show an investigator what produced it. The seed deliberately writes none.

**Reference data carries its provenance in the payload.** Every
`/api/reference/*` response includes `provenance: "NCRB · OFFICIAL"` and a
`source_note`; `/api/geo/*` says `SYNTHETIC`. The badge in the UI is driven by
that field so a page cannot render the data without it. Loaded district sums
reconcile exactly with NCRB's own published state totals — the loader skips 491
`TOTAL` rollup rows precisely so that they do.

**Every simulated OSINT adapter is marked by the framework, not by itself.** An
adapter declares `live: true|false` and the envelope stamps `simulated` from
that, so an adapter that forgot to set a flag is not a possible bug.
