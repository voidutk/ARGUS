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

const axios = require('axios');
const env = require('../config/env');
const logger = require('../lib/logger');

const client = axios.create({
  baseURL: env.intelServiceUrl,
  timeout: env.intelTimeoutMs,
  headers: { 'Content-Type': 'application/json' },
  // A malicious or misconfigured service on this port should not be able to
  // bounce us somewhere else, and a large response should not exhaust memory.
  maxRedirects: 0,
  maxContentLength: 32 * 1024 * 1024,
});

/**
 * Circuit breaker.
 *
 * Without one, every request pays the full timeout while the service is down —
 * `POST /api/complaints` would take 8 seconds instead of 200ms for as long as
 * FastAPI is stopped, and the §T scene-2 budget of "under 3 seconds" would be
 * missed by a service that is *correctly* being treated as optional. After a
 * few consecutive failures the breaker opens and calls fail instantly with the
 * last known reason. One probe is allowed through per cooldown to close it.
 *
 * Health checks bypass the breaker: their entire job is to report the true
 * current state, and the admin page must show recovery the moment it happens.
 */
const breaker = {
  failures: 0,
  openedAt: 0,
  reason: null,
  isOpen() {
    if (this.failures < env.intelBreakerThreshold) return false;
    if (Date.now() - this.openedAt >= env.intelBreakerCooldownMs) return false; // half-open probe
    return true;
  },
  recordSuccess() {
    if (this.failures) logger.info('intel-service recovered — circuit closed');
    this.failures = 0;
    this.reason = null;
  },
  recordFailure(reason) {
    this.failures += 1;
    this.reason = reason;
    if (this.failures === env.intelBreakerThreshold) {
      this.openedAt = Date.now();
      logger.warn({ reason, failures: this.failures }, 'intel-service circuit opened');
    } else if (this.failures > env.intelBreakerThreshold) {
      this.openedAt = Date.now();
    }
  },
  state() {
    return this.isOpen() ? 'open' : this.failures ? 'half-open' : 'closed';
  },
};

async function call(method, path, body, { timeout, bypassBreaker = false } = {}) {
  if (!bypassBreaker && breaker.isOpen()) {
    return { ok: false, data: null, reason: `intel-service circuit open — ${breaker.reason}`, circuit: 'open' };
  }

  try {
    const res = await client.request({ method, url: path, data: body, timeout });
    breaker.recordSuccess();
    return { ok: true, data: res.data, reason: null };
  } catch (err) {
    /**
     * 501 is a CAPABILITY answer, not a failure.
     *
     * intel-service deliberately does not implement the analytics and graph
     * reads — Express already computes those over Postgres, that code is
     * unit-tested and proven by verify-plant, and a second NetworkX copy could
     * silently disagree about who the coordinator is. The service says so with
     * a 501.
     *
     * Counting that against the breaker would be actively harmful: three
     * dashboard loads would trip it, and `/extract` — which the service DOES
     * implement and which Scene 2 depends on — would start failing fast for a
     * service that is perfectly healthy. So a 501 falls back without any
     * effect on health, and it resets the breaker, because receiving one is
     * proof the service answered.
     */
    if (err.response?.status === 501) {
      breaker.recordSuccess();
      return {
        ok: false,
        // A SHORT reason. The service's own `detail` is a paragraph written for
        // a developer reading logs, and it was being piped straight into a UI
        // banner where it filled four lines and read like an outage. The long
        // form stays available on `detail` for anyone who wants it.
        reason: 'computed by the Express core API',
        detail: err.response.data?.detail || null,
        data: null,
        delegated: true,
        circuit: breaker.state(),
      };
    }

    const reason =
      err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT'
        ? `intel-service timed out after ${timeout || env.intelTimeoutMs}ms`
        : err.response
          ? `intel-service returned ${err.response.status}`
          : `intel-service unreachable (${err.code || 'no response'})`;
    breaker.recordFailure(reason);
    return { ok: false, reason, data: null, circuit: breaker.state() };
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
  const r = await call('get', '/health', null, { timeout: 2000, bypassBreaker: true });
  if (!r.ok) return { ...r, circuit: breaker.state() };

  if (r.data?.service !== SERVICE_NAME) {
    const reason =
      `something else is listening on ${env.intelServiceUrl} ` +
      `(reports "${r.data?.service ?? 'unknown'}", expected "${SERVICE_NAME}")`;
    // A stranger on the port is a hard failure, not a transient one — trip the
    // breaker so /extract never posts a complaint narrative to it.
    breaker.recordFailure(reason);
    return { ok: false, data: null, reason, circuit: breaker.state() };
  }
  return { ...r, circuit: breaker.state() };
}

/** Extract entities from a complaint narrative. */
const extract = (narrative, complaintId) =>
  call('post', '/extract', { narrative, complaint_id: complaintId });

/** Merge one complaint and its entities into Neo4j. */
const ingest = (payload) => call('post', '/ingest', payload);

/** Rebuild the whole graph from Postgres. Slow by nature — give it room. */
const ingestBulk = (payload) => call('post', '/ingest/bulk', payload, { timeout: 120_000, bypassBreaker: true });

/** Recompute communities, influence and risk. */
const runAnalytics = () => call('post', '/analytics/run', null, { timeout: 60_000, bypassBreaker: true });

const graphOverview = (limit = 150) => call('get', `/graph/overview?limit=${limit}`);
const graphNeighbors = (nodeId, depth = 1, limit = 50) =>
  call('get', `/graph/neighbors/${encodeURIComponent(nodeId)}?depth=${depth}&limit=${limit}`);
const graphCluster = (clusterKey) => call('get', `/graph/cluster/${encodeURIComponent(clusterKey)}`);

module.exports = {
  health, extract, ingest, ingestBulk, runAnalytics,
  graphOverview, graphNeighbors, graphCluster,
  circuitState: () => breaker.state(),
  resetCircuit: () => { breaker.failures = 0; breaker.openedAt = 0; breaker.reason = null; },
};
