/**
 * The criminal graph, built from Postgres.
 *
 * This is the FALLBACK path (docs/PROJECT.md §F rule 4 and the degradation
 * table). When intel-service is up it owns the graph in Neo4j and Express just
 * proxies; when it is not, this module answers the same questions in the same
 * payload shape so the Network Explorer keeps working. The frontend cannot tell
 * which one served it, which is the point — a dead AI service must not produce
 * an empty canvas in front of judges.
 *
 * The whole graph is ~1,200 nodes and ~1,600 edges, so it loads into memory and
 * is cached. Recomputing betweenness per request would cost seconds; recomputing
 * it once per load costs a few hundred milliseconds and every read after that is
 * a map lookup.
 *
 * Node ids follow docs/API.md exactly: `<lowercased type>:<normalized_value>`
 * for entities and `complaint:<id>` for complaints. They are stable across
 * rebuilds, so the frontend may cache on them.
 */

const pool = require('../db/pool');
const { Graph, influenceScores } = require('./graphAlgos');

const CACHE_TTL_MS = 60_000;
let cache = null;
let cachedAt = 0;

const entNodeId = (type, normalized) => `${String(type).toLowerCase()}:${normalized}`;
const complaintNodeId = (id) => `complaint:${id}`;

/** Human-readable label. Long identifiers are elided in the middle, not truncated. */
function displayLabel(e) {
  if (e.label) return e.label;
  const v = e.value || e.normalized_value;
  if (e.entity_type === 'WALLET' && v.length > 16) return `${v.slice(0, 8)}…${v.slice(-4)}`;
  if (e.entity_type === 'BANK_ACCOUNT' && v.length > 8) return `••${v.slice(-4)}`;
  return v;
}

async function build() {
  const [ents, links, ces, txs, clusters, complaints] = await Promise.all([
    pool.query(`SELECT id, entity_type, value, normalized_value, label, cluster_id,
                       risk_score, influence_score, is_flagged
                  FROM entities`),
    pool.query(`SELECT from_entity_id, to_entity_id, relationship, weight FROM entity_links`),
    pool.query(`SELECT complaint_id, entity_id, role FROM complaint_entities`),
    pool.query(`SELECT from_entity_id, to_entity_id, SUM(amount_inr)::float AS amount, COUNT(*)::int AS n
                  FROM transactions GROUP BY from_entity_id, to_entity_id`),
    pool.query(`SELECT id, cluster_key, label, risk_level, mastermind_entity_id FROM clusters`),
    pool.query(`SELECT id, complaint_ref, scam_category, amount_inr, state, district, status, filed_at
                  FROM complaints`),
  ]);

  const clusterById = new Map(clusters.rows.map((c) => [c.id, c]));
  const nodes = new Map();       // nodeId -> node payload
  const byEntityId = new Map();  // entities.id -> nodeId
  const g = new Graph();

  for (const e of ents.rows) {
    const id = entNodeId(e.entity_type, e.normalized_value);
    byEntityId.set(e.id, id);
    const cl = e.cluster_id ? clusterById.get(e.cluster_id) : null;
    nodes.set(id, {
      id,
      pg_id: e.id,
      label: displayLabel(e),
      value: e.value,
      type: e.entity_type,
      cluster: cl ? cl.cluster_key : null,
      cluster_label: cl ? cl.label : null,
      risk: e.risk_score,
      influence: e.influence_score,
      degree: 0,
      is_flagged: e.is_flagged,
      is_mastermind: false,
    });
  }

  for (const c of complaints.rows) {
    const id = complaintNodeId(c.id);
    nodes.set(id, {
      id,
      pg_id: c.id,
      label: c.complaint_ref,
      type: 'COMPLAINT',
      cluster: null,
      category: c.scam_category,
      amount_inr: Number(c.amount_inr),
      state: c.state,
      district: c.district,
      status: c.status,
      filed_at: c.filed_at,
      risk: 0,
      influence: 0,
      degree: 0,
      is_mastermind: false,
    });
  }

  // --- edges ---------------------------------------------------------------
  const edges = [];
  let n = 0;
  const pushEdge = (a, b, type, weight, label) => {
    if (!a || !b || a === b || !nodes.has(a) || !nodes.has(b)) return;
    edges.push({ id: `e_${++n}`, source: a, target: b, type, weight, label: label || null });
    g.add(a, b);
  };

  for (const r of ces.rows) {
    pushEdge(complaintNodeId(r.complaint_id), byEntityId.get(r.entity_id), 'REPORTED_IN', 1, r.role);
  }
  for (const r of links.rows) {
    pushEdge(byEntityId.get(r.from_entity_id), byEntityId.get(r.to_entity_id), r.relationship, r.weight);
  }
  for (const r of txs.rows) {
    pushEdge(byEntityId.get(r.from_entity_id), byEntityId.get(r.to_entity_id), 'TRANSFERRED_TO',
      Math.min(6, 1 + r.n), `₹${Math.round(r.amount).toLocaleString('en-IN')}`);
  }

  // --- computed measures ---------------------------------------------------
  const { influence, pagerank, betweenness } = influenceScores(g);
  for (const [id, node] of nodes) {
    node.degree = g.degree(id);
    node.influence = Math.round(influence.get(id) || 0);
    node.pagerank = Number((pagerank.get(id) || 0).toFixed(4));
    node.betweenness = Number((betweenness.get(id) || 0).toFixed(4));
  }

  // Flag the top-influence entity in each cluster as its coordinator.
  const mastermindByCluster = new Map();
  for (const c of clusters.rows) {
    let best = null;
    for (const node of nodes.values()) {
      if (node.cluster !== c.cluster_key || node.type === 'COMPLAINT') continue;
      if (!best || node.influence > best.influence) best = node;
    }
    if (best) { best.is_mastermind = true; mastermindByCluster.set(c.cluster_key, best); }
  }

  return { nodes, edges, g, byEntityId, clusters: clusters.rows, mastermindByCluster };
}

async function load({ force = false } = {}) {
  if (!force && cache && Date.now() - cachedAt < CACHE_TTL_MS) return cache;
  cache = await build();
  cachedAt = Date.now();
  return cache;
}

function invalidate() { cache = null; cachedAt = 0; }

/** Edges whose endpoints are both inside `keep`. */
function inducedEdges(edges, keep) {
  return edges.filter((e) => keep.has(e.source) && keep.has(e.target));
}

/**
 * Opening view of the Network Explorer.
 *
 * Seeded with the highest-influence nodes rather than a random sample — an
 * investigator opening the page should land on the organisations, not on 150
 * unrelated one-off complaints. Everything else arrives by expansion.
 */
async function overview({ limit = 150 } = {}) {
  const { nodes, edges, clusters, mastermindByCluster } = await load();
  const ranked = [...nodes.values()].sort((a, b) => b.influence - a.influence);
  const keep = new Set(ranked.slice(0, limit).map((n2) => n2.id));

  const kept = ranked.filter((n2) => keep.has(n2.id));
  return {
    nodes: kept,
    edges: inducedEdges(edges, keep),
    stats: {
      total_nodes: nodes.size,
      total_edges: edges.length,
      shown_nodes: kept.length,
      clusters: clusters.length,
      masterminds: [...mastermindByCluster.entries()].map(([k, v]) => ({ cluster: k, label: v.label, id: v.id })),
      source: 'postgres-fallback',
    },
  };
}

/** Expand-on-click. Capped so one double-click cannot lock the canvas. */
async function neighbors(nodeId, { depth = 1, limit = 50 } = {}) {
  const { nodes, edges, g } = await load();
  if (!nodes.has(nodeId)) return { nodes: [], edges: [], error: 'unknown node' };

  let frontier = new Set([nodeId]);
  const seen = new Set([nodeId]);
  for (let d = 0; d < Math.min(depth, 3); d++) {
    const next = new Set();
    for (const v of frontier) {
      for (const w of g.neighbors(v)) if (!seen.has(w)) { next.add(w); seen.add(w); }
    }
    frontier = next;
    if (!frontier.size) break;
  }

  // Keep the most influential neighbours when the cap bites, so expansion
  // reveals structure rather than an arbitrary slice.
  const found = [...seen]
    .filter((id) => id !== nodeId)
    .map((id) => nodes.get(id))
    .filter(Boolean)
    .sort((a, b) => b.influence - a.influence)
    .slice(0, limit);

  const keep = new Set([nodeId, ...found.map((n2) => n2.id)]);
  return {
    nodes: [nodes.get(nodeId), ...found],
    edges: inducedEdges(edges, keep),
    truncated: seen.size - 1 > limit,
  };
}

/** Every node in one criminal organisation. */
async function cluster(clusterKey) {
  const { nodes, edges, clusters } = await load();
  const meta = clusters.find((c) => c.cluster_key === String(clusterKey).toUpperCase());
  if (!meta) return null;

  const members = [...nodes.values()].filter((n2) => n2.cluster === meta.cluster_key);
  const keep = new Set(members.map((n2) => n2.id));

  // Pull in the complaints those entities were reported in — a cluster without
  // its complaints is an abstraction an investigator cannot act on.
  for (const e of edges) {
    if (e.type !== 'REPORTED_IN') continue;
    if (keep.has(e.target) && nodes.get(e.source)?.type === 'COMPLAINT') keep.add(e.source);
    if (keep.has(e.source) && nodes.get(e.target)?.type === 'COMPLAINT') keep.add(e.target);
  }

  const kept = [...keep].map((id) => nodes.get(id)).filter(Boolean);
  return {
    nodes: kept.sort((a, b) => b.influence - a.influence),
    edges: inducedEdges(edges, keep),
    cluster: {
      cluster_key: meta.cluster_key,
      label: meta.label,
      risk_level: meta.risk_level,
      node_count: kept.length,
    },
  };
}

/** Look up a node id from an entities.id — used by controllers holding a pg id. */
async function nodeIdForEntity(entityId) {
  const { byEntityId } = await load();
  return byEntityId.get(Number(entityId)) || null;
}

module.exports = { load, invalidate, overview, neighbors, cluster, nodeIdForEntity, entNodeId, complaintNodeId };
