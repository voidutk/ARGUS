/**
 * Migration runner.
 *
 * The previous version replayed every .sql file on every run. That works for
 * exactly as long as every migration is idempotent, and stops working the first
 * time someone writes `ALTER TABLE ... ADD COLUMN` or a data backfill — which
 * is to say, the first real migration. This version records what has run.
 *
 * Three properties it guarantees:
 *
 *   applied once   — a file that has run is skipped, so migrations may contain
 *                    non-idempotent DDL and one-shot backfills.
 *   unmodified     — each file's SHA-256 is stored. Editing an applied migration
 *                    is refused rather than silently ignored, because the
 *                    database and the repository would otherwise disagree with
 *                    nobody noticing.
 *   one at a time  — a session-level advisory lock means two processes racing
 *                    to migrate (an API restart during a deploy, two terminals)
 *                    cannot interleave DDL.
 *
 * Each file runs inside its own transaction, so a migration that fails halfway
 * leaves nothing behind. Postgres does transactional DDL; this is free here and
 * would be impossible on MySQL.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const env = require('../config/env');

// A distinct pool: migrations legitimately run longer than the API's statement
// timeout (a backfill over 9,000 NCRB rows is not a slow query, it is a load).
const pool = new Pool({
  connectionString: env.databaseUrl,
  max: 1,
  application_name: 'argus-migrate',
});

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const LOCK_KEY = 8_421_337; // arbitrary but fixed; shared by every migrator

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

async function ensureLedger(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      checksum    CHAR(64) NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      duration_ms INTEGER NOT NULL DEFAULT 0
    )`);
}

function readMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((filename) => {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
      return { filename, sql, checksum: sha256(sql) };
    });
}

async function run({ silent = false } = {}) {
  const log = silent ? () => {} : (...a) => console.log(...a);
  const client = await pool.connect();
  let locked = false;

  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    locked = true;

    await ensureLedger(client);
    const { rows: applied } = await client.query('SELECT filename, checksum FROM schema_migrations');
    const appliedBy = new Map(applied.map((r) => [r.filename, r.checksum]));

    const files = readMigrations();
    if (!files.length) { log('No migrations found.'); return { applied: 0, skipped: 0 }; }

    // Detect edits to already-applied files before running anything, so the
    // run either proceeds cleanly or refuses without half-applying.
    const drifted = files.filter(
      (f) => appliedBy.has(f.filename) && appliedBy.get(f.filename) !== f.checksum
    );
    if (drifted.length) {
      throw new Error(
        `Migration file(s) changed after being applied:\n` +
        drifted.map((f) => `    • ${f.filename}`).join('\n') +
        `\n\n  A migration is immutable once it has run. Add a new numbered file instead.\n` +
        `  If this database is disposable, reset it:  npm run db:reset\n`
      );
    }

    let count = 0;
    for (const file of files) {
      if (appliedBy.has(file.filename)) { log(`  skip     ${file.filename}`); continue; }

      const startedAt = Date.now();
      await client.query('BEGIN');
      try {
        await client.query(file.sql);
        await client.query(
          `INSERT INTO schema_migrations (filename, checksum, duration_ms) VALUES ($1, $2, $3)`,
          [file.filename, file.checksum, Date.now() - startedAt]
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`Migration ${file.filename} failed and was rolled back:\n  ${err.message}`);
      }
      log(`  applied  ${file.filename}  (${Date.now() - startedAt}ms)`);
      count++;
    }

    log(count ? `\nMigrations complete — ${count} applied.` : '\nMigrations complete — already up to date.');
    return { applied: count, skipped: files.length - count };
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
}

module.exports = { run };

if (require.main === module) {
  run()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch(async (err) => {
      console.error(`\nMigration failed:\n  ${err.message}\n`);
      await pool.end().catch(() => {});
      process.exit(1);
    });
}
