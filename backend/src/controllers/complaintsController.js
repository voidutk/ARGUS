const pool = require('../db/pool');
const intel = require('../services/intelClient');
const graph = require('../services/graphService');
const audit = require('../services/auditService');
const { normalize } = require('../services/normalize');

/** GET /api/complaints */
async function list(req, res, next) {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;
    const { state, category, cluster, status, q } = req.query;

    const where = [];
    const params = [];
    const add = (sql, val) => { params.push(val); where.push(sql.replace('?', `$${params.length}`)); };

    if (state) add('c.state = ?', state);
    if (category) add('c.scam_category = ?', category);
    if (status) add('c.status = ?', status);
    if (q) {
      // One bound value, three placeholders — build it explicitly rather than
      // through `add`, which only substitutes a single `?`.
      params.push(`%${q}%`);
      const p = `$${params.length}`;
      where.push(`(c.complaint_ref ILIKE ${p} OR c.victim_name ILIKE ${p} OR c.narrative ILIKE ${p})`);
    }
    if (cluster) {
      params.push(String(cluster).toUpperCase());
      where.push(`EXISTS (
        SELECT 1 FROM complaint_entities ce
          JOIN entities e ON e.id = ce.entity_id
          JOIN clusters cl ON cl.id = e.cluster_id
         WHERE ce.complaint_id = c.id AND cl.cluster_key = $${params.length})`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const totalQ = await pool.query(`SELECT count(*)::int AS n FROM complaints c ${whereSql}`, params);

    params.push(limit, offset);
    const { rows } = await pool.query(
      `SELECT c.id, c.complaint_ref, c.victim_name, c.scam_category, c.amount_inr,
              c.state, c.district, c.status, c.filed_at,
              (SELECT count(*)::int FROM complaint_entities ce WHERE ce.complaint_id = c.id) AS entity_count
         FROM complaints c ${whereSql}
        ORDER BY c.filed_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({
      complaints: rows.map((r) => ({ ...r, amount_inr: Number(r.amount_inr) })),
      total: totalQ.rows[0].n,
      limit, offset,
    });
  } catch (err) { next(err); }
}

/**
 * GET /api/complaints/:id
 * Returns the complaint, its extracted entities, and every OTHER complaint that
 * shares an entity with it — which is the entire reason this page exists.
 */
async function detail(req, res, next) {
  try {
    const id = Number(req.params.id);
    const { rows } = await pool.query(`SELECT * FROM complaints WHERE id = $1`, [id]);
    const complaint = rows[0];
    if (!complaint) return res.status(404).json({ error: 'Complaint not found' });

    const entities = await pool.query(
      `SELECT e.id, e.entity_type, e.value, e.normalized_value, e.label,
              e.risk_score, e.influence_score, e.is_flagged,
              ce.role, ce.confidence, ce.method, ce.context_snippet,
              cl.cluster_key, cl.label AS cluster_label
         FROM complaint_entities ce
         JOIN entities e ON e.id = ce.entity_id
         LEFT JOIN clusters cl ON cl.id = e.cluster_id
        WHERE ce.complaint_id = $1
        ORDER BY e.is_flagged DESC, e.influence_score DESC`,
      [id]
    );

    // Linked complaints, ranked by how many entities they share. Victim-side
    // entities are excluded: two complaints are not related because both
    // victims have phone numbers.
    const linked = await pool.query(
      `SELECT c2.id AS complaint_id, c2.complaint_ref, c2.scam_category, c2.state,
              c2.amount_inr, c2.filed_at,
              count(*)::int AS shared_count,
              array_agg(DISTINCT e.entity_type) AS shared_types,
              array_agg(DISTINCT COALESCE(e.label, e.value)) AS shared_values
         FROM complaint_entities ce1
         JOIN complaint_entities ce2 ON ce2.entity_id = ce1.entity_id AND ce2.complaint_id <> ce1.complaint_id
         JOIN entities e ON e.id = ce1.entity_id
         JOIN complaints c2 ON c2.id = ce2.complaint_id
        WHERE ce1.complaint_id = $1 AND ce1.role <> 'VICTIM' AND ce2.role <> 'VICTIM'
        GROUP BY c2.id, c2.complaint_ref, c2.scam_category, c2.state, c2.amount_inr, c2.filed_at
        ORDER BY shared_count DESC, c2.filed_at DESC
        LIMIT 60`,
      [id]
    );

    const clusterQ = await pool.query(
      `SELECT cl.cluster_key, cl.label, cl.risk_level, cl.risk_score, cl.complaint_count,
              cl.total_amount_inr, cl.states_touched,
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
    );

    res.json({
      complaint: { ...complaint, amount_inr: Number(complaint.amount_inr) },
      entities: entities.rows,
      linked: linked.rows.map((r) => ({ ...r, amount_inr: Number(r.amount_inr) })),
      cluster: clusterQ.rows[0] || null,
    });
  } catch (err) { next(err); }
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
async function create(req, res, next) {
  const client = await pool.connect();
  try {
    const {
      victim_name, victim_phone, victim_email, narrative,
      scam_category = 'OTHER', amount_inr = 0, state, district, lat, lon,
    } = req.body;

    if (!victim_name || !narrative) {
      return res.status(400).json({ error: 'victim_name and narrative are required' });
    }

    const extraction = await intel.extract(narrative);

    await client.query('BEGIN');

    const refQ = await client.query(
      `SELECT 'NCRP-2026-' || LPAD((COALESCE(MAX(SUBSTRING(complaint_ref FROM 11)::int), 0) + 1)::text, 6, '0') AS ref
         FROM complaints WHERE complaint_ref LIKE 'NCRP-2026-%'`
    );

    const ins = await client.query(
      `INSERT INTO complaints (complaint_ref, victim_name, victim_phone, victim_email, narrative,
                               scam_category, amount_inr, state, district, lat, lon, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'NEW') RETURNING *`,
      [refQ.rows[0].ref, victim_name, victim_phone || null, victim_email || null, narrative,
       scam_category, amount_inr, state || null, district || null, lat || null, lon || null]
    );
    const complaint = ins.rows[0];

    // Victim identifiers are always linked, extraction or not.
    const found = [];
    if (victim_phone) found.push({ type: 'PHONE', value: victim_phone, role: 'VICTIM', confidence: 1, method: 'MANUAL' });
    if (victim_email) found.push({ type: 'EMAIL', value: victim_email, role: 'VICTIM', confidence: 1, method: 'MANUAL' });

    if (extraction.ok) {
      for (const e of extraction.data.entities || []) {
        found.push({
          type: e.type, value: e.value, role: 'SUSPECT',
          confidence: e.confidence ?? 0.9, method: e.method || 'REGEX',
          snippet: e.context_snippet || null,
        });
      }
    }

    const linkedEntities = [];
    for (const f of found) {
      const norm = f.normalized_value || normalize(f.type, f.value);
      if (!norm) continue;
      const up = await client.query(
        `INSERT INTO entities (entity_type, value, normalized_value, last_seen)
         VALUES ($1,$2,$3, now())
         ON CONFLICT (entity_type, normalized_value)
           DO UPDATE SET last_seen = now()
         RETURNING id, entity_type, value, normalized_value, label, cluster_id, risk_score, influence_score, is_flagged`,
        [f.type, f.value, norm]
      );
      const ent = up.rows[0];
      await client.query(
        `INSERT INTO complaint_entities (complaint_id, entity_id, role, confidence, method, context_snippet)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (complaint_id, entity_id, role) DO NOTHING`,
        [complaint.id, ent.id, f.role, f.confidence, f.method, f.snippet || null]
      );
      linkedEntities.push({ ...ent, role: f.role, confidence: f.confidence, method: f.method });
    }

    await client.query('COMMIT');

    // How many existing complaints this one just connected to.
    const linkQ = await pool.query(
      `SELECT count(DISTINCT ce2.complaint_id)::int AS n
         FROM complaint_entities ce1
         JOIN complaint_entities ce2 ON ce2.entity_id = ce1.entity_id AND ce2.complaint_id <> ce1.complaint_id
        WHERE ce1.complaint_id = $1 AND ce1.role <> 'VICTIM' AND ce2.role <> 'VICTIM'`,
      [complaint.id]
    );

    const clusterQ = await pool.query(
      `SELECT cl.cluster_key, cl.label, cl.risk_level
         FROM complaint_entities ce
         JOIN entities e ON e.id = ce.entity_id
         JOIN clusters cl ON cl.id = e.cluster_id
        WHERE ce.complaint_id = $1
        GROUP BY cl.id, cl.cluster_key, cl.label, cl.risk_level
        ORDER BY count(*) DESC LIMIT 1`,
      [complaint.id]
    );

    graph.invalidate();
    intel.ingest({ complaint, entities: linkedEntities }).catch(() => {});

    await audit.log({
      actorId: req.user.id, action: 'COMPLAINT_RECEIVED', entityType: 'complaint',
      entityId: complaint.id,
      metadata: { ref: complaint.complaint_ref, extracted: linkedEntities.length, linked: linkQ.rows[0].n },
      ipAddress: audit.clientIp(req),
    });

    res.status(201).json({
      complaint: { ...complaint, amount_inr: Number(complaint.amount_inr) },
      entities: linkedEntities,
      linked_count: linkQ.rows[0].n,
      cluster: clusterQ.rows[0] || null,
      extraction: {
        available: extraction.ok,
        reason: extraction.ok ? null : extraction.reason,
        count: linkedEntities.length,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
}

module.exports = { list, detail, create };
