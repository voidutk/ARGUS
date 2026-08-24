-- ARGUS migration 002 — reference data, generated alerts, concurrency fixes.
--
-- Three unrelated concerns share one migration because they landed in one
-- hardening pass and splitting them would imply an ordering that does not exist.
-- See docs/PLAN-V2-DATA-AND-INTEL.md §2 and §3.3.

-- ---------------------------------------------------------------------------
-- 1. Complaint references — a sequence, not SELECT max()+1
--
-- The intake controller used to derive the next reference by reading the
-- highest one and adding one. Two intakes arriving together read the same
-- maximum, build the same reference, and one dies on the UNIQUE constraint —
-- a 500 for the citizen who happened to hit Submit second. `nextval` is atomic
-- and never returns the same number twice, so the race cannot occur.
--
-- The sequence starts above the highest reference already present, so seeded
-- data and live intake share one numbering line with no collision.
-- ---------------------------------------------------------------------------

CREATE SEQUENCE IF NOT EXISTS complaint_ref_seq AS BIGINT START WITH 1;

SELECT setval(
  'complaint_ref_seq',
  GREATEST(
    (SELECT COALESCE(MAX(substring(complaint_ref FROM '(\d+)$')::bigint), 0)
       FROM complaints
      WHERE complaint_ref ~ '^NCRP-\d{4}-\d+$'),
    1
  )
);

-- ---------------------------------------------------------------------------
-- 2. Layer 1 — official NCRB statistics (PLAN-V2 §1, §2)
--
-- Kept in separate tables from `complaints` on purpose. These are AGGREGATE
-- COUNTS per state/district/year with no entities behind them; `complaints` are
-- individual records that correlate. Merging the two would produce a system
-- that cannot tell an investigator whether a figure on screen is a real NCRB
-- number or one of ours, which is precisely the distinction the provenance
-- badges exist to make.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS crime_reference (
  id            SERIAL PRIMARY KEY,
  state         VARCHAR(80) NOT NULL,          -- canonical, normalised on load
  district      VARCHAR(80),                   -- NULL = state-level rollup
  year          SMALLINT NOT NULL CHECK (year BETWEEN 1990 AND 2100),
  metric        VARCHAR(40) NOT NULL CHECK (metric IN (
                  'CHEATING', 'CRIMINAL_BREACH_OF_TRUST', 'FORGERY', 'TOTAL_IPC')),
  value         INTEGER NOT NULL CHECK (value >= 0),
  source        VARCHAR(40) NOT NULL DEFAULT 'NCRB',
  source_file   VARCHAR(120),                  -- provenance, down to the CSV
  UNIQUE (state, district, year, metric)
);

CREATE TABLE IF NOT EXISTS fraud_reference (
  id            SERIAL PRIMARY KEY,
  state         VARCHAR(80) NOT NULL,
  year          SMALLINT NOT NULL CHECK (year BETWEEN 1990 AND 2100),
  loss_bracket  VARCHAR(24) NOT NULL CHECK (loss_bracket IN (
                  '1_10_CR', '10_25_CR', '25_50_CR', '50_100_CR', 'ABOVE_100_CR')),
  cases         INTEGER NOT NULL CHECK (cases >= 0),
  source        VARCHAR(40) NOT NULL DEFAULT 'NCRB',
  source_file   VARCHAR(120),
  UNIQUE (state, year, loss_bracket)
);

-- The choropleth asks "every state, one metric, one year" on every map paint.
CREATE INDEX IF NOT EXISTS idx_crime_reference_lookup
  ON crime_reference (metric, year, state);
-- The district baseline panel asks the same question the other way round.
CREATE INDEX IF NOT EXISTS idx_crime_reference_district
  ON crime_reference (state, district, metric, year);
CREATE INDEX IF NOT EXISTS idx_fraud_reference_lookup
  ON fraud_reference (year, state);

-- ---------------------------------------------------------------------------
-- 3. Alerts become GENERATED, not seeded prose (PLAN-V2 §3.3)
--
-- `rule_key` says which rule fired. `fingerprint` identifies the specific
-- finding, so re-running the rules updates the existing alert rather than
-- filing a duplicate every time — a threat feed that grows by eight rows per
-- refresh is noise, not intelligence.
--
-- `query_sql` stores the statement that produced the alert so the UI can offer
-- "show me why": an alert an investigator cannot audit is an assertion, and
-- assertions are what this system exists to replace.
-- ---------------------------------------------------------------------------

ALTER TABLE alerts ADD COLUMN IF NOT EXISTS rule_key     VARCHAR(40);
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS fingerprint  VARCHAR(120);
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS query_sql    TEXT;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS evidence     JSONB;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS generated_at TIMESTAMPTZ;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS updated_at   TIMESTAMPTZ NOT NULL DEFAULT now();

-- Partial, because the hand-seeded alerts have no fingerprint and several NULLs
-- must not collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_fingerprint
  ON alerts (fingerprint) WHERE fingerprint IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. Indexes the hardening pass showed were missing
--
-- Every one of these backs a query that already existed and was doing a
-- sequential scan. At 220 complaints that is invisible; the point of the system
-- is that it is pointed at NCRP, where it would not be.
-- ---------------------------------------------------------------------------

-- "which complaints share this entity" walks entity -> complaint constantly.
CREATE INDEX IF NOT EXISTS idx_complaint_entities_pair
  ON complaint_entities (entity_id, complaint_id) INCLUDE (role);

-- The evidence locker lists newest-first and joins anchors on every row.
CREATE INDEX IF NOT EXISTS idx_evidence_created ON evidence (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_complaint ON evidence (complaint_id);
CREATE INDEX IF NOT EXISTS idx_evidence_anchors_status ON evidence_anchors (status);
CREATE INDEX IF NOT EXISTS idx_verifications_evidence ON verifications (evidence_id, verified_at);

-- Two exhibits with the same digest are the same exhibit; the anchor path looks
-- this up before registering, and the verify path looks it up per check.
CREATE INDEX IF NOT EXISTS idx_evidence_sha256 ON evidence (sha256_hash);

-- The timeline filters by actor and by action as well as ordering by time.
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs (action, created_at DESC);

-- Complaint search is ILIKE over three columns; trigram indexes make that an
-- index scan instead of a full table scan on every keystroke. pg_trgm ships
-- with Postgres but is not enabled by default, and CREATE EXTENSION needs
-- privileges a locked-down role may not have — so the whole block is optional
-- and the search works either way.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE INDEX IF NOT EXISTS idx_complaints_ref_trgm
    ON complaints USING gin (complaint_ref gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS idx_complaints_victim_trgm
    ON complaints USING gin (victim_name gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS idx_entities_value_trgm
    ON entities USING gin (value gin_trgm_ops);
EXCEPTION WHEN insufficient_privilege OR undefined_file THEN
  RAISE NOTICE 'pg_trgm unavailable — complaint search falls back to sequential ILIKE';
END $$;
