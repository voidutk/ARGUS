-- ARGUS initial schema (see docs/PLAN.md §3.1)
--
-- Postgres is the SOURCE OF TRUTH for records. Neo4j is a derived index built
-- by the intelligence service and can be dropped and rebuilt from these tables
-- at any time. Nothing in here depends on the graph being up.

-- ---------------------------------------------------------------------------
-- People and units
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS units (
  id SERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  code VARCHAR(20) UNIQUE NOT NULL,
  state VARCHAR(60),
  location VARCHAR(120)
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name VARCHAR(120) NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('ADMIN', 'SUPERVISOR', 'INVESTIGATOR', 'ANALYST')),
  rank_title VARCHAR(60),
  wallet_address VARCHAR(42),
  unit_id INTEGER REFERENCES units(id),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Complaints — the raw intake ARGUS correlates
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS complaints (
  id SERIAL PRIMARY KEY,
  complaint_ref VARCHAR(40) UNIQUE NOT NULL,        -- e.g. NCRP-2026-004412
  victim_name VARCHAR(120) NOT NULL,
  victim_phone VARCHAR(20),
  victim_email VARCHAR(255),
  narrative TEXT NOT NULL,                          -- free text; what /extract reads
  scam_category VARCHAR(40) NOT NULL CHECK (scam_category IN (
    'UPI_FRAUD', 'INVESTMENT_SCAM', 'DIGITAL_ARREST', 'JOB_FRAUD',
    'LOAN_APP', 'CRYPTO_FRAUD', 'SEXTORTION', 'PHISHING',
    'MATRIMONIAL', 'OTP_FRAUD', 'OTHER'
  )),
  amount_inr NUMERIC(14, 2) NOT NULL DEFAULT 0,
  state VARCHAR(60),
  district VARCHAR(80),
  lat DOUBLE PRECISION,
  lon DOUBLE PRECISION,
  status VARCHAR(20) NOT NULL DEFAULT 'NEW'
    CHECK (status IN ('NEW', 'TRIAGED', 'LINKED', 'UNDER_INVESTIGATION', 'CLOSED')),
  filed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Entities — canonical and deduplicated.
--
-- This table is the entire product. If the same UPI ID lands here twice under
-- two spellings, no network is ever found. Everything is normalised on write
-- and the UNIQUE constraint below is the guarantee.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS entities (
  id SERIAL PRIMARY KEY,
  entity_type VARCHAR(20) NOT NULL CHECK (entity_type IN (
    'PHONE', 'UPI', 'BANK_ACCOUNT', 'WALLET', 'EMAIL',
    'IP', 'DEVICE', 'LOCATION', 'PERSON', 'TELEGRAM'
  )),
  value VARCHAR(255) NOT NULL,                      -- as it appeared
  normalized_value VARCHAR(255) NOT NULL,           -- what we match on
  label VARCHAR(120),                               -- display name, if known
  risk_score SMALLINT NOT NULL DEFAULT 0 CHECK (risk_score BETWEEN 0 AND 100),
  influence_score SMALLINT NOT NULL DEFAULT 0 CHECK (influence_score BETWEEN 0 AND 100),
  cluster_id INTEGER,                               -- FK added after clusters exists
  is_flagged BOOLEAN NOT NULL DEFAULT false,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (entity_type, normalized_value)
);

CREATE TABLE IF NOT EXISTS complaint_entities (
  id SERIAL PRIMARY KEY,
  complaint_id INTEGER NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
  entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL DEFAULT 'SUSPECT' CHECK (role IN ('VICTIM', 'SUSPECT', 'INTERMEDIARY')),
  confidence REAL NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),
  method VARCHAR(10) NOT NULL DEFAULT 'REGEX' CHECK (method IN ('REGEX', 'NER', 'MANUAL')),
  context_snippet TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (complaint_id, entity_id, role)
);

-- Entity-to-entity edges that are NOT derivable from complaint co-occurrence.
--
-- Most links are inferred: two entities named in the same complaint are related.
-- But the highest-value nodes are exactly the ones that never appear in a
-- complaint — a coordinator who speaks only to handlers and never to a victim
-- is invisible to co-occurrence. Those edges come from intelligence: seized
-- phone contact lists, telco CDRs, bank KYC. Without this table the mastermind
-- is unreachable in the graph, so this is what makes §I.4 possible at all.
CREATE TABLE IF NOT EXISTS entity_links (
  id SERIAL PRIMARY KEY,
  from_entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relationship VARCHAR(24) NOT NULL CHECK (relationship IN (
    'USES', 'OWNS', 'CONNECTED_TO', 'COMMUNICATED_WITH', 'LOCATED_AT', 'REGISTERED_TO'
  )),
  weight REAL NOT NULL DEFAULT 1 CHECK (weight > 0),
  source VARCHAR(12) NOT NULL DEFAULT 'INFERRED'
    CHECK (source IN ('INFERRED', 'INTEL', 'SEIZURE', 'TELCO', 'BANK')),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (from_entity_id, to_entity_id, relationship)
);

-- ---------------------------------------------------------------------------
-- Criminal clusters — materialised by the analytics job, not hand-edited
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS clusters (
  id SERIAL PRIMARY KEY,
  cluster_key VARCHAR(20) UNIQUE NOT NULL,          -- ALPHA, BETA, GAMMA...
  label VARCHAR(120) NOT NULL,
  description TEXT,
  node_count INTEGER NOT NULL DEFAULT 0,
  complaint_count INTEGER NOT NULL DEFAULT 0,
  total_amount_inr NUMERIC(16, 2) NOT NULL DEFAULT 0,
  states_touched INTEGER NOT NULL DEFAULT 0,
  risk_level VARCHAR(10) NOT NULL DEFAULT 'LOW'
    CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  risk_score SMALLINT NOT NULL DEFAULT 0 CHECK (risk_score BETWEEN 0 AND 100),
  mastermind_entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE entities
  DROP CONSTRAINT IF EXISTS entities_cluster_id_fkey;
ALTER TABLE entities
  ADD CONSTRAINT entities_cluster_id_fkey
  FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Money flow — the laundering chain, hop by hop
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY,
  complaint_id INTEGER REFERENCES complaints(id) ON DELETE CASCADE,
  from_entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  amount_inr NUMERIC(14, 2) NOT NULL,
  rail VARCHAR(10) NOT NULL CHECK (rail IN ('UPI', 'IMPS', 'NEFT', 'RTGS', 'CRYPTO', 'CASH')),
  hop_index SMALLINT NOT NULL DEFAULT 0,            -- 0 = victim's outgoing payment
  reference VARCHAR(80),                            -- UTR / tx hash
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Evidence + on-chain anchoring
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS evidence (
  id SERIAL PRIMARY KEY,
  complaint_id INTEGER REFERENCES complaints(id) ON DELETE SET NULL,
  title VARCHAR(255) NOT NULL,
  filename VARCHAR(255) NOT NULL,
  mime_type VARCHAR(100),
  size_bytes BIGINT,
  evidence_type VARCHAR(30) NOT NULL DEFAULT 'DOCUMENT' CHECK (evidence_type IN (
    'SCREENSHOT', 'BANK_STATEMENT', 'CHAT_LOG', 'CALL_RECORD', 'DOCUMENT', 'OTHER'
  )),
  sha256_hash CHAR(64) NOT NULL,                    -- of the PLAINTEXT; this goes on-chain
  encrypted_path TEXT NOT NULL,
  iv VARCHAR(64) NOT NULL,
  auth_tag VARCHAR(64) NOT NULL,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS evidence_anchors (
  id SERIAL PRIMARY KEY,
  evidence_id INTEGER NOT NULL UNIQUE REFERENCES evidence(id) ON DELETE CASCADE,
  tx_hash VARCHAR(66),
  block_number BIGINT,
  network VARCHAR(20) NOT NULL DEFAULT 'localhost',
  contract_address VARCHAR(42),
  on_chain_hash CHAR(64),
  anchored_at TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'ANCHORED', 'FAILED'))
);

CREATE TABLE IF NOT EXISTS verifications (
  id SERIAL PRIMARY KEY,
  evidence_id INTEGER NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  verified_by INTEGER REFERENCES users(id),
  computed_hash CHAR(64),
  chain_hash CHAR(64),
  is_valid BOOLEAN,
  tx_hash VARCHAR(66),                              -- the logVerification tx, if written
  verified_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Investigations, alerts, audit
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS investigations (
  id SERIAL PRIMARY KEY,
  case_ref VARCHAR(40) UNIQUE NOT NULL,             -- e.g. ARGUS-CASE-0007
  title VARCHAR(200) NOT NULL,
  cluster_id INTEGER REFERENCES clusters(id) ON DELETE SET NULL,
  assigned_to INTEGER REFERENCES users(id),
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN', 'ACTIVE', 'PENDING_REVIEW', 'CLOSED')),
  priority VARCHAR(10) NOT NULL DEFAULT 'MEDIUM'
    CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS alerts (
  id SERIAL PRIMARY KEY,
  severity VARCHAR(10) NOT NULL CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  alert_type VARCHAR(60) NOT NULL,                  -- WALLET_REUSE, DEVICE_REUSE, IP_CLUSTER...
  title VARCHAR(200) NOT NULL,
  details JSONB,
  cluster_id INTEGER REFERENCES clusters(id) ON DELETE SET NULL,
  entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL,
  complaint_id INTEGER REFERENCES complaints(id) ON DELETE SET NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only. This table IS the Investigation Timeline page.
CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  actor_id INTEGER REFERENCES users(id),
  action VARCHAR(80) NOT NULL,
  entity_type VARCHAR(40),
  entity_id INTEGER,
  metadata JSONB,
  ip_address VARCHAR(45),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Indexes. complaint_entities(entity_id) is the hot path: "which complaints
-- share this entity" is the question every correlation asks.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_complaint_entities_entity ON complaint_entities(entity_id);
CREATE INDEX IF NOT EXISTS idx_complaint_entities_complaint ON complaint_entities(complaint_id);
CREATE INDEX IF NOT EXISTS idx_entities_lookup ON entities(entity_type, normalized_value);
CREATE INDEX IF NOT EXISTS idx_entities_cluster ON entities(cluster_id);
CREATE INDEX IF NOT EXISTS idx_entities_influence ON entities(influence_score DESC);
CREATE INDEX IF NOT EXISTS idx_entity_links_from ON entity_links(from_entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_links_to ON entity_links(to_entity_id);
CREATE INDEX IF NOT EXISTS idx_complaints_state ON complaints(state);
CREATE INDEX IF NOT EXISTS idx_complaints_category ON complaints(scam_category);
CREATE INDEX IF NOT EXISTS idx_complaints_filed ON complaints(filed_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_from ON transactions(from_entity_id);
CREATE INDEX IF NOT EXISTS idx_transactions_to ON transactions(to_entity_id);
CREATE INDEX IF NOT EXISTS idx_transactions_complaint ON transactions(complaint_id);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status, severity);
CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
