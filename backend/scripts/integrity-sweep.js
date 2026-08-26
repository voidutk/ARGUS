/**
 * Proactive disk-integrity check for evidence already at rest.
 *
 *   node scripts/integrity-sweep.js [baseUrl]
 *
 * /api/evidence/:id/verify only runs when someone happens to re-check one
 * exhibit. This calls the admin-only /api/evidence/integrity-sweep endpoint,
 * which decrypts and re-hashes every exhibit in one pass and reports any that
 * no longer match — catching disk-level tampering or corruption on exhibits
 * nobody happened to be looking at.
 */

const BASE = process.argv[2] || process.env.ARGUS_URL || 'http://localhost:4000';
const CRED = { email: 'admin@argus.gov.in', password: 'argus2026' };

async function main() {
  console.log(`\nARGUS evidence integrity sweep → ${BASE}\n`);

  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(CRED),
  }).then((r) => r.json());
  if (!login.token) { console.error('login failed:', login); process.exit(1); }

  const res = await fetch(`${BASE}/api/evidence/integrity-sweep`, {
    method: 'POST', headers: { Authorization: `Bearer ${login.token}` },
  });
  const body = await res.json();
  if (res.status !== 200) { console.error('sweep request failed:', body); process.exit(1); }

  console.log(`  scanned    ${body.scanned}`);
  console.log(`  anomalies  ${body.anomalies.length}`);
  if (body.anomalies.length) {
    console.log('');
    body.anomalies.forEach((a) => console.log(`    evidence #${a.id} "${a.title}" — ${a.reason}`));
    console.log('\n  Investigate these before relying on their chain-of-custody status.\n');
    process.exit(1);
  }
  console.log('\n  All exhibits at rest still match their sealed digest.\n');
}

main().catch((err) => { console.error('\nintegrity sweep crashed:', err); process.exit(1); });
