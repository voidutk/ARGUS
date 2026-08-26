/**
 * Shoot ONE page and report what the browser complained about.
 *
 *   node scripts/page.mjs <route> <out.png> [settleMs]
 *
 * `shoot.mjs` walks all twelve screens, which is right for a sweep and far too
 * slow for the edit-look-edit loop you actually work in when fixing a single
 * page. This is that loop: one route, one picture, the console errors, and any
 * API call that came back 4xx/5xx.
 *
 * Credentials come from ARGUS_EMAIL / ARGUS_PASSWORD so admin-gated screens can
 * be shot as an admin without editing the file.
 */

import { chromium } from 'playwright';

/**
 * Git Bash on Windows rewrites a leading-slash argument into a filesystem path,
 * so `/geo` arrives as `C:/Program Files/Git/geo`. Strip that prefix back off
 * and accept a bare `geo` too, rather than making every caller remember to set
 * MSYS_NO_PATHCONV.
 */
const ROUTE = (() => {
  let r = process.argv[2] ?? '/';
  const mangled = r.match(/^[A-Za-z]:[\\/].*?[\\/]Git[\\/](.*)$/);
  if (mangled) r = `/${mangled[1]}`;
  return r.startsWith('/') ? r : `/${r}`;
})();
const OUT = process.argv[3] ?? 'page.png';
const SETTLE = Number(process.argv[4] ?? 1800);
const BASE = process.env.ARGUS_UI ?? 'http://localhost:5173';
const EMAIL = process.env.ARGUS_EMAIL ?? 'investigator@argus.gov.in';
const PASSWORD = process.env.ARGUS_PASSWORD ?? 'argus2026';
const FULL = process.env.ARGUS_FULLPAGE === '1';

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  colorScheme: 'dark',
});
const page = await context.newPage();

const problems = [];
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') problems.push(`[console] ${m.text()}`); });
page.on('requestfailed', (r) => {
  if (!r.url().includes('favicon')) problems.push(`[request] ${r.method()} ${r.url()} — ${r.failure()?.errorText}`);
});
page.on('response', (r) => {
  if (r.status() >= 400 && r.url().includes('/api/')) problems.push(`[http] ${r.status()} ${r.url()}`);
});

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.fill('input[type="email"]', EMAIL);
await page.fill('input[type="password"]', PASSWORD);
await page.click('button[type="submit"]');
await page.waitForURL((u) => !u.pathname.includes('login'), { timeout: 15_000 });

await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'networkidle', timeout: 25_000 });
await new Promise((r) => setTimeout(r, SETTLE));
await page.screenshot({ path: OUT, fullPage: FULL });

console.log(`shot ${ROUTE} -> ${OUT}`);
if (!problems.length) {
  console.log('clean — no console errors, page errors or failed requests');
} else {
  const seen = new Map();
  for (const p of problems) seen.set(p, (seen.get(p) ?? 0) + 1);
  console.log(`${seen.size} distinct problem(s):`);
  for (const [text, n] of seen) console.log(`  ${n > 1 ? `x${n} ` : ''}${text}`);
}

await browser.close();
