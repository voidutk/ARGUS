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

// ---------------------------------------------------------------------------
// Clusters
// ---------------------------------------------------------------------------

async function listClusters(req, res, next) {
  try {
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
  } catch (err) { next(err); }
}

async function clusterDetail(req, res, next) {
  try {
    const key = String(req.params.key).toUpperCase();
    const { rows } = await pool.query(
      `SELECT cl.*, cl.total_amount_inr::float AS total_amount_inr,
              me.id AS mastermind_id, COALESCE(me.label, me.value) AS mastermind_label,
              me.entity_type AS mastermind_type, me.influence_score AS mastermind_influence
         FROM clusters cl LEFT JOIN entities me ON me.id = cl.mastermind_entity_id
        WHERE cl.cluster_key = $1`,
      [key]
    );
    const cluster = rows[0];
    if (!cluster) return res.status(404).json({ error: 'Unknown cluster' });

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
        ? { id: cluster.mastermind_id, label: cluster.mastermind_label,
            type: cluster.mastermind_type, influence: cluster.mastermind_influence }
        : null,
      top_entities: topEntities.rows,
      complaints: complaints.rows,
      states: states.rows,
    });
  } catch (err) { next(err); }
}

/** ADMIN only — recompute communities, influence and risk. */
async function runAnalytics(req, res, next) {
  try {
    const started = Date.now();
    const live = await intel.runAnalytics();
    graph.invalidate();

    await audit.log({
      actorId: req.user.id, action: 'CLUSTER_COMPUTED', entityType: 'cluster',
      metadata: { intel_ok: live.ok, reason: live.reason || null },
      ipAddress: audit.clientIp(req),
    });

    if (!live.ok) {
      // Express recomputes influence itself on the fallback path, so the
      // Explorer still shows fresh scores — just not Neo4j-backed Louvain.
      const g = await graph.load({ force: true });
      return res.status(202).json({
        source: 'postgres-fallback',
        reason: live.reason,
        nodes_scored: g.nodes.size,
        duration_ms: Date.now() - started,
      });
    }
    res.json({ ...live.data, source: 'intel-service', duration_ms: Date.now() - started });
  } catch (err) { next(err); }
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

async function listEntities(req, res, next) {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const { type, flagged, cluster, q } = req.query;
    const where = [];
    const params = [];

    if (type) { params.push(type); where.push(`e.entity_type = $${params.length}`); }
    if (flagged === 'true') where.push('e.is_flagged');
    if (cluster) { params.push(String(cluster).toUpperCase()); where.push(`cl.cluster_key = $${params.length}`); }
    if (q) { params.push(`%${q}%`); where.push(`(e.value ILIKE $${params.length} OR e.label ILIKE $${params.length})`); }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT e.id, e.entity_type, e.value, e.normalized_value, e.label, e.risk_score,
              e.influence_score, e.is_flagged, cl.cluster_key,
              (SELECT count(*)::int FROM complaint_entities ce WHERE ce.entity_id = e.id) AS complaint_count
         FROM entities e LEFT JOIN clusters cl ON cl.id = e.cluster_id
         ${whereSql}
        ORDER BY e.influence_score DESC, complaint_count DESC
        LIMIT $${params.length}`,
      params
    );
    res.json({ entities: rows, total: rows.length });
  } catch (err) { next(err); }
}

async function entityDetail(req, res, next) {
  try {
    const id = Number(req.params.id);
    const { rows } = await pool.query(
      `SELECT e.*, cl.cluster_key, cl.label AS cluster_label, cl.risk_level
         FROM entities e LEFT JOIN clusters cl ON cl.id = e.cluster_id
        WHERE e.id = $1`,
      [id]
    );
    const entity = rows[0];
    if (!entity) return res.status(404).json({ error: 'Entity not found' });

    const [complaints, links] = await Promise.all([
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
           JOIN entities o ON o.id = CASE WHEN el.from_entity_id = $1 THEN el.to_entity_id ELSE el.from_entity_id END
          WHERE el.from_entity_id = $1 OR el.to_entity_id = $1`,
        [id]
      ),
    ]);

    res.json({
      entity,
      node_id: await graph.nodeIdForEntity(id),
      complaints: complaints.rows,
      links: links.rows,
      neighbors_count: links.rows.length + complaints.rows.length,
    });
  } catch (err) { next(err); }
}

// ---------------------------------------------------------------------------
// Alerts / threat feed
// ---------------------------------------------------------------------------

async function listAlerts(req, res, next) {
  try {
    const limit = Math.min(Number(req.query.limit) || 40, 200);
    const { severity, status } = req.query;
    const where = [];
    const params = [];
    if (severity) { params.push(severity); where.push(`a.severity = $${params.length}`); }
    if (status) { params.push(status); where.push(`a.status = $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    params.push(limit);
    const [alerts, counts] = await Promise.all([
      pool.query(
        `SELECT a.id, a.severity, a.alert_type, a.title, a.details, a.status, a.created_at,
                cl.cluster_key, COALESCE(e.label, e.value) AS entity_label, e.id AS entity_id,
                c.complaint_ref
           FROM alerts a
           LEFT JOIN clusters cl ON cl.id = a.cluster_id
           LEFT JOIN entities e ON e.id = a.entity_id
           LEFT JOIN complaints c ON c.id = a.complaint_id
           ${whereSql}
          ORDER BY
            CASE a.severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END,
            a.created_at DESC
          LIMIT $${params.length}`,
        params
      ),
      pool.query(
        `SELECT severity, count(*)::int AS n FROM alerts WHERE status='OPEN' GROUP BY severity`
      ),
    ]);

    const byLevel = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
    counts.rows.forEach((r) => { byLevel[r.severity] = r.n; });

    res.json({ alerts: alerts.rows, counts: byLevel });
  } catch (err) { next(err); }
}

async function updateAlert(req, res, next) {
  try {
    const { status } = req.body;
    if (!['OPEN', 'ACKNOWLEDGED', 'RESOLVED'].includes(status)) {
      return res.status(400).json({ error: 'status must be OPEN, ACKNOWLEDGED or RESOLVED' });
    }
    const { rows } = await pool.query(
      `UPDATE alerts SET status = $2 WHERE id = $1 RETURNING *`,
      [Number(req.params.id), status]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Alert not found' });

    await audit.log({
      actorId: req.user.id, action: `ALERT_${status}`, entityType: 'alert',
      entityId: rows[0].id, metadata: { title: rows[0].title }, ipAddress: audit.clientIp(req),
    });
    res.json({ alert: rows[0] });
  } catch (err) { next(err); }
}

// ---------------------------------------------------------------------------
// Geo
// ---------------------------------------------------------------------------

async function geoStates(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT c.state,
              count(*)::int AS complaint_count,
              SUM(c.amount_inr)::float AS total_amount_inr,
              (SELECT c2.scam_category FROM complaints c2
                WHERE c2.state = c.state GROUP BY c2.scam_category
                ORDER BY count(*) DESC LIMIT 1) AS dominant_category,
              AVG(c.lat)::float AS lat, AVG(c.lon)::float AS lon
         FROM complaints c
        WHERE c.state IS NOT NULL
        GROUP BY c.state ORDER BY complaint_count DESC`
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
    });
  } catch (err) { next(err); }
}

/**
 * Interstate routes: a cluster active in two states implies movement between
 * them. Derived from cluster membership, never from the victim's own location.
 */
async function geoRoutes(req, res, next) {
  try {
    const { rows } = await pool.query(
      `WITH cluster_states AS (
         SELECT DISTINCT cl.cluster_key, c.state,
                AVG(c.lat) OVER (PARTITION BY c.state) AS lat,
                AVG(c.lon) OVER (PARTITION BY c.state) AS lon,
                count(*) OVER (PARTITION BY cl.cluster_key, c.state) AS n
           FROM complaints c
           JOIN complaint_entities ce ON ce.complaint_id = c.id
           JOIN entities e ON e.id = ce.entity_id
           JOIN clusters cl ON cl.id = e.cluster_id
          WHERE c.state IS NOT NULL
       )
       SELECT a.cluster_key, a.state AS from_state, a.lat AS from_lat, a.lon AS from_lon,
              b.state AS to_state, b.lat AS to_lat, b.lon AS to_lon,
              LEAST(a.n, b.n)::int AS count
         FROM cluster_states a JOIN cluster_states b
           ON a.cluster_key = b.cluster_key AND a.state < b.state
        ORDER BY count DESC LIMIT 60`
    );
    res.json({ routes: rows });
  } catch (err) { next(err); }
}

// ---------------------------------------------------------------------------
// Money flow
// ---------------------------------------------------------------------------

/** GET /api/money/trace/:complaintId — d3-sankey shaped, ordered by hop. */
async function moneyTrace(req, res, next) {
  try {
    const complaintId = Number(req.params.complaintId);
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
        ORDER BY t.hop_index ASC`,
      [complaintId]
    );

    if (!rows.length) return res.json({ nodes: [], links: [], summary: null });

    const nodes = new Map();
    const nid = (type, norm) => `${String(type).toLowerCase()}:${norm}`;
    const addNode = (type, norm, label, hop, role) => {
      const id = nid(type, norm);
      if (!nodes.has(id)) nodes.set(id, { id, label, type, hop, role });
      else nodes.get(id).hop = Math.min(nodes.get(id).hop, hop);
      return id;
    };

    const links = rows.map((r) => {
      const roleFor = (t, isLast) =>
        r.hop_index === 0 && t === 'from' ? 'VICTIM'
        : isLast ? 'TERMINAL'
        : 'INTERMEDIARY';
      const isLast = r.hop_index === rows[rows.length - 1].hop_index;
      const s = addNode(r.from_type, r.from_norm, r.from_label, r.hop_index, roleFor('from', false));
      const t = addNode(r.to_type, r.to_norm, r.to_label, r.hop_index + 1, roleFor('to', isLast));
      return { source: s, target: t, value: r.amount, rail: r.rail, reference: r.reference, hop: r.hop_index };
    });

    const terminal = [...nodes.values()].sort((a, b) => b.hop - a.hop)[0];
    res.json({
      nodes: [...nodes.values()].sort((a, b) => a.hop - b.hop),
      links,
      summary: {
        total_inr: rows[0].amount,
        hops: rows.length,
        terminal_type: terminal?.type || null,
        terminal_label: terminal?.label || null,
        leakage_inr: Math.round(rows[0].amount - rows[rows.length - 1].amount),
      },
    });
  } catch (err) { next(err); }
}

// ---------------------------------------------------------------------------
// Timeline / audit
// ---------------------------------------------------------------------------

async function timeline(req, res, next) {
  try {
    const limit = Math.min(Number(req.query.limit) || 80, 300);
    const { rows } = await pool.query(
      `SELECT a.id, a.action, a.entity_type, a.entity_id, a.metadata, a.ip_address, a.created_at,
              u.full_name AS actor_name, u.role AS actor_role
         FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
        ORDER BY a.created_at DESC LIMIT $1`,
      [limit]
    );
    res.json({ events: rows });
  } catch (err) { next(err); }
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

async function adminUsers(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.full_name, u.role, u.rank_title, u.is_active, u.created_at,
              un.code AS unit_code, un.name AS unit_name
         FROM users u LEFT JOIN units un ON un.id = u.unit_id
        ORDER BY u.id`
    );
    res.json({ users: rows });
  } catch (err) { next(err); }
}

/** Live status of all four components — the Admin page's service board. */
async function adminHealth(req, res, next) {
  try {
    const chain = require('../services/chainService');
    let postgres = { ok: false, detail: 'unknown' };
    try {
      const r = await pool.query('SELECT count(*)::int AS n FROM complaints');
      postgres = { ok: true, detail: `${r.rows[0].n} complaints` };
    } catch (e) { postgres = { ok: false, detail: e.message }; }

    const intelHealth = await intel.health();
    const chainStatus = chain.status();

    res.json({
      postgres,
      intel: {
        ok: intelHealth.ok,
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
      chain: { ok: chainStatus.ready, detail: chainStatus.ready
        ? `${chainStatus.network} @ ${chainStatus.contractAddress}` : chainStatus.reason },
    });
  } catch (err) { next(err); }
}

module.exports = {
  listClusters, clusterDetail, runAnalytics,
  listEntities, entityDetail,
  listAlerts, updateAlert,
  geoStates, geoRoutes,
  moneyTrace,
  timeline,
  adminUsers, adminHealth,
};
