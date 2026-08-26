/**
 * The read-only intelligence endpoints: clusters, alerts, geo, money, timeline,
 * entities and admin health. Grouped in one module because each is a handful of
 * lines of SQL over the same schema; splitting them into eight files would
 * scatter the shape of the API rather than clarify it.
 */

const pool = require('../db/pool');
const intel = require('../services/intelClient');
const graph = require('../services/graphService');
const audit = require('../services/auditService');
const chain = require('../services/chainService');
const alertRules = require('../services/alertRules');
const osint = require('../services/osint');
const { asyncHandler, notFound } = require('../lib/errors');

// ---------------------------------------------------------------------------
// Clusters
// ---------------------------------------------------------------------------

const listClusters = asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT cl.id, cl.cluster_key, cl.label, cl.description, cl.node_count, cl.complaint_count,
            cl.total_amount_inr::float AS total_amount_inr, cl.states_touched,
            cl.risk_level, cl.risk_score, cl.computed_at,
            me.id AS mastermind_id, COALESCE(me.label, me.value) AS mastermind_label,
            me.entity_type AS mastermind_type
       FROM clusters cl LEFT JOIN entities me ON me.id = cl.mastermind_entity_id
      ORDER BY cl.risk_score DESC`
  );
  res.json({ clusters: rows });
});

const clusterDetail = asyncHandler(async (req, res) => {
  const { key } = req.valid.params;

  const { rows } = await pool.query(
    `SELECT cl.*, cl.total_amount_inr::float AS total_amount_inr,
            me.id AS mastermind_id, COALESCE(me.label, me.value) AS mastermind_label,
            me.entity_type AS mastermind_type, me.influence_score AS mastermind_influence
       FROM clusters cl LEFT JOIN entities me ON me.id = cl.mastermind_entity_id
      WHERE cl.cluster_key = $1`,
    [key]
  );
  const cluster = rows[0];
  if (!cluster) throw notFound('Cluster');

  const [topEntities, complaints, states] = await Promise.all([
    pool.query(
      `SELECT e.id, e.entity_type, e.value, e.label, e.influence_score, e.risk_score, e.is_flagged,
              (SELECT count(*)::int FROM complaint_entities ce WHERE ce.entity_id = e.id) AS complaint_count
         FROM entities e WHERE e.cluster_id = $1
        ORDER BY e.influence_score DESC, complaint_count DESC LIMIT 25`,
      [cluster.id]
    ),
    pool.query(
      `SELECT DISTINCT c.id, c.complaint_ref, c.scam_category, c.amount_inr::float AS amount_inr,
              c.state, c.district, c.filed_at, c.status
         FROM complaints c
         JOIN complaint_entities ce ON ce.complaint_id = c.id
         JOIN entities e ON e.id = ce.entity_id
        WHERE e.cluster_id = $1
        ORDER BY c.filed_at DESC LIMIT 100`,
      [cluster.id]
    ),
    pool.query(
      `SELECT c.state, count(DISTINCT c.id)::int AS n, SUM(c.amount_inr)::float AS amount
         FROM complaints c
         JOIN complaint_entities ce ON ce.complaint_id = c.id
         JOIN entities e ON e.id = ce.entity_id
        WHERE e.cluster_id = $1 AND c.state IS NOT NULL
        GROUP BY c.state ORDER BY n DESC`,
      [cluster.id]
    ),
  ]);

  res.json({
    cluster,
    mastermind: cluster.mastermind_id
      ? {
          id: cluster.mastermind_id,
          label: cluster.mastermind_label,
          type: cluster.mastermind_type,
          influence: cluster.mastermind_influence,
          node_id: await graph.nodeIdForEntity(cluster.mastermind_id),
        }
      : null,
    top_entities: topEntities.rows,
    complaints: complaints.rows,
    states: states.rows,
  });
});

/** ADMIN/ANALYST — recompute communities, influence and risk. */
const runAnalytics = asyncHandler(async (req, res) => {
  const started = Date.now();
  const live = await intel.runAnalytics();
  graph.invalidate();

  await audit.log({
    actorId: req.user.id,
    action: 'CLUSTER_COMPUTED',
    entityType: 'cluster',
    metadata: { intel_ok: live.ok, reason: live.reason || null },
    ipAddress: audit.clientIp(req),
  });

  /**
   * Write the scores back, on BOTH paths.
   *
   * This used to call `graph.load({ force: true })` and report `nodes_scored`,
   * which read as success and persisted nothing — the scores lived in the
   * in-memory graph and the `entities.influence_score` / `risk_score` columns
   * stayed at their default of zero. Anything reading the graph (the Explorer)
   * looked right; anything reading the table (Networks, the entity list, entity
   * detail) showed "influence 0" next to the coordinator, which is precisely
   * the number the whole demo turns on.
   *
   * The intel-service path needs it too: intel-service computes over Neo4j and
   * does not write to Postgres either, so without this the same columns stay
   * empty on the healthy path as well.
   */
  const persisted = await graph.persistScores();

  if (!live.ok) {
    return res.status(202).json({
      source: 'postgres-fallback',
      reason: live.reason,
      nodes_scored: persisted.entities,
      entities_scored: persisted.scored,
      top_influence: persisted.top_influence,
      top_risk: persisted.top_risk,
      duration_ms: Date.now() - started,
    });
  }
  res.json({
    ...live.data,
    source: 'intel-service',
    entities_scored: persisted.scored,
    top_influence: persisted.top_influence,
    top_risk: persisted.top_risk,
    duration_ms: Date.now() - started,
  });
});

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

const listEntities = asyncHandler(async (req, res) => {
  const { limit, offset, type, flagged, cluster, q } = req.valid.query;

  const where = [];
  const params = [];

  if (type) { params.push(type); where.push(`e.entity_type = $${params.length}`); }
  if (flagged === true) where.push('e.is_flagged');
  if (flagged === false) where.push('NOT e.is_flagged');
  if (cluster) { params.push(cluster); where.push(`cl.cluster_key = $${params.length}`); }
  if (q) {
    params.push(`%${q.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`);
    where.push(`(e.value ILIKE $${params.length} OR e.label ILIKE $${params.length})`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // `total` used to be `rows.length` — the size of the page, not the size of the
  // result. A client paginating on it would stop after one page every time.
  params.push(limit, offset);
  const { rows } = await pool.query(
    `SELECT e.id, e.entity_type, e.value, e.normalized_value, e.label, e.risk_score,
            e.influence_score, e.is_flagged, cl.cluster_key,
            (SELECT count(*)::int FROM complaint_entities ce WHERE ce.entity_id = e.id) AS complaint_count,
            count(*) OVER ()::int AS total_count
       FROM entities e LEFT JOIN clusters cl ON cl.id = e.cluster_id
       ${whereSql}
      ORDER BY e.influence_score DESC, e.id
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  const total = rows[0]?.total_count ?? 0;
  res.json({
    entities: rows.map(({ total_count, ...r }) => r),
    total,
    limit,
    offset,
    has_more: offset + rows.length < total,
  });
});

const entityDetail = asyncHandler(async (req, res) => {
  const { id } = req.valid.params;

  const { rows } = await pool.query(
    `SELECT e.*, cl.cluster_key, cl.label AS cluster_label, cl.risk_level
       FROM entities e LEFT JOIN clusters cl ON cl.id = e.cluster_id
      WHERE e.id = $1`,
    [id]
  );
  const entity = rows[0];
  if (!entity) throw notFound('Entity');

  const [complaints, links, nodeId] = await Promise.all([
    pool.query(
      `SELECT c.id, c.complaint_ref, c.scam_category, c.amount_inr::float AS amount_inr,
              c.state, c.filed_at, ce.role, ce.confidence, ce.method
         FROM complaint_entities ce JOIN complaints c ON c.id = ce.complaint_id
        WHERE ce.entity_id = $1 ORDER BY c.filed_at DESC LIMIT 100`,
      [id]
    ),
    pool.query(
      `SELECT el.relationship, el.weight, el.source, el.note,
              o.id, o.entity_type, o.value, COALESCE(o.label, o.value) AS label
         FROM entity_links el
         JOIN entities o
           ON o.id = CASE WHEN el.from_entity_id = $1 THEN el.to_entity_id ELSE el.from_entity_id END
        WHERE el.from_entity_id = $1 OR el.to_entity_id = $1`,
      [id]
    ),
    graph.nodeIdForEntity(id),
  ]);

  res.json({
    entity,
    node_id: nodeId,
    complaints: complaints.rows,
    links: links.rows,
    neighbors_count: links.rows.length + complaints.rows.length,
  });
});

/**
 * GET /api/entities/:id/why — §3.1, addressed by database id.
 *
 * The Explorer holds node ids and calls `/api/graph/why/:nodeId`; a list view
 * holds a row id and calls this. Same explanation, resolved through the entity
 * table so neither surface has to know the other's identifier scheme.
 */
const entityWhy = asyncHandler(async (req, res) => {
  const { id } = req.valid.params;

  const nodeId = await graph.nodeIdForEntity(id);
  if (!nodeId) throw notFound('Entity');

  const explanation = await graph.why(nodeId);
  if (!explanation) throw notFound('Entity in the graph');

  // The count from Postgres rather than from graph edges: the graph is a cached
  // projection, and "named in 0 complaints" is the load-bearing claim of the
  // whole feature. It gets read from the source of truth.
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM complaint_entities WHERE entity_id = $1`,
    [id]
  );

  res.json({
    ...explanation,
    entity_id: id,
    appearances: {
      ...explanation.appearances,
      complaint_count: rows[0].n,
      never_named: rows[0].n === 0,
    },
    source: 'postgres',
  });
});

/** GET /api/entities/:id/osint — §3.4. Provenance is stamped by the service. */
const entityOsint = asyncHandler(async (req, res) => {
  const { id } = req.valid.params;

  const { rows } = await pool.query(
    `SELECT id, entity_type, value, normalized_value FROM entities WHERE id = $1`, [id]
  );
  const entity = rows[0];
  if (!entity) throw notFound('Entity');

  const enrichment = await osint.enrich(entity.entity_type, entity.value);

  await audit.log({
    actorId: req.user.id,
    action: 'OSINT_QUERIED',
    entityType: 'entity',
    entityId: id,
    metadata: { adapters: enrichment.results.map((r) => r.adapter), any_live: enrichment.any_live },
    ipAddress: audit.clientIp(req),
  });

  res.json(enrichment);
});

/** GET /api/osint/adapters — what exists and which are real. */
const osintAdapters = asyncHandler(async (req, res) => {
  res.json({
    adapters: osint.describe(),
    integrity_rule:
      'Every simulated adapter is marked `simulated: true` by the framework, not by the adapter. '
      + 'ARGUS demonstrates that the architecture supports OSINT fusion; it never implies a service '
      + 'was queried when it was not.',
  });
});

// ---------------------------------------------------------------------------
// Alerts / threat feed
// ---------------------------------------------------------------------------

const listAlerts = asyncHandler(async (req, res) => {
  const { limit, severity, status, rule } = req.valid.query;

  const where = [];
  const params = [];
  if (severity) { params.push(severity); where.push(`a.severity = $${params.length}`); }
  if (status) { params.push(status); where.push(`a.status = $${params.length}`); }
  if (rule) { params.push(rule); where.push(`a.rule_key = $${params.length}`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  params.push(limit);
  const [alerts, counts] = await Promise.all([
    pool.query(
      `SELECT a.id, a.severity, a.alert_type, a.title, a.details, a.status, a.created_at,
              a.rule_key, a.generated_at, a.updated_at,
              cl.cluster_key, COALESCE(e.label, e.value) AS entity_label, e.id AS entity_id,
              c.complaint_ref, c.id AS complaint_id
         FROM alerts a
         LEFT JOIN clusters cl ON cl.id = a.cluster_id
         LEFT JOIN entities e ON e.id = a.entity_id
         LEFT JOIN complaints c ON c.id = a.complaint_id
         ${whereSql}
        ORDER BY
          CASE a.severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END,
          COALESCE(a.updated_at, a.created_at) DESC
        LIMIT $${params.length}`,
      params
    ),
    pool.query(`SELECT severity, count(*)::int AS n FROM alerts WHERE status='OPEN' GROUP BY severity`),
  ]);

  const byLevel = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  counts.rows.forEach((r) => { byLevel[r.severity] = r.n; });

  res.json({ alerts: alerts.rows, counts: byLevel });
});

/**
 * GET /api/alerts/:id/explain
 *
 * The query that produced the alert, plus the row it matched. An alert an
 * investigator cannot audit is an assertion, and assertions are what this
 * system exists to replace.
 */
const explainAlert = asyncHandler(async (req, res) => {
  const { id } = req.valid.params;

  const { rows } = await pool.query(
    `SELECT id, rule_key, alert_type, title, severity, details, evidence, query_sql,
            generated_at, fingerprint
       FROM alerts WHERE id = $1`,
    [id]
  );
  const alert = rows[0];
  if (!alert) throw notFound('Alert');

  const rule = alertRules.RULES.find((r) => r.key === alert.rule_key) || null;

  res.json({
    alert,
    generated: Boolean(alert.rule_key),
    rule: rule ? { key: rule.key, title: rule.title } : null,
    query_sql: alert.query_sql,
    matched_row: alert.evidence,
    note: alert.rule_key
      ? 'This alert was produced by the query below, run against live data.'
      : 'This alert predates the rule engine and has no generating query.',
  });
});

const updateAlert = asyncHandler(async (req, res) => {
  const { id } = req.valid.params;
  const { status } = req.valid.body;

  const { rows } = await pool.query(
    `UPDATE alerts SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, status]
  );
  if (!rows[0]) throw notFound('Alert');

  await audit.log({
    actorId: req.user.id,
    action: `ALERT_${status}`,
    entityType: 'alert',
    entityId: rows[0].id,
    metadata: { title: rows[0].title },
    ipAddress: audit.clientIp(req),
  });
  res.json({ alert: rows[0] });
});

/** POST /api/alerts/regenerate — ADMIN/ANALYST. Re-runs every rule. */
const regenerateAlerts = asyncHandler(async (req, res) => {
  const started = Date.now();
  const result = await alertRules.run();

  await audit.log({
    actorId: req.user.id,
    action: 'ALERTS_REGENERATED',
    entityType: 'alert',
    metadata: { created: result.created, updated: result.updated },
    ipAddress: audit.clientIp(req),
  });

  res.json({ ...result, duration_ms: Date.now() - started });
});

/** GET /api/alerts/rules — the rule catalogue with its thresholds in the open. */
const listAlertRules = asyncHandler(async (req, res) => {
  res.json({
    rules: alertRules.describe(),
    note: 'Thresholds are declared in src/services/alertRules.js and are visible here on purpose: '
      + 'a threat feed whose triggers cannot be inspected cannot be trusted.',
  });
});

// ---------------------------------------------------------------------------
// Geo
// ---------------------------------------------------------------------------

const geoStates = asyncHandler(async (req, res) => {
  // The dominant category used to be a correlated subquery evaluated once per
  // state — a full re-aggregation of the complaints table for every row. A
  // window function computes all of them in one pass.
  const { rows } = await pool.query(
    `WITH per_state_category AS (
       SELECT state, scam_category, count(*)::int AS n,
              row_number() OVER (PARTITION BY state ORDER BY count(*) DESC, scam_category) AS rank
         FROM complaints
        WHERE state IS NOT NULL
        GROUP BY state, scam_category
     ),
     totals AS (
       SELECT state,
              count(*)::int             AS complaint_count,
              SUM(amount_inr)::float    AS total_amount_inr,
              AVG(lat)::float           AS lat,
              AVG(lon)::float           AS lon
         FROM complaints
        WHERE state IS NOT NULL
        GROUP BY state
     )
     SELECT t.state, t.complaint_count, t.total_amount_inr, t.lat, t.lon,
            d.scam_category AS dominant_category
       FROM totals t
       LEFT JOIN per_state_category d ON d.state = t.state AND d.rank = 1
      ORDER BY t.complaint_count DESC`
  );

  // Risk band is relative to the worst-hit state, so the map stays readable
  // whatever the absolute volume happens to be.
  const max = Math.max(...rows.map((r) => r.complaint_count), 1);
  res.json({
    states: rows.map((r) => ({
      ...r,
      intensity: Number((r.complaint_count / max).toFixed(3)),
      risk_level:
        r.complaint_count / max > 0.66 ? 'CRITICAL'
        : r.complaint_count / max > 0.4 ? 'HIGH'
        : r.complaint_count / max > 0.15 ? 'MEDIUM' : 'LOW',
    })),
    max_complaints: max,
    // The synthetic layer says so, in the same field the NCRB layer uses.
    provenance: 'SYNTHETIC',
  });
});

/**
 * Interstate routes: a cluster active in two states implies movement between
 * them. Derived from cluster membership, never from the victim's own location.
 */
const geoRoutes = asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `WITH cluster_states AS (
       SELECT cl.cluster_key, c.state,
              count(DISTINCT c.id)::int AS n,
              AVG(c.lat)::float AS lat,
              AVG(c.lon)::float AS lon
         FROM complaints c
         JOIN complaint_entities ce ON ce.complaint_id = c.id
         JOIN entities e ON e.id = ce.entity_id
         JOIN clusters cl ON cl.id = e.cluster_id
        WHERE c.state IS NOT NULL
        GROUP BY cl.cluster_key, c.state
     )
     SELECT a.cluster_key,
            a.state AS from_state, a.lat AS from_lat, a.lon AS from_lon,
            b.state AS to_state,   b.lat AS to_lat,   b.lon AS to_lon,
            LEAST(a.n, b.n)::int AS count
       FROM cluster_states a
       JOIN cluster_states b ON a.cluster_key = b.cluster_key AND a.state < b.state
      ORDER BY count DESC, a.cluster_key, a.state
      LIMIT 60`
  );
  res.json({ routes: rows, provenance: 'SYNTHETIC' });
});

// ---------------------------------------------------------------------------
// Money flow
// ---------------------------------------------------------------------------

/** GET /api/money/trace/:complaintId — d3-sankey shaped, ordered by hop. */
const moneyTrace = asyncHandler(async (req, res) => {
  const { complaintId } = req.valid.params;

  const { rows } = await pool.query(
    `SELECT t.hop_index, t.amount_inr::float AS amount, t.rail, t.reference, t.occurred_at,
            f.id AS from_id, f.entity_type AS from_type, f.normalized_value AS from_norm,
            COALESCE(f.label, f.value) AS from_label,
            o.id AS to_id, o.entity_type AS to_type, o.normalized_value AS to_norm,
            COALESCE(o.label, o.value) AS to_label
       FROM transactions t
       JOIN entities f ON f.id = t.from_entity_id
       JOIN entities o ON o.id = t.to_entity_id
      WHERE t.complaint_id = $1
      ORDER BY t.hop_index ASC, t.id ASC`,
    [complaintId]
  );

  if (!rows.length) return res.json({ nodes: [], links: [], summary: null });

  const nodes = new Map();
  const nid = (type, norm) => `${String(type).toLowerCase()}:${norm}`;
  const addNode = (type, norm, label, hop, role) => {
    const id = nid(type, norm);
    const existing = nodes.get(id);
    if (!existing) nodes.set(id, { id, label, type, hop, role });
    else existing.hop = Math.min(existing.hop, hop);
    return id;
  };

  const lastHop = rows[rows.length - 1].hop_index;
  const links = rows.map((r) => {
    const isLast = r.hop_index === lastHop;
    const source = addNode(r.from_type, r.from_norm, r.from_label, r.hop_index,
      r.hop_index === 0 ? 'VICTIM' : 'INTERMEDIARY');
    const target = addNode(r.to_type, r.to_norm, r.to_label, r.hop_index + 1,
      isLast ? 'TERMINAL' : 'INTERMEDIARY');
    return {
      source, target, value: r.amount, rail: r.rail,
      reference: r.reference, hop: r.hop_index,
    };
  });

  const ordered = [...nodes.values()].sort((a, b) => a.hop - b.hop);
  const terminal = ordered[ordered.length - 1];

  // Leakage is what the chain absorbed between the victim's payment and the
  // final hop — commission taken at each step. Computed from the first and last
  // hop AMOUNTS, both of which are read by hop index rather than array position,
  // because a complaint may carry more than one branch.
  const firstHopTotal = rows.filter((r) => r.hop_index === 0)
    .reduce((sum, r) => sum + r.amount, 0);
  const lastHopTotal = rows.filter((r) => r.hop_index === lastHop)
    .reduce((sum, r) => sum + r.amount, 0);

  res.json({
    nodes: ordered,
    links,
    summary: {
      total_inr: firstHopTotal,
      hops: lastHop + 1,
      terminal_type: terminal?.type || null,
      terminal_label: terminal?.label || null,
      leakage_inr: Math.round(firstHopTotal - lastHopTotal),
    },
  });
});

// ---------------------------------------------------------------------------
// Timeline / audit
// ---------------------------------------------------------------------------

const timeline = asyncHandler(async (req, res) => {
  const { limit, offset, action, actor_id } = req.valid.query;

  const where = [];
  const params = [];
  if (action) { params.push(action); where.push(`a.action = $${params.length}`); }
  if (actor_id) { params.push(actor_id); where.push(`a.actor_id = $${params.length}`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  params.push(limit, offset);
  const { rows } = await pool.query(
    `SELECT a.id, a.action, a.entity_type, a.entity_id, a.metadata, a.ip_address, a.created_at,
            u.full_name AS actor_name, u.role AS actor_role,
            count(*) OVER ()::int AS total_count
       FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
       ${whereSql}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  const total = rows[0]?.total_count ?? 0;
  res.json({
    events: rows.map(({ total_count, ...r }) => r),
    total,
    limit,
    offset,
    has_more: offset + rows.length < total,
  });
});

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

const adminUsers = asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.full_name, u.role, u.rank_title, u.is_active, u.created_at,
            un.code AS unit_code, un.name AS unit_name
       FROM users u LEFT JOIN units un ON un.id = u.unit_id
      ORDER BY u.id`
  );
  res.json({ users: rows });
});

/** Live status of all four components — the Admin page's service board. */
const adminHealth = asyncHandler(async (req, res) => {
  let postgres;
  try {
    const r = await pool.query('SELECT count(*)::int AS n FROM complaints');
    postgres = {
      ok: true,
      detail: `${r.rows[0].n} complaints`,
      pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
    };
  } catch (e) {
    postgres = { ok: false, detail: e.message };
  }

  const intelHealth = await intel.health();
  const chainStatus = chain.status();

  const { rows: refRows } = await pool
    .query(`SELECT count(*)::int AS n, max(year) AS to_year FROM crime_reference`)
    .catch(() => ({ rows: [{ n: 0, to_year: null }] }));

  res.json({
    postgres,
    intel: {
      ok: intelHealth.ok,
      circuit: intelHealth.circuit,
      detail: intelHealth.ok
        ? `neo4j ${intelHealth.data?.neo4j_connected ? 'connected' : 'disconnected'}, ${intelHealth.data?.node_count ?? '?'} nodes`
        : intelHealth.reason,
    },
    neo4j: {
      ok: Boolean(intelHealth.ok && intelHealth.data?.neo4j_connected),
      detail: intelHealth.ok
        ? (intelHealth.data?.neo4j_connected ? 'reachable via intel-service' : 'intel-service cannot reach Neo4j')
        : 'unknown — intel-service is down',
    },
    chain: {
      ok: chainStatus.ready,
      detail: chainStatus.ready
        ? `${chainStatus.network} @ ${chainStatus.contractAddress}`
        : chainStatus.reason,
    },
    reference_data: {
      ok: refRows[0].n > 0,
      detail: refRows[0].n > 0
        ? `${refRows[0].n} NCRB rows loaded, through ${refRows[0].to_year}`
        : 'not loaded — run npm run load-reference',
    },
  });
});

module.exports = {
  listClusters, clusterDetail, runAnalytics,
  listEntities, entityDetail, entityWhy, entityOsint, osintAdapters,
  listAlerts, updateAlert, explainAlert, regenerateAlerts, listAlertRules,
  geoStates, geoRoutes,
  moneyTrace,
  timeline,
  adminUsers, adminHealth,
};
