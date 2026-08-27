/**
 * End-to-end proof of the evidence integrity claim (docs/PROJECT.md §J, §U).
 *
 *   node scripts/evidence-e2e.js [baseUrl]
 *
 * Runs the whole exhibit lifecycle against a live API and a live chain:
 *
 *   upload -> anchor -> verify (passes) -> TAMPER -> verify (fails loudly)
 *   -> confirm the failure is permanently on-chain
 *
 * The last step is the one that matters. Anyone can show a hash matching. The
 * claim ARGUS makes is that a MISMATCH is recorded on the same terms as a match
 * and cannot be quietly removed — that is the whole argument for putting this on
 * a chain instead of in a table. If this script ever passes the tamper step,
 * the product does not work.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE = process.argv[2] || process.env.ARGUS_URL || 'http://localhost:4000';
const CRED = { email: 'investigator@argus.gov.in', password: 'argus2026' };

let token = null;
const failures = [];
let pass = 0;

function check(name, condition, detail) {
  if (condition === true) { pass++; console.log(`  ok    ${name}`); return true; }
  failures.push(`${name} — ${detail || condition}`);
  console.log(`  FAIL  ${name}  — ${detail || condition}`);
  return false;
}

async function api(method, urlPath, body) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${urlPath}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`\nARGUS evidence lifecycle → ${BASE}\n`);

  // --- login ---------------------------------------------------------------
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(CRED),
  }).then((r) => r.json());
  if (!login.token) { console.error('login failed:', login); process.exit(1); }
  token = login.token;
  check('login', true);

  const chain = await api('GET', '/api/chain/status');
  if (!chain.body?.ready) {
    console.error(`\n  Chain is not ready: ${chain.body?.reason}`);
    console.error('  Start it first:  npx hardhat node   &&   npm --prefix blockchain run deploy:local\n');
    process.exit(1);
  }
  check('chain is ready', true, chain.body.network);

  // --- upload --------------------------------------------------------------
  const content = Buffer.from(
    `WhatsApp export — ARGUS e2e exhibit\n`
    + `generated ${new Date().toISOString()}\n`
    + `nonce ${crypto.randomBytes(16).toString('hex')}\n`
    + `"Sir aapka parcel customs me atka hai, 48500 turant transfer kijiye."\n`
  );
  const expectedDigest = crypto.createHash('sha256').update(content).digest('hex');

  const form = new FormData();
  form.append('file', new Blob([content], { type: 'text/plain' }), 'exhibit-a.txt');
  form.append('title', 'E2E exhibit — chat export');
  form.append('evidence_type', 'CHAT_LOG');

  const up = await fetch(`${BASE}/api/evidence/upload`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
  });
  const uploaded = await up.json();
  if (up.status !== 201) { console.error('upload failed:', uploaded); process.exit(1); }

  const ev = uploaded.evidence;
  check('upload accepted', up.status === 201);
  check('server hashed the plaintext correctly',
    ev.sha256_hash === expectedDigest,
    `server said ${ev.sha256_hash?.slice(0, 16)}…, we computed ${expectedDigest.slice(0, 16)}…`);
  check('anchor starts PENDING (upload is not blocked on the chain)',
    ev.anchor.status === 'PENDING', `was ${ev.anchor.status}`);

  // --- wait for the async anchor ------------------------------------------
  let anchored = null;
  for (let i = 0; i < 25; i++) {
    await sleep(600);
    const { body } = await api('GET', `/api/evidence?complaint_id=`);
    const row = body?.evidence?.find((e) => e.id === ev.id);
    if (row?.anchor?.status === 'ANCHORED') { anchored = row; break; }
    if (row?.anchor?.status === 'FAILED') { anchored = row; break; }
  }
  check('anchor reached ANCHORED',
    anchored?.anchor?.status === 'ANCHORED',
    `status is ${anchored?.anchor?.status ?? 'still pending after 15s'}`);
  if (anchored?.anchor?.tx_hash) {
    console.log(`        tx ${anchored.anchor.tx_hash.slice(0, 22)}…  block ${anchored.anchor.block_number}`);
  }

  // --- verify: should PASS --------------------------------------------------
  const v1 = await api('POST', `/api/evidence/${ev.id}/verify`);
  check('verify passes on an untouched exhibit', v1.body?.is_valid === true, v1.body?.note);
  check('verify confirms the digest is on-chain', v1.body?.chain?.exists === true);
  check('custody trail has 1 entry',
    v1.body?.history?.length === 1, `has ${v1.body?.history?.length}`);
  check('that entry records a PASS',
    v1.body?.history?.[0]?.matched === true);

  // --- TAMPER ---------------------------------------------------------------
  // Re-encrypt DIFFERENT content under the real key. This is the hard case: the
  // file still decrypts cleanly, so only the digest comparison catches it. A bit
  // flip would be caught by AES-GCM's auth tag without the hash doing any work,
  // which would not actually test what we claim to test.
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const key = Buffer.from(process.env.EVIDENCE_ENCRYPTION_KEY, 'hex');

  const pool = require('../src/db/pool');
  const { rows } = await pool.query('SELECT encrypted_path, iv, auth_tag FROM evidence WHERE id=$1', [ev.id]);
  const stored = rows[0];

  const forged = Buffer.from(
    'WhatsApp export — ARGUS e2e exhibit\n'
    + 'THIS LINE WAS SUBSTITUTED AFTER THE EXHIBIT WAS SEALED\n'
  );
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  // Must match evidenceController.aadFor(ev.id) — this re-encryption keeps the
  // SAME row identity, so it should still decrypt cleanly and be caught by the
  // digest comparison, not by an AAD mismatch. The AAD-mismatch case (a
  // DIFFERENT row's crypto envelope) is exercised separately below.
  cipher.setAAD(Buffer.from(`evidence:${ev.id}`, 'utf8'));
  const ct = Buffer.concat([cipher.update(forged), cipher.final()]);

  const storeDir = path.resolve(process.cwd(), process.env.STORAGE_DIR || 'storage/evidence');
  fs.writeFileSync(path.join(storeDir, stored.encrypted_path), ct);
  await pool.query('UPDATE evidence SET iv=$2, auth_tag=$3 WHERE id=$1',
    [ev.id, iv.toString('hex'), cipher.getAuthTag().toString('hex')]);
  console.log('\n  -- exhibit substituted on disk with valid ciphertext --\n');

  // --- verify: must FAIL ----------------------------------------------------
  const v2 = await api('POST', `/api/evidence/${ev.id}/verify`);
  check('verify FAILS on the substituted exhibit', v2.body?.is_valid === false, v2.body?.note);
  check('the failure names the cause',
    typeof v2.body?.note === 'string' && v2.body.note.includes('mismatch'),
    `note was "${v2.body?.note}"`);
  check('recomputed digest differs from the sealed one',
    v2.body?.computed_hash !== v2.body?.stored_hash);
  check('the sealed digest is unchanged',
    v2.body?.stored_hash === expectedDigest,
    'the original digest must survive tampering — it is the reference');

  // --- the claim: the failure is permanent ---------------------------------
  const hist = await api('GET', `/api/evidence/${ev.id}/history`);
  const onChain = hist.body?.on_chain || [];
  check('custody trail grew to 2 entries', onChain.length === 2, `has ${onChain.length}`);
  check('entry 1 is the PASS', onChain[0]?.matched === true);
  check('entry 2 is the FAILURE, recorded on-chain',
    onChain[1]?.matched === false,
    'a tamper that leaves no permanent trace would defeat the entire design');
  check('the failure carries its reason on-chain',
    typeof onChain[1]?.note === 'string' && onChain[1].note.length > 0,
    `note was "${onChain[1]?.note}"`);

  console.log('\n  on-chain chain of custody:');
  onChain.forEach((h, i) => {
    console.log(`    ${i + 1}. ${h.matched ? 'MATCH   ' : 'MISMATCH'}  ${h.checked_at}  "${h.note}"`);
  });

  // --- cross-row AAD binding ------------------------------------------------
  // A harder attack than editing one file: copy ANOTHER exhibit's entire
  // crypto envelope (ciphertext + iv + auth_tag) onto this row. Before AAD
  // binding, if the attacker also overwrote sha256_hash to match, this would
  // decrypt cleanly and hash-match — a full identity swap invisible to the
  // digest check alone. AAD ties ciphertext to the row's OWN id, so decrypting
  // under evidence A's id with evidence B's envelope must fail outright.
  console.log('\n  -- cross-row swap: exhibit B\'s crypto envelope copied onto exhibit A\'s row --\n');

  const content2 = Buffer.from(`unrelated exhibit ${crypto.randomBytes(8).toString('hex')}\n`);
  const form2 = new FormData();
  form2.append('file', new Blob([content2], { type: 'text/plain' }), 'exhibit-b.txt');
  form2.append('title', 'E2E exhibit B — for cross-row swap test');
  form2.append('evidence_type', 'CHAT_LOG');
  const up2 = await fetch(`${BASE}/api/evidence/upload`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form2,
  });
  const evB = (await up2.json()).evidence;
  check('second exhibit uploaded for the swap test', up2.status === 201);

  const { rows: bRows } = await pool.query(
    'SELECT encrypted_path, iv, auth_tag FROM evidence WHERE id=$1', [evB.id]
  );
  const bCiphertext = fs.readFileSync(path.join(storeDir, bRows[0].encrypted_path));
  fs.writeFileSync(path.join(storeDir, stored.encrypted_path), bCiphertext);
  await pool.query('UPDATE evidence SET iv=$2, auth_tag=$3 WHERE id=$1',
    [ev.id, bRows[0].iv, bRows[0].auth_tag]);

  const v3 = await api('POST', `/api/evidence/${ev.id}/verify`);
  check('verify FAILS when another exhibit\'s envelope is substituted whole',
    v3.body?.is_valid === false, v3.body?.note);
  check('the cause is an unreadable/unauthenticated envelope, not just a hash mismatch',
    typeof v3.body?.note === 'string' && v3.body.note.includes('unreadable'),
    `note was "${v3.body?.note}"`);

  // --- RBAC on raw evidence access ------------------------------------------
  console.log('\n  -- RBAC: an ANALYST must not be able to download raw evidence --\n');

  const analystLogin = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'analyst@argus.gov.in', password: 'argus2026' }),
  }).then((r) => r.json());
  const dl = await fetch(`${BASE}/api/evidence/${ev.id}/download`, {
    headers: { Authorization: `Bearer ${analystLogin.token}` },
  });
  check('ANALYST gets 403 on evidence download', dl.status === 403, `got ${dl.status}`);

  await pool.end();

  // --- report ---------------------------------------------------------------
  console.log(`\n${'='.repeat(64)}`);
  if (failures.length) {
    console.log(`\n${pass} passed, ${failures.length} FAILED\n`);
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    console.log('');
    process.exit(1);
  }
  console.log(`\nAll ${pass} checks passed — tamper was detected and permanently recorded.\n`);
}

main().catch((err) => { console.error('\ne2e crashed:', err); process.exit(1); });
