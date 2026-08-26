/**
 * Liveness and readiness, which are different questions.
 *
 *   /health        is this process alive? Answers from memory, touches nothing.
 *                  An orchestrator restarts the container when this fails, so it
 *                  must never depend on Postgres — a database blip would
 *                  otherwise trigger a restart storm that makes recovery slower.
 *
 *   /health/ready  can this process serve traffic? Checks Postgres, because a
 *                  request that needs the database is the only kind we have.
 *                  Returns 503 when it cannot, so a load balancer drains this
 *                  instance instead of sending it work it will fail.
 *
 * The optional services — intel-service and the chain — are reported but never
 * gate readiness. §F is explicit that neither may be a single point of failure,
 * and a readiness probe that fails when the AI service restarts would turn an
 * advisory dependency into a hard one.
 */

const express = require('express');
const pool = require('../db/pool');
const env = require('../config/env');
const { asyncHandler, describeError } = require('../lib/errors');

const router = express.Router();
const startedAt = Date.now();

router.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'argus-core',
    env: env.nodeEnv,
    version: require('../../package.json').version,
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
  });
});

router.get('/ready', asyncHandler(async (req, res) => {
  let postgres;
  try {
    postgres = { ok: true, ...(await pool.ping()) };
  } catch (err) {
    postgres = { ok: false, error: describeError(err) };
  }

  const ready = postgres.ok;
  res.status(ready ? 200 : 503).json({
    ready,
    checks: {
      postgres,
      pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
    },
  });
}));

module.exports = router;
