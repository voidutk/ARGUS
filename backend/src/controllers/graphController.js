const intel = require('../services/intelClient');
const graph = require('../services/graphService');
const audit = require('../services/auditService');

/**
 * Graph reads.
 *
 * Every handler tries intel-service first and falls back to the Postgres graph
 * (docs/PROJECT.md §F). The response carries `source` so the UI can show a
 * "live analysis unavailable" banner honestly — degrading silently would be
 * worse than degrading visibly, because an investigator needs to know whether
 * they are looking at freshly computed intelligence or the last known picture.
 */

async function overview(req, res, next) {
  try {
    const limit = Math.min(Number(req.query.limit) || 150, 600);

    const live = await intel.graphOverview(limit);
    if (live.ok) return res.json({ ...live.data, source: 'intel-service' });

    const data = await graph.overview({ limit });
    res.json({ ...data, source: 'postgres-fallback', degraded_reason: live.reason });
  } catch (err) { next(err); }
}

async function neighbors(req, res, next) {
  try {
    const { nodeId } = req.params;
    const depth = Math.min(Number(req.query.depth) || 1, 3);
    const limit = Math.min(Number(req.query.limit) || 50, 200);

    const live = await intel.graphNeighbors(nodeId, depth, limit);
    if (live.ok) return res.json({ ...live.data, source: 'intel-service' });

    const data = await graph.neighbors(nodeId, { depth, limit });
    if (data.error) return res.status(404).json({ error: 'Unknown node' });
    res.json({ ...data, source: 'postgres-fallback', degraded_reason: live.reason });
  } catch (err) { next(err); }
}

async function cluster(req, res, next) {
  try {
    const { clusterKey } = req.params;

    const live = await intel.graphCluster(clusterKey);
    if (live.ok) return res.json({ ...live.data, source: 'intel-service' });

    const data = await graph.cluster(clusterKey);
    if (!data) return res.status(404).json({ error: 'Unknown cluster' });
    res.json({ ...data, source: 'postgres-fallback', degraded_reason: live.reason });
  } catch (err) { next(err); }
}

/** ADMIN only. Rebuilds Neo4j from Postgres and drops the local cache. */
async function rebuild(req, res, next) {
  try {
    graph.invalidate();
    const live = await intel.ingestBulk({ source: 'postgres' });

    await audit.log({
      actorId: req.user.id, action: 'GRAPH_REBUILD', entityType: 'graph',
      metadata: { intel_ok: live.ok, reason: live.reason || null },
      ipAddress: audit.clientIp(req),
    });

    if (!live.ok) {
      // The local cache was still dropped, so the fallback graph is fresh.
      return res.status(202).json({
        rebuilt: 'postgres-fallback-only',
        reason: live.reason,
        note: 'Local graph cache cleared. Neo4j was not reachable.',
      });
    }
    res.json({ ...live.data, source: 'intel-service' });
  } catch (err) { next(err); }
}

module.exports = { overview, neighbors, cluster, rebuild };
