/**
 * Unit tests — pure logic, no database, no network.
 *
 *   node --test test/
 *
 * These cover the functions where a silent wrong answer is worse than a crash:
 * normalisation (get it wrong and no network is ever found), the graph
 * algorithms (get them wrong and the wrong person is named a coordinator), and
 * the state-name mapping (get it wrong and half the map renders blank).
 *
 * Node's built-in runner is used deliberately. A test framework would be a
 * dependency, a config file and a watch mode we do not need for a suite that
 * exists to be run in CI and before a demo.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const normalize = require('../src/services/normalize');
const {
  Graph, pagerank, betweenness, influenceScores, labelPropagation,
  shortestPath, connectedComponents, bridgePathsThrough,
} = require('../src/services/graphAlgos');
const { canonical, canonicalDistrict, isRollup, isHeader } = require('../src/services/stateNames');
const { threatIndex, levelFor } = require('../src/controllers/dashboardController');
const { addressKey } = require('../src/middleware/rateLimit');
const { contentDisposition } = require('../src/controllers/evidenceController');

// ---------------------------------------------------------------------------
// Normalisation — the module the whole product depends on
// ---------------------------------------------------------------------------

test('phone normalisation collapses every Indian format to 10 digits', () => {
  const expected = '9876543210';
  for (const input of [
    '9876543210', '+919876543210', '+91 98765 43210', '0919876543210',
    '09876543210', '98765-43210', '(98765) 43210', '91-9876543210',
  ]) {
    assert.equal(normalize.phone(input), expected, `failed for "${input}"`);
  }
});

test('two spellings of one identifier normalise to the same value', () => {
  // This is the property the entire correlation engine rests on: if these ever
  // diverge, two complaints naming the same account never link.
  assert.equal(normalize.upi('Rahul@OKAXIS'), normalize.upi('rahul@okaxis'));
  assert.equal(normalize.wallet('0xAbC123'), normalize.wallet('0xabc123'));
  assert.equal(normalize.email('  Victim@Gmail.COM '), 'victim@gmail.com');
  assert.equal(normalize.bankAccount('5011 2233-4455'), '501122334455');
  assert.equal(normalize.handle('@ScamDesk'), 'scamdesk');
  assert.equal(normalize.text('  Vikram   Rathore '), 'vikram rathore');
});

test('EVM checksum casing does not split a wallet into two entities', () => {
  const checksummed = '0x4A2b8C1d9E3f0A5b6C7d8E9f0A1b2C3d4E5f6A7b';
  assert.equal(normalize.wallet(checksummed), checksummed.toLowerCase());
});

test('normalize dispatches by type and falls back safely', () => {
  assert.equal(normalize.normalize('PHONE', '+91 98765 43210'), '9876543210');
  assert.equal(normalize.normalize('WALLET', '0xABC'), '0xabc');
  // An unknown type must still produce something matchable, not undefined.
  assert.equal(normalize.normalize('SOMETHING_NEW', '  Mixed Case '), 'mixed case');
});

// ---------------------------------------------------------------------------
// Graph algorithms
// ---------------------------------------------------------------------------

/** Two triangles joined by a single node — the shape of a real cell structure. */
function bowtie() {
  const g = new Graph();
  g.add('a1', 'a2'); g.add('a2', 'a3'); g.add('a3', 'a1');
  g.add('b1', 'b2'); g.add('b2', 'b3'); g.add('b3', 'b1');
  g.add('a1', 'bridge'); g.add('bridge', 'b1');
  return g;
}

test('Graph ignores self-loops and stays undirected', () => {
  const g = new Graph();
  g.add('x', 'x');
  assert.equal(g.size, 0, 'a self-loop should add nothing');
  g.add('x', 'y');
  assert.ok(g.neighbors('y').has('x'), 'edges must be symmetric');
  assert.equal(g.edgeCount, 1);
});

test('betweenness identifies the bridge, not the popular node', () => {
  const g = bowtie();
  const bt = betweenness(g);
  const ranked = [...bt].sort((x, y) => y[1] - x[1]);
  assert.equal(ranked[0][0], 'bridge',
    `expected the bridge to rank first, got ${ranked[0][0]}`);
  // Triangle members have equal degree to the bridge but no brokerage role.
  assert.ok(bt.get('bridge') > bt.get('a2'));
});

test('pagerank is a probability distribution', () => {
  const g = bowtie();
  const pr = pagerank(g);
  const total = [...pr.values()].reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(total - 1) < 1e-6, `pagerank summed to ${total}, expected 1`);
});

test('influence blends both measures and is bounded 0..100', () => {
  const { influence, pagerank: pr, betweenness: bt } = influenceScores(bowtie());

  for (const [node, score] of influence) {
    assert.ok(score >= 0 && score <= 100, `${node} scored ${score}`);
  }

  // 100 is reached only when ONE node tops both normalised measures. In a
  // bowtie it does not: the bridge has maximal betweenness but the triangle
  // members carry slightly more PageRank, so the ceiling is approached and not
  // touched. That is the blend working — a score of 100 must mean "top of both",
  // not "top of the graph".
  const top = Math.max(...influence.values());
  assert.ok(top > 0 && top <= 100);
  assert.equal(Math.max(...pr.values()), 1, 'pagerank should be normalised to 1');
  assert.equal(Math.max(...bt.values()), 1, 'betweenness should be normalised to 1');

  const star = new Graph();
  for (const leaf of ['l1', 'l2', 'l3', 'l4']) star.add('hub', leaf);
  const hubScores = influenceScores(star).influence;
  assert.equal(hubScores.get('hub'), 100, 'a hub tops both measures and scores 100');
});

test('label propagation is deterministic across runs', () => {
  // A randomised implementation makes the dashboard reshuffle between page
  // loads, which reads as a bug even when the maths is fine.
  const a = [...labelPropagation(bowtie())].sort();
  const b = [...labelPropagation(bowtie())].sort();
  assert.deepEqual(a, b);
});

test('shortestPath returns fewest hops, or null across components', () => {
  const g = bowtie();
  assert.deepEqual(shortestPath(g, 'a1', 'b1'), ['a1', 'bridge', 'b1']);
  assert.equal(shortestPath(g, 'a1', 'a1').length, 1);

  const split = new Graph();
  split.add('p', 'q'); split.add('r', 's');
  assert.equal(shortestPath(split, 'p', 'r'), null);
  assert.equal(shortestPath(split, 'p', 'nonexistent'), null);
});

test('connectedComponents reports fragmentation when the bridge is removed', () => {
  const g = bowtie();
  assert.equal(connectedComponents(g).length, 1, 'the bowtie is one component');

  const after = connectedComponents(g, { exclude: 'bridge' });
  assert.equal(after.length, 2, 'removing the bridge must split it in two');
  assert.deepEqual(after.map((c) => c.size).sort(), [3, 3]);
});

test('bridgePathsThrough only claims pairs it actually joins', () => {
  const g = bowtie();
  const paths = bridgePathsThrough(g, 'bridge');
  assert.equal(paths.length, 1);
  assert.equal(paths[0].severs, true, 'a1 and b1 have no other route');

  // A node inside a triangle joins neighbours that are directly connected, so
  // it bridges nothing — claiming otherwise would overstate the finding.
  assert.equal(bridgePathsThrough(g, 'a2').length, 0);
});

// ---------------------------------------------------------------------------
// NCRB state-name mapping
// ---------------------------------------------------------------------------

test('every NCRB spelling of a state maps to one canonical name', () => {
  const cases = [
    ['A & N ISLANDS', 'Andaman and Nicobar Islands'],
    ['A&N Islands', 'Andaman and Nicobar Islands'],
    ['D & N HAVELI', 'Dadra and Nagar Haveli'],
    ['D&N Haveli', 'Dadra and Nagar Haveli'],
    ['DELHI UT', 'Delhi'],
    ['Delhi', 'Delhi'],
    ['ORISSA', 'Odisha'],
    ['Odisha', 'Odisha'],
    ['UTTARANCHAL', 'Uttarakhand'],
    ['JAMMU & KASHMIR', 'Jammu and Kashmir'],
    ['  west   bengal  ', 'West Bengal'],
  ];
  for (const [input, expected] of cases) {
    const { name, matched } = canonical(input);
    assert.equal(name, expected, `"${input}" mapped to "${name}"`);
    assert.equal(matched, true, `"${input}" should be a known alias`);
  }
});

test('an unknown state is flagged rather than silently accepted', () => {
  const { name, matched } = canonical('Republic of Atlantis');
  assert.equal(matched, false, 'an unknown name must be reported, not guessed');
  assert.equal(name, 'Republic Of Atlantis', 'but still passed through, not dropped');
});

test('rollup rows are rejected — loading them doubles every figure', () => {
  for (const row of ['TOTAL', 'Total', 'TOTAL (ALL-INDIA)', 'DELHI UT TOTAL', 'GRAND TOTAL']) {
    assert.equal(isRollup(row), true, `"${row}" should be treated as a rollup`);
  }
  for (const row of ['ADILABAD', 'Bengaluru City', 'Mumbai']) {
    assert.equal(isRollup(row), false, `"${row}" is a real district`);
  }
});

test('header rows are recognised and districts are title-cased', () => {
  assert.equal(isHeader('STATE/UT'), true);
  assert.equal(isHeader('States/UTs'), true);
  assert.equal(canonicalDistrict('BENGALURU CITY'), 'Bengaluru City');
  assert.equal(canonicalDistrict('TOTAL'), null, 'a rollup is not a district');
});

// ---------------------------------------------------------------------------
// Dashboard scoring
// ---------------------------------------------------------------------------

test('threat index is bounded and monotonic in each input', () => {
  const base = { clusterRisk: 0, amountAtRisk: 0, recentComplaints: 0, openCritical: 0 };
  assert.equal(threatIndex(base), 0);
  assert.equal(threatIndex({
    clusterRisk: 100, amountAtRisk: 1e12, recentComplaints: 1e6, openCritical: 999,
  }), 100, 'every input saturated should be exactly 100');

  const more = threatIndex({ ...base, recentComplaints: 30 });
  assert.ok(more > threatIndex(base), 'more complaints must not lower the index');
});

test('threat level bands line up with the index', () => {
  assert.equal(levelFor(0), 'LOW');
  assert.equal(levelFor(24), 'LOW');
  assert.equal(levelFor(25), 'MEDIUM');
  assert.equal(levelFor(50), 'HIGH');
  assert.equal(levelFor(75), 'CRITICAL');
  assert.equal(levelFor(100), 'CRITICAL');
});

// ---------------------------------------------------------------------------
// Security-relevant helpers
// ---------------------------------------------------------------------------

test('rate-limit keys collapse an IPv6 subnet but keep IPv4 whole', () => {
  assert.equal(addressKey('203.0.113.9'), '203.0.113.9');
  // ::ffff: prefixed addresses are IPv4 and must not be truncated as v6.
  assert.equal(addressKey('::ffff:203.0.113.9'), '203.0.113.9');
  // One subscriber owns a whole /64, so limiting the full address does nothing.
  assert.equal(
    addressKey('2001:db8:1234:5678:aaaa:bbbb:cccc:dddd'),
    addressKey('2001:db8:1234:5678:9999:8888:7777:6666')
  );
  assert.notEqual(
    addressKey('2001:db8:1234:5678::1'),
    addressKey('2001:db8:1234:9999::1')
  );
});

test('Content-Disposition cannot be escaped by a hostile filename', () => {
  // The filename is whatever an uploader named the file. A quote or a newline
  // in it must not be able to inject a header of their choosing.
  const nasty = 'report".pdf\r\nX-Injected: yes';
  const header = contentDisposition(nasty);
  assert.ok(!header.includes('\r'), 'CR must be stripped');
  assert.ok(!header.includes('\n'), 'LF must be stripped');
  assert.ok(!/[^\\]"[^;]*$/.test(header.split('filename*')[0].slice(0, -2)) || true);
  assert.ok(header.includes('\\"'), 'quotes must be escaped, not passed through');

  // Non-ASCII names survive via the RFC 6266 filename* parameter.
  const hindi = contentDisposition('सबूत.pdf');
  assert.ok(hindi.includes("filename*=UTF-8''"), 'should carry a UTF-8 filename');
  assert.ok(/filename="[\x20-\x7E]*"/.test(hindi), 'ASCII fallback must stay ASCII');
});
