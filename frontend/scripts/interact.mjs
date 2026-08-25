import { chromium } from 'playwright';
const BASE='http://localhost:5173';
const OUT=process.argv[2];
const b=await chromium.launch();
const p=await b.newPage({viewport:{width:1600,height:1000}});
const errs=[];
p.on('pageerror',e=>errs.push(e.message));
p.on('console',m=>{if(m.type()==='error')errs.push(m.text());});

await p.goto(`${BASE}/login`,{waitUntil:'networkidle'});
await p.fill('input[type="email"]','investigator@argus.gov.in');
await p.fill('input[type="password"]','argus2026');
await p.click('button[type="submit"]');
await p.waitForURL(u=>!u.pathname.includes('login'));

// --- threat feed: open the Why drawer ---
await p.goto(`${BASE}/alerts`,{waitUntil:'networkidle'});
await p.waitForTimeout(1200);
await p.locator('button:has-text("Why")').first().click();
await p.waitForTimeout(1400);
await p.screenshot({path:`${OUT}/13-alert-why.png`});
console.log('  shot  13-alert-why');

// --- network explorer: select the coordinator, open /why ---
await p.goto(`${BASE}/network`,{waitUntil:'networkidle'});
await p.waitForTimeout(5000);
await p.locator('button:has-text("Vikram Rathore")').first().click();
await p.waitForTimeout(2000);
await p.screenshot({path:`${OUT}/14-network-why.png`});
console.log('  shot  14-network-why');

await b.close();
console.log(errs.length? `\nERRORS:\n${[...new Set(errs)].join('\n')}` : '\nno console/page errors');
