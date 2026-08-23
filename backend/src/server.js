const app = require('./app');
const env = require('./config/env');
const pool = require('./db/pool');
const chain = require('./services/chainService');
const intel = require('./services/intelClient');

/**
 * Startup deliberately does NOT require the chain or the intelligence service.
 * Both are probed, both are reported, and neither can stop the API coming up
 * (docs/PROJECT.md §F). A demo machine with no Hardhat node running must still
 * serve every page that does not need one.
 */
async function start() {
  const server = app.listen(env.port, () => {
    console.log(`\n  ARGUS core API   http://localhost:${env.port}`);
    console.log(`  environment      ${env.nodeEnv}`);
    console.log(`  cors origin      ${env.corsOrigin}\n`);
  });

  try {
    const r = await pool.query('SELECT count(*)::int AS n FROM complaints');
    console.log(`  postgres         up — ${r.rows[0].n} complaints`);
  } catch (err) {
    console.error(`  postgres         DOWN — ${err.message}`);
    console.error('                   run: docker compose up -d && npm run migrate && npm run seed');
  }

  const health = await intel.health();
  console.log(health.ok
    ? `  intel-service    up — spacy ${health.data?.spacy_loaded ? 'loaded' : 'absent'}, neo4j ${health.data?.neo4j_connected ? 'connected' : 'disconnected'}`
    : `  intel-service    down — ${health.reason} (graph falls back to postgres)`);

  const c = await chain.init();
  console.log(c.ready
    ? `  chain            up — ${c.network} @ ${c.address}`
    : `  chain            down — ${c.reason} (uploads still work, anchors stay PENDING)`);
  console.log('');

  const shutdown = (sig) => {
    console.log(`\n${sig} received — closing`);
    server.close(() => pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 8000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start();
