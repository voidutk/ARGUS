/**
 * Graph algorithms — shared by the API's fallback path and by verify-plant.
 *
 * These live in Express for one reason: the platform must keep working when the
 * FastAPI intelligence service is down (docs/PROJECT.md §F). When intel-service
 * is up it owns analytics and runs these in NetworkX against Neo4j; when it is
 * not, Express computes the same measures over Postgres and the graph pages
 * still render real numbers rather than an error card.
 *
 * Both implementations must agree on the MODEL, not just the maths:
 * complaints are NODES, never cliques of their entities. Expanding a complaint
 * with 7 entities into 21 mutual edges would invent connections no investigator
 * could evidence and would bury the real structure under noise.
 */

class Graph {
  constructor() { this.adj = new Map(); }

  add(a, b) {
    if (a === b) return;
    if (!this.adj.has(a)) this.adj.set(a, new Set());
    if (!this.adj.has(b)) this.adj.set(b, new Set());
    this.adj.get(a).add(b);
    this.adj.get(b).add(a);
  }

  has(n) { return this.adj.has(n); }
  nodes() { return [...this.adj.keys()]; }
  neighbors(n) { return this.adj.get(n) || new Set(); }
  degree(n) { return (this.adj.get(n) || new Set()).size; }
  get size() { return this.adj.size; }
  get edgeCount() { let s = 0; for (const v of this.adj.values()) s += v.size; return s / 2; }
}

/** Undirected PageRank by power iteration. */
function pagerank(g, { damping = 0.85, iterations = 80 } = {}) {
  const nodes = g.nodes();
  const n = nodes.length;
  if (!n) return new Map();
  let pr = new Map(nodes.map((v) => [v, 1 / n]));

  for (let it = 0; it < iterations; it++) {
    const next = new Map(nodes.map((v) => [v, (1 - damping) / n]));
    let dangling = 0;
    for (const v of nodes) {
      const deg = g.neighbors(v).size;
      if (deg === 0) { dangling += pr.get(v); continue; }
      const share = (damping * pr.get(v)) / deg;
      for (const w of g.neighbors(v)) next.set(w, next.get(w) + share);
    }
    if (dangling > 0) {
      const spread = (damping * dangling) / n;
      for (const v of nodes) next.set(v, next.get(v) + spread);
    }
    pr = next;
  }
  return pr;
}

/**
 * Brandes betweenness centrality, unweighted.
 *
 * This is the measure that finds a coordinator: someone who sits on the only
 * route between parts of an organisation that are otherwise kept apart.
 */
function betweenness(g) {
  const nodes = g.nodes();
  const cb = new Map(nodes.map((v) => [v, 0]));

  for (const s of nodes) {
    const stack = [];
    const pred = new Map();
    const sigma = new Map();
    const dist = new Map();
    for (const v of nodes) { pred.set(v, []); sigma.set(v, 0); dist.set(v, -1); }
    sigma.set(s, 1);
    dist.set(s, 0);

    const queue = [s];
    let qi = 0;
    while (qi < queue.length) {
      const v = queue[qi++];
      stack.push(v);
      for (const w of g.neighbors(v)) {
        if (dist.get(w) < 0) { dist.set(w, dist.get(v) + 1); queue.push(w); }
        if (dist.get(w) === dist.get(v) + 1) {
          sigma.set(w, sigma.get(w) + sigma.get(v));
          pred.get(w).push(v);
        }
      }
    }

    const delta = new Map(nodes.map((v) => [v, 0]));
    while (stack.length) {
      const w = stack.pop();
      for (const v of pred.get(w)) {
        delta.set(v, delta.get(v) + (sigma.get(v) / sigma.get(w)) * (1 + delta.get(w)));
      }
      if (w !== s) cb.set(w, cb.get(w) + delta.get(w));
    }
  }

  for (const v of nodes) cb.set(v, cb.get(v) / 2); // undirected: each pair twice
  return cb;
}

/**
 * One shortest path between two nodes, as a list of node ids.
 *
 * BFS, so "shortest" means fewest hops — which is the right measure here.
 * Weighting by transfer amount or contact frequency would answer "the strongest
 * route", but an investigator asking how two complaints connect wants the
 * fewest links to explain, and every extra hop is another thing to evidence.
 *
 * Returns null when no path exists; the two nodes are in different components,
 * which is itself an answer worth showing.
 */
function shortestPath(g, from, to) {
  if (!g.has(from) || !g.has(to)) return null;
  if (from === to) return [from];

  const prev = new Map([[from, null]]);
  const queue = [from];
  let qi = 0;

  while (qi < queue.length) {
    const v = queue[qi++];
    for (const w of g.neighbors(v)) {
      if (prev.has(w)) continue;
      prev.set(w, v);
      if (w === to) {
        const path = [];
        for (let at = to; at !== null; at = prev.get(at)) path.push(at);
        return path.reverse();
      }
      queue.push(w);
    }
  }
  return null;
}

/**
 * Connected components, as an array of Sets.
 *
 * This is the measure behind the removal test in `/why`: recompute components
 * with a node deleted and see how many pieces its cluster falls into. A node
 * whose removal fragments an organisation is a coordinator regardless of what
 * any centrality score says, and that is a claim an investigator can act on.
 */
function connectedComponents(g, { exclude = null } = {}) {
  const seen = new Set(exclude ? [exclude] : []);
  const components = [];

  for (const start of g.nodes()) {
    if (seen.has(start)) continue;
    const component = new Set([start]);
    seen.add(start);
    const queue = [start];
    let qi = 0;
    while (qi < queue.length) {
      const v = queue[qi++];
      for (const w of g.neighbors(v)) {
        if (seen.has(w)) continue;
        seen.add(w);
        component.add(w);
        queue.push(w);
      }
    }
    components.push(component);
  }
  return components;
}

/**
 * Concrete routes that pass THROUGH `via` — the evidence behind a betweenness
 * score.
 *
 * Betweenness answers "how often is this node on a shortest path" with a
 * number. A number is not an explanation. This returns the actual paths, so the
 * claim becomes `Caller B → [Vikram Rathore] → Cell C wallet` — a sentence an
 * investigator can check, and the reason §3.1 of the plan rates this feature
 * above everything else on its list.
 *
 * Only pairs of the node's own neighbours are considered, and only where the
 * shortest route between them genuinely runs through `via`: if two neighbours
 * are also directly connected to each other, `via` is a convenience, not a
 * bridge, and claiming otherwise would overstate the finding.
 */
function bridgePathsThrough(g, via, { limit = 8 } = {}) {
  if (!g.has(via)) return [];

  const neighbours = [...g.neighbors(via)];
  const withoutVia = new Set([via]);
  const paths = [];

  // Reachability with `via` removed, computed once per source rather than per
  // pair — the pairwise version is O(n²) BFS and visibly slow on a big cluster.
  const reachableWithout = new Map();
  const bfsWithout = (start) => {
    const seen = new Set([start]);
    const queue = [start];
    let qi = 0;
    while (qi < queue.length) {
      const v = queue[qi++];
      for (const w of g.neighbors(v)) {
        if (withoutVia.has(w) || seen.has(w)) continue;
        seen.add(w);
        queue.push(w);
      }
    }
    return seen;
  };

  for (let i = 0; i < neighbours.length; i++) {
    for (let j = i + 1; j < neighbours.length; j++) {
      const a = neighbours[i];
      const b = neighbours[j];

      // Directly connected: `via` is not what joins them.
      if (g.neighbors(a).has(b)) continue;

      if (!reachableWithout.has(a)) reachableWithout.set(a, bfsWithout(a));
      const detourExists = reachableWithout.get(a).has(b);

      paths.push({
        from: a,
        to: b,
        via,
        // A cut pair has NO route at all once `via` is gone: removing this node
        // does not lengthen their connection, it severs it.
        severs: !detourExists,
      });

      if (paths.length >= limit * 4) break;
    }
    if (paths.length >= limit * 4) break;
  }

  // Severing pairs first: they are the strongest evidence and the ones worth
  // the limited space in a UI panel.
  return paths
    .sort((x, y) => Number(y.severs) - Number(x.severs))
    .slice(0, limit);
}

/** Scale a measure onto 0..1 by its maximum. */
function normalise(m) {
  const max = Math.max(...m.values(), 1e-12);
  return new Map([...m].map(([k, v]) => [k, v / max]));
}

/**
 * Influence 0..100 — an equal blend of PageRank and betweenness (§I.4).
 *
 * The blend is 50/50 and stays 50/50. It is deliberately NOT tuned: weights
 * chosen to make a particular name come out on top would be reverse-engineering
 * the answer, and would collapse the moment a judge added a complaint. If a
 * coordinator does not surface, the graph is wrong, not the weighting.
 */
function influenceScores(g) {
  const pr = normalise(pagerank(g));
  const bt = normalise(betweenness(g));
  const influence = new Map();
  for (const v of g.nodes()) {
    influence.set(v, 100 * (0.5 * (pr.get(v) || 0) + 0.5 * (bt.get(v) || 0)));
  }
  return { influence, pagerank: pr, betweenness: bt };
}

/**
 * Label propagation — a cheap stand-in for Louvain on the fallback path.
 *
 * Deterministic: nodes are processed in a fixed order and ties break on the
 * lowest label, so the same graph always yields the same communities. A
 * randomised implementation would make the dashboard reshuffle between page
 * loads, which reads as a bug even when the maths is fine.
 */
function labelPropagation(g, { iterations = 30 } = {}) {
  const nodes = g.nodes().sort();
  const label = new Map(nodes.map((v) => [v, v]));

  for (let it = 0; it < iterations; it++) {
    let changed = false;
    for (const v of nodes) {
      const counts = new Map();
      for (const w of g.neighbors(v)) {
        const l = label.get(w);
        counts.set(l, (counts.get(l) || 0) + 1);
      }
      if (!counts.size) continue;
      let best = label.get(v);
      let bestN = -1;
      for (const [l, n] of [...counts].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        if (n > bestN) { bestN = n; best = l; }
      }
      if (best !== label.get(v)) { label.set(v, best); changed = true; }
    }
    if (!changed) break;
  }
  return label;
}

module.exports = {
  Graph, pagerank, betweenness, normalise, influenceScores, labelPropagation,
  shortestPath, connectedComponents, bridgePathsThrough,
};
