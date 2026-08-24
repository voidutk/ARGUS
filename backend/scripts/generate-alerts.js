/**
 * Runs the alert rules once and reports what they found.
 *
 *   node scripts/generate-alerts.js
 *
 * Part of `npm run setup`, because the seed no longer writes alerts: the threat
 * feed is produced by rules over the seeded data rather than by prose written
 * alongside it (docs/PLAN-V2-DATA-AND-INTEL.md §3.3). Also useful on its own
 * after loading new data, and equivalent to `POST /api/alerts/regenerate`.
 */

const pool = require('../src/db/pool');
const alertRules = require('../src/services/alertRules');

async function main() {
  console.log('\nARGUS alert rules\n');

  const result = await alertRules.run();

  for (const r of result.detail) {
    if (r.error) {
      console.log(`  FAILED   ${r.rule.padEnd(24)} ${r.error}`);
      continue;
    }
    console.log(
      `  ${String(r.matched).padStart(4)} matched  ${r.rule.padEnd(24)}`
      + `  ${r.created} new, ${r.updated} refreshed   ${r.duration_ms}ms`
    );
  }

  const { rows } = await pool.query(
    `SELECT severity, count(*)::int AS n FROM alerts WHERE rule_key IS NOT NULL
      GROUP BY severity
      ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1
                             WHEN 'MEDIUM' THEN 2 ELSE 3 END`
  );

  console.log(`\n  ${result.created} created, ${result.updated} refreshed\n`);
  console.log('  threat feed by severity:');
  for (const r of rows) console.log(`      ${r.severity.padEnd(10)} ${r.n}`);

  const failed = result.detail.filter((r) => r.error);
  console.log('');
  await pool.end();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (err) => {
  console.error(`\nAlert generation failed: ${err.message}\n`);
  await pool.end().catch(() => {});
  process.exit(1);
});
