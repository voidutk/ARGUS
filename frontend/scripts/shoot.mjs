/**
 * Screenshots every page, and reports what the browser complained about.
 *
 *   node scripts/shoot.mjs [outDir]
 *
 * Built because reviewing this UI by reading source is guesswork — a layout
 * that compiles and lints cleanly can still render as a diagonal line, which is
 * exactly what happened to the Network Explorer. This drives a real browser
 * against the real API so the pages can be LOOKED at.
 *
 * It also captures console errors and failed requests, which is the half of
 * "does it work" that a screenshot cannot show: a page can look perfect while
 * throwing on every render.
 */

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const OUT = process.argv[2] || 'shots';
const BASE = process.env.ARGUS_UI ?? 'http://localhost:5173';
const CRED = { email: 'investigator@argus.gov.in', password: 'argus2026' };

/** Graph layouts animate; a fixed wait is the difference between a picture of
 *  the network and a picture of it mid-flight. */
const PAGES = [
  { name: '01-login', path: '/login', auth: false, settle: 1800 },
  { name: '02-dashboard', path: '/', settle: 1200 },
  { name: '03-network', path: '/network', settle: 5200 },
  { name: '04-complaints', path: '/complaints', settle: 1200 },
  { name: '05-complaint-detail', path: null, settle: 1500 }, // resolved below
  { name: '06-alerts', path: '/alerts', settle: 1000 },
  { name: '07-timeline', path: '/timeline', settle: 1000 },
  { name: '08-money', path: '/money?complaint=1', settle: 1800 },
  { name: '09-geo', path: '/geo', settle: 1500 },
  { name: '10-clusters', path: '/clusters', settle: 1000 },
  { name: '11-evidence', path: '/evidence', settle: 1000 },
  { name: '12-admin', path: '/admin', settle: 1000 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await mkdir(OUT, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
  });

  const problems = [];
  const page = await context.newPage();

  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push({ where: page.url(), kind: 'console', text: msg.text() });
  });
  page.on('pageerror', (err) => {
    problems.push({ where: page.url(), kind: 'pageerror', text: err.message });
  });
  page.on('requestfailed', (req) => {
    // Favicon noise is not a defect worth reporting.
    if (req.url().includes('favicon')) return;
    problems.push({ where: page.url(), kind: 'request', text: `${req.method()} ${req.url()} — ${req.failure()?.errorText}` });
  });
  page.on('response', (res) => {
    if (res.status() >= 400 && res.url().includes('/api/')) {
      problems.push({ where: page.url(), kind: 'http', text: `${res.status()} ${res.url()}` });
    }
  });

  // ---- sign in once; the token lives in localStorage for every later page ----
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await sleep(1800);
  await page.screenshot({ path: path.join(OUT, '01-login.png') });
  console.log('  shot  01-login');

  await page.fill('input[type="email"]', CRED.email);
  await page.fill('input[type="password"]', CRED.password);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.includes('login'), { timeout: 15_000 });
  await sleep(1200);

  // Find a complaint that actually has links, so the detail shot shows the
  // panel that matters rather than an empty state.
  const token = await page.evaluate(() => localStorage.getItem('argus.token'));
  const list = await fetch(`${BASE}/api/complaints?cluster=ALPHA&limit=1`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then((r) => r.json());
  const complaintId = list?.complaints?.[0]?.id;

  for (const spec of PAGES) {
    if (spec.name === '01-login') continue;
    const target = spec.path ?? (complaintId ? `/complaints/${complaintId}` : null);
    if (!target) { console.log(`  skip  ${spec.name} (no complaint found)`); continue; }

    try {
      await page.goto(`${BASE}${target}`, { waitUntil: 'networkidle', timeout: 25_000 });
      await sleep(spec.settle);
      await page.screenshot({ path: path.join(OUT, `${spec.name}.png`), fullPage: false });
      console.log(`  shot  ${spec.name}`);
    } catch (err) {
      console.log(`  FAIL  ${spec.name} — ${err.message.split('\n')[0]}`);
      problems.push({ where: target, kind: 'navigation', text: err.message.split('\n')[0] });
    }
  }

  await browser.close();

  console.log('');
  if (!problems.length) {
    console.log('No console errors, page errors or failed requests.\n');
    return;
  }

  // Collapse duplicates — one broken poll would otherwise print fifty times.
  const seen = new Map();
  for (const p of problems) {
    const key = `${p.kind}:${p.text}`;
    seen.set(key, { ...p, count: (seen.get(key)?.count ?? 0) + 1 });
  }
  console.log(`${seen.size} distinct problem(s):\n`);
  for (const p of seen.values()) {
    console.log(`  [${p.kind}]${p.count > 1 ? ` x${p.count}` : ''} ${p.text}`);
    console.log(`      on ${p.where}`);
  }
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
