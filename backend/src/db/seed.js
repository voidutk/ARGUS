/**
 * ARGUS seed — the synthetic national dataset every page renders from.
 *
 * This is the most important file in the repo (docs/PROJECT.md §R). It does not
 * scatter random complaints and hope a network appears; it PLANTS three
 * criminal organisations with deliberate topology, then buries them in
 * unclustered noise so the clustering has something to reject.
 *
 * The demo claim is that centrality finds a mastermind nobody could see by
 * reading complaints. That claim is only honest if the graph shape genuinely
 * produces that ranking, so the topology below is built to make it TRUE, not to
 * be asserted afterwards. `npm run verify-plant` proves it independently.
 *
 * Why the mastermind is findable at all: it appears in NO complaint. It touches
 * no victim. It is reachable only through entity_links — the intelligence edges
 * (seized contact lists, telco records, bank KYC) that sit between the handlers
 * who call victims and the wallets that hold the money. That makes it a cut
 * vertex, which is exactly what betweenness centrality is built to find.
 *
 * Deterministic by design: a fixed PRNG seed means every teammate and every
 * rehearsal gets the identical dataset. A demo that reshuffles itself is a demo
 * that cannot be rehearsed.
 */

const bcrypt = require('bcryptjs');
const pool = require('./pool');
const { normalize } = require('../services/normalize');
const D = require('./seedData');

const SEED = 20260420;
const DEMO_PASSWORD = 'argus2026';

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32)
// ---------------------------------------------------------------------------
let _s = SEED;
function rnd() {
  _s |= 0; _s = (_s + 0x6D2B79F5) | 0;
  let t = Math.imul(_s ^ (_s >>> 15), 1 | _s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (min, max) => Math.floor(rnd() * (max - min + 1)) + min;
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};

// ---------------------------------------------------------------------------
// Synthetic identifier generators
// ---------------------------------------------------------------------------
const mobile = () => `${pick(['6', '7', '8', '9'])}${String(int(0, 999999999)).padStart(9, '0')}`;
const personName = () => `${pick(D.FIRST_NAMES)} ${pick(D.LAST_NAMES)}`;
const accountNo = () => String(int(10000000000, 99999999999));
const ifsc = (code) => `${code}0${String(int(100000, 999999))}`;
const ipv4 = () => `${int(49, 223)}.${int(0, 255)}.${int(0, 255)}.${int(1, 254)}`;
const deviceFp = () => `${Array.from({ length: 4 }, () => int(0x1000, 0xffff).toString(16)).join('-')}`;
const ethWallet = () => `0x${Array.from({ length: 40 }, () => '0123456789abcdefABCDEF'[Math.floor(rnd() * 22)]).join('')}`;
const utr = () => `UTR${int(100000000000, 999999999999)}`;
const txHash = () => `0x${Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(rnd() * 16)]).join('')}`;

function upiFor(name) {
  const slug = name.toLowerCase().split(' ')[0] + (rnd() < 0.5 ? int(1, 999) : '');
  return `${slug}@${pick(D.UPI_HANDLES)}`;
}
function emailFor(name) {
  const slug = name.toLowerCase().replace(/\s+/g, '.');
  return `${slug}${int(1, 99)}@${pick(D.EMAIL_DOMAINS)}`;
}

// Amounts that read like real filings: mostly modest, a few large.
function amount() {
  const r = rnd();
  if (r < 0.55) return int(5, 99) * 500;          // 2.5k – 49.5k
  if (r < 0.85) return int(10, 60) * 5000;        // 50k – 3L
  return int(7, 40) * 50000;                      // 3.5L – 20L
}

// ---------------------------------------------------------------------------
// In-memory graph being built
// ---------------------------------------------------------------------------
const entities = new Map();   // key -> {type, value, normalized, label, isFlagged}
const complaints = [];        // {ref, victim..., narrative, ...}
const cEntities = [];         // {ci, key, role, confidence, method, snippet}
const eLinks = [];            // {from, to, rel, weight, source, note}
const txns = [];              // {ci, from, to, amount, rail, hop, ref, at}
const plant = {};             // what we planted, for verify-plant

const keyOf = (type, normalized) => `${type}::${normalized}`;

/** Register (or reuse) a canonical entity. Returns its key. */
function ent(type, value, { label = null, flagged = false } = {}) {
  const normalized = normalize(type, value);
  const key = keyOf(type, normalized);
  if (!entities.has(key)) {
    entities.set(key, { type, value: String(value), normalized, label, isFlagged: flagged });
  } else if (flagged) {
    entities.get(key).isFlagged = true;
  }
  return key;
}

function link(ci, key, role, method = 'REGEX', confidence = 0.97, snippet = null) {
  cEntities.push({ ci, key, role, method, confidence, snippet });
}

function elink(from, to, rel, { weight = 1, source = 'INTEL', note = null } = {}) {
  if (from === to) return;
  eLinks.push({ from, to, rel, weight, source, note });
}

let refCounter = 4000;
const nextRef = () => `NCRP-2026-${String(++refCounter).padStart(6, '0')}`;

function daysAgo(d, hourSpread = true) {
  const t = new Date('2026-04-20T09:00:00Z').getTime() - d * 86400000;
  return new Date(t - (hourSpread ? int(0, 82800000) : 0)).toISOString();
}

/**
 * Build one complaint: victim, narrative with identifiers inline, and the
 * entity links that follow from it.
 */
function makeComplaint({ category, place, handlerPhoneKey, handlerName, upiKey, accountKey,
                         bankName, ifscCode, walletKey, telegramHandle, deviceKey, ipKey,
                         filedDaysAgo, clusterTag }) {
  const [state, district, lat, lon] = place;
  const victim = personName();
  const victimPhone = mobile();
  const victimEmail = emailFor(victim);

  const amt1 = amount();
  const amt2 = amount();
  const total = amt1 + amt2;

  const tpl = pick(D.NARRATIVES[category] || D.NARRATIVES.UPI_FRAUD);
  const narrative = tpl({
    handlerName: handlerName || personName(),
    handlerPhone: rnd() < 0.35 ? `+91 ${entities.get(handlerPhoneKey).normalized}` : entities.get(handlerPhoneKey).normalized,
    upi: rnd() < 0.25 ? entities.get(upiKey).normalized.toUpperCase() : entities.get(upiKey).normalized,
    account: accountKey ? entities.get(accountKey).normalized : accountNo(),
    bank: bankName || pick(D.BANKS)[0],
    ifsc: ifscCode || ifsc(pick(D.BANKS)[1]),
    wallet: walletKey ? entities.get(walletKey).value : ethWallet(),
    telegram: telegramHandle || 'trader_pro_x',
    email: victimEmail,
    ip: ipKey ? entities.get(ipKey).normalized : ipv4(),
    groupName: pick(D.TELEGRAM_GROUP_NAMES),
    amt1: amt1.toLocaleString('en-IN'),
    amt2: amt2.toLocaleString('en-IN'),
    total: total.toLocaleString('en-IN'),
  });

  const ci = complaints.length;
  complaints.push({
    ref: nextRef(),
    victimName: victim,
    victimPhone,
    victimEmail,
    narrative,
    category,
    amount: total,
    state, district, lat, lon,
    status: clusterTag ? 'LINKED' : pick(['NEW', 'NEW', 'TRIAGED']),
    filedAt: daysAgo(filedDaysAgo),
    clusterTag: clusterTag || null,
  });

  // Victim-side entities
  const vPhoneKey = ent('PHONE', victimPhone, { label: victim });
  const vEmailKey = ent('EMAIL', victimEmail, { label: victim });
  link(ci, vPhoneKey, 'VICTIM');
  link(ci, vEmailKey, 'VICTIM', 'REGEX', 0.95);

  // NOTE: the victim's city is deliberately NOT an entity node.
  //
  // Linking every complaint to a shared "Mumbai" node makes that city the most
  // central object in the country and bridges gangs that have nothing to do with
  // each other. Two victims living in the same district is not evidence they were
  // scammed by the same people. Geography lives on the complaint row (state,
  // district, lat, lon) and drives the Geo page; it never correlates complaints.
  // LOCATION stays a valid entity type for genuinely evidential addresses —
  // a cash-out shop, a raided premises — which the seeder does not generate.

  // Suspect-side entities — these are what actually correlate complaints
  link(ci, handlerPhoneKey, 'SUSPECT');
  link(ci, upiKey, 'SUSPECT');
  if (accountKey) link(ci, accountKey, 'SUSPECT');
  if (walletKey) link(ci, walletKey, 'SUSPECT');
  if (deviceKey) link(ci, deviceKey, 'SUSPECT', 'MANUAL', 0.88);
  if (ipKey) link(ci, ipKey, 'SUSPECT', 'REGEX', 0.92);

  return { ci, victimPhoneKey: vPhoneKey, amt1, amt2, total };
}

// ---------------------------------------------------------------------------
// CLUSTER ALPHA — investment scam run as three isolated cells, 42 complaints.
//
// Topology (the load-bearing part of the whole demo):
//
//    14 complaints ─► cell A: 2 callers · 2 UPI · 4 mule a/c ─► wallet A ─┐
//    14 complaints ─► cell B: 2 callers · 2 UPI · 4 mule a/c ─► wallet B ─┤
//    14 complaints ─► cell C: 2 callers · 2 UPI · 4 mule a/c ─► wallet C ─┤
//                                     └────────────┬──────────────────────┘
//                                          [ COORDINATOR ]
//                                            │          │
//                                       2 devices    4 IPs
//
// Two properties make the coordinator findable, and both are deliberate:
//
// 1. The cells are AIRTIGHT. Each has its own callers, UPI IDs, mule accounts,
//    cash-out wallet and Telegram group. Nothing is shared. That is how a cell
//    structure is actually run — so one arrest cannot roll up the network — and
//    it means the only route between any two cells passes through one person.
//
// 2. Operational assets ROTATE. No single caller or mule account carries a
//    whole cell; numbers and accounts are churned constantly to stay under bank
//    and telco thresholds. Rotation is what stops any one mule becoming a bigger
//    hub than the coordinator, because the coordinator is the only node that
//    touches EVERY rotated asset. That is precisely what makes them the
//    coordinator, and it is why the graph can name them.
//
// The coordinator appears in ZERO complaints and speaks to ZERO victims. No
// amount of reading complaints surfaces them. Each caller, by contrast, is named
// in seven filings. Reading finds callers; only the graph finds the person the
// callers route through.
//
// Two earlier versions of this function failed verify-plant, and both failures
// were informative: sharing mules across cells created shortcuts that bypassed
// the coordinator, and funnelling a whole cell through one mule made that mule
// out-rank them. The script refused both. See docs/PROJECT.md §R.
// ---------------------------------------------------------------------------
function buildAlpha() {
  const bossName = 'Vikram Rathore';
  const boss = ent('PERSON', bossName, { label: bossName, flagged: true });
  const bossTg = ent('TELEGRAM', '@vikram_ops', { label: `${bossName} (coordination)`, flagged: true });
  const bossPhone = ent('PHONE', mobile(), { label: `${bossName} (coordination)`, flagged: true });

  const devices = Array.from({ length: 2 }, () => ent('DEVICE', deviceFp(), { flagged: true }));
  const ips = Array.from({ length: 4 }, () => ent('IP', ipv4(), { flagged: true }));

  const CELL_TG = ['nifty_vip_signals', 'wealth_builders_in', 'stockguru_premium'];
  const cells = Array.from({ length: 3 }, (_, i) => {
    const tag = 'ABC'[i];
    return {
      tag,
      handlers: Array.from({ length: 2 }, () => {
        const name = personName();
        return { name, key: ent('PHONE', mobile(), { label: `Caller ${tag} — ${name}`, flagged: true }) };
      }),
      upis: Array.from({ length: 2 }, () => ent('UPI', upiFor(personName()), { flagged: true })),
      mules: Array.from({ length: 4 }, () => {
        const [bankName, code] = pick(D.BANKS);
        return {
          key: ent('BANK_ACCOUNT', accountNo(), { label: `${bankName} mule ${tag}`, flagged: true }),
          bankName,
          ifscCode: ifsc(code),
        };
      }),
      wallet: ent('WALLET', ethWallet(), { label: `Cell ${tag} cash-out`, flagged: true }),
      telegram: ent('TELEGRAM', `@${CELL_TG[i]}`, { label: `Cell ${tag} group`, flagged: true }),
      tgHandle: CELL_TG[i],
    };
  });

  // --- intelligence edges: the only things that reach the coordinator -----
  cells.forEach((c) => {
    c.handlers.forEach((h) => {
      elink(h.key, boss, 'COMMUNICATED_WITH',
        { weight: 4, source: 'SEIZURE', note: 'contact list recovered from seized handset' });
      elink(h.key, bossPhone, 'COMMUNICATED_WITH',
        { weight: 3, source: 'TELCO', note: 'CDR: repeated contact, no victim numbers in common' });
    });
    c.mules.forEach((m) => elink(m.key, boss, 'REGISTERED_TO',
      { weight: 4, source: 'BANK', note: 'KYC documents across rotated accounts share one address' }));
    elink(boss, c.wallet, 'OWNS',
      { weight: 5, source: 'INTEL', note: 'exchange KYC resolves all three wallets to one identity' });
  });
  elink(bossPhone, boss, 'REGISTERED_TO', { weight: 3, source: 'TELCO' });
  elink(bossTg, boss, 'REGISTERED_TO', { weight: 3, source: 'INTEL' });

  devices.forEach((d, i) => {
    elink(boss, d, 'USES', { weight: 3, source: 'SEIZURE' });
    elink(d, ips[i * 2], 'CONNECTED_TO', { source: 'INTEL' });
    elink(d, ips[i * 2 + 1], 'CONNECTED_TO', { source: 'INTEL' });
  });

  const places = shuffle(D.PLACES).slice(0, 14);
  const built = [];

  for (let i = 0; i < 42; i++) {
    const cell = cells[i % 3];
    const k = Math.floor(i / 3);                  // 0..13 within the cell
    const handler = cell.handlers[k % 2];
    const mule = cell.mules[k % 4];
    const r = makeComplaint({
      category: i % 5 === 0 ? 'CRYPTO_FRAUD' : 'INVESTMENT_SCAM',
      place: places[i % places.length],
      handlerPhoneKey: handler.key,
      handlerName: handler.name,
      upiKey: cell.upis[k % 2],
      accountKey: mule.key,
      bankName: mule.bankName,
      ifscCode: mule.ifscCode,
      walletKey: null,                             // victims pay the mule, never see the wallet
      telegramHandle: cell.tgHandle,
      deviceKey: null,
      ipKey: null,
      filedDaysAgo: int(1, 95),
      clusterTag: 'ALPHA',
    });
    link(r.ci, cell.telegram, 'SUSPECT', 'REGEX', 0.93);
    built.push({ ...r, cell, mule });
  }

  // Money stays inside the cell: victim -> rotated mule -> that cell's wallet.
  built.forEach((r) => {
    const at = complaints[r.ci].filedAt;
    txns.push({ ci: r.ci, from: r.victimPhoneKey, to: r.mule.key, amount: r.amt2, rail: 'IMPS', hop: 0, ref: utr(), at });
    txns.push({ ci: r.ci, from: r.mule.key, to: r.cell.wallet, amount: Math.round(r.amt2 * 0.94), rail: 'CRYPTO', hop: 1, ref: txHash(), at });
  });

  plant.ALPHA = {
    label: 'Investment-advisory ring run as three isolated cells',
    mastermindKey: boss,
    mastermindName: bossName,
    handlerKeys: cells.flatMap((c) => c.handlers.map((h) => h.key)),
    walletKeys: cells.map((c) => c.wallet),
  };
}

// ---------------------------------------------------------------------------
// CLUSTER BETA — digital-arrest scam, 28 complaints across three crews.
// Same cell discipline and same rotation as ALPHA: each crew runs its own VoIP
// gateway, its own collection accounts and its own numbers, so only the
// coordinator links them. Beta exists so the clustering has to separate two
// organisations rather than treat the whole country as one blob.
// ---------------------------------------------------------------------------
function buildBeta() {
  const bossName = 'Imran Sheikh';
  const boss = ent('PERSON', bossName, { label: bossName, flagged: true });
  const bossDevice = ent('DEVICE', deviceFp(), { label: `${bossName} console`, flagged: true });

  const crews = Array.from({ length: 3 }, (_, i) => ({
    tag: i + 1,
    callers: Array.from({ length: 2 }, () => {
      const name = personName();
      return { name, key: ent('PHONE', mobile(), { label: `Caller ${i + 1} — ${name}`, flagged: true }) };
    }),
    upis: Array.from({ length: 2 }, () => ent('UPI', upiFor(personName()), { flagged: true })),
    accounts: Array.from({ length: 3 }, () => {
      const [bankName, code] = pick(D.BANKS);
      return {
        key: ent('BANK_ACCOUNT', accountNo(), { label: `${bankName} mule ${i + 1}`, flagged: true }),
        bankName,
        ifscCode: ifsc(code),
      };
    }),
    voip: ent('IP', ipv4(), { label: `VoIP gateway ${i + 1}`, flagged: true }),
  }));

  crews.forEach((c) => {
    c.callers.forEach((h) => elink(h.key, boss, 'COMMUNICATED_WITH',
      { weight: 3, source: 'SEIZURE', note: 'callers report to a single coordinator' }));
    c.accounts.forEach((a) => elink(a.key, boss, 'REGISTERED_TO', { weight: 3, source: 'BANK' }));
    elink(c.voip, bossDevice, 'CONNECTED_TO',
      { weight: 2, source: 'INTEL', note: 'gateways provisioned from one console' });
  });
  elink(boss, bossDevice, 'USES', { weight: 3, source: 'SEIZURE' });

  const places = shuffle(D.PLACES).slice(0, 11);
  const built = [];
  for (let i = 0; i < 28; i++) {
    const crew = crews[i % 3];
    const k = Math.floor(i / 3);
    const caller = crew.callers[k % 2];
    const account = crew.accounts[k % 3];
    const r = makeComplaint({
      category: 'DIGITAL_ARREST',
      place: places[i % places.length],
      handlerPhoneKey: caller.key,
      handlerName: caller.name,
      upiKey: crew.upis[k % 2],
      accountKey: account.key,
      bankName: account.bankName,
      ifscCode: account.ifscCode,
      deviceKey: null,
      ipKey: crew.voip,
      filedDaysAgo: int(1, 70),
      clusterTag: 'BETA',
    });
    built.push({ ...r, account });
  }

  built.forEach((r) => {
    txns.push({ ci: r.ci, from: r.victimPhoneKey, to: r.account.key, amount: r.amt2,
      rail: 'NEFT', hop: 0, ref: utr(), at: complaints[r.ci].filedAt });
  });

  plant.BETA = { label: 'Digital-arrest impersonation cell', mastermindKey: boss, mastermindName: bossName };
}

// ---------------------------------------------------------------------------
// CLUSTER GAMMA — crypto laundering, 15 complaints.
// Shallow on the victim side and DEEP on the money side: two independent
// six-hop ladders, each ending at its own exchange deposit address. This cluster
// exists to make the Money Flow page (§E.6) worth looking at.
//
// An earlier version ran ONE linear chain. In a linear chain the MIDDLE has the
// highest betweenness, so the score named a layering account instead of a
// person. Splitting the chain in two and hanging both off a single owner is what
// turns that owner into the articulation point.
// ---------------------------------------------------------------------------
function buildGamma() {
  const bossName = 'Farhan Khan';
  const boss = ent('PERSON', bossName, { label: bossName, flagged: true });
  const bossTg = ent('TELEGRAM', '@fk_desk_private', { label: `${bossName} (private)`, flagged: true });
  elink(bossTg, boss, 'REGISTERED_TO', { weight: 3, source: 'INTEL' });

  const cells = Array.from({ length: 2 }, (_, i) => ({
    tag: i + 1,
    recruiters: Array.from({ length: 2 }, () => {
      const name = personName();
      return { name, key: ent('PHONE', mobile(), { label: `Recruiter ${i + 1} — ${name}`, flagged: true }) };
    }),
    upis: Array.from({ length: 2 }, () => ent('UPI', upiFor(personName()), { flagged: true })),
    collectors: Array.from({ length: 3 }, (_, j) => {
      const [bankName, code] = pick(D.BANKS);
      return {
        key: ent('BANK_ACCOUNT', accountNo(), { label: `${bankName} collection ${i + 1}${'abc'[j]}`, flagged: true }),
        bankName,
        ifscCode: ifsc(code),
      };
    }),
    telegram: ent('TELEGRAM', `@arbitrage_desk_${i + 1}`, { label: `Desk ${i + 1}`, flagged: true }),
    tgHandle: `arbitrage_desk_${i + 1}`,
    layer1: ent('BANK_ACCOUNT', accountNo(), { label: `Layering ${i + 1}A`, flagged: true }),
    layer2: ent('BANK_ACCOUNT', accountNo(), { label: `Layering ${i + 1}B`, flagged: true }),
    hot: ent('WALLET', ethWallet(), { label: `Aggregation wallet ${i + 1}`, flagged: true }),
    mixer: ent('WALLET', ethWallet(), { label: `Mixer deposit ${i + 1}`, flagged: true }),
    exchange: ent('WALLET', ethWallet(), { label: `Exchange deposit ${i + 1}`, flagged: true }),
  }));

  cells.forEach((c) => {
    c.recruiters.forEach((h) => elink(h.key, boss, 'COMMUNICATED_WITH', { weight: 3, source: 'SEIZURE' }));
    c.collectors.forEach((a) => elink(a.key, boss, 'REGISTERED_TO',
      { weight: 4, source: 'BANK', note: 'accounts opened on documents traced to one identity' }));
    [c.hot, c.mixer, c.exchange].forEach((w) => elink(boss, w, 'OWNS',
      { weight: 5, source: 'INTEL', note: 'exchange KYC resolves to the same identity' }));
  });

  const places = shuffle(D.PLACES).slice(0, 8);
  const built = [];
  for (let i = 0; i < 15; i++) {
    const c = cells[i % 2];
    const k = Math.floor(i / 2);
    const rec = c.recruiters[k % 2];
    const collector = c.collectors[k % 3];
    const r = makeComplaint({
      category: 'CRYPTO_FRAUD',
      place: places[i % places.length],
      handlerPhoneKey: rec.key,
      handlerName: rec.name,
      upiKey: c.upis[k % 2],
      accountKey: collector.key,
      bankName: collector.bankName,
      ifscCode: collector.ifscCode,
      walletKey: null,
      telegramHandle: c.tgHandle,
      filedDaysAgo: int(2, 55),
      clusterTag: 'GAMMA',
    });
    link(r.ci, c.telegram, 'SUSPECT', 'REGEX', 0.92);
    built.push({ ...r, cell: c, collector });
  }

  // Six-hop ladder per complaint — this is what the Money Flow page traces.
  built.forEach((r) => {
    const a = r.amt2;
    const at = complaints[r.ci].filedAt;
    const c = r.cell;
    txns.push({ ci: r.ci, from: r.victimPhoneKey, to: r.collector.key, amount: a, rail: 'UPI', hop: 0, ref: utr(), at });
    txns.push({ ci: r.ci, from: r.collector.key, to: c.layer1, amount: Math.round(a * 0.97), rail: 'IMPS', hop: 1, ref: utr(), at });
    txns.push({ ci: r.ci, from: c.layer1, to: c.layer2, amount: Math.round(a * 0.94), rail: 'NEFT', hop: 2, ref: utr(), at });
    txns.push({ ci: r.ci, from: c.layer2, to: c.hot, amount: Math.round(a * 0.90), rail: 'CRYPTO', hop: 3, ref: txHash(), at });
    txns.push({ ci: r.ci, from: c.hot, to: c.mixer, amount: Math.round(a * 0.88), rail: 'CRYPTO', hop: 4, ref: txHash(), at });
    txns.push({ ci: r.ci, from: c.mixer, to: c.exchange, amount: Math.round(a * 0.85), rail: 'CRYPTO', hop: 5, ref: txHash(), at });
  });

  plant.GAMMA = {
    label: 'Crypto laundering — twin ladders to offshore exchanges',
    mastermindKey: boss,
    mastermindName: bossName,
  };
}

// ---------------------------------------------------------------------------
// NOISE — ~135 unrelated complaints.
// Each gets its own fresh entities so nothing accidentally correlates. Without
// these, Louvain has a trivial job and the demo proves nothing.
// ---------------------------------------------------------------------------
function buildNoise(n) {
  for (let i = 0; i < n; i++) {
    const category = pick(D.CATEGORIES);
    const suspect = personName();
    const [bankName, code] = pick(D.BANKS);
    const r = makeComplaint({
      category,
      place: pick(D.PLACES),
      handlerPhoneKey: ent('PHONE', mobile(), { label: `Suspect — ${suspect}` }),
      handlerName: suspect,
      upiKey: ent('UPI', upiFor(suspect)),
      accountKey: rnd() < 0.7 ? ent('BANK_ACCOUNT', accountNo(), { label: bankName }) : null,
      bankName,
      ifscCode: ifsc(code),
      walletKey: rnd() < 0.12 ? ent('WALLET', ethWallet()) : null,
      deviceKey: rnd() < 0.15 ? ent('DEVICE', deviceFp()) : null,
      ipKey: rnd() < 0.25 ? ent('IP', ipv4()) : null,
      filedDaysAgo: int(1, 120),
      clusterTag: null,
    });
    if (rnd() < 0.6) {
      txns.push({ ci: r.ci, from: r.victimPhoneKey, to: cEntities.filter((c) => c.ci === r.ci && c.role === 'SUSPECT')[0].key,
        amount: r.amt2, rail: pick(['UPI', 'IMPS', 'NEFT']), hop: 0, ref: utr(), at: complaints[r.ci].filedAt });
    }
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
async function persist(client) {
  // --- units + users ---
  const unitIds = {};
  for (const [name, code, state, location] of D.UNITS) {
    const { rows } = await client.query(
      `INSERT INTO units (name, code, state, location) VALUES ($1,$2,$3,$4) RETURNING id`,
      [name, code, state, location]
    );
    unitIds[code] = rows[0].id;
  }

  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const USERS = [
    ['admin@argus.gov.in', 'Ananya Krishnan', 'ADMIN', 'Deputy Inspector General', 'I4C-HQ'],
    ['supervisor@argus.gov.in', 'Rajesh Menon', 'SUPERVISOR', 'Superintendent of Police', 'CCPS-BLR'],
    ['investigator@argus.gov.in', 'Priya Deshmukh', 'INVESTIGATOR', 'Inspector', 'CCPS-BLR'],
    ['analyst@argus.gov.in', 'Sameer Qureshi', 'ANALYST', 'Cyber Intelligence Analyst', 'I4C-HQ'],
    ['investigator2@argus.gov.in', 'Kabir Sandhu', 'INVESTIGATOR', 'Sub-Inspector', 'CCPS-MUM'],
  ];
  const userIds = {};
  for (const [email, fullName, role, rankTitle, unit] of USERS) {
    const { rows } = await client.query(
      `INSERT INTO users (email, password_hash, full_name, role, rank_title, unit_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [email, hash, fullName, role, rankTitle, unitIds[unit]]
    );
    userIds[email] = rows[0].id;
  }

  // --- entities (canonical; the UNIQUE constraint is the dedup backstop) ---
  const entityIds = new Map();
  const entArr = [...entities.entries()];
  for (let i = 0; i < entArr.length; i += 500) {
    const chunk = entArr.slice(i, i + 500);
    const vals = [];
    const params = [];
    chunk.forEach(([, e], j) => {
      const b = j * 5;
      vals.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5})`);
      params.push(e.type, e.value, e.normalized, e.label, e.isFlagged);
    });
    const { rows } = await client.query(
      `INSERT INTO entities (entity_type, value, normalized_value, label, is_flagged)
       VALUES ${vals.join(',')}
       ON CONFLICT (entity_type, normalized_value) DO UPDATE SET label = COALESCE(entities.label, EXCLUDED.label)
       RETURNING id, entity_type, normalized_value`,
      params
    );
    rows.forEach((r) => entityIds.set(keyOf(r.entity_type, r.normalized_value), r.id));
  }

  // --- complaints ---
  const complaintIds = [];
  for (let i = 0; i < complaints.length; i += 200) {
    const chunk = complaints.slice(i, i + 200);
    const vals = [];
    const params = [];
    chunk.forEach((c, j) => {
      const b = j * 13;
      vals.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},$${b + 12},$${b + 13})`);
      params.push(c.ref, c.victimName, c.victimPhone, c.victimEmail, c.narrative, c.category,
        c.amount, c.state, c.district, c.lat, c.lon, c.status, c.filedAt);
    });
    const { rows } = await client.query(
      `INSERT INTO complaints
        (complaint_ref, victim_name, victim_phone, victim_email, narrative, scam_category,
         amount_inr, state, district, lat, lon, status, filed_at)
       VALUES ${vals.join(',')} RETURNING id`,
      params
    );
    rows.forEach((r) => complaintIds.push(r.id));
  }

  // --- complaint_entities ---
  for (let i = 0; i < cEntities.length; i += 500) {
    const chunk = cEntities.slice(i, i + 500);
    const vals = [];
    const params = [];
    let n = 0;
    chunk.forEach((ce) => {
      const eid = entityIds.get(ce.key);
      if (!eid) return;
      const b = n * 6;
      vals.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6})`);
      params.push(complaintIds[ce.ci], eid, ce.role, ce.confidence, ce.method, ce.snippet);
      n++;
    });
    if (!n) continue;
    await client.query(
      `INSERT INTO complaint_entities (complaint_id, entity_id, role, confidence, method, context_snippet)
       VALUES ${vals.join(',')} ON CONFLICT (complaint_id, entity_id, role) DO NOTHING`,
      params
    );
  }

  // --- entity_links ---
  for (let i = 0; i < eLinks.length; i += 500) {
    const chunk = eLinks.slice(i, i + 500);
    const vals = [];
    const params = [];
    let n = 0;
    chunk.forEach((l) => {
      const a = entityIds.get(l.from); const b2 = entityIds.get(l.to);
      if (!a || !b2) return;
      const b = n * 6;
      vals.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6})`);
      params.push(a, b2, l.rel, l.weight, l.source, l.note);
      n++;
    });
    if (!n) continue;
    await client.query(
      `INSERT INTO entity_links (from_entity_id, to_entity_id, relationship, weight, source, note)
       VALUES ${vals.join(',')} ON CONFLICT (from_entity_id, to_entity_id, relationship) DO NOTHING`,
      params
    );
  }

  // --- transactions ---
  for (let i = 0; i < txns.length; i += 500) {
    const chunk = txns.slice(i, i + 500);
    const vals = [];
    const params = [];
    let n = 0;
    chunk.forEach((t) => {
      const a = entityIds.get(t.from); const b2 = entityIds.get(t.to);
      if (!a || !b2) return;
      const b = n * 7;
      vals.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`);
      params.push(complaintIds[t.ci], a, b2, t.amount, t.rail, t.hop, t.ref);
      n++;
    });
    if (!n) continue;
    await client.query(
      `INSERT INTO transactions (complaint_id, from_entity_id, to_entity_id, amount_inr, rail, hop_index, reference)
       VALUES ${vals.join(',')}`,
      params
    );
  }

  return { unitIds, userIds, entityIds, complaintIds };
}

/**
 * Cluster rows and the planted mastermind pointer.
 *
 * NOTE: these are PLACEHOLDER rows. The analytics job (§I.3–I.4) overwrites
 * cluster membership, influence and risk with computed values. Seeding them
 * here only means the UI has something to render before the intel service is
 * up; `verify-plant` checks the computed answer, never this one.
 */
async function persistClusters(client, ids) {
  const meta = {
    ALPHA: { risk: 'CRITICAL', score: 94, desc: 'High-volume investment fraud coordinated over Telegram. Handlers rotate across four numbers; proceeds consolidate into three wallets held by a single identity.' },
    BETA: { risk: 'HIGH', score: 78, desc: 'Impersonation of law enforcement over VoIP. Victims held on video calls and coerced into "verification" transfers.' },
    GAMMA: { risk: 'HIGH', score: 71, desc: 'Layering operation converting UPI collections into crypto across a five-hop ladder terminating at an offshore exchange.' },
  };

  const clusterIds = {};
  for (const [key, p] of Object.entries(plant)) {
    const m = meta[key];
    const members = complaints.filter((c) => c.clusterTag === key);
    const states = new Set(members.map((c) => c.state));
    const total = members.reduce((s, c) => s + c.amount, 0);
    const nodeCount = cEntities.filter((ce) => members.some((_, i) => complaints[ce.ci]?.clusterTag === key)).length;

    const { rows } = await client.query(
      `INSERT INTO clusters (cluster_key, label, description, node_count, complaint_count,
                             total_amount_inr, states_touched, risk_level, risk_score, mastermind_entity_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [key, p.label, m.desc, nodeCount, members.length, total, states.size, m.risk, m.score,
       ids.entityIds.get(p.mastermindKey)]
    );
    clusterIds[key] = rows[0].id;

    // Tag the entities we planted into this cluster so the UI has colour before
    // the analytics job runs.
    const memberIdx = new Set(members.map((c) => complaints.indexOf(c)));
    const entIds = new Set();
    cEntities.forEach((ce) => { if (memberIdx.has(ce.ci)) { const id = ids.entityIds.get(ce.key); if (id) entIds.add(id); } });
    const bossId = ids.entityIds.get(p.mastermindKey);
    if (bossId) entIds.add(bossId);
    if (entIds.size) {
      await client.query(`UPDATE entities SET cluster_id = $1 WHERE id = ANY($2::int[])`, [rows[0].id, [...entIds]]);
    }
  }
  return clusterIds;
}

async function persistCasesAndAlerts(client, ids, clusterIds) {
  const inv = [
    ['ARGUS-CASE-0001', 'Telegram investment ring — multi-state', 'ALPHA', 'investigator@argus.gov.in', 'ACTIVE', 'CRITICAL'],
    ['ARGUS-CASE-0002', 'Digital arrest impersonation cell', 'BETA', 'investigator2@argus.gov.in', 'ACTIVE', 'HIGH'],
    ['ARGUS-CASE-0003', 'Crypto layering ladder — offshore cash-out', 'GAMMA', 'analyst@argus.gov.in', 'OPEN', 'HIGH'],
    ['ARGUS-CASE-0004', 'OLX QR-code refund fraud cluster', null, 'investigator@argus.gov.in', 'OPEN', 'MEDIUM'],
  ];
  for (const [ref, title, ck, email, status, priority] of inv) {
    await client.query(
      `INSERT INTO investigations (case_ref, title, cluster_id, assigned_to, status, priority)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [ref, title, ck ? clusterIds[ck] : null, ids.userIds[email], status, priority]
    );
  }

  /**
   * No alerts are seeded.
   *
   * They used to be: eight hand-written rows saying things like "Wallet reused
   * across 14 complaints in 6 states" — numbers computed from nothing, which
   * would have gone on saying 14 and 6 however the data changed. That is a mock
   * wearing the costume of a feature, and docs/PLAN-V2-DATA-AND-INTEL.md §3.3
   * says to replace it.
   *
   * The threat feed is now produced by src/services/alertRules.js, which runs
   * five rules over the live tables and stores the query behind each finding.
   * `npm run setup` runs it after seeding; `POST /api/alerts/regenerate`
   * re-runs it on demand.
   */

  // Audit trail — this is what the Investigation Timeline page renders.
  const events = [
    ['investigator@argus.gov.in', 'COMPLAINT_RECEIVED', 'complaint', 'Complaint intake from NCRP'],
    ['analyst@argus.gov.in', 'ENTITIES_EXTRACTED', 'complaint', 'AI extracted 7 entities'],
    ['analyst@argus.gov.in', 'GRAPH_INGESTED', 'complaint', 'Entities merged into criminal graph'],
    ['analyst@argus.gov.in', 'CLUSTER_COMPUTED', 'cluster', 'Louvain identified 3 communities'],
    ['analyst@argus.gov.in', 'MASTERMIND_RANKED', 'entity', 'PageRank + betweenness ranked coordinator'],
    ['supervisor@argus.gov.in', 'INVESTIGATION_OPENED', 'investigation', 'Case ARGUS-CASE-0001 opened'],
    ['supervisor@argus.gov.in', 'INVESTIGATOR_ASSIGNED', 'investigation', 'Assigned to Inspector Priya Deshmukh'],
    ['investigator@argus.gov.in', 'EVIDENCE_UPLOADED', 'evidence', 'Screenshot bundle uploaded'],
    ['investigator@argus.gov.in', 'EVIDENCE_ANCHORED', 'evidence', 'SHA-256 digest anchored on-chain'],
    ['investigator2@argus.gov.in', 'EVIDENCE_VERIFIED', 'evidence', 'Integrity check passed'],
    ['admin@argus.gov.in', 'ALERT_ACKNOWLEDGED', 'alert', 'Critical wallet-reuse alert acknowledged'],
    ['investigator@argus.gov.in', 'COMPLAINT_LINKED', 'complaint', 'Complaint linked to Cluster ALPHA'],
  ];
  for (let i = 0; i < events.length; i++) {
    const [email, action, etype, note] = events[i];
    await client.query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, metadata, ip_address, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [ids.userIds[email], action, etype, JSON.stringify({ note }), '10.12.4.' + (11 + i),
       daysAgo(events.length - i, false)]
    );
  }
}

// ---------------------------------------------------------------------------
async function main() {
  console.log('ARGUS seed — building planted dataset\n');

  buildAlpha();
  buildBeta();
  buildGamma();
  buildNoise(135);

  console.log(`  complaints        ${complaints.length}`);
  console.log(`  canonical entities ${entities.size}`);
  console.log(`  complaint links   ${cEntities.length}`);
  console.log(`  intel edges       ${eLinks.length}`);
  console.log(`  transactions      ${txns.length}\n`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Order matters: FKs cascade from complaints/entities outward.
    await client.query(`TRUNCATE
      audit_logs, alerts, investigations, verifications, evidence_anchors, evidence,
      transactions, entity_links, complaint_entities, clusters, entities, complaints,
      users, units RESTART IDENTITY CASCADE`);

    const ids = await persist(client);
    const clusterIds = await persistClusters(client, ids);
    await persistCasesAndAlerts(client, ids, clusterIds);

    /**
     * Re-point the reference sequence past everything just seeded.
     *
     * `TRUNCATE ... RESTART IDENTITY` resets the tables' own identity columns
     * but NOT `complaint_ref_seq`, which is a standalone sequence the intake
     * controller draws from. Without this, a freshly seeded database holds
     * refs up to NCRP-YYYY-000220 while the sequence still sits at 1 — and the
     * first complaint filed in the demo collides with a seeded one and dies on
     * the UNIQUE constraint. Seeded and live refs share one numbering line, so
     * the seed has to hand it over correctly.
     */
    await client.query(
      `SELECT setval('complaint_ref_seq', GREATEST(
         (SELECT COALESCE(MAX(substring(complaint_ref FROM '(\\d+)$')::bigint), 0)
            FROM complaints WHERE complaint_ref ~ '^NCRP-\\d{4}-\\d+$'),
         1))`
    );

    await client.query('COMMIT');
    console.log('Seed committed.\n');

    const { rows } = await client.query(`
      SELECT
        (SELECT count(*) FROM complaints)         AS complaints,
        (SELECT count(*) FROM entities)           AS entities,
        (SELECT count(*) FROM complaint_entities) AS links,
        (SELECT count(*) FROM entity_links)       AS intel_edges,
        (SELECT count(*) FROM transactions)       AS txns,
        (SELECT count(*) FROM alerts)             AS alerts,
        (SELECT count(*) FROM users)              AS users`);
    console.table(rows[0]);

    const boss = await client.query(
      `SELECT e.id, e.value, e.entity_type FROM entities e WHERE e.entity_type='PERSON' AND e.normalized_value=$1`,
      [normalize('PERSON', plant.ALPHA.mastermindName)]
    );
    console.log(`Planted ALPHA coordinator: ${plant.ALPHA.mastermindName} (entity id ${boss.rows[0]?.id})`);
    console.log(`Demo login: investigator@argus.gov.in / ${DEMO_PASSWORD}\n`);
    console.log('Next: npm run verify-plant — proves centrality actually ranks the coordinator first.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('\nSeed failed:', err.message);
  if (err.detail) console.error('detail:', err.detail);
  process.exit(1);
});
