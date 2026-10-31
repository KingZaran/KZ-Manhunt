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
// Jump the clock in steps short enough that nobody looks gone (which would hand over the organiser role).
const pages = [];
async function jump(ms) {
  for (let left = ms; left > 0; left -= 30000) {
    await advance(Math.min(30000, left));
    await Promise.all(pages.filter((p) => !p.isClosed()).map((p) => p.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))).catch(() => {})));
    await new Promise((r) => setTimeout(r, 400));
  }
}

const LAT = 51.1, LNG = -1.65;
const mlon = 111320 * Math.cos(LAT * Math.PI / 180);
const at = (dN, dE, acc = 6) => ({ latitude: LAT + dN / 111320, longitude: LNG + dE / mlon, accuracy: acc });

const browser = await chromium.launch();
const errors = [];
let failures = 0;
function check(cond, msg) { if (cond) console.log('  ok  ', msg); else { failures++; console.log('  FAIL', msg); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function phone(label, pos, url = '/index.html') {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    geolocation: pos, permissions: ['geolocation'],
  });
  await ctx.route('https://www.gstatic.com/firebasejs/**', (route) => {
    const file = route.request().url().split('/').pop();
    route.fulfill({ contentType: 'text/javascript', body: readFileSync(HERE + 'firebase-shim/' + file, 'utf8') });
  });
  await ctx.route(/\/js\/config\.js/, (route) => route.fulfill({ contentType: 'text/javascript', body: `export const firebaseConfig = { apiKey: 'test', databaseURL: '${BASE}' };` }));
  await ctx.route(/fonts\.(googleapis|gstatic)\.com|cdn\.jsdelivr\.net|openfreemap\.org|openstreetmap\.org|arcgisonline\.com/, (route) => route.abort());
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(`${label} console: ${m.text()}`); });
  page.label = label;
  pages.push(page);
  page.ctx = ctx;
  await page.goto(BASE + url);
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

  console.log('invite');
  await ann.click('.invite-btn');
  check((await ann.locator('#sheet .qr svg').count()) === 1, 'invite sheet shows a QR code');
  check((await text(ann, '#sheet .invite-code')).trim() === code, 'invite sheet shows the code');
  await shot(ann, '01b-invite');
  await ann.click('#sheet [data-action="close-sheet"]');

  const bob = await phone('Bob', at(40, 10), `/index.html?code=${code}`);
  await bob.waitForSelector('#home:not([hidden])');
  check((await text(bob, '#join-form button')).includes(code), 'opening the QR link shows "Join" for that game');
  await shot(bob, '01c-invited');
  await bob.click('.home-help');
  check((await text(bob, '#sheet')).includes('How to play'), 'how-to-play opens from the home screen');
  await sleep(300); await shot(bob, '01d-help');
  await bob.click('#sheet [data-action="close-sheet"]');
  await bob.fill('#name', 'Bob');
  await bob.click('#join-form button');
  await bob.waitForSelector('#lobby:not([hidden])');
  const cat = await phone('Cat', at(200, 0));
  await cat.waitForSelector('#home:not([hidden])');
  await cat.fill('#name', 'Cat');
  await cat.fill('#code', code);
  await cat.click('#join-form button');
  await cat.waitForSelector('#lobby:not([hidden])');
  check(await waitFor(async () => (await ann.locator('.player').count()) === 3), 'host sees 3 players');

  // host setup
  await ann.click('[data-action="area-here"]');
  await ann.click('[data-action="area-radius"][data-v="500"]');
  const annUid = await ann.evaluate(() => localStorage.getItem('shimUid'));
  await ann.click(`[data-action="toggle-role"][data-uid="${annUid}"]`);
  await ann.click('[data-action="setting"][data-k="hideSecs"][data-v="60"]');
  await ann.click('.set-group[data-group="Reveal"] summary');
  await ann.click('[data-action="setting"][data-k="revealCooldownSecs"][data-v="60"]');
  await ann.click('.set-group[data-group="Missions"] summary');
  await ann.click('[data-action="setting"][data-k="missionStart"][data-v="600"]');
  await ann.click('.set-group[data-group="Power-ups"] summary');
  await ann.click('[data-action="setting"][data-k="supplies"][data-v="0"]');
  await ann.click('[data-action="pool"][data-k="flare"]');
  check(await waitFor(async () => (await text(bob, '#team-counts')).includes('1 hunter')), 'guests see team change');
  check(await waitFor(async () => (await text(bob, '#settings')).includes('1 min')), 'guests see the rules');
  const tree0 = await fetch(BASE + '/__test/tree').then((r) => r.json());
  check(tree0.games[code].meta.settings.pool.flare === false, 'host can take a power-up out of the pool');
  await waitFor(async () => !(await text(ann, '#player-list')).includes('No GPS'), 6000, 'all GPS ok');
  await shot(ann, '02-lobby-host');
  await ann.evaluate(() => document.querySelector('#settings').scrollIntoView({ block: 'start' }));
  await shot(ann, '02b-lobby-rules');
  await bob.evaluate(() => document.querySelector('#settings').scrollIntoView({ block: 'center' }));
  await shot(bob, '03b-lobby-guest-rules');

  console.log('profile, sound and map style');
  await bob.click('#profile-btn');
  check((await bob.locator('#pf-colours .colour:disabled').count()) >= 2, 'other players\' colours are greyed out');
  const free = bob.locator('#pf-colours .colour:not(:disabled):not([aria-checked="true"])').first();
  const freeColour = await free.getAttribute('data-pc');
  await free.click();
  await bob.click('#pf-save');
  check(await waitFor(async () => (await ann.locator('#player-list').innerHTML()).toLowerCase().includes(freeColour.toLowerCase())), 'colour change shows for everyone');
  await bob.click('#profile-btn');
  await bob.click('#sheet [data-action="sound"]');
  check((await bob.locator('#sheet [data-pref]').count()) === 4, 'sound settings sheet');
  await sleep(300); await shot(bob, '03c-sound');
  await bob.click('#snd-test');
  await bob.click('#sheet [data-action="close-sheet"]');
  const audio = await bob.evaluate(async () => { const r = await fetch('sounds/frozen.mp3'); return r.ok && (await r.arrayBuffer()).byteLength; });
  check(audio > 2000, `sound files are served (${audio} bytes)`);
  await ann.click('#lobby-style');
  await ann.click('[data-action="set-map-style"][data-v="dark"]');
  check(await waitFor(async () => (await ann.locator('#lobby-map.map-dark').count()) === 1), 'map style switches to dark');
  await ann.click('#lobby-style');
  await ann.click('[data-action="set-map-style"][data-v="light"]');
  await shot(bob, '03-lobby-guest');
  check(await bob.locator('#start').isHidden(), 'guests cannot see Start');

  console.log('head start');
  await ann.click('#start');
  check(await waitFor(() => bob.locator('#game:not([hidden])').count().then((c) => c === 1)), 'game starts for hiders');
  check(await waitFor(async () => (await text(bob, '#clock-phase')) === 'Head start'), 'hider sees head start');
  check(await waitFor(async () => !(await ann.locator('#hold').isHidden())), 'hunter is held during head start');
  check(await waitFor(async () => (await bob.locator('#game-map .pin.seeker').count()) >= 1), 'hider can see the hunter during head start');
  await shot(ann, '04-hunter-wait');
  await shot(bob, '05-hider-headstart');

  console.log('hunt');
  await jump(61000);
  check(await waitFor(async () => (await text(ann, '#clock-phase')) === 'Hunting'), 'hunt starts');
  check(await waitFor(async () => (await bob.locator('#game-map .pin.seeker').count()) === 0), 'hider loses sight of the hunter');
  check((await ann.locator('#game-map .pin.hider').count()) === 0, 'hunter cannot see hiders');
  check(await waitFor(async () => (await cat.locator('.power').count()) >= 1, 8000), 'everyone gets a free power-up at the whistle');
  check(await waitFor(async () => (await ann.locator('.power.seeker, .power.both, .power').count()) >= 1, 8000), 'the hunter gets one too');
  check(await waitFor(async () => !(await cat.locator('#dock-mission').isHidden()), 8000), 'hiders see the mission countdown');
  check(await waitFor(async () => (await cat.locator('#game-map .circle-label.mission').count()) === 2, 8000), 'two mission circles on the map');
  check(await waitFor(async () => !(await cat.locator('#stamina').isHidden())), 'hiders see their stamina');
  check(await ann.locator('[data-action="reveal"]').isDisabled(), 'reveal on cooldown');
  check(await ann.locator('[data-action="freeze"]').isDisabled(), 'freeze on cooldown');
  await sleep(4500); // heartbeats refresh everyone's location after the time jump
  await shot(cat, '05b-hider-hunt');
  await shot(ann, '05c-hunter-hunt');

  const catUid = await cat.evaluate(() => localStorage.getItem('shimUid'));
  const bobUid = await bob.evaluate(() => localStorage.getItem('shimUid'));

  console.log('supply caches');
  const catPos = at(200, 0);
  const op = (uid, o, p, v) => fetch(BASE + '/__db/op', { method: 'POST', body: JSON.stringify({ uid, op: o, path: `games/${code}/${p}`, value: v }) }).then((r) => r.json());
  const TS = { '.sv': 'timestamp' };
  check((await op(annUid, 'set', 'caches/h/hlook01', { lat: catPos.latitude + 4 / 111320, lng: catPos.longitude, k: 'spy', t: TS })).ok, 'organiser places a cache next to Cat');
  check(await waitFor(async () => (await toasts(cat)).includes('Picked up'), 10000), 'Cat picks it up by walking over it');
  check(await waitFor(async () => (await cat.locator('.power[data-kind="spy"]').count()) === 1), 'it appears in Cat\'s bar');
  check((await cat.locator('#game-map .pin.seeker').count()) === 0, 'Cat can\'t see the hunter yet');
  await cat.click('.power[data-kind="spy"]');
  await cat.click('#use-pw');
  check(await waitFor(async () => (await cat.locator('#game-map .pin.seeker').count()) >= 1, 8000), 'Lookout shows Cat the hunter');
  check(await waitFor(async () => (await cat.locator('#dock-powers').innerText()).includes('Lookout')), 'Lookout timer shows');
  await shot(cat, '13-lookout');

  console.log('minimise the bottom panel');
  await cat.click('.dock-x');
  check(await waitFor(async () => !(await cat.locator('#dock-mini').isHidden()) && await cat.locator('#dock-actions').isHidden()), 'the × minimises the panel');
  check((await text(cat, '#dock-mini')).includes('power-up') || (await text(cat, '#dock-mini')).includes('🏃'), 'the mini bar still shows stamina and power-ups');
  await shot(cat, '13b-minimised');
  await cat.click('.mini-open');
  check(await waitFor(async () => !(await cat.locator('#dock-actions').isHidden())), 'tapping the mini bar brings it back');
  const swipe = (p, from, to) => p.evaluate(([a, b]) => {
    const el = document.querySelector('#dock');
    const tp = (y) => new Touch({ identifier: 1, target: el, clientX: 200, clientY: y });
    el.dispatchEvent(new TouchEvent('touchstart', { touches: [tp(a)], bubbles: true }));
    for (let i = 1; i <= 5; i++) el.dispatchEvent(new TouchEvent('touchmove', { touches: [tp(a + (b - a) * i / 5)], bubbles: true }));
    el.dispatchEvent(new TouchEvent('touchend', { touches: [], bubbles: true }));
  }, [from, to]);
  await swipe(cat, 650, 760);
  check(await waitFor(async () => !(await cat.locator('#dock-mini').isHidden())), 'swiping down minimises it');
  await swipe(cat, 800, 740);
  check(await waitFor(async () => !(await cat.locator('#dock-actions').isHidden())), 'swiping up brings it back');
  await cat.click('.menu-btn');
  check((await text(cat, '#sheet')).includes('Leave game'), 'in-game menu has Leave');
  await sleep(300); await shot(cat, '14-menu');
  await cat.click('#sheet [data-action="roster"]');
  check((await cat.locator('#sheet .player').count()) === 3, 'players sheet lists everyone');
  await cat.click('#sheet [data-action="close-sheet"]');

  console.log('catch distance');
  await ann.click('[data-action="catch-menu"]');
  await sleep(400);
  await shot(ann, '06-catch-sheet');
  await ann.click(`[data-action="catch"][data-uid="${catUid}"]`);
  check(await waitFor(async () => (await toasts(ann)).includes('isn\'t within')), 'catch from 200 m is refused');
  await shot(ann, '07-catch-refused');

  console.log('reveal');
  await cat.context().setGeolocation(at(260, 0));
  await jump(120000);
  await sleep(4500);
  check(await waitFor(async () => !(await ann.locator('[data-action="reveal"]').isDisabled())), 'reveal ready after cooldown');
  check(await waitFor(async () => !(await ann.locator('[data-action="freeze"]').isDisabled())), 'freeze ready after cooldown');
  await ann.click('[data-action="reveal"]');
  check(await waitFor(async () => (await ann.locator('#game-map .circle-label').allInnerTexts()).filter((t) => t.startsWith('Revealed')).length >= 2, 10000), 'hunter sees a circle for each hider');
  await shot(ann, '09-reveal-hunter');
  const tree1 = await fetch(BASE + '/__test/tree').then((r) => r.json());
  const circ = tree1.games[code].circles[catUid];
  const off = Math.hypot((circ.lat - (LAT + 260 / 111320)) * 111320, (circ.lng - LNG) * mlon);
  check(off < 100 && off > 0.01, `circle is off-centre (${off.toFixed(1)} m) but contains Cat`);

  console.log('freeze');
  await ann.click('[data-action="freeze"]');
  await ann.click('#do-freeze');
  check(await waitFor(async () => (await text(bob, '#hold')).includes('YOU WILL BE FROZEN'), 10000), 'Bob (41 m away) must find cover');
  await shot(bob, '16-freeze-cover');
  check(await cat.locator('#hold').isHidden(), 'Cat (260 m away) is out of range');
  await jump(21000);
  check(await waitFor(async () => (await text(bob, '#hold')).includes('HOLD STILL'), 8000), 'then Bob must hold still');
  await shot(bob, '17-freeze-hold');
  check(await waitFor(async () => (await toasts(ann)).length >= 0 && (await ann.evaluate(() => Object.keys(window.__mh.S.fz).length)) === 1), 'one hider was hit');
  await jump(61000);
  check(await waitFor(async () => await bob.locator('#hold').isHidden(), 8000), 'Bob is released after the hold');
  await sleep(4500);

  console.log('catch');
  await clearToasts(ann);
  await ann.context().setGeolocation(at(36, 8));   // walk up to Bob (~4.5 m away)
  await sleep(3000);
  await ann.click('[data-action="catch-menu"]');
  await ann.click(`[data-action="catch"][data-uid="${bobUid}"]`);
  check(await waitFor(async () => (await toasts(ann)).includes('caught Bob')), 'catch from 4.5 m counts');
  check(await waitFor(async () => (await text(bob, '#hold')).includes('You\'re out')), 'Bob is told he was caught');
  await shot(bob, '08-caught');
  check(await waitFor(async () => (await bob.locator('#clock.team-seeker').count()) === 1, 6000), 'Bob is now a hunter');
  check(await waitFor(async () => (await bob.locator('#game-map .pin.seeker').count()) >= 1), 'Bob now sees his fellow hunter');

  console.log('play area');
  await cat.context().setGeolocation(at(600, 0)); // runs out of bounds
  check(await waitFor(async () => (await cat.locator('#banner').innerText()).includes('play area')), 'Cat is warned she is out of bounds');
  await shot(cat, '11b-out');
  await sleep(3000);
  await jump(62000);
  check(await waitFor(async () => (await ann.locator('#game-map .pin.exposed').allInnerTexts()).some((t) => t.includes('outside')), 10000), 'after the grace period, hunters see Cat');
  check(await waitFor(async () => (await text(cat, '#sheet')).includes('Was that fair?'), 8000), 'Cat is asked whether she was eliminated');
  await shot(cat, '11c-fair');
  await cat.click('#pen-no');
  await shot(ann, '11-exposed');
  await cat.context().setGeolocation(at(200, 0));
  check(await waitFor(async () => (await ann.locator('#game-map .pin.exposed').count()) === 0, 10000), 'Cat hidden again once back inside');

  console.log('end');
  await cat.click('[data-action="self-caught"]');
  await cat.click('#sheet-ok');
  check(await waitFor(async () => !(await ann.locator('#end').isHidden()), 8000), 'game ends when everyone is caught');
  check((await text(ann, '#end-head')).includes('Hunters win'), 'hunters win');
  await waitFor(async () => !(await bob.locator('#end').isHidden()));
  await shot(bob, '12-end');
  check((await text(bob, '#end-log')).includes('Ann caught Bob'), 'results list the catch');
  console.log('organiser leaves on the results screen');
  check(await bob.locator('#end [data-action="again"]').isHidden(), 'Bob can\'t go back to the lobby yet');
  await ann.click('#end [data-action="leave"]');
  check((await text(ann, '#sheet')).includes('will become the organiser'), 'leaving tells Ann who takes over');
  await ann.click('#sheet-ok');
  check(await waitFor(async () => !(await bob.locator('#end [data-action="again"]').isHidden()), 8000), 'Bob is now the organiser and can go back to the lobby');
  check(await waitFor(async () => (await toasts(bob)).includes('now the organiser')), 'Bob is told he\'s the organiser');
  await bob.click('#end [data-action="again"]');
  check(await waitFor(async () => !(await cat.locator('#lobby').isHidden())), 'host takes everyone back to the lobby');
  check((await text(cat, '#team-counts')).includes('0 hunters, 2 hiders'), 'back in the lobby without Ann');
  check((await cat.locator('#player-list .player').count()) === 2, 'Ann has left the player list');
  check((await text(cat, '#player-list')).includes('👑'), 'the new organiser is marked');
  const tree2 = await fetch(BASE + '/__test/tree').then((r) => r.json());
  check(!tree2.games[code].bag && !tree2.games[code].mission && !tree2.games[code].caught, 'the round was cleared');

  console.log('organiser goes quiet');
  await bob.close();
  await clearToasts(cat);
  await advance(50000);
  check(await waitFor(async () => (await toasts(cat)).includes('You\'re now the organiser'), 20000), 'Cat takes over when Bob\'s phone goes quiet');
  check(await waitFor(async () => !(await cat.locator('#start').isHidden())), 'Cat can now start the game');
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
