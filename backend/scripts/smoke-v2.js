/**
 * API suite for the Plan-V2 features and the error paths.
 *
 *   node scripts/smoke-v2.js [baseUrl]
 *
 * `smoke.js` proves the endpoints in docs/API.md answer correctly. This proves
 * the two things it does not:
 *
 *   1. The features added in docs/PLAN-V2-DATA-AND-INTEL.md — the NCRB
 *      reference layer, `/why` explainability, path and common, generated
 *      alerts, OSINT provenance.
 *
 *   2. That the API FAILS correctly. Every check in this half sends something
 *      wrong on purpose and asserts a 4xx with a useful message. An API that
 *      500s on a bad `?limit=` value is not a working API — it is one whose
 *      happy path happens to be tested, and the difference shows up the first
 *      time a frontend sends an empty filter.
 *
 * Exits non-zero on any failure so it can gate a commit.
 */

const BASE = process.argv[2] || process.env.ARGUS_URL || 'http://localhost:4000';
const CRED = { email: 'investigator@argus.gov.in', password: 'argus2026' };
const ADMIN = { email: 'admin@argus.gov.in', password: 'argus2026' };

let token = null;
let pass = 0;
const failures = [];

async function req(method, path, { body, rawBody, tokenOverride } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const useToken = tokenOverride !== undefined ? tokenOverride : token;
  if (useToken) headers.Authorization = `Bearer ${useToken}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    // rawBody sends bytes verbatim, which is the only way to test how the API
    // handles a body that is not valid JSON at all.
    body: rawBody !== undefined ? rawBody : (body ? JSON.stringify(body) : undefined),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, body: json, headers: res.headers };
}

async function test(name, method, path, check, opts = {}) {
  try {
    const { status, body, headers } = await req(method, path, opts);
    const expected = opts.expectStatus || 200;
    if (status !== expected) {
      failures.push(`${name}\n      expected HTTP ${expected}, got ${status}`
        + (body?.error ? ` — ${body.error}` : ''));
      console.log(`  FAIL  ${name}  (HTTP ${status})`);
      return null;
    }
    const verdict = check ? check(body, headers) : true;
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

/** A rejection is only useful if it explains itself. */
const rejects = (bodyCheck) => (b) => {
  if (typeof b?.error !== 'string' || !b.error.length) return 'no error message in the body';
  if (!b.request_id) return 'no request_id — a failure must be traceable';
  return bodyCheck ? bodyCheck(b) : true;
};

async function main() {
  console.log(`\nARGUS v2 + error-path suite → ${BASE}\n`);

  // -------------------------------------------------------------------------
  console.log('  — auth —');
  const login = await test('login', 'POST', '/api/auth/login', (b) => {
    if (!b?.token) return 'no token';
    token = b.token;
    return true;
  }, { body: CRED });
  if (!login) { console.log('\nCannot continue without a token.\n'); process.exit(1); }

  const adminLogin = await req('POST', '/api/auth/login', { body: ADMIN });
  const adminToken = adminLogin.body?.token || null;

  await test('a token from another audience is rejected', 'GET', '/api/auth/me',
    rejects(), {
      expectStatus: 401,
      // Correctly signed structure, wrong secret — proves the signature is
      // actually checked rather than the payload merely decoded.
      tokenOverride: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MSwicm9sZSI6IkFETUlOIn0.bogus',
    });

  // -------------------------------------------------------------------------
  console.log('\n  — reference data (NCRB · OFFICIAL) —');

  await test('reference meta describes what is loaded', 'GET', '/api/reference/meta', (b) => {
    if (!b?.loaded) return 'no reference data loaded — run npm run load-reference';
    if (!Array.isArray(b.metrics) || !b.metrics.length) return 'no metrics';
    if (!b.metrics.some((m) => m.metric === 'CHEATING')) return 'CHEATING metric missing';
    if (!Array.isArray(b.caveats) || !b.caveats.length) return 'caveats must ship with the data';
    return true;
  });

  await test('reference states returns a real choropleth', 'GET',
    '/api/reference/states?metric=CHEATING&year=2014', (b) => {
      if (b?.provenance !== 'NCRB · OFFICIAL') return `provenance was "${b?.provenance}"`;
      if (!Array.isArray(b.states) || b.states.length < 20) return `only ${b?.states?.length} states`;
      const top = b.states[0];
      if (!(top.value > 0)) return 'top state has no value';
      if (top.intensity !== 1) return `top state intensity should be 1, was ${top.intensity}`;
      if (!b.states.every((s) => Number.isInteger(s.value))) return 'values must be integers';
      return true;
    });

  await test('reference district gives a citable baseline', 'GET',
    '/api/reference/district/Karnataka/Bengaluru%20City', (b) => {
      if (b?.provenance !== 'NCRB · OFFICIAL') return 'missing provenance';
      if (!b.latest?.CHEATING) return 'no CHEATING figure for the latest year';
      if (!b.state_totals?.CHEATING) return 'no state total to compare against';
      const share = b.share_of_state?.CHEATING;
      if (!(share > 0 && share <= 1)) return `share_of_state was ${share}`;
      return true;
    });

  await test('reference trend returns a series and a national comparison', 'GET',
    '/api/reference/trend?state=Karnataka&metric=CHEATING', (b) => {
      if (!Array.isArray(b?.series) || b.series.length < 10) return `series had ${b?.series?.length} points`;
      if (!Array.isArray(b.national) || !b.national.length) return 'no national series to compare';
      const years = b.series.map((s) => s.year);
      if (years.some((y, i) => i && y <= years[i - 1])) return 'series is not ordered by year';
      if (typeof b.summary?.change_pct !== 'number') return 'no change_pct in the summary';
      return true;
    });

  await test('reference fraud buckets by loss', 'GET', '/api/reference/fraud?year=2010', (b) => {
    if (!Array.isArray(b?.rows) || !b.rows.length) return 'no fraud rows';
    if (!b.totals_by_bracket || !Object.keys(b.totals_by_bracket).length) return 'no bracket totals';
    return true;
  });

  await test('an unknown district 404s rather than returning empty', 'GET',
    '/api/reference/district/Karnataka/Atlantis', rejects(), { expectStatus: 404 });

  await test('an out-of-range metric is rejected by name', 'GET',
    '/api/reference/states?metric=MURDER&year=2014',
    rejects((b) => (b.error.includes('metric') ? true : `message did not name the field: "${b.error}"`)),
    { expectStatus: 400 });

  // -------------------------------------------------------------------------
  console.log('\n  — explainability (§3.1) —');

  const overview = await req('GET', '/api/graph/overview?limit=150');
  const mastermind = overview.body?.stats?.masterminds?.[0];
  if (!mastermind) {
    failures.push('no mastermind in the graph overview — cannot test /why');
    console.log('  FAIL  graph overview surfaces a mastermind to explain');
  }

  const why = mastermind && await test('graph /why explains a coordinator', 'GET',
    `/api/graph/why/${encodeURIComponent(mastermind.id)}`, (b) => {
      if (!b?.node) return 'no node in the response';
      if (!Array.isArray(b.bridge_paths)) return 'no bridge_paths array';
      if (!b.removal_test) return 'no removal_test';
      if (typeof b.removal_test.fragments_after !== 'number') return 'removal_test has no fragment count';
      if (!b.rank?.graph_wide) return 'no graph-wide rank';
      if (!b.appearances) return 'no appearances block';
      if (!b.method) return 'no method block — an explanation must state how it was derived';
      return true;
    });

  if (why) {
    await test('the coordinator is never named in a complaint', 'GET',
      `/api/graph/why/${encodeURIComponent(mastermind.id)}`, (b) => {
        if (b.appearances.complaint_count !== 0) {
          return `coordinator appears in ${b.appearances.complaint_count} complaints — §T scene 4 claims 0`;
        }
        if (b.appearances.never_named !== true) return 'never_named should be true';
        return true;
      });

    await test('removing the coordinator fragments the network', 'GET',
      `/api/graph/why/${encodeURIComponent(mastermind.id)}`, (b) => {
        if (!b.removal_test.fragmenting) return 'removal does not fragment — the claim does not hold';
        if (b.removal_test.fragments_after < 2) return `only ${b.removal_test.fragments_after} fragment`;
        if (!b.removal_test.summary?.length) return 'no human-readable summary';
        return true;
      });

    await test('bridge paths carry a readable narrative', 'GET',
      `/api/graph/why/${encodeURIComponent(mastermind.id)}`, (b) => {
        if (!b.bridge_paths.length) return 'no bridge paths for a coordinator';
        const p = b.bridge_paths[0];
        if (!p.narrative?.includes('→')) return 'narrative is not a route';
        if (!p.from?.label || !p.to?.label) return 'path endpoints are not hydrated';
        if (typeof p.severs !== 'boolean') return 'severs flag missing';
        return true;
      });
  }

  await test('/why 404s on an unknown node', 'GET',
    '/api/graph/why/phone%3Anot-a-real-node', rejects(), { expectStatus: 404 });

  // -------------------------------------------------------------------------
  console.log('\n  — path & common (§3.2) —');

  const nodes = overview.body?.nodes || [];
  const a = nodes[0]?.id;
  const b2 = nodes.find((n) => n.id !== a && n.cluster === nodes[0]?.cluster)?.id || nodes[1]?.id;

  await test('shortest path between two nodes', 'GET',
    `/api/graph/path?from=${encodeURIComponent(a)}&to=${encodeURIComponent(b2)}`, (b) => {
      if (typeof b?.found !== 'boolean') return 'no found flag';
      if (b.found) {
        if (!Array.isArray(b.node_ids) || b.node_ids.length < 2) return 'path too short';
        if (b.node_ids[0] !== a) return 'path does not start at from';
        if (b.node_ids[b.node_ids.length - 1] !== b2) return 'path does not end at to';
        if (b.hops !== b.node_ids.length - 1) return 'hop count disagrees with the path';
        if (!b.narrative?.includes('→')) return 'no readable narrative';
      }
      return true;
    });

  await test('path refuses identical endpoints', 'GET',
    `/api/graph/path?from=${encodeURIComponent(a)}&to=${encodeURIComponent(a)}`,
    rejects(), { expectStatus: 400 });

  await test('path 404s on an unknown node', 'GET',
    `/api/graph/path?from=${encodeURIComponent(a)}&to=wallet%3A0xdeadbeef`,
    rejects(), { expectStatus: 404 });

  await test('common neighbours between two nodes', 'GET',
    `/api/graph/common?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b2)}`, (b) => {
      if (!Array.isArray(b?.shared)) return 'no shared array';
      if (typeof b.count !== 'number') return 'no count';
      if (b.count !== b.shared.length) return 'count disagrees with the array';
      if (typeof b.directly_connected !== 'boolean') return 'no directly_connected flag';
      return true;
    });

  // -------------------------------------------------------------------------
  console.log('\n  — generated alerts (§3.3) —');

  await test('alert rules are declared with their thresholds', 'GET', '/api/alerts/rules', (b) => {
    if (!Array.isArray(b?.rules) || b.rules.length < 4) return `only ${b?.rules?.length} rules`;
    if (!b.rules.every((r) => r.key && r.title)) return 'a rule is missing key or title';
    if (!b.rules.some((r) => Object.keys(r.thresholds || {}).length)) return 'no thresholds exposed';
    return true;
  });

  const alerts = await test('alerts are generated, not seeded prose', 'GET',
    '/api/alerts?limit=50', (b) => {
      if (!Array.isArray(b?.alerts) || !b.alerts.length) return 'no alerts';
      const generated = b.alerts.filter((x) => x.rule_key);
      if (!generated.length) return 'no rule-generated alerts — run POST /api/alerts/regenerate';
      if (!generated.every((x) => x.details && typeof x.details === 'object')) {
        return 'a generated alert has no structured details';
      }
      return true;
    });

  const generatedAlert = alerts?.alerts?.find((x) => x.rule_key);
  if (generatedAlert) {
    await test('an alert can show the query that produced it', 'GET',
      `/api/alerts/${generatedAlert.id}/explain`, (b) => {
        if (!b?.generated) return 'alert is not marked generated';
        if (!b.query_sql || b.query_sql.length < 20) return 'no query_sql — the alert is unauditable';
        if (!/select/i.test(b.query_sql)) return 'query_sql is not a query';
        if (!b.matched_row) return 'no matched row recorded as evidence';
        return true;
      });
  }

  if (adminToken) {
    await test('regenerating rules is idempotent', 'POST', '/api/alerts/regenerate', (b) => {
      if (typeof b?.created !== 'number' || typeof b.updated !== 'number') return 'no created/updated counts';
      if (!Array.isArray(b.detail)) return 'no per-rule detail';
      // A second run over unchanged data must refresh, never duplicate.
      if (b.created > 0 && b.updated === 0) return 'a repeat run created new alerts instead of updating';
      return true;
    }, { tokenOverride: adminToken });

    await test('regenerate is closed to an investigator', 'POST', '/api/alerts/regenerate',
      rejects(), { expectStatus: 403 });
  }

  // -------------------------------------------------------------------------
  console.log('\n  — OSINT provenance (§3.4) —');

  await test('every adapter declares whether it is simulated', 'GET', '/api/osint/adapters', (b) => {
    if (!Array.isArray(b?.adapters) || !b.adapters.length) return 'no adapters';
    for (const ad of b.adapters) {
      if (typeof ad.simulated !== 'boolean') return `adapter ${ad.key} does not declare simulated`;
      if (ad.simulated && !ad.note?.includes('Illustrative')) {
        return `simulated adapter ${ad.key} does not say so in its note`;
      }
    }
    if (!b.adapters.some((ad) => ad.simulated === false)) return 'no live adapter at all';
    if (!b.integrity_rule) return 'the integrity rule must be stated in the payload';
    return true;
  });

  const phoneEntity = await req('GET', '/api/entities?type=PHONE&limit=1');
  const phoneId = phoneEntity.body?.entities?.[0]?.id;
  if (phoneId) {
    await test('a simulated enrichment is marked on every result', 'GET',
      `/api/entities/${phoneId}/osint`, (b) => {
        if (!Array.isArray(b?.results)) return 'no results array';
        for (const r of b.results) {
          if (typeof r.simulated !== 'boolean') return `result ${r.adapter} has no simulated flag`;
          if (r.simulated && r.note !== 'Illustrative — no live query made') {
            return `result ${r.adapter} is simulated but carries note "${r.note}"`;
          }
        }
        if (typeof b.any_simulated !== 'boolean') return 'no any_simulated summary flag';
        return true;
      });
  }

  // -------------------------------------------------------------------------
  console.log('\n  — error paths —');

  await test('a non-numeric id is a 400, not a 500', 'GET', '/api/complaints/abc',
    rejects((b) => (b.error.includes('id') ? true : `message did not name the field: "${b.error}"`)),
    { expectStatus: 400 });

  await test('a negative id is rejected', 'GET', '/api/complaints/-5', rejects(), { expectStatus: 400 });

  await test('an over-ceiling limit is rejected', 'GET', '/api/complaints?limit=99999',
    rejects(), { expectStatus: 400 });

  await test('a limit of zero is rejected', 'GET', '/api/complaints?limit=0',
    rejects(), { expectStatus: 400 });

  await test('empty filter values are treated as absent, not as errors', 'GET',
    '/api/complaints?state=&category=&cluster=&q=', (b) => {
      // This is what a form sends when its filters are cleared. A 400 here
      // makes the list page look broken for the most ordinary user action.
      if (!Array.isArray(b?.complaints)) return 'no complaints array';
      if (!b.complaints.length) return 'empty filters should return everything';
      return true;
    });

  await test('an unknown enum value names the field', 'GET', '/api/complaints?category=NOT_A_CATEGORY',
    rejects((b) => (b.error.includes('category') ? true : `message was "${b.error}"`)),
    { expectStatus: 400 });

  await test('malformed JSON is a 400 with a clear reason', 'POST', '/api/complaints',
    rejects((b) => (/json/i.test(b.error) ? true : `message was "${b.error}"`)),
    { expectStatus: 400, rawBody: '{"victim_name": "Test",}' });

  await test('a complaint with no narrative is rejected', 'POST', '/api/complaints',
    rejects((b) => (b.error.includes('narrative') ? true : `message was "${b.error}"`)),
    { expectStatus: 400, body: { victim_name: 'Test Person' } });

  await test('a complaint with a non-numeric amount is rejected', 'POST', '/api/complaints',
    rejects((b) => (b.error.includes('amount_inr') ? true : `message was "${b.error}"`)),
    { expectStatus: 400, body: {
      victim_name: 'Test Person',
      narrative: 'A narrative long enough to pass the minimum length check.',
      amount_inr: 'five thousand rupees',
    } });

  await test('a negative amount is rejected', 'POST', '/api/complaints', rejects(),
    { expectStatus: 400, body: {
      victim_name: 'Test Person',
      narrative: 'A narrative long enough to pass the minimum length check.',
      amount_inr: -50000,
    } });

  await test('an unknown route 404s as JSON, not as HTML', 'GET', '/api/does-not-exist',
    rejects(), { expectStatus: 404 });

  await test('an invalid alert status is rejected', 'PATCH', '/api/alerts/1',
    rejects(), { expectStatus: 400, body: { status: 'BANANA' } });

  await test('a bad node id shape is rejected before it reaches the graph', 'GET',
    '/api/graph/why/no-colon-here', rejects(), { expectStatus: 400 });

  // -------------------------------------------------------------------------
  console.log('\n  — response hygiene —');

  await test('every response carries a request id', 'GET', '/api/dashboard/summary',
    (b, headers) => (headers.get('x-request-id') ? true : 'no X-Request-Id header'));

  await test('the server does not advertise its stack', 'GET', '/api/dashboard/summary',
    (b, headers) => (headers.get('x-powered-by') ? 'X-Powered-By is still being sent' : true));

  await test('security headers are present', 'GET', '/api/dashboard/summary', (b, headers) => {
    if (headers.get('x-content-type-options') !== 'nosniff') return 'missing nosniff';
    if (!headers.get('referrer-policy')) return 'missing Referrer-Policy';
    return true;
  });

  await test('pagination reports a real total, not the page size', 'GET', '/api/entities?limit=5',
    (b) => {
      if (!Array.isArray(b?.entities)) return 'no entities';
      if (b.entities.length !== 5) return `asked for 5, got ${b.entities.length}`;
      if (b.total <= 5) return `total is ${b.total} — that is the page size, not the result size`;
      if (b.has_more !== true) return 'has_more should be true';
      return true;
    });

  await test('offset actually pages', 'GET', '/api/entities?limit=3&offset=3', (b) => {
    if (b?.offset !== 3) return 'offset not echoed';
    if (b.entities.length !== 3) return `expected 3 rows, got ${b.entities.length}`;
    return true;
  });

  // -------------------------------------------------------------------------
  console.log('\n' + '='.repeat(64) + '\n');
  if (failures.length) {
    console.log(`${pass} passed, ${failures.length} FAILED\n`);
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    console.log('');
    process.exit(1);
  }
  console.log(`All ${pass} checks passed.\n`);
}

main().catch((err) => {
  console.error('\nSuite crashed:', err);
  process.exit(1);
});
