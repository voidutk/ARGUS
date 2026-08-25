const intel = require('../services/intelClient');
const graph = require('../services/graphService');
const audit = require('../services/auditService');
const { asyncHandler, notFound, badRequest } = require('../lib/errors');

/**
 * Graph reads.
 *
 * Every handler tries intel-service first and falls back to the Postgres graph
 * (docs/PROJECT.md §F). The response carries `source` so the UI can show a
 * "live analysis unavailable" banner honestly — degrading silently would be
 * worse than degrading visibly, because an investigator needs to know whether
 * they are looking at freshly computed intelligence or the last known picture.
 *
 * The explainability endpoints below are the exception: they are answered from
 * Postgres unconditionally. `/why` has to derive its evidence from the same
 * graph the Explorer is rendering, and a proxied version could describe a
 * different one — an explanation that does not match the picture it explains is
 * worse than no explanation.
 */

const overview = asyncHandler(async (req, res) => {
  const { limit } = req.valid.query;

  const live = await intel.graphOverview(limit);
  if (live.ok) return res.json({ ...live.data, source: 'intel-service' });

  const data = await graph.overview({ limit });
  res.json({ ...data, source: 'postgres-fallback', degraded_reason: live.reason });
});

const neighbors = asyncHandler(async (req, res) => {
  const { nodeId } = req.valid.params;
  const { depth, limit } = req.valid.query;

  const live = await intel.graphNeighbors(nodeId, depth, limit);
  if (live.ok) return res.json({ ...live.data, source: 'intel-service' });

  const data = await graph.neighbors(nodeId, { depth, limit });
  if (data.error) throw notFound('Node');
  res.json({ ...data, source: 'postgres-fallback', degraded_reason: live.reason });
});

const cluster = asyncHandler(async (req, res) => {
  const { clusterKey } = req.valid.params;

  const live = await intel.graphCluster(clusterKey);
  if (live.ok) return res.json({ ...live.data, source: 'intel-service' });

  const data = await graph.cluster(clusterKey);
  if (!data) throw notFound('Cluster');
  res.json({ ...data, source: 'postgres-fallback', degraded_reason: live.reason });
});

/**
 * GET /api/graph/why/:nodeId — docs/PLAN-V2-DATA-AND-INTEL.md §3.1.
 *
 * The answer to "why is this person flagged?", and the hardest question this
 * system has to survive. Always computed locally: the explanation and the graph
 * on screen must come from the same source or the explanation is worthless.
 */
const why = asyncHandler(async (req, res) => {
  const { nodeId } = req.valid.params;
  const explanation = await graph.why(nodeId);
  if (!explanation) throw notFound('Node');
  res.json({ ...explanation, source: 'postgres' });
});

/** GET /api/graph/path?from=&to= — §3.2. How two nodes connect, in fewest hops. */
const path = asyncHandler(async (req, res) => {
  const { from, to } = req.valid.query;
  if (from === to) throw badRequest('from and to must be different nodes');

  const result = await graph.path(from, to);
  if (result.error === 'unknown_from') throw notFound(`Node "${from}"`);
  if (result.error === 'unknown_to') throw notFound(`Node "${to}"`);
  res.json({ ...result, source: 'postgres' });
});

/** GET /api/graph/common?a=&b= — §3.2. What two nodes have in common. */
const common = asyncHandler(async (req, res) => {
  const { a, b } = req.valid.query;
  if (a === b) throw badRequest('a and b must be different nodes');

  const result = await graph.common(a, b);
  if (result.error === 'unknown_a') throw notFound(`Node "${a}"`);
  if (result.error === 'unknown_b') throw notFound(`Node "${b}"`);
  res.json({ ...result, source: 'postgres' });
});

/** ADMIN only. Rebuilds Neo4j from Postgres and drops the local cache. */
const rebuild = asyncHandler(async (req, res) => {
  graph.invalidate();
  const live = await intel.ingestBulk({ source: 'postgres' });

  await audit.log({
    actorId: req.user.id,
    action: 'GRAPH_REBUILD',
    entityType: 'graph',
    metadata: { intel_ok: live.ok, reason: live.reason || null },
    ipAddress: audit.clientIp(req),
  });

  if (!live.ok) {
    // The local cache was still dropped, so the fallback graph is fresh. 202
    // rather than 500: the part of the job we own succeeded.
    return res.status(202).json({
      rebuilt: 'postgres-fallback-only',
      reason: live.reason,
      note: 'Local graph cache cleared. Neo4j was not reachable.',
    });
  }
  res.json({ ...live.data, source: 'intel-service' });
});

module.exports = { overview, neighbors, cluster, why, path, common, rebuild };
