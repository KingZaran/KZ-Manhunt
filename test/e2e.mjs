// End-to-end test: three simulated phones with fake GPS play a full game
// against the mock database (which enforces the real security rules).
//
// Run: PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers NODE_PATH=/opt/npm-tools/node_modules node test/e2e.mjs
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const PORT = 8788;
const BASE = `http://localhost:${PORT}`;
const HERE = new URL('.', import.meta.url).pathname;
const SHOTS = process.env.SHOTS || '/tmp/manhunt-shots';
mkdirSync(SHOTS, { recursive: true });

const srv = spawn(process.execPath, [HERE + 'mock-server.mjs', String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => srv.stdout.once('data', r));
const advance = (ms) => fetch(BASE + '/__test/advance', { method: 'POST', body: JSON.stringify({ ms }) });

const LAT = 51.1, LNG = -1.65;
const mlon = 111320 * Math.cos(LAT * Math.PI / 180);
const at = (dN, dE, acc = 6) => ({ latitude: LAT + dN / 111320, longitude: LNG + dE / mlon, accuracy: acc });

const browser = await chromium.launch();
const errors = [];
let failures = 0;
function check(cond, msg) { if (cond) console.log('  ok  ', msg); else { failures++; console.log('  FAIL', msg); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function phone(label, pos) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    geolocation: pos, permissions: ['geolocation'],
  });
  await ctx.route('https://www.gstatic.com/firebasejs/**', (route) => {
    const file = route.request().url().split('/').pop();
    route.fulfill({ contentType: 'text/javascript', body: readFileSync(HERE + 'firebase-shim/' + file, 'utf8') });
  });
  await ctx.route(/\/js\/config\.js/, (route) => route.fulfill({ contentType: 'text/javascript', body: `export const firebaseConfig = { apiKey: 'test', databaseURL: '${BASE}' };` }));
  await ctx.route(/fonts\.(googleapis|gstatic)\.com|basemaps\.cartocdn\.com|arcgisonline\.com/, (route) => route.abort());
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(`${label} console: ${m.text()}`); });
  page.label = label;
  page.ctx = ctx;
  await page.goto(BASE + '/index.html');
  return page;
}
const shot = (p, n) => p.screenshot({ path: `${SHOTS}/${n}.png` });
const text = (p, sel) => p.locator(sel).innerText();
const toasts = (p) => p.locator('#toasts').innerText();
const clearToasts = (...ps) => Promise.all(ps.map((p) => p.evaluate(() => { document.querySelector('#toasts').innerHTML = ''; })));
async function waitFor(fn, ms = 8000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch (e) { /* retry */ } await sleep(200); }
  console.log('     (timed out waiting for', label, ')');
  return false;
}

try {
  console.log('setup');
  const ann = await phone('Ann', at(0, 0));
  await ann.waitForSelector('#home:not([hidden])');
  await shot(ann, '01-home');
  await ann.fill('#name', 'Ann');
  await ann.click('#create');
  await ann.waitForSelector('#lobby:not([hidden])');
  await waitFor(async () => (await text(ann, '#code-big')).trim().length === 5);
  const code = (await text(ann, '#code-big')).trim();
  check(/^[A-Z2-9]{5}$/.test(code), `game created with code ${code}`);

  const bob = await phone('Bob', at(40, 10));
  const cat = await phone('Cat', at(200, 0));
  for (const [p, n] of [[bob, 'Bob'], [cat, 'Cat']]) {
    await p.waitForSelector('#home:not([hidden])');
    await p.fill('#name', n);
    await p.fill('#code', code);
    await p.click('#join-form button');
    await p.waitForSelector('#lobby:not([hidden])');
  }
  check(await waitFor(async () => (await ann.locator('.player').count()) === 3), 'host sees 3 players');

  // host setup
  await ann.click('[data-action="area-here"]');
  await ann.click('[data-action="area-radius"][data-v="400"]');
  const annUid = await ann.evaluate(() => localStorage.getItem('shimUid'));
  await ann.click(`[data-action="toggle-role"][data-uid="${annUid}"]`);
  await ann.click('[data-action="setting"][data-k="hideSecs"][data-v="60"]');
  await ann.click('[data-action="setting"][data-k="revealCooldownSecs"][data-v="120"]');
  check(await waitFor(async () => (await text(bob, '#team-counts')).includes('1 seeker')), 'guests see team change');
  check(await waitFor(async () => (await bob.locator('[data-k="hideSecs"][data-v="60"][aria-pressed="true"]').count()) === 1), 'guests see settings');
  await waitFor(async () => (await text(ann, '#player-list')).split('GPS ok').length === 4, 6000, 'all GPS ok');
  await shot(ann, '02-lobby-host');
  await shot(bob, '03-lobby-guest');
  check(await bob.locator('#start').isHidden(), 'guests cannot see Start');

  console.log('head start');
  await ann.click('#start');
  check(await waitFor(() => bob.locator('#game:not([hidden])').count().then((c) => c === 1)), 'game starts for hiders');
  check(await waitFor(async () => (await text(bob, '#clock-phase')) === 'Head start'), 'hider sees head start');
  check(await waitFor(async () => !(await ann.locator('#hold').isHidden())), 'seeker is held during head start');
  check(await waitFor(async () => (await bob.locator('#game-map .pin.seeker').count()) >= 1), 'hider can see the seeker during head start');
  await shot(ann, '04-seeker-wait');
  await shot(bob, '05-hider-headstart');

  console.log('hunt');
  await advance(61000);
  check(await waitFor(async () => (await text(ann, '#clock-phase')) === 'Hunt'), 'hunt starts');
  check(await waitFor(async () => (await bob.locator('#game-map .pin.seeker').count()) === 0), 'hider loses sight of seeker');
  check((await ann.locator('#game-map .pin.hider').count()) === 0, 'seeker cannot see hiders');
  await sleep(4500); // heartbeats refresh everyone's location after the time jump

  await ann.click('[data-action="catch-menu"]');
  await sleep(400);
  await shot(ann, '06-catch-sheet');
  const catUid = await cat.evaluate(() => localStorage.getItem('shimUid'));
  const bobUid = await bob.evaluate(() => localStorage.getItem('shimUid'));
  await ann.click(`[data-action="catch"][data-uid="${catUid}"]`);
  check(await waitFor(async () => (await toasts(ann)).includes('Not counted')), 'catch from 200 m is refused');
  await shot(ann, '07-catch-refused');

  await clearToasts(ann);
  await ann.click('[data-action="catch-menu"]');
  await ann.click(`[data-action="catch"][data-uid="${bobUid}"]`);
  check(await waitFor(async () => (await toasts(ann)).includes('Not counted')), 'catch from 41 m is refused');

  await ann.context().setGeolocation(at(36, 8));   // walk up to Bob (~4.5 m away)
  await sleep(3000);
  await ann.click('[data-action="catch-menu"]');
  await ann.click(`[data-action="catch"][data-uid="${bobUid}"]`);
  check(await waitFor(async () => (await toasts(ann)).includes('caught Bob')), 'catch from 4.5 m counts');
  check(await waitFor(async () => (await text(bob, '#hold')).includes('been caught')), 'Bob is told he was caught');
  await shot(bob, '08-caught');
  check(await waitFor(async () => (await bob.locator('#clock.team-seeker').count()) === 1, 6000), 'Bob is now a seeker');
  check(await waitFor(async () => (await bob.locator('#game-map .pin.seeker').count()) >= 1), 'Bob now sees his fellow seeker');

  console.log('reveal');
  check(await ann.locator('[data-action="reveal"]').isDisabled(), 'reveal on cooldown');
  await advance(120000);
  await sleep(4500);
  check(await waitFor(async () => !(await ann.locator('[data-action="reveal"]').isDisabled())), 'reveal ready after cooldown');
  await clearToasts(cat);
  await ann.click('[data-action="reveal"]');
  check(await waitFor(async () => (await toasts(cat)).includes('Reveal')), 'Cat is warned about the reveal');
  check(await waitFor(async () => (await ann.locator('#game-map .circle-label').allInnerTexts()).some((t) => t.startsWith('Cat')), 10000), 'seeker sees Cat\'s reveal circle');
  await shot(ann, '09-reveal-seeker');
  await shot(cat, '10-reveal-hider');
  const circ = await fetch(BASE + '/__test/tree').then((r) => r.json()).then((t) => t.games[code].circles[catUid]);
  const off = Math.hypot((circ.lat - (LAT + 200 / 111320)) * 111320, (circ.lng - LNG) * mlon);
  check(off < 100 && off > 0.01, `circle is off-centre (${off.toFixed(1)} m) but contains Cat`);

  console.log('exposure');
  await cat.context().setGeolocation(at(600, 0)); // runs out of bounds
  check(await waitFor(async () => (await cat.locator('#banner').innerText()).includes('outside the play area')), 'Cat is warned she is out of bounds');
  check(await waitFor(async () => (await ann.locator('#game-map .pin.exposed').allInnerTexts()).some((t) => t.includes('outside')), 10000), 'seekers see out-of-bounds Cat');
  await shot(ann, '11-exposed');
  await cat.context().setGeolocation(at(200, 0));
  check(await waitFor(async () => (await ann.locator('#game-map .pin.exposed').count()) === 0, 10000), 'Cat hidden again once back inside');

  console.log('end');
  await cat.click('[data-action="self-caught"]');
  await cat.click('#sheet-ok');
  check(await waitFor(async () => !(await ann.locator('#end').isHidden()), 8000), 'game ends when everyone is caught');
  check((await text(ann, '#end-head')).includes('Seekers win'), 'seekers win');
  await waitFor(async () => !(await bob.locator('#end').isHidden()));
  await shot(bob, '12-end');
  check((await text(bob, '#end-log')).includes('Ann caught Bob'), 'results list the catch');
  await ann.click('[data-action="again"]');
  if (process.env.DEBUG) { await sleep(1000); console.log((await fetch(BASE + '/__test/log').then((r) => r.json())).filter((l) => l.op === 'update').slice(-3), await toasts(ann)); }
  check(await waitFor(async () => !(await cat.locator('#lobby').isHidden())), 'host takes everyone back to the lobby');
  check((await text(cat, '#team-counts')).includes('1 seeker, 2 hiders'), 'teams reset to starting roles');
} catch (e) {
  failures++;
  console.log('ERROR', e);
} finally {
  if (errors.length) { console.log('\npage errors:'); errors.forEach((e) => console.log('  ', e)); }
  await browser.close();
  srv.kill();
  console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
  process.exit(failures ? 1 : 0);
}
