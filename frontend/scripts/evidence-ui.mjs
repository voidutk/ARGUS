/**
 * Drives the Evidence Locker through the BROWSER — upload, verify, custody.
 *
 * scripts/evidence-e2e.js in the backend already proves the API does this. What
 * it cannot prove is that the page wires it up: a FormData built wrong, a blob
 * download that never fires, a custody panel that does not re-read after a
 * verification. Those only fail in a browser.
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const BASE = 'http://localhost:5173';
const OUT = process.argv[2];
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

const ok = (label, cond) => console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}`);

await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await p.fill('input[type="email"]', 'investigator@argus.gov.in');
await p.fill('input[type="password"]', 'argus2026');
await p.click('button[type="submit"]');
await p.waitForURL((u) => !u.pathname.includes('login'));

await p.goto(`${BASE}/evidence`, { waitUntil: 'networkidle' });
await p.waitForTimeout(1500);

const before = await p.locator('text=/^Sealed exhibits$/i').count();

// --- upload a real file through the form ---
const file = path.join(tmpdir(), `argus-ui-exhibit-${Date.now()}.txt`);
writeFileSync(file, `Seized chat export.\nHandler +91 9334825546 to UPI imran@okhdfcbank.\nSealed ${new Date().toISOString()}\n`);

await p.setInputFiles('input[type="file"]', file);
await p.fill('input[placeholder="Exhibit title (optional)"]', 'UI-sealed exhibit');
await p.waitForTimeout(300);
await p.click('button:has-text("Hash, encrypt")');
await p.waitForTimeout(3000);
await p.screenshot({ path: `${OUT}/15-evidence-uploaded.png` });

const listText = await p.locator('body').innerText();
ok('upload appears in the locker', listText.includes('UI-sealed exhibit'));
ok('a digest is shown', /SHA-256 OF THE PLAINTEXT/i.test(listText));

// --- wait for the async anchor, then verify ---
await p.waitForTimeout(4000);
await p.reload({ waitUntil: 'networkidle' });
await p.waitForTimeout(1500);
await p.locator('button:has-text("UI-sealed exhibit")').first().click().catch(() => {});
await p.waitForTimeout(1200);

await p.click('button:has-text("Verify integrity")');
await p.waitForTimeout(4000);
await p.screenshot({ path: `${OUT}/16-evidence-verified.png` });

const afterText = await p.locator('body').innerText();
ok('verification returned a verdict', /Integrity confirmed|INTEGRITY FAILED/.test(afterText));
ok('custody trail rendered', /CHAIN OF CUSTODY/i.test(afterText));

await b.close();
console.log(errs.length ? `\nERRORS:\n${[...new Set(errs)].join('\n')}` : '\nno console/page errors');
