/**
 * Proves the seed is deterministic — docs/PLAN-V2-DATA-AND-INTEL.md §5.
 *
 *   node scripts/verify-determinism.js
 *
 * The plan claims "two runs, content-hashed — identical". That claim had no
 * script behind it, which made it an assertion rather than a check. This is the
 * check.
 *
 * Why it matters more than it sounds: a demo that reshuffles itself cannot be
 * rehearsed. If the coordinator's name, the cluster sizes, or the money ladder
 * change between runs, every rehearsed line is wrong on stage, and
 * `verify-plant` proving the topology on Tuesday says nothing about Wednesday.
 *
 * The hash covers CONTENT, not identity: every narrative, every normalised
 * entity value, every transaction amount and hop. Serial ids are excluded on
 * purpose — they are assigned by the database and would differ between runs
 * even if every meaningful value were identical, which would make the check
 * fail for a reason nobody cares about.
 *
 * This script RE-SEEDS the database twice. It regenerates the alert feed at the
 * end so the database is left ready to serve.
 */

const crypto = require('crypto');
const { execFileSync } = require('child_process');
const path = require('path');
const pool = require('../src/db/pool');

const ROOT = path.resolve(__dirname, '..');

function run(script) {
  execFileSync(process.execPath, [script], { cwd: ROOT, stdio: 'pipe' });
}

/**
 * A content hash of everything the seed writes.
 *
 * Ordered by natural keys rather than by id, so two runs that assign different
 * serial numbers to the same rows still hash identically — and two runs that
 * produce genuinely different data cannot.
 */
async function contentHash() {
  const queries = {
    complaints: `SELECT complaint_ref, victim_name, victim_phone, victim_email, narrative,
                        scam_category, amount_inr::text, state, district, status
                   FROM complaints ORDER BY complaint_ref`,
    entities: `SELECT entity_type, normalized_value, value, label, is_flagged
                 FROM entities ORDER BY entity_type, normalized_value`,
    complaint_entities: `SELECT c.complaint_ref, e.entity_type, e.normalized_value,
                                ce.role, ce.method, ce.confidence::text
                           FROM complaint_entities ce
                           JOIN complaints c ON c.id = ce.complaint_id
                           JOIN entities e ON e.id = ce.entity_id
                          ORDER BY c.complaint_ref, e.entity_type, e.normalized_value, ce.role`,
    entity_links: `SELECT f.entity_type AS ft, f.normalized_value AS fv,
                          t.entity_type AS tt, t.normalized_value AS tv,
                          el.relationship, el.weight::text, el.source
                     FROM entity_links el
                     JOIN entities f ON f.id = el.from_entity_id
                     JOIN entities t ON t.id = el.to_entity_id
                    ORDER BY ft, fv, tt, tv, el.relationship`,
    transactions: `SELECT c.complaint_ref, f.normalized_value AS fv, t2.normalized_value AS tv,
                          t.amount_inr::text, t.rail, t.hop_index, t.reference
                     FROM transactions t
                     LEFT JOIN complaints c ON c.id = t.complaint_id
                     JOIN entities f ON f.id = t.from_entity_id
                     JOIN entities t2 ON t2.id = t.to_entity_id
                    ORDER BY c.complaint_ref, t.hop_index, f.normalized_value, t2.normalized_value`,
    clusters: `SELECT cluster_key, label, description, risk_level, risk_score,
                      node_count, complaint_count, total_amount_inr::text, states_touched
                 FROM clusters ORDER BY cluster_key`,
    users: `SELECT email, full_name, role, rank_title FROM users ORDER BY email`,
  };

  const perTable = {};
  const overall = crypto.createHash('sha256');

  for (const [name, sql] of Object.entries(queries)) {
    const { rows } = await pool.query(sql);
    const table = crypto.createHash('sha256');
    for (const row of rows) table.update(JSON.stringify(row));
    const digest = table.digest('hex');
    perTable[name] = { digest, rows: rows.length };
    overall.update(`${name}:${digest}`);
  }

  return { overall: overall.digest('hex'), perTable };
}

async function main() {
  console.log('\nARGUS seed determinism\n');

  console.log('  seeding (run 1)…');
  run('src/db/seed.js');
  const first = await contentHash();

  console.log('  seeding (run 2)…');
  run('src/db/seed.js');
  const second = await contentHash();

  console.log('');
  let mismatches = 0;
  for (const name of Object.keys(first.perTable)) {
    const a = first.perTable[name];
    const b = second.perTable[name];
    const same = a.digest === b.digest && a.rows === b.rows;
    if (!same) mismatches++;
    console.log(
      `  ${same ? 'ok   ' : 'DIFFER'}  ${name.padEnd(20)} ${String(a.rows).padStart(6)} rows  ${a.digest.slice(0, 16)}…`
      + (same ? '' : `\n          run 2: ${String(b.rows).padStart(6)} rows  ${b.digest.slice(0, 16)}…`)
    );
  }

  console.log('');
  console.log(`  run 1 content hash  ${first.overall}`);
  console.log(`  run 2 content hash  ${second.overall}`);
  console.log('');

  // Leave the database usable: the seed no longer writes alerts, so without
  // this the threat feed would be empty after running a verification script.
  console.log('  regenerating the alert feed…');
  const alertRules = require('../src/services/alertRules');
  const result = await alertRules.run();
  console.log(`  ${result.created + result.updated} alerts in the feed\n`);

  await pool.end();

  if (mismatches || first.overall !== second.overall) {
    console.log('  FAILED — the seed is not deterministic. A demo that reshuffles itself');
    console.log('           cannot be rehearsed, and verify-plant proves nothing about the');
    console.log('           dataset that will actually be on screen.\n');
    process.exit(1);
  }
  console.log('  Two independent seed runs produced byte-identical content.\n');

  /**
   * This check re-seeds twice, and a seed TRUNCATEs. Everything computed or
   * sealed after the last seed is therefore gone: entity influence and risk are
   * back to zero, and the evidence locker is empty. Both look like ordinary
   * page bugs if you open the UI next without knowing why — "influence 0" and
   * "Nothing sealed yet" — so say it plainly rather than leaving it to be
   * rediscovered an hour before a demo.
   */
  console.log('  NOTE — this check re-seeded the database. Scores and evidence were');
  console.log('         truncated with it. Restore them before demoing:\n');
  console.log('           npm run compute-scores && npm run seed:evidence\n');
}

main().catch(async (err) => {
  console.error(`\nDeterminism check failed to run: ${err.message}\n`);
  await pool.end().catch(() => {});
  process.exit(1);
});
