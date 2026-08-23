/**
 * End-to-end smoke test against a running ARGUS core API.
 *
 *   node scripts/smoke.js [baseUrl]
 *
 * Hits every endpoint in docs/API.md with a real token and asserts the response
 * SHAPE, not just the status code — a 200 carrying an empty array is exactly the
 * failure that looks fine in a terminal and renders an empty page on stage.
 *
 * Exits non-zero on any failure so it can gate a commit.
 */

const BASE = process.argv[2] || process.env.ARGUS_URL || 'http://localhost:4000';
const CRED = { email: 'investigator@argus.gov.in', password: 'argus2026' };

let token = null;
let pass = 0;
const failures = [];

async function req(method, path, { body, raw = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return { status: res.status, body: await res.text() };
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, body: json };
}

/** `check` receives the parsed body and returns true, or a string describing the miss. */
async function test(name, method, path, check, opts = {}) {
  try {
    const { status, body } = await req(method, path, opts);
    const expected = opts.expectStatus || 200;
    if (status !== expected) {
      failures.push(`${name}\n      expected HTTP ${expected}, got ${status}` +
        (body?.error ? ` — ${body.error}` : ''));
      console.log(`  FAIL  ${name}  (HTTP ${status})`);
      return null;
    }
    const verdict = check ? check(body) : true;
    if (verdict !== true) {
      failures.push(`${name}\n      ${verdict}`);
      console.log(`  FAIL  ${name}  — ${verdict}`);
      return body;
    }
    pass++;
    console.log(`  ok    ${name}`);
    return body;
  } catch (err) {
    failures.push(`${name}\n      threw: ${err.message}`);
    console.log(`  FAIL  ${name}  — ${err.message}`);
    return null;
  }
}

const nonEmpty = (key) => (b) =>
  Array.isArray(b?.[key]) && b[key].length > 0 ? true : `${key} was empty or missing`;

async function main() {
  console.log(`\nARGUS smoke test → ${BASE}\n`);

  // --- unauthenticated -----------------------------------------------------
  await test('health', 'GET', '/health', (b) =>
    b?.service === 'argus-core' ? true : `service was "${b?.service}"`);

  await test('auth rejects a bad password', 'POST', '/api/auth/login',
    (b) => (b?.error ? true : 'expected an error body'),
    { body: { ...CRED, password: 'wrong' }, expectStatus: 401 });

  await test('protected route rejects anonymous', 'GET', '/api/complaints',
    () => true, { expectStatus: 401 });

  // --- login ---------------------------------------------------------------
  const login = await test('login', 'POST', '/api/auth/login',
    (b) => (b?.token && b?.user?.role ? true : 'no token or role'), { body: CRED });
  if (!login?.token) {
    console.log('\nCannot continue without a token.\n');
    process.exit(1);
  }
  token = login.token;

  await test('auth/me', 'GET', '/api/auth/me',
    (b) => (b?.user?.email === CRED.email ? true : 'wrong user'));

  // --- dashboard -----------------------------------------------------------
  await test('dashboard/summary', 'GET', '/api/dashboard/summary', (b) => {
    if (typeof b?.threat_index !== 'number') return 'threat_index missing';
    if (b.threat_index < 0 || b.threat_index > 100) return `threat_index out of range: ${b.threat_index}`;
    if (!b.complaints_total) return 'complaints_total is zero';
    if (!Array.isArray(b.top_clusters) || !b.top_clusters.length) return 'top_clusters empty';
    if (!Array.isArray(b.recent_complaints) || !b.recent_complaints.length) return 'recent_complaints empty';
    return true;
  });

  // --- complaints ----------------------------------------------------------
  const list = await test('complaints list', 'GET', '/api/complaints?limit=5', (b) => {
    if (!Array.isArray(b?.complaints) || b.complaints.length !== 5) return 'expected 5 complaints';
    if (typeof b.total !== 'number' || b.total < 200) return `total looks wrong: ${b.total}`;
    return true;
  });

  await test('complaints filter by state', 'GET', '/api/complaints?state=Karnataka&limit=3',
    (b) => (b?.complaints?.every((c) => c.state === 'Karnataka') ? true : 'state filter leaked'));

  await test('complaints search', 'GET', '/api/complaints?q=NCRP&limit=3', nonEmpty('complaints'));

  const cid = list?.complaints?.[0]?.id;
  await test('complaint detail', 'GET', `/api/complaints/${cid}`, (b) => {
    if (!b?.complaint?.narrative) return 'no narrative';
    if (!Array.isArray(b.entities) || !b.entities.length) return 'no extracted entities';
    return true;
  });

  await test('complaint 404s cleanly', 'GET', '/api/complaints/999999',
    (b) => (b?.error ? true : 'no error body'), { expectStatus: 404 });

  // --- clusters ------------------------------------------------------------
  const clusters = await test('clusters list', 'GET', '/api/clusters', (b) => {
    if (!Array.isArray(b?.clusters) || b.clusters.length < 3) return 'expected 3+ clusters';
    if (!b.clusters.every((c) => c.mastermind_label)) return 'a cluster has no mastermind';
    return true;
  });

  const key = clusters?.clusters?.[0]?.cluster_key;
  await test('cluster detail', 'GET', `/api/clusters/${key}`, (b) => {
    if (!b?.cluster) return 'no cluster';
    if (!b.mastermind) return 'no mastermind';
    if (!Array.isArray(b.top_entities) || !b.top_entities.length) return 'no top_entities';
    if (!Array.isArray(b.complaints) || !b.complaints.length) return 'no complaints';
    return true;
  });

  // --- graph ---------------------------------------------------------------
  const graph = await test('graph overview', 'GET', '/api/graph/overview?limit=120', (b) => {
    if (!Array.isArray(b?.nodes) || b.nodes.length < 50) return `only ${b?.nodes?.length} nodes`;
    if (!Array.isArray(b.edges) || !b.edges.length) return 'no edges';
    const n = b.nodes[0];
    for (const f of ['id', 'label', 'type', 'influence', 'degree']) {
      if (!(f in n)) return `node missing "${f}" — breaks the Cytoscape contract`;
    }
    const e = b.edges[0];
    for (const f of ['id', 'source', 'target', 'type']) {
      if (!(f in e)) return `edge missing "${f}"`;
    }
    // Every edge must land on a node we actually returned, or Cytoscape throws.
    const ids = new Set(b.nodes.map((x) => x.id));
    const dangling = b.edges.find((x) => !ids.has(x.source) || !ids.has(x.target));
    if (dangling) return `edge ${dangling.id} references a node not in the payload`;
    return true;
  });

  // The coordinator must be visible in the default view — scene 4 depends on it.
  await test('graph overview surfaces a mastermind', 'GET', '/api/graph/overview?limit=150',
    (b) => (b?.nodes?.some((n) => n.is_mastermind) ? true : 'no mastermind node in the opening view'));

  const topNode = graph?.nodes?.[0]?.id;
  await test('graph neighbors', 'GET',
    `/api/graph/neighbors/${encodeURIComponent(topNode)}?depth=1&limit=25`, (b) => {
      if (!Array.isArray(b?.nodes) || b.nodes.length < 2) return 'expansion returned nothing';
      if (b.nodes[0].id !== topNode) return 'first node should be the one expanded';
      return true;
    });

  await test('graph neighbors 404s on nonsense', 'GET',
    '/api/graph/neighbors/phone%3Anot-a-real-node', () => true, { expectStatus: 404 });

  await test('graph cluster subgraph', 'GET', `/api/graph/cluster/${key}`, (b) => {
    if (!Array.isArray(b?.nodes) || b.nodes.length < 20) return `only ${b?.nodes?.length} nodes`;
    if (!b.cluster?.cluster_key) return 'no cluster meta';
    return true;
  });

  // --- entities ------------------------------------------------------------
  const ents = await test('entities list, flagged wallets', 'GET',
    '/api/entities?type=WALLET&flagged=true&limit=10', nonEmpty('entities'));

  const eid = ents?.entities?.[0]?.id;
  await test('entity detail', 'GET', `/api/entities/${eid}`, (b) => {
    if (!b?.entity) return 'no entity';
    if (!b.node_id) return 'no node_id — the UI cannot jump to the graph without it';
    return true;
  });

  // --- geo -----------------------------------------------------------------
  await test('geo states', 'GET', '/api/geo/states', (b) => {
    if (!Array.isArray(b?.states) || b.states.length < 5) return 'too few states';
    const s = b.states[0];
    if (typeof s.intensity !== 'number') return 'no intensity';
    if (!s.risk_level) return 'no risk_level';
    return true;
  });

  await test('geo routes', 'GET', '/api/geo/routes', (b) =>
    Array.isArray(b?.routes) ? true : 'routes missing');

  // --- money ---------------------------------------------------------------
  // Find a GAMMA complaint — those carry the full six-hop ladder.
  const gamma = await req('GET', '/api/clusters/GAMMA');
  const gammaComplaint = gamma.body?.complaints?.[0]?.id;
  if (gammaComplaint) {
    await test('money trace (laundering ladder)', 'GET', `/api/money/trace/${gammaComplaint}`, (b) => {
      if (!Array.isArray(b?.nodes) || b.nodes.length < 4) return `only ${b?.nodes?.length} hops`;
      if (!Array.isArray(b.links) || !b.links.length) return 'no links';
      if (!b.summary) return 'no summary';
      const ids = new Set(b.nodes.map((x) => x.id));
      const bad = b.links.find((l) => !ids.has(l.source) || !ids.has(l.target));
      if (bad) return 'sankey link references a missing node';
      if (b.summary.hops < 5) return `expected a deep chain, got ${b.summary.hops} hops`;
      return true;
    });
  } else {
    failures.push('money trace — could not find a GAMMA complaint to trace');
    console.log('  FAIL  money trace — no GAMMA complaint found');
  }

  // --- alerts --------------------------------------------------------------
  const alerts = await test('alerts list', 'GET', '/api/alerts', (b) => {
    if (!Array.isArray(b?.alerts) || !b.alerts.length) return 'no alerts';
    if (!b.counts || typeof b.counts.CRITICAL !== 'number') return 'no severity counts';
    return true;
  });

  const aid = alerts?.alerts?.[0]?.id;
  await test('alert acknowledge', 'PATCH', `/api/alerts/${aid}`,
    (b) => (b?.alert?.status === 'ACKNOWLEDGED' ? true : 'status did not change'),
    { body: { status: 'ACKNOWLEDGED' } });
  await test('alert rejects a bad status', 'PATCH', `/api/alerts/${aid}`,
    () => true, { body: { status: 'BANANA' }, expectStatus: 400 });
  await req('PATCH', `/api/alerts/${aid}`, { body: { status: 'OPEN' } }); // restore

  // --- timeline ------------------------------------------------------------
  await test('timeline', 'GET', '/api/timeline?limit=20', (b) => {
    if (!Array.isArray(b?.events) || !b.events.length) return 'no events';
    if (!b.events[0].action) return 'event has no action';
    return true;
  });

  // --- evidence & chain ----------------------------------------------------
  await test('evidence list', 'GET', '/api/evidence',
    (b) => (Array.isArray(b?.evidence) ? true : 'evidence not an array'));

  await test('chain status reports honestly', 'GET', '/api/chain/status', (b) => {
    if (typeof b?.ready !== 'boolean') return 'no ready flag';
    if (!b.ready && !b.reason) return 'chain is down but gives no reason';
    return true;
  });

  await test('chain transactions', 'GET', '/api/chain/transactions',
    (b) => (Array.isArray(b?.transactions) ? true : 'transactions not an array'));

  // --- admin ---------------------------------------------------------------
  await test('admin health', 'GET', '/api/admin/health', (b) => {
    for (const k of ['postgres', 'intel', 'neo4j', 'chain']) {
      if (!(k in b)) return `missing "${k}"`;
      if (typeof b[k].ok !== 'boolean') return `"${k}" has no ok flag`;
    }
    return b.postgres.ok ? true : 'postgres reported down';
  });

  await test('admin users is role-gated for an investigator', 'GET', '/api/admin/users',
    () => true, { expectStatus: 403 });

  // --- the live moment (§T scene 2) ----------------------------------------
  const narrative =
    'I was added to a Telegram group and a person called me from +91 9876501234. '
    + 'I paid Rs 48,500 to UPI ID rahul.pay@okaxis and later transferred to '
    + 'account 50100234567890 of HDFC Bank. They also asked me to send USDT to '
    + '0x4A2b1c9D8e7F6a5B4c3D2e1F0a9B8c7D6e5F4a3B. Login alert showed IP 103.21.58.9.';

  const created = await test('file a complaint (scene 2)', 'POST', '/api/complaints', (b) => {
    if (!b?.complaint?.complaint_ref) return 'no complaint_ref';
    if (!Array.isArray(b.entities)) return 'no entities array';
    if (!('linked_count' in b)) return 'no linked_count';
    if (!b.extraction) return 'no extraction block';
    // intel-service is expected to be down in dev; the complaint must still file.
    if (b.extraction.available === false && !b.extraction.reason) {
      return 'extraction unavailable but no reason given';
    }
    return true;
  }, {
    body: {
      victim_name: 'Smoke Test Victim', victim_phone: '9123456780',
      victim_email: 'smoke.test@example.com', narrative,
      scam_category: 'INVESTMENT_SCAM', amount_inr: 48500,
      state: 'Karnataka', district: 'Bengaluru',
    },
    expectStatus: 201,
  });

  if (created?.complaint?.id) {
    await test('the new complaint is retrievable', 'GET',
      `/api/complaints/${created.complaint.id}`,
      (b) => (b?.complaint?.complaint_ref === created.complaint.complaint_ref
        ? true : 'ref mismatch'));
  }

  // --- report --------------------------------------------------------------
  console.log(`\n${'='.repeat(64)}`);
  if (failures.length) {
    console.log(`\n${pass} passed, ${failures.length} FAILED\n`);
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    console.log('');
    process.exit(1);
  }
  console.log(`\nAll ${pass} checks passed.\n`);
}

main().catch((err) => { console.error('\nsmoke test crashed:', err); process.exit(1); });
