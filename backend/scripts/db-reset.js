/**
 * Drops every ARGUS object and rebuilds from migration 001.
 *
 *   node scripts/db-reset.js --yes
 *
 * The escape hatch for the one thing `migrate.js` refuses to do: re-run a
 * migration that has already been applied. That refusal is correct — an applied
 * migration is immutable, because the database and the repository would
 * otherwise disagree with nobody noticing — but during development a migration
 * file legitimately changes while it is being written, and the honest fix is to
 * throw the database away rather than to weaken the guarantee.
 *
 * `--yes` is required. This deletes everything, and a destructive script that
 * runs on a bare invocation will eventually run when someone did not mean it.
 */

const { Pool } = require('pg');
const env = require('../src/config/env');
const migrate = require('../src/db/migrate');

if (!process.argv.includes('--yes')) {
  console.error(
    '\n  This DROPS every ARGUS table and all their data.\n'
    + '  Re-run with --yes if that is what you want:\n\n'
    + '      node scripts/db-reset.js --yes\n'
  );
  process.exit(1);
}

if (env.isProduction) {
  console.error('\n  Refusing to run against NODE_ENV=production.\n');
  process.exit(1);
}

const pool = new Pool({ connectionString: env.databaseUrl, max: 1, application_name: 'argus-reset' });

// Ordered outward-in is unnecessary with CASCADE, but listing them explicitly
// means this script drops OUR objects rather than everything in the schema — it
// will not quietly take out a table someone else put in the same database.
const TABLES = [
  'schema_migrations',
  'audit_logs', 'alerts', 'investigations', 'verifications',
  'evidence_anchors', 'evidence', 'transactions', 'entity_links',
  'complaint_entities', 'clusters', 'entities', 'complaints',
  'users', 'units', 'crime_reference', 'fraud_reference',
];

const SEQUENCES = ['complaint_ref_seq'];

async function main() {
  console.log(`\n  Resetting ${env.databaseUrl.replace(/:[^:@]*@/, ':***@')}\n`);

  for (const table of TABLES) {
    await pool.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
    console.log(`  dropped  ${table}`);
  }
  for (const seq of SEQUENCES) {
    await pool.query(`DROP SEQUENCE IF EXISTS ${seq} CASCADE`);
    console.log(`  dropped  sequence ${seq}`);
  }

  console.log('');
  await migrate.run();
  console.log('\n  Next: npm run seed && npm run load-reference\n');
  await pool.end();
}

main().catch(async (err) => {
  console.error(`\n  Reset failed: ${err.message}\n`);
  await pool.end().catch(() => {});
  process.exit(1);
});
