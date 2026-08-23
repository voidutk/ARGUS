const axios = require('axios');
const env = require('../config/env');

/**
 * Client for the FastAPI intelligence service (entity extraction, Neo4j, analytics).
 *
 * Every function here is ADVISORY and NEVER THROWS. It returns
 * `{ ok, data, reason }` and the caller decides what to do with a miss. That is
 * the §F degradation rule made concrete: intel-service being down must degrade
 * the intelligence, not take the platform offline. Complaints still file,
 * evidence still uploads, graph pages still render from Postgres.
 *
 * A short timeout is part of the contract. A hung AI call that eventually
 * succeeds is worse than a fast miss during a three-minute demo.
 */

const client = axios.create({
  baseURL: env.intelServiceUrl,
  timeout: env.intelTimeoutMs,
  headers: { 'Content-Type': 'application/json' },
});

async function call(method, path, body, { timeout } = {}) {
  try {
    const res = await client.request({ method, url: path, data: body, timeout });
    return { ok: true, data: res.data };
  } catch (err) {
    const reason =
      err.code === 'ECONNABORTED' ? `intel-service timed out after ${timeout || env.intelTimeoutMs}ms`
      : err.response ? `intel-service returned ${err.response.status}`
      : 'intel-service unreachable';
    return { ok: false, reason, data: null };
  }
}

/** The identity our intel service reports. Anything else is not ours. */
const SERVICE_NAME = 'argus-intel';

/**
 * Liveness + what the service can currently do.
 *
 * A 200 is NOT enough. Dev machines routinely have something else bound to
 * :8000 — during this build it was a leftover FastAPI service from a previous
 * project, which answered /health happily and would have received our /extract
 * calls. So the response must also identify itself as ours; otherwise we report
 * the port as occupied by a stranger and fall back, which is the truthful
 * reading of that situation.
 */
async function health() {
  const r = await call('get', '/health', null, { timeout: 2000 });
  if (!r.ok) return r;
  if (r.data?.service !== SERVICE_NAME) {
    return {
      ok: false,
      data: null,
      reason: `something else is listening on ${env.intelServiceUrl} `
        + `(reports "${r.data?.service ?? 'unknown'}", expected "${SERVICE_NAME}")`,
    };
  }
  return r;
}

/** Extract entities from a complaint narrative. */
const extract = (narrative, complaintId) =>
  call('post', '/extract', { narrative, complaint_id: complaintId });

/** Merge one complaint and its entities into Neo4j. */
const ingest = (payload) => call('post', '/ingest', payload);

/** Rebuild the whole graph from Postgres. Slow by nature — give it room. */
const ingestBulk = (payload) => call('post', '/ingest/bulk', payload, { timeout: 120000 });

/** Recompute communities, influence and risk. */
const runAnalytics = () => call('post', '/analytics/run', null, { timeout: 60000 });

const graphOverview = (limit = 150) => call('get', `/graph/overview?limit=${limit}`);
const graphNeighbors = (nodeId, depth = 1, limit = 50) =>
  call('get', `/graph/neighbors/${encodeURIComponent(nodeId)}?depth=${depth}&limit=${limit}`);
const graphCluster = (clusterKey) => call('get', `/graph/cluster/${encodeURIComponent(clusterKey)}`);

module.exports = {
  health, extract, ingest, ingestBulk, runAnalytics,
  graphOverview, graphNeighbors, graphCluster,
};
