/**
 * Drive a page through a scripted sequence of clicks, then shoot it.
 *
 *   node scripts/act.mjs <route> <out.png> "<step>|<step>|..."
 *
 * A step is one of:
 *   click:<selector>        click it
 *   text:<string>           click the first element whose text matches
 *   wait:<ms>               pause
 *   shot:<file.png>         capture mid-sequence
 *
 * Exists because half the defects on these screens only appear in a state you
 * have to reach — a second tab, a selected row, a toggled layer. A screenshot of
 * the default state cannot find those, and neither can reading the source.
 */

import { chromium } from 'playwright';

const norm = (r) => {
  const mangled = String(r).match(/^[A-Za-z]:[\\/].*?[\\/]Git[\\/](.*)$/);
  const s = mangled ? `/${mangled[1]}` : String(r);
  return s.startsWith('/') ? s : `/${s}`;
};

const ROUTE = norm(process.argv[2] ?? '/');
const OUT = process.argv[3] ?? 'page.png';
const STEPS = (process.argv[4] ?? '').split('|').filter(Boolean);
const BASE = process.env.ARGUS_UI ?? 'http://localhost:5173';
const EMAIL = process.env.ARGUS_EMAIL ?? 'investigator@argus.gov.in';
const PASSWORD = process.env.ARGUS_PASSWORD ?? 'argus2026';

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, colorScheme: 'dark' });
const page = await context.newPage();

const problems = [];
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') problems.push(`[console] ${m.text()}`); });
page.on('response', (r) => {
  if (r.status() >= 400 && r.url().includes('/api/')) problems.push(`[http] ${r.status()} ${r.url()}`);
});

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.fill('input[type="email"]', EMAIL);
await page.fill('input[type="password"]', PASSWORD);
await page.click('button[type="submit"]');
await page.waitForURL((u) => !u.pathname.includes('login'), { timeout: 15_000 });
await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'networkidle', timeout: 25_000 });
await page.waitForTimeout(1500);

for (const step of STEPS) {
  const idx = step.indexOf(':');
  const kind = step.slice(0, idx);
  const arg = step.slice(idx + 1);
  try {
    if (kind === 'click') await page.click(arg, { timeout: 8000 });
    else if (kind === 'text') await page.getByText(arg, { exact: false }).first().click({ timeout: 8000 });
    else if (kind === 'wait') await page.waitForTimeout(Number(arg));
    else if (kind === 'shot') { await page.screenshot({ path: arg }); console.log(`  mid-shot -> ${arg}`); }
    console.log(`  ok  ${step}`);
  } catch (err) {
    console.log(`  FAIL ${step} — ${err.message.split('\n')[0]}`);
    problems.push(`[step] ${step} — ${err.message.split('\n')[0]}`);
  }
}

await page.waitForTimeout(1200);
await page.screenshot({ path: OUT });
console.log(`shot ${ROUTE} -> ${OUT}`);
console.log(problems.length ? `${problems.length} problem(s):\n  ${[...new Set(problems)].join('\n  ')}` : 'clean');

await browser.close();
