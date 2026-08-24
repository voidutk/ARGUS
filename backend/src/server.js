/**
 * Process lifecycle: start, report, and shut down without losing work.
 *
 * Startup deliberately does NOT require the chain or the intelligence service.
 * Both are probed, both are reported, and neither can stop the API coming up
 * (docs/PROJECT.md §F). A demo machine with no Hardhat node running must still
 * serve every page that does not need one.
 *
 * Postgres is different in kind. It is not optional — every endpoint reads it —
 * but the server still binds its port when Postgres is down, because answering
 * `/health/ready` with a 503 and a reason is more useful to an operator than a
 * process that exits before it can be asked anything.
 */

const app = require('./app');
const env = require('./config/env');
const pool = require('./db/pool');
const logger = require('./lib/logger');
const { describeError } = require('./lib/errors');
const chain = require('./services/chainService');
const intel = require('./services/intelClient');

const banner = (label, text) => console.log(`  ${label.padEnd(16)} ${text}`);

async function reportDependencies() {
  try {
    const r = await pool.query('SELECT count(*)::int AS n FROM complaints');
    banner('postgres', `up — ${r.rows[0].n} complaints`);
  } catch (err) {
    banner('postgres', `DOWN — ${describeError(err)}`);
    banner('', 'run: docker compose up -d && npm run migrate && npm run seed');
  }

  const health = await intel.health();
  banner('intel-service', health.ok
    ? `up — spacy ${health.data?.spacy_loaded ? 'loaded' : 'absent'}, neo4j ${health.data?.neo4j_connected ? 'connected' : 'disconnected'}`
    : `down — ${health.reason} (graph falls back to postgres)`);

  const c = await chain.init();
  banner('chain', c.ready
    ? `up — ${c.network} @ ${c.address}`
    : `down — ${c.reason} (uploads still work, anchors stay PENDING)`);
  console.log('');
}

async function start() {
  const server = app.listen(env.port, () => {
    console.log(`\n  ARGUS core API   http://localhost:${env.port}`);
    banner('environment', env.nodeEnv);
    banner('cors origin', env.corsOrigin.join(', '));
  });

  // Slowloris: a client that opens a socket and dribbles headers forever holds
  // a connection each. Node's defaults are generous; these are not.
  server.headersTimeout = 20_000;
  server.requestTimeout = 60_000;
  server.keepAliveTimeout = 65_000;

  await reportDependencies();

  /**
   * Graceful shutdown.
   *
   * `server.close()` stops accepting new connections and waits for in-flight
   * requests, which matters here specifically because of evidence uploads: a
   * request killed between "file written to disk" and "row inserted" leaves an
   * orphaned ciphertext with no record of what it is. The forced exit is the
   * backstop for a request that will never finish — a hung chain call, a stuck
   * socket — because a process that refuses to die on SIGTERM gets SIGKILLed,
   * and that loses everything the drain was protecting.
   */
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutdown requested');
    console.log(`\n${signal} received — draining`);

    const forced = setTimeout(() => {
      logger.error('drain exceeded 10s — forcing exit');
      process.exit(1);
    }, 10_000);
    forced.unref();

    await new Promise((resolve) => server.close(resolve));
    await pool.end().catch((err) => logger.error({ err: err.message }, 'pool drain failed'));
    clearTimeout(forced);
    logger.info('shutdown complete');
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  /**
   * A rejected promise nobody awaited is a bug, and Node's default for it is to
   * terminate. Logging it and staying up is the right trade for an investigative
   * tool mid-demo: one broken request beats an API that vanishes. An uncaught
   * exception is treated as fatal, because after one the process state is no
   * longer trustworthy — it drains and lets the supervisor restart it clean.
   */
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason instanceof Error ? reason.stack : String(reason) }, 'unhandled rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err: err.stack }, 'uncaught exception — shutting down');
    shutdown('uncaughtException');
  });
}

start().catch((err) => {
  logger.fatal({ err: err.stack }, 'failed to start');
  console.error(err);
  process.exit(1);
});
