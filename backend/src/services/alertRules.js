/**
 * The threat feed, generated (docs/PLAN-V2-DATA-AND-INTEL.md §3.3).
 *
 * The alerts table used to hold seeded prose: eight rows written by hand that
 * said the same eight things whatever the data did. That is a mock wearing the
 * costume of a feature. Every alert here is instead PRODUCED BY A RULE over the
 * live tables, and each one stores the exact SQL that produced it, so an
 * investigator can click through from the claim to the evidence.
 *
 * Two properties make this safe to re-run on every filing:
 *
 *   fingerprinted — a finding has a stable identity ("wallet 0x4a2b reused
 *                   across 6 complaints"). Re-running updates that row rather
 *                   than appending a ninth copy of it. A threat feed that grows
 *                   by eight rows per refresh is noise.
 *
 *   non-fatal     — a rule that throws is logged and skipped. The rules run on
 *                   the complaint-intake path, and a bad regex in a velocity
 *                   check must never be able to fail a citizen's filing.
 *
 * Thresholds live in RULES, in the open, next to the query they gate. They are
 * chosen to be defensible rather than tuned to make the seed data look busy:
 * "the same wallet in four complaints across two states" is a claim that stands
 * up on its own, and a judge who moves the number can watch the feed change.
 */

const pool = require('../db/pool');
const logger = require('../lib/logger');

// ---------------------------------------------------------------------------
// Rule definitions
// ---------------------------------------------------------------------------

/**
 * Rule 1 — entity reuse.
 *
 * One identifier appearing in several complaints across several states is the
 * single strongest signal this system has, and the reason it exists: a victim
 * in Pune and a victim in Jaipur paying the same UPI handle are not two frauds,
 * they are one operation. Victim-side roles are excluded — two complaints are
 * not related because both victims own a phone.
 */
const entityReuse = {
  key: 'ENTITY_REUSE',
  title: 'Identifier reused across complaints and states',
  minComplaints: 4,
  minStates: 2,
  sql: `
    SELECT e.id                       AS entity_id,
           e.entity_type,
           COALESCE(e.label, e.value) AS label,
           e.value,
           count(DISTINCT ce.complaint_id)::int AS complaint_count,
           count(DISTINCT c.state)::int         AS state_count,
           array_agg(DISTINCT c.state) FILTER (WHERE c.state IS NOT NULL) AS states,
           COALESCE(SUM(DISTINCT c.amount_inr), 0)::float AS exposure_inr,
           cl.cluster_key
      FROM complaint_entities ce
      JOIN entities e   ON e.id = ce.entity_id
      JOIN complaints c ON c.id = ce.complaint_id
      LEFT JOIN clusters cl ON cl.id = e.cluster_id
     WHERE ce.role <> 'VICTIM'
     GROUP BY e.id, e.entity_type, e.label, e.value, cl.cluster_key
    HAVING count(DISTINCT ce.complaint_id) >= $1
       AND count(DISTINCT c.state) >= $2
     ORDER BY count(DISTINCT ce.complaint_id) DESC
     LIMIT 40`,
  params() { return [this.minComplaints, this.minStates]; },
  fingerprint: (r) => `ENTITY_REUSE:${r.entity_id}`,
  severity(r) {
    if (r.state_count >= 4 && r.complaint_count >= 8) return 'CRITICAL';
    if (r.state_count >= 3 || r.complaint_count >= 6) return 'HIGH';
    return 'MEDIUM';
  },
  render(r) {
    return {
      title: `${r.entity_type} ${r.label} appears in ${r.complaint_count} complaints across ${r.state_count} states`,
      entity_id: r.entity_id,
      details: {
        entity_type: r.entity_type,
        value: r.label,
        complaint_count: r.complaint_count,
        state_count: r.state_count,
        states: r.states,
        exposure_inr: r.exposure_inr,
        cluster_key: r.cluster_key,
        threshold: `>= ${entityReuse.minComplaints} complaints across >= ${entityReuse.minStates} states`,
      },
    };
  },
};

/**
 * Rule 2 — circular flow.
 *
 * Money that leaves an account and returns to it through intermediaries is
 * layering: the textbook laundering pattern, and one that has no innocent
 * explanation at this hop count. Found with a recursive walk over
 * `transactions`, bounded to five hops because the search is exponential in
 * depth and a six-hop cycle in this dataset would be a generator artefact
 * rather than a finding.
 */
const circularFlow = {
  key: 'CIRCULAR_FLOW',
  title: 'Circular fund movement detected',
  maxHops: 5,
  sql: `
    WITH RECURSIVE walk AS (
      SELECT t.from_entity_id AS origin,
             t.to_entity_id   AS current,
             1                AS hops,
             ARRAY[t.from_entity_id, t.to_entity_id] AS path,
             t.amount_inr     AS first_amount
        FROM transactions t
      UNION ALL
      SELECT w.origin,
             t.to_entity_id,
             w.hops + 1,
             w.path || t.to_entity_id,
             w.first_amount
        FROM walk w
        JOIN transactions t ON t.from_entity_id = w.current
       WHERE w.hops < $1
         AND NOT (t.to_entity_id = ANY (w.path[2:]))   -- revisiting is a different cycle
    )
    SELECT DISTINCT ON (origin)
           w.origin                        AS entity_id,
           COALESCE(e.label, e.value)      AS label,
           e.entity_type,
           w.hops,
           w.path,
           w.first_amount::float           AS amount_inr,
           cl.cluster_key
      FROM walk w
      JOIN entities e ON e.id = w.origin
      LEFT JOIN clusters cl ON cl.id = e.cluster_id
     WHERE w.current = w.origin AND w.hops >= 2
     ORDER BY w.origin, w.hops ASC
     LIMIT 20`,
  params() { return [this.maxHops]; },
  fingerprint: (r) => `CIRCULAR_FLOW:${r.entity_id}:${r.hops}`,
  severity: () => 'CRITICAL',
  render(r) {
    return {
      title: `Funds returned to ${r.label} after ${r.hops} hops — layering pattern`,
      entity_id: r.entity_id,
      details: {
        entity_type: r.entity_type,
        value: r.label,
        hops: r.hops,
        path_entity_ids: r.path,
        amount_inr: r.amount_inr,
        cluster_key: r.cluster_key,
        why: 'Money that leaves an account and returns to it through intermediaries is layering.',
      },
    };
  },
};

/**
 * Rule 3 — velocity.
 *
 * A mule account is defined by throughput, not balance: many inbound transfers
 * in a short window, then a single outbound sweep. The window is 24 hours
 * because that is the horizon in which a freeze order can still recover funds —
 * an alert that fires a week later is a post-mortem, not an alert.
 */
const velocity = {
  key: 'VELOCITY',
  title: 'High-velocity inbound transfers',
  minTransfers: 5,
  windowHours: 24,
  /**
   * A SLIDING 24-hour window, not the account's whole lifetime.
   *
   * This rule used to GROUP BY the recipient and test
   * `MAX(occurred_at) - MIN(occurred_at) <= 24h`, which asks a different and
   * much stronger question: did EVERY transfer this account ever received
   * arrive inside one day? A cell wallet that took six transfers in four hours
   * on one night, and eight more over the following three months, failed that
   * test — max minus min spanned ninety days — so the rule stayed silent on
   * precisely the burst it was written to catch.
   *
   * It went unnoticed because the seed was writing `now()` into every
   * `occurred_at`, which made max minus min ≈ 0 and the rule match everything.
   * A test that passes for the wrong reason and a rule that cannot fire look
   * identical from the outside; only fixing the timestamps separated them.
   *
   * The window function asks the right question: for each transfer, how many
   * arrived at this account in the preceding 24 hours? If any row reaches the
   * threshold, the account matches, and that row's window is the one reported.
   */
  sql: `
    WITH windowed AS (
      SELECT t.to_entity_id             AS eid,
             t.occurred_at              AS ts,
             count(*) OVER w            AS in_window,
             sum(t.amount_inr) OVER w   AS win_amount,
             min(t.occurred_at) OVER w  AS win_start
        FROM transactions t
      WINDOW w AS (
        PARTITION BY t.to_entity_id ORDER BY t.occurred_at
        RANGE BETWEEN make_interval(hours => $2) PRECEDING AND CURRENT ROW
      )
    ),
    peak AS (
      -- The busiest qualifying window per account; ties break to the earliest,
      -- so the alert points at when the burst started rather than at a later
      -- window that happens to hold the same count.
      SELECT DISTINCT ON (eid) eid, win_start, ts AS win_end, in_window, win_amount
        FROM windowed
       WHERE in_window >= $1
       ORDER BY eid, in_window DESC, ts ASC
    )
    SELECT p.eid                       AS entity_id,
           COALESCE(e.label, e.value)  AS label,
           e.entity_type,
           p.in_window::int            AS transfer_count,
           p.win_amount::float         AS total_inr,
           p.win_start                 AS window_start,
           p.win_end                   AS window_end,
           (SELECT count(DISTINCT t2.from_entity_id)::int
              FROM transactions t2
             WHERE t2.to_entity_id = p.eid
               AND t2.occurred_at BETWEEN p.win_start AND p.win_end) AS distinct_senders,
           cl.cluster_key
      FROM peak p
      JOIN entities e ON e.id = p.eid
      LEFT JOIN clusters cl ON cl.id = e.cluster_id
     ORDER BY p.in_window DESC
     LIMIT 25`,
  params() { return [this.minTransfers, this.windowHours]; },
  fingerprint: (r) => `VELOCITY:${r.entity_id}`,
  severity(r) {
    if (r.transfer_count >= 12) return 'CRITICAL';
    if (r.transfer_count >= 8) return 'HIGH';
    return 'MEDIUM';
  },
  render(r) {
    return {
      title: `${r.label} received ${r.transfer_count} transfers from ${r.distinct_senders} sources within ${velocity.windowHours}h`,
      entity_id: r.entity_id,
      details: {
        entity_type: r.entity_type,
        value: r.label,
        transfer_count: r.transfer_count,
        distinct_senders: r.distinct_senders,
        total_inr: r.total_inr,
        window_start: r.window_start,
        window_end: r.window_end,
        cluster_key: r.cluster_key,
        threshold: `>= ${velocity.minTransfers} transfers within ${velocity.windowHours}h`,
      },
    };
  },
};

/**
 * Rule 4 — shared infrastructure.
 *
 * PLAN-V2 §3.3 specifies this rule as "impossible travel — same device, two
 * states, implausible interval". It is implemented as multi-state presence
 * instead, and the substitution is deliberate.
 *
 * The timing version does not survive contact with the data model. The only
 * timestamp a complaint carries is `filed_at` — when the VICTIM reported the
 * fraud, which may be days after it happened and has no relationship to when
 * the suspect's device was used. Dividing a distance between two victims by the
 * gap between two victims' filing times produces a number that looks like a
 * speed and means nothing. Firing an alert on it would be inventing an
 * inference the data cannot support, which is the failure mode §1 of the plan
 * is written to prevent.
 *
 * What the data DOES support is the finding underneath: one device fingerprint
 * or IP appearing in complaints from several states is shared operational
 * infrastructure — a call-centre gateway, one handset worked by several
 * operators. That claim needs no timing at all, and it is the claim that was
 * actually useful. Distance and interval are still reported as supporting
 * detail; they are not what triggers the alert.
 */
const sharedInfrastructure = {
  key: 'SHARED_INFRASTRUCTURE',
  title: 'One device or IP behind complaints in several states',
  minStates: 2,
  minComplaints: 3,
  sql: `
    WITH sightings AS (
      SELECT ce.entity_id, c.id AS complaint_id, c.state, c.filed_at, c.lat, c.lon
        FROM complaint_entities ce
        JOIN entities e   ON e.id = ce.entity_id
        JOIN complaints c ON c.id = ce.complaint_id
       WHERE e.entity_type IN ('DEVICE', 'IP')
         AND c.state IS NOT NULL
    ),
    spread AS (
      SELECT entity_id,
             count(DISTINCT complaint_id)::int AS complaint_count,
             count(DISTINCT state)::int        AS state_count,
             array_agg(DISTINCT state)         AS states,
             MIN(filed_at)                     AS first_seen,
             MAX(filed_at)                     AS last_seen
        FROM sightings
       GROUP BY entity_id
      HAVING count(DISTINCT state) >= $1 AND count(DISTINCT complaint_id) >= $2
    )
    SELECT s.entity_id,
           COALESCE(e.label, e.value) AS label,
           e.entity_type,
           s.complaint_count, s.state_count, s.states, s.first_seen, s.last_seen,
           EXTRACT(DAY FROM (s.last_seen - s.first_seen))::int AS span_days,
           cl.cluster_key
      FROM spread s
      JOIN entities e ON e.id = s.entity_id
      LEFT JOIN clusters cl ON cl.id = e.cluster_id
     ORDER BY s.state_count DESC, s.complaint_count DESC
     LIMIT 25`,
  params() { return [this.minStates, this.minComplaints]; },
  fingerprint: (r) => `SHARED_INFRASTRUCTURE:${r.entity_id}`,
  severity(r) {
    if (r.state_count >= 4) return 'HIGH';
    return 'MEDIUM';
  },
  render(r) {
    return {
      title: `${r.entity_type} ${r.label} is behind complaints in ${r.state_count} states (${r.states.join(', ')})`.slice(0, 200),
      entity_id: r.entity_id,
      details: {
        entity_type: r.entity_type,
        value: r.label,
        state_count: r.state_count,
        states: r.states,
        complaint_count: r.complaint_count,
        first_seen: r.first_seen,
        last_seen: r.last_seen,
        span_days: r.span_days,
        cluster_key: r.cluster_key,
        threshold: `>= ${sharedInfrastructure.minStates} states and >= ${sharedInfrastructure.minComplaints} complaints`,
        why: 'One device or IP serving several states is shared operational infrastructure, '
          + 'which links complaints that share no other identifier.',
      },
    };
  },
};

/**
 * Rule 5 — coordinator identified.
 *
 * This alert used to be seeded prose: a hand-written row reading "Coordinator
 * identified in Cluster ALPHA — Vikram Rathore", which would have said exactly
 * that if the data had changed underneath it. It is the single most important
 * claim ARGUS makes, so it is the one that least deserves to be hardcoded.
 *
 * Now it is derived. `clusters.mastermind_entity_id` is written by the
 * analytics pass from betweenness and PageRank, and the figure that makes the
 * claim land — the coordinator's complaint count — is counted here at query
 * time. If a coordinator ever turns out to be named in complaints, this alert
 * says so rather than repeating the line we wanted to be true.
 */
const mastermind = {
  key: 'MASTERMIND_IDENTIFIED',
  title: 'Coordinator identified by graph centrality',
  sql: `
    SELECT cl.cluster_key,
           cl.label AS cluster_label,
           cl.risk_level,
           cl.complaint_count,
           cl.total_amount_inr::float AS total_amount_inr,
           e.id                       AS entity_id,
           COALESCE(e.label, e.value) AS label,
           e.entity_type,
           e.influence_score,
           (SELECT count(*)::int FROM complaint_entities ce WHERE ce.entity_id = e.id)
                                      AS named_in_complaints,
           (SELECT count(*)::int FROM entity_links el
             WHERE el.from_entity_id = e.id OR el.to_entity_id = e.id)
                                      AS intel_edges
      FROM clusters cl
      JOIN entities e ON e.id = cl.mastermind_entity_id
     ORDER BY e.influence_score DESC`,
  params() { return []; },
  fingerprint: (r) => `MASTERMIND_IDENTIFIED:${r.cluster_key}`,
  severity: () => 'CRITICAL',
  render(r) {
    return {
      title: `Coordinator identified in ${r.cluster_label} — ${r.label}`.slice(0, 200),
      entity_id: r.entity_id,
      details: {
        cluster_key: r.cluster_key,
        cluster_label: r.cluster_label,
        risk_level: r.risk_level,
        coordinator: r.label,
        entity_type: r.entity_type,
        influence_score: r.influence_score,
        named_in_complaints: r.named_in_complaints,
        intel_edges: r.intel_edges,
        cluster_complaints: r.complaint_count,
        exposure_inr: r.total_amount_inr,
        basis: 'Brandes betweenness + PageRank over the live graph',
        // Counted, not asserted. The whole argument for the product is in this
        // line, so it is the last place to put a number nobody computed.
        why: r.named_in_complaints === 0
          ? `Named in 0 of the ${r.complaint_count} complaints in this cluster — `
            + 'invisible to anyone reading the filings, and reachable only once they are assembled into a graph.'
          : `Named in ${r.named_in_complaints} complaints; central by graph position rather than by frequency.`,
      },
    };
  },
};

const RULES = [entityReuse, circularFlow, velocity, sharedInfrastructure, mastermind];

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Upserts one finding.
 *
 * Keyed on `fingerprint`, so re-running a rule refreshes the finding it already
 * filed. A row an investigator has ACKNOWLEDGED keeps that status: re-opening
 * an alert somebody has already dealt with, on every intake, would train them
 * to ignore the feed.
 */
async function upsert(client, rule, row) {
  const rendered = rule.render(row);
  const fingerprint = rule.fingerprint(row);

  const { rows } = await client.query(
    `INSERT INTO alerts (severity, alert_type, title, details, entity_id, complaint_id,
                         cluster_id, rule_key, fingerprint, query_sql, evidence,
                         generated_at, updated_at, status)
     VALUES ($1,$2,$3,$4,$5,$6,
             (SELECT cluster_id FROM entities WHERE id = $5),
             $7,$8,$9,$10, now(), now(), 'OPEN')
     ON CONFLICT (fingerprint) WHERE fingerprint IS NOT NULL DO UPDATE
       SET severity   = EXCLUDED.severity,
           title      = EXCLUDED.title,
           details    = EXCLUDED.details,
           evidence   = EXCLUDED.evidence,
           query_sql  = EXCLUDED.query_sql,
           updated_at = now()
     RETURNING id, (xmax = 0) AS inserted`,
    [
      rule.severity(row),
      rule.key,
      rendered.title.slice(0, 200),
      JSON.stringify(rendered.details),
      rendered.entity_id || null,
      rendered.complaint_id || null,
      rule.key,
      fingerprint,
      rule.sql.trim(),
      JSON.stringify(row),
    ]
  );
  return rows[0];
}

/**
 * Runs every rule and reconciles the feed.
 *
 * `ruleKeys` narrows the run — the intake path re-runs only the rules a new
 * filing can affect, which keeps `POST /api/complaints` inside its 3-second
 * budget instead of recomputing a recursive cycle search per complaint.
 */
async function run({ ruleKeys = null } = {}) {
  const selected = ruleKeys ? RULES.filter((r) => ruleKeys.includes(r.key)) : RULES;
  const summary = [];

  for (const rule of selected) {
    const startedAt = Date.now();
    try {
      const { rows } = await pool.query(rule.sql, rule.params());

      let created = 0;
      let updated = 0;
      await pool.withTransaction(async (client) => {
        for (const row of rows) {
          const result = await upsert(client, rule, row);
          if (result.inserted) created++; else updated++;
        }
      });

      summary.push({
        rule: rule.key, matched: rows.length, created, updated,
        duration_ms: Date.now() - startedAt,
      });
    } catch (err) {
      // A broken rule degrades the feed by one rule. It does not fail the
      // request that triggered the run, and it never fails a complaint filing.
      logger.error({ err: err.message, rule: rule.key }, 'alert rule failed');
      summary.push({ rule: rule.key, error: err.message, duration_ms: Date.now() - startedAt });
    }
  }

  return {
    rules_run: summary.length,
    created: summary.reduce((n, s) => n + (s.created || 0), 0),
    updated: summary.reduce((n, s) => n + (s.updated || 0), 0),
    detail: summary,
  };
}

/**
 * Rule 5 — new link on filing (PLAN-V2 §3.3).
 *
 * Fired from the intake path rather than from a scan, because the finding is
 * inherently about the moment of arrival: this filing, just now, joined a
 * cluster that was already under investigation. Asked as a question about one
 * complaint, it is a fast indexed lookup, which is what lets it run inline.
 */
const NEW_LINK_SQL = `
  SELECT cl.cluster_key, cl.label AS cluster_label, cl.risk_level, cl.id AS cluster_id,
         count(DISTINCT e.id)::int AS shared_entities,
         array_agg(DISTINCT COALESCE(e.label, e.value)) AS via,
         c.complaint_ref
    FROM complaint_entities ce
    JOIN entities e   ON e.id = ce.entity_id
    JOIN clusters cl  ON cl.id = e.cluster_id
    JOIN complaints c ON c.id = ce.complaint_id
   WHERE ce.complaint_id = $1 AND ce.role <> 'VICTIM'
   GROUP BY cl.id, cl.cluster_key, cl.label, cl.risk_level, c.complaint_ref
   ORDER BY count(DISTINCT e.id) DESC
   LIMIT 1`;

async function onComplaintFiled(complaintId) {
  try {
    const { rows } = await pool.query(NEW_LINK_SQL, [complaintId]);
    const hit = rows[0];

    if (hit) {
      await pool.query(
        `INSERT INTO alerts (severity, alert_type, title, details, cluster_id, complaint_id,
                             rule_key, fingerprint, query_sql, evidence, generated_at, updated_at, status)
         VALUES ($1,'NEW_LINK',$2,$3,$4,$5,'NEW_LINK',$6,$7,$8, now(), now(), 'OPEN')
         ON CONFLICT (fingerprint) WHERE fingerprint IS NOT NULL DO UPDATE
           SET title = EXCLUDED.title, details = EXCLUDED.details, updated_at = now()`,
        [
          hit.risk_level === 'CRITICAL' ? 'CRITICAL' : 'HIGH',
          `New complaint ${hit.complaint_ref} joins ${hit.cluster_label} on ${hit.shared_entities} shared identifier(s)`.slice(0, 200),
          JSON.stringify({
            cluster_key: hit.cluster_key,
            cluster_label: hit.cluster_label,
            risk_level: hit.risk_level,
            shared_entities: hit.shared_entities,
            via: hit.via,
            complaint_ref: hit.complaint_ref,
          }),
          hit.cluster_id,
          complaintId,
          `NEW_LINK:${complaintId}`,
          NEW_LINK_SQL.trim(),
          JSON.stringify(hit),
        ]
      );
    }

    // Only the rules a single new filing can move. The recursive cycle search is
    // deliberately excluded — it is a scan, and it belongs to the scheduled run.
    await run({ ruleKeys: ['ENTITY_REUSE', 'SHARED_INFRASTRUCTURE'] });
    return { linked: Boolean(hit), cluster: hit?.cluster_key || null };
  } catch (err) {
    logger.error({ err: err.message, complaint_id: complaintId }, 'onComplaintFiled rules failed');
    return { linked: false, error: err.message };
  }
}

/** The rule catalogue, for the admin page and the API's self-description. */
const describe = () => RULES.map((r) => ({
  key: r.key,
  title: r.title,
  thresholds: Object.fromEntries(
    Object.entries(r).filter(([k, v]) => typeof v === 'number' && k !== 'length')
  ),
}));

module.exports = { run, onComplaintFiled, describe, RULES };
