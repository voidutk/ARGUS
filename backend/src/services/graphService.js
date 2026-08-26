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
const env = require('../config/env');
const {
  Graph, influenceScores, shortestPath, connectedComponents, bridgePathsThrough,
} = require('./graphAlgos');

const CACHE_TTL_MS = env.graphCacheTtlMs;
let cache = null;
let cachedAt = 0;
let building = null;

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

/**
 * Loads the cached graph, building it at most once at a time.
 *
 * The single-flight guard is the point. Building costs a few hundred
 * milliseconds of betweenness over the whole graph, and without it a cold cache
 * plus five concurrent requests means five simultaneous builds — five full table
 * reads and five Brandes runs racing to write the same cache. Sharing the
 * in-flight promise means the first caller does the work and the rest await it.
 */
async function load({ force = false } = {}) {
  if (!force && cache && Date.now() - cachedAt < CACHE_TTL_MS) return cache;
  if (building) return building;

  building = build()
    .then((built) => {
      cache = built;
      cachedAt = Date.now();
      return built;
    })
    .finally(() => { building = null; });

  return building;
}

function invalidate() { cache = null; cachedAt = 0; }

/** Edges whose endpoints are both inside `keep`. */
function inducedEdges(edges, keep) {
  return edges.filter((e) => keep.has(e.source) && keep.has(e.target));
}

/**
 * Opening view of the Network Explorer.
 *
 * An investigator opening this page must land on the ORGANISATIONS. The
 * previous implementation ranked every node by influence and took the top N,
 * which sounds like the same thing and is not: it returned 150 nodes with 22
 * edges between them, 125 of them isolated, and 119 of the 150 were complaints.
 *
 * Two things went wrong, and both are worth naming because they are easy to
 * reintroduce:
 *
 *   1. Complaints dominate an influence ranking BY CONSTRUCTION. A complaint
 *      node sits between the entities named in it, so it scores high on
 *      betweenness — every complaint is a bridge. Ranking all node types
 *      together therefore fills the view with complaint boxes and pushes out
 *      the coordinators and infrastructure the page exists to show.
 *
 *   2. Top-N-by-score is not a connected subgraph. The highest-influence nodes
 *      are spread across separate organisations, so inducing edges over them
 *      yields almost none — a scatter plot, not a network.
 *
 * So the view is GROWN instead of sliced. Seed with the highest-influence
 * ENTITIES, then expand outward along real edges, always taking the most
 * influential unvisited neighbour next. The result is connected by
 * construction, centred on the organisations, and complaints appear where they
 * belong — hanging off the entities that link them, which is exactly the
 * picture §T scene 3 describes.
 */
async function overview({ limit = 150 } = {}) {
  const { nodes, edges, g, clusters, mastermindByCluster } = await load();

  const entities = [...nodes.values()]
    .filter((n) => n.type !== 'COMPLAINT')
    .sort((a, b) => b.influence - a.influence);

  const keep = new Set();

  /**
   * One seed per cluster first, so no organisation is missing from the opening
   * shot just because another one outranks it everywhere. Without this a single
   * dominant cluster can consume the whole budget.
   */
  const seeds = [];
  const seenCluster = new Set();
  for (const node of entities) {
    if (node.cluster && !seenCluster.has(node.cluster)) {
      seenCluster.add(node.cluster);
      seeds.push(node);
    }
  }
  // Then the strongest remaining entities, whatever their cluster.
  for (const node of entities) {
    if (seeds.length >= 12) break;
    if (!seeds.includes(node)) seeds.push(node);
  }

  // Breadth-first from every seed at once, always expanding the most
  // influential frontier node next, so the budget is spent on structure rather
  // than on whichever branch happened to be walked first.
  const frontier = [];
  const pushNode = (id) => {
    if (keep.has(id) || keep.size >= limit) return;
    keep.add(id);
    frontier.push(id);
  };
  seeds.forEach((s) => pushNode(s.id));

  while (frontier.length && keep.size < limit) {
    frontier.sort((a, b) => (nodes.get(b)?.influence ?? 0) - (nodes.get(a)?.influence ?? 0));
    const current = frontier.shift();
    const neighbourIds = [...g.neighbors(current)]
      .filter((id) => !keep.has(id))
      .sort((a, b) => (nodes.get(b)?.influence ?? 0) - (nodes.get(a)?.influence ?? 0));
    for (const id of neighbourIds) {
      if (keep.size >= limit) break;
      pushNode(id);
    }
  }

  const kept = [...keep]
    .map((id) => nodes.get(id))
    .filter(Boolean)
    .sort((a, b) => b.influence - a.influence);

  const shownEdges = inducedEdges(edges, keep);

  return {
    nodes: kept,
    edges: shownEdges,
    stats: {
      total_nodes: nodes.size,
      total_edges: edges.length,
      shown_nodes: kept.length,
      shown_edges: shownEdges.length,
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

/**
 * "Why is this person flagged?" — docs/PLAN-V2-DATA-AND-INTEL.md §3.1.
 *
 * The hardest question a judge can ask about this system is "how do you know?",
 * and a centrality score is not an answer to it. This assembles the four things
 * that are:
 *
 *   bridge paths   — the concrete routes through this node, not the number that
 *                    summarises them.
 *   removal test   — what the organisation looks like with the node deleted.
 *                    If it falls into three pieces, the node was holding it
 *                    together, and that is a finding no score can convey.
 *   rank           — where the node sits, in its cluster and graph-wide, so the
 *                    claim is placed rather than asserted.
 *   complaint count— usually zero for a coordinator, and the line that lands:
 *                    the most important person in the network is the one no
 *                    victim ever named.
 *
 * Everything here is derived at read time from the same cached graph the
 * Explorer renders, so the explanation cannot drift from the picture.
 */
async function why(nodeId, { pathLimit = 8 } = {}) {
  const { nodes, edges, g, clusters } = await load();
  const node = nodes.get(nodeId);
  if (!node) return null;

  // --- bridge paths --------------------------------------------------------
  const bridges = bridgePathsThrough(g, nodeId, { limit: pathLimit });
  const describe = (id) => {
    const n = nodes.get(id);
    return n ? { id, label: n.label, type: n.type, cluster: n.cluster } : { id, label: id, type: 'UNKNOWN' };
  };
  const bridge_paths = bridges.map((b) => ({
    from: describe(b.from),
    via: describe(b.via),
    to: describe(b.to),
    severs: b.severs,
    // The sentence an investigator reads, assembled here rather than in the UI
    // so the API and the frontend cannot disagree about what was claimed.
    narrative: `${describe(b.from).label} → [${node.label}] → ${describe(b.to).label}`,
  }));

  // --- removal test --------------------------------------------------------
  //
  // Scoped to the node's own cluster plus everything reachable from it, not the
  // whole graph. Removing one node from a 1,200-node graph that already has
  // several disconnected pieces would report a fragment count dominated by
  // components that have nothing to do with this node.
  const componentOf = connectedComponents(g).find((c) => c.has(nodeId));
  const before = componentOf ? componentOf.size : 0;

  const after = connectedComponents(g, { exclude: nodeId })
    .filter((c) => componentOf && [...c].some((id) => componentOf.has(id)));

  const fragments = after.length;
  const largestAfter = after.reduce((max, c) => Math.max(max, c.size), 0);
  const orphaned = after.filter((c) => c.size === 1).length;

  // --- rank ----------------------------------------------------------------
  const entityNodes = [...nodes.values()].filter((n) => n.type !== 'COMPLAINT');
  const rankedGraph = entityNodes.slice().sort((a, b) => b.influence - a.influence);
  const graphRank = rankedGraph.findIndex((n) => n.id === nodeId) + 1;

  const clusterPeers = node.cluster
    ? entityNodes.filter((n) => n.cluster === node.cluster).sort((a, b) => b.influence - a.influence)
    : [];
  const clusterRank = clusterPeers.findIndex((n) => n.id === nodeId) + 1;

  // --- appearances ---------------------------------------------------------
  const complaintEdges = edges.filter(
    (e) => (e.source === nodeId || e.target === nodeId) && e.type === 'REPORTED_IN'
  );
  const clusterMeta = clusters.find((c) => c.cluster_key === node.cluster) || null;

  return {
    node: {
      id: node.id, label: node.label, type: node.type, cluster: node.cluster,
      influence: node.influence, pagerank: node.pagerank, betweenness: node.betweenness,
      degree: node.degree, is_mastermind: node.is_mastermind, risk: node.risk,
    },
    cluster: clusterMeta
      ? { cluster_key: clusterMeta.cluster_key, label: clusterMeta.label, risk_level: clusterMeta.risk_level }
      : null,
    bridge_paths,
    bridge_pair_count: bridges.length,
    severing_pair_count: bridges.filter((b) => b.severs).length,
    removal_test: {
      component_size_before: before,
      fragments_after: fragments,
      largest_fragment_after: largestAfter,
      isolated_nodes_after: orphaned,
      fragmenting: fragments > 1,
      summary: fragments > 1
        ? `Removing this node splits a ${before}-node network into ${fragments} fragments`
        : `Removing this node leaves the network connected`,
    },
    rank: {
      in_cluster: clusterRank || null,
      cluster_size: clusterPeers.length || null,
      graph_wide: graphRank || null,
      graph_entities: entityNodes.length,
    },
    appearances: {
      complaint_count: complaintEdges.length,
      // The headline for a coordinator: named in nothing, central to everything.
      never_named: complaintEdges.length === 0,
    },
    method: {
      influence: 'Equal blend of PageRank and Brandes betweenness, both computed over the live graph.',
      removal_test: 'Connected components recomputed with this node deleted.',
      bridge_paths: 'Neighbour pairs with no direct edge, checked for an alternative route without this node.',
    },
  };
}

/**
 * Shortest route between two nodes — docs/PLAN-V2-DATA-AND-INTEL.md §3.2.
 *
 * Returns the hydrated node objects and the edges along the path, so the
 * Explorer can highlight the route it describes rather than re-deriving it.
 */
async function path(fromId, toId) {
  const { nodes, edges, g } = await load();
  if (!nodes.has(fromId)) return { error: 'unknown_from' };
  if (!nodes.has(toId)) return { error: 'unknown_to' };

  const ids = shortestPath(g, fromId, toId);
  if (!ids) {
    return {
      found: false,
      hops: null,
      nodes: [nodes.get(fromId), nodes.get(toId)],
      edges: [],
      note: 'These two nodes are in separate components — no route connects them.',
    };
  }

  const onPath = new Set(ids);
  const pathEdges = [];
  for (let i = 0; i < ids.length - 1; i++) {
    const a = ids[i];
    const b = ids[i + 1];
    const edge = edges.find(
      (e) => (e.source === a && e.target === b) || (e.source === b && e.target === a)
    );
    if (edge) pathEdges.push(edge);
  }

  return {
    found: true,
    hops: ids.length - 1,
    node_ids: ids,
    nodes: ids.map((id) => nodes.get(id)),
    edges: pathEdges,
    narrative: ids.map((id) => nodes.get(id)?.label ?? id).join(' → '),
    // Present so the caller can style the subgraph without a second request.
    highlight: [...onPath],
  };
}

/**
 * Neighbours two nodes have in common — docs/PLAN-V2-DATA-AND-INTEL.md §3.2.
 *
 * The investigator's version of "what do these two have in common": a shared
 * mule account between two complaints is a lead; a shared cluster label is not.
 */
async function common(aId, bId) {
  const { nodes, g } = await load();
  if (!nodes.has(aId)) return { error: 'unknown_a' };
  if (!nodes.has(bId)) return { error: 'unknown_b' };

  const shared = [...g.neighbors(aId)]
    .filter((id) => g.neighbors(bId).has(id))
    .map((id) => nodes.get(id))
    .filter(Boolean)
    .sort((x, y) => y.influence - x.influence);

  return {
    a: nodes.get(aId),
    b: nodes.get(bId),
    shared,
    count: shared.length,
    directly_connected: g.neighbors(aId).has(bId),
  };
}

/**
 * Risk-scoring weights — PLAN §I.5.
 *
 * Declared here, in the open, rather than buried in the SQL that gathers the
 * inputs. Anyone asking "why is this wallet an 80?" gets an answer in four
 * numbers that sum to one, and `GET /entities/:id/why` reads them straight off
 * this object rather than restating them.
 *
 * They are round numbers on purpose. There is no labelled corpus of "true"
 * entity risk to fit against, so any more precise-looking weight (0.27, 0.31)
 * would be fabricated precision — it would imply a training run that never
 * happened. Round weights say what this is: a declared policy, not a model.
 */
const RISK_WEIGHTS = {
  complaints: 0.30,  // how many separate victims name it
  amount: 0.25,      // total rupee exposure across those complaints
  spread: 0.20,      // how many states it reaches — organised, not local
  reuse: 0.25,       // shared-infrastructure links to other entities
};

/**
 * Writes the derived scores back onto `entities`.
 *
 * PLAN §288 says the analytics job writes `cluster_id`, `influence` and `risk`
 * back onto each node, and until now nothing did. The columns existed, the UI
 * read them, and every entity in the database sat at zero — so the Networks
 * page displayed "influence 0" beside the coordinator whose whole significance
 * is that centrality ranks him first. The Explorer looked correct only because
 * it reads the in-memory graph and never touches these columns.
 *
 * `is_flagged` is deliberately NOT an input to risk. It is the label a human
 * already attached to an entity, and feeding it into the score would make the
 * score partly a restatement of that judgement — the model would "discover"
 * exactly what someone typed in. Risk here is computed from behaviour alone,
 * which is what makes it capable of disagreeing with the flag.
 */
async function persistScores() {
  // `byEntityId` is the entities.id -> nodeId map the build already keeps.
  // Node ids are `<type>:<normalized_value>`, so they cannot be derived from a
  // numeric id alone — this map is the only correct way across.
  const { nodes, byEntityId } = await load({ force: true });

  // Inputs for risk, gathered per entity. Complaints are de-duplicated first:
  // an entity linked to the same complaint under two roles must not count twice.
  const { rows } = await pool.query(`
    WITH ec AS (
      SELECT DISTINCT entity_id, complaint_id FROM complaint_entities
    ),
    agg AS (
      SELECT ec.entity_id AS id,
             count(*)                                                    AS complaints,
             count(DISTINCT c.state) FILTER (WHERE c.state IS NOT NULL)  AS states,
             COALESCE(sum(c.amount_inr), 0)                              AS amount
        FROM ec JOIN complaints c ON c.id = ec.complaint_id
       GROUP BY ec.entity_id
    ),
    lnk AS (
      SELECT id, sum(n) AS links FROM (
        SELECT from_entity_id AS id, count(*) AS n FROM entity_links GROUP BY 1
        UNION ALL
        SELECT to_entity_id   AS id, count(*) AS n FROM entity_links GROUP BY 1
      ) t GROUP BY id
    )
    SELECT e.id,
           COALESCE(agg.complaints, 0)::int   AS complaints,
           COALESCE(agg.states, 0)::int       AS states,
           COALESCE(agg.amount, 0)::float8    AS amount,
           COALESCE(lnk.links, 0)::int        AS links
      FROM entities e
      LEFT JOIN agg ON agg.id = e.id
      LEFT JOIN lnk ON lnk.id = e.id`);

  if (!rows.length) return { entities: 0, scored: 0 };

  /**
   * Normalise against the corpus, not against a constant.
   *
   * Complaint counts and rupee amounts are heavy-tailed — one entity touching
   * forty complaints would flatten everything else to nearly zero under linear
   * scaling, and the ranking below it would carry no information. A square root
   * compresses that tail while preserving order, so the middle of the
   * distribution stays legible. States and links are small integers already and
   * are scaled linearly.
   */
  const max = {
    complaints: Math.max(1, ...rows.map((r) => r.complaints)),
    amount: Math.max(1, ...rows.map((r) => r.amount)),
    states: Math.max(1, ...rows.map((r) => r.states)),
    links: Math.max(1, ...rows.map((r) => r.links)),
  };
  const sqrtNorm = (v, m) => (m <= 0 ? 0 : Math.sqrt(Math.max(0, v) / m));
  const linNorm = (v, m) => (m <= 0 ? 0 : Math.min(1, Math.max(0, v) / m));

  const updates = rows.map((r) => {
    const risk = Math.round(100 * (
      RISK_WEIGHTS.complaints * sqrtNorm(r.complaints, max.complaints)
      + RISK_WEIGHTS.amount * sqrtNorm(r.amount, max.amount)
      + RISK_WEIGHTS.spread * linNorm(r.states, max.states)
      + RISK_WEIGHTS.reuse * linNorm(r.links, max.links)
    ));
    const node = nodes.get(byEntityId.get(r.id));
    return {
      id: r.id,
      influence: Math.max(0, Math.min(100, Math.round(node?.influence ?? 0))),
      risk: Math.max(0, Math.min(100, risk)),
    };
  });

  // One statement rather than 962. UNNEST keeps it a single round trip and a
  // single plan, which matters because this runs inside a request.
  await pool.query(
    `UPDATE entities e
        SET influence_score = v.influence,
            risk_score      = v.risk
       FROM (SELECT * FROM unnest($1::int[], $2::int[], $3::int[])
                       AS t(id, influence, risk)) v
      WHERE e.id = v.id
        AND (e.influence_score IS DISTINCT FROM v.influence
             OR e.risk_score   IS DISTINCT FROM v.risk)`,
    [updates.map((u) => u.id), updates.map((u) => u.influence), updates.map((u) => u.risk)]
  );

  return {
    entities: updates.length,
    scored: updates.filter((u) => u.influence > 0 || u.risk > 0).length,
    top_influence: Math.max(0, ...updates.map((u) => u.influence)),
    top_risk: Math.max(0, ...updates.map((u) => u.risk)),
  };
}

module.exports = {
  load, invalidate, overview, neighbors, cluster, nodeIdForEntity,
  why, path, common, persistScores, RISK_WEIGHTS,
  entNodeId, complaintNodeId,
};
