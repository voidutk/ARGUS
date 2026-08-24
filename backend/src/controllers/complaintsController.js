const pool = require('../db/pool');
const intel = require('../services/intelClient');
const graph = require('../services/graphService');
const audit = require('../services/auditService');
const alertRules = require('../services/alertRules');
const { normalize } = require('../services/normalize');
const { asyncHandler, notFound } = require('../lib/errors');
const logger = require('../lib/logger');

/** GET /api/complaints */
const list = asyncHandler(async (req, res) => {
  const { limit, offset, state, category, cluster, status, q } = req.valid.query;

  const where = [];
  const params = [];
  const add = (sql, val) => { params.push(val); where.push(sql.replace('?', `$${params.length}`)); };

  if (state) add('c.state = ?', state);
  if (category) add('c.scam_category = ?', category);
  if (status) add('c.status = ?', status);
  if (q) {
    // One bound value, three placeholders — built explicitly rather than through
    // `add`, which only substitutes a single `?`. `%` and `_` in the search text
    // are escaped so a user typing "50%" searches for that, not for everything.
    params.push(`%${q.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`);
    const p = `$${params.length}`;
    where.push(`(c.complaint_ref ILIKE ${p} OR c.victim_name ILIKE ${p} OR c.narrative ILIKE ${p})`);
  }
  if (cluster) {
    params.push(cluster);
    where.push(`EXISTS (
      SELECT 1 FROM complaint_entities ce
        JOIN entities e ON e.id = ce.entity_id
        JOIN clusters cl ON cl.id = e.cluster_id
       WHERE ce.complaint_id = c.id AND cl.cluster_key = $${params.length})`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // Count and page in one round trip. Two queries would be two chances for the
  // set to change between them, which is how a paginated list ends up claiming
  // 220 results and rendering 219.
  params.push(limit, offset);
  const { rows } = await pool.query(
    `WITH filtered AS (SELECT c.* FROM complaints c ${whereSql})
     SELECT f.id, f.complaint_ref, f.victim_name, f.scam_category, f.amount_inr::float AS amount_inr,
            f.state, f.district, f.status, f.filed_at,
            (SELECT count(*)::int FROM complaint_entities ce WHERE ce.complaint_id = f.id) AS entity_count,
            count(*) OVER ()::int AS total_count
       FROM filtered f
      ORDER BY f.filed_at DESC, f.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  const total = rows[0]?.total_count ?? 0;
  res.json({
    complaints: rows.map(({ total_count, ...r }) => r),
    total,
    limit,
    offset,
    has_more: offset + rows.length < total,
  });
});

/**
 * GET /api/complaints/:id
 * Returns the complaint, its extracted entities, and every OTHER complaint that
 * shares an entity with it — which is the entire reason this page exists.
 */
const detail = asyncHandler(async (req, res) => {
  const { id } = req.valid.params;

  const { rows } = await pool.query(
    `SELECT c.*, c.amount_inr::float AS amount_inr FROM complaints c WHERE c.id = $1`,
    [id]
  );
  const complaint = rows[0];
  if (!complaint) throw notFound('Complaint');

  const [entities, linked, clusterQ] = await Promise.all([
    pool.query(
      `SELECT e.id, e.entity_type, e.value, e.normalized_value, e.label,
              e.risk_score, e.influence_score, e.is_flagged,
              ce.role, ce.confidence, ce.method, ce.context_snippet,
              cl.cluster_key, cl.label AS cluster_label
         FROM complaint_entities ce
         JOIN entities e ON e.id = ce.entity_id
         LEFT JOIN clusters cl ON cl.id = e.cluster_id
        WHERE ce.complaint_id = $1
        ORDER BY e.is_flagged DESC, e.influence_score DESC, e.id`,
      [id]
    ),
    // Linked complaints, ranked by how many entities they share. Victim-side
    // entities are excluded: two complaints are not related because both
    // victims have phone numbers.
    pool.query(
      `SELECT c2.id AS complaint_id, c2.complaint_ref, c2.scam_category, c2.state,
              c2.amount_inr::float AS amount_inr, c2.filed_at,
              count(DISTINCT e.id)::int AS shared_count,
              array_agg(DISTINCT e.entity_type) AS shared_types,
              array_agg(DISTINCT COALESCE(e.label, e.value)) AS shared_values
         FROM complaint_entities ce1
         JOIN complaint_entities ce2
           ON ce2.entity_id = ce1.entity_id AND ce2.complaint_id <> ce1.complaint_id
         JOIN entities e ON e.id = ce1.entity_id
         JOIN complaints c2 ON c2.id = ce2.complaint_id
        WHERE ce1.complaint_id = $1 AND ce1.role <> 'VICTIM' AND ce2.role <> 'VICTIM'
        GROUP BY c2.id, c2.complaint_ref, c2.scam_category, c2.state, c2.amount_inr, c2.filed_at
        ORDER BY shared_count DESC, c2.filed_at DESC
        LIMIT 60`,
      [id]
    ),
    pool.query(
      `SELECT cl.cluster_key, cl.label, cl.risk_level, cl.risk_score, cl.complaint_count,
              cl.total_amount_inr::float AS total_amount_inr, cl.states_touched,
              me.id AS mastermind_id, COALESCE(me.label, me.value) AS mastermind_label
         FROM complaint_entities ce
         JOIN entities e ON e.id = ce.entity_id
         JOIN clusters cl ON cl.id = e.cluster_id
         LEFT JOIN entities me ON me.id = cl.mastermind_entity_id
        WHERE ce.complaint_id = $1
        GROUP BY cl.id, cl.cluster_key, cl.label, cl.risk_level, cl.risk_score,
                 cl.complaint_count, cl.total_amount_inr, cl.states_touched, me.id, me.label, me.value
        ORDER BY count(*) DESC LIMIT 1`,
      [id]
    ),
  ]);

  res.json({
    complaint,
    entities: entities.rows,
    linked: linked.rows,
    cluster: clusterQ.rows[0] || null,
  });
});

/**
 * Allocates the next complaint reference.
 *
 * A `SELECT max(...) + 1` is a race: two intakes reading the same maximum both
 * build the same reference and one loses to the UNIQUE constraint. A sequence
 * cannot race — `nextval` is atomic and never hands the same number to two
 * callers, even in concurrent transactions, even if one of them rolls back.
 *
 * The year comes from the row's own timestamp rather than a literal, so this
 * keeps working on the 1st of January without anyone remembering to edit it.
 */
async function nextRef(client) {
  const { rows } = await client.query(
    `SELECT 'NCRP-' || to_char(now(), 'YYYY') || '-'
            || LPAD(nextval('complaint_ref_seq')::text, 6, '0') AS ref`
  );
  return rows[0].ref;
}

/**
 * POST /api/complaints — the live moment of the demo (§T scene 2).
 *
 * Synchronous on purpose: file → extract → canonicalise → link → answer, all in
 * one request, so the investigator sees entities appear and the graph redraw
 * without a polling spinner. It must stay under ~3s.
 *
 * If intel-service is down the complaint is STILL filed. It just arrives with
 * no extracted entities and `extraction.available = false`, and can be
 * re-extracted later. Losing a citizen's complaint because an AI service was
 * restarting would be indefensible.
 */
const create = asyncHandler(async (req, res) => {
  const body = req.valid.body;

  // Extraction happens BEFORE the transaction opens. It is a network call to an
  // optional service with an 8-second ceiling, and holding a pooled connection
  // and row locks across it would let a slow AI service exhaust the pool.
  const startedAt = Date.now();
  const extraction = await intel.extract(body.narrative);
  const extractionMs = Date.now() - startedAt;

  const { complaint, linkedEntities } = await pool.withTransaction(async (client) => {
    const ref = await nextRef(client);

    const ins = await client.query(
      `INSERT INTO complaints (complaint_ref, victim_name, victim_phone, victim_email, narrative,
                               scam_category, amount_inr, state, district, lat, lon, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'NEW')
       RETURNING *, amount_inr::float AS amount_inr`,
      [ref, body.victim_name, body.victim_phone, body.victim_email, body.narrative,
        body.scam_category, body.amount_inr, body.state, body.district, body.lat, body.lon]
    );
    const row = ins.rows[0];

    // Victim identifiers are always linked, extraction or not.
    const found = [];
    if (body.victim_phone) {
      found.push({ type: 'PHONE', value: body.victim_phone, role: 'VICTIM', confidence: 1, method: 'MANUAL' });
    }
    if (body.victim_email) {
      found.push({ type: 'EMAIL', value: body.victim_email, role: 'VICTIM', confidence: 1, method: 'MANUAL' });
    }

    if (extraction.ok) {
      for (const e of extraction.data?.entities || []) {
        if (!e || !e.type || !e.value) continue;
        found.push({
          type: e.type,
          value: String(e.value).slice(0, 255),
          role: 'SUSPECT',
          confidence: Number.isFinite(e.confidence) ? e.confidence : 0.9,
          method: ['REGEX', 'NER', 'MANUAL'].includes(e.method) ? e.method : 'REGEX',
          snippet: e.context_snippet ? String(e.context_snippet).slice(0, 500) : null,
        });
      }
    }

    const entities = [];
    const seen = new Set();
    for (const f of found) {
      const norm = normalize(f.type, f.value);
      // A victim phone the extractor also found in the narrative would otherwise
      // be inserted twice — once as VICTIM, once as SUSPECT — and the victim
      // would appear as a suspect inside their own criminal network.
      if (!norm || seen.has(`${f.type}:${norm}`)) continue;
      seen.add(`${f.type}:${norm}`);

      const up = await client.query(
        `INSERT INTO entities (entity_type, value, normalized_value, last_seen)
         VALUES ($1,$2,$3, now())
         ON CONFLICT (entity_type, normalized_value)
           DO UPDATE SET last_seen = now()
         RETURNING id, entity_type, value, normalized_value, label, cluster_id,
                   risk_score, influence_score, is_flagged`,
        [f.type, f.value, norm]
      );
      const ent = up.rows[0];

      await client.query(
        `INSERT INTO complaint_entities (complaint_id, entity_id, role, confidence, method, context_snippet)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (complaint_id, entity_id, role) DO NOTHING`,
        [row.id, ent.id, f.role, f.confidence, f.method, f.snippet || null]
      );
      entities.push({ ...ent, role: f.role, confidence: f.confidence, method: f.method });
    }

    return { complaint: row, linkedEntities: entities };
  });

  // Reads that describe what the insert just did. Outside the transaction: they
  // are reporting, and holding a write transaction open for them would mean
  // holding locks in order to render a response.
  const [linkQ, clusterQ] = await Promise.all([
    pool.query(
      `SELECT count(DISTINCT ce2.complaint_id)::int AS n
         FROM complaint_entities ce1
         JOIN complaint_entities ce2
           ON ce2.entity_id = ce1.entity_id AND ce2.complaint_id <> ce1.complaint_id
        WHERE ce1.complaint_id = $1 AND ce1.role <> 'VICTIM' AND ce2.role <> 'VICTIM'`,
      [complaint.id]
    ),
    pool.query(
      `SELECT cl.cluster_key, cl.label, cl.risk_level
         FROM complaint_entities ce
         JOIN entities e ON e.id = ce.entity_id
         JOIN clusters cl ON cl.id = e.cluster_id
        WHERE ce.complaint_id = $1
        GROUP BY cl.id, cl.cluster_key, cl.label, cl.risk_level
        ORDER BY count(*) DESC LIMIT 1`,
      [complaint.id]
    ),
  ]);

  graph.invalidate();

  // Both are fire-and-forget by design: the complaint is already durable in
  // Postgres, and neither the Neo4j mirror nor the threat feed is allowed to
  // delay the investigator's answer or fail their intake.
  intel.ingest({ complaint, entities: linkedEntities })
    .catch((err) => logger.warn({ err: err.message }, 'neo4j ingest failed for new complaint'));
  alertRules.onComplaintFiled(complaint.id)
    .catch((err) => logger.warn({ err: err.message }, 'alert rules failed for new complaint'));

  await audit.log({
    actorId: req.user.id,
    action: 'COMPLAINT_RECEIVED',
    entityType: 'complaint',
    entityId: complaint.id,
    metadata: { ref: complaint.complaint_ref, extracted: linkedEntities.length, linked: linkQ.rows[0].n },
    ipAddress: audit.clientIp(req),
  });

  res.status(201).json({
    complaint,
    entities: linkedEntities,
    linked_count: linkQ.rows[0].n,
    cluster: clusterQ.rows[0] || null,
    extraction: {
      available: extraction.ok,
      reason: extraction.ok ? null : extraction.reason,
      count: linkedEntities.length,
      duration_ms: extractionMs,
    },
  });
});

/** PATCH /api/complaints/:id — triage. Status is the only mutable field. */
const updateStatus = asyncHandler(async (req, res) => {
  const { id } = req.valid.params;
  const { status } = req.valid.body;

  const { rows } = await pool.query(
    `UPDATE complaints SET status = $2 WHERE id = $1
     RETURNING id, complaint_ref, status`,
    [id, status]
  );
  if (!rows[0]) throw notFound('Complaint');

  await audit.log({
    actorId: req.user.id,
    action: 'COMPLAINT_STATUS_CHANGED',
    entityType: 'complaint',
    entityId: id,
    metadata: { status, ref: rows[0].complaint_ref },
    ipAddress: audit.clientIp(req),
  });
  res.json({ complaint: rows[0] });
});

module.exports = { list, detail, create, updateStatus };
