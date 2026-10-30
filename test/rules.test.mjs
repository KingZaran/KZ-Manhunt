// Tests the security rules (Hide Tag mechanics + anti-cheat) against the mock database.
// Run: node test/rules.test.mjs   (starts its own mock server)

import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { DEFAULTS } from '../js/rules-config.js';

const PORT = 8799;
const BASE = `http://localhost:${PORT}`;
const srv = spawn(process.execPath, [new URL('./mock-server.mjs', import.meta.url).pathname, String(PORT)], { stdio: 'pipe' });
await new Promise((r) => srv.stdout.once('data', r));

const TS = { '.sv': 'timestamp' };
const op = async (uid, o, path, value) => (await fetch(BASE + '/__db/op', { method: 'POST', body: JSON.stringify({ uid, op: o, path, value }) })).json();
const advance = async (ms) => fetch(BASE + '/__test/advance', { method: 'POST', body: JSON.stringify({ ms }) });
const tree = async () => (await fetch(BASE + '/__test/tree')).json();

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ok  ', name); }
  catch (e) { failed++; console.log('  FAIL', name, '\n      ', e.message); }
}
const ok = async (p, msg) => { const r = await p; assert.ok(r.ok, (msg || '') + ' expected ok, got ' + JSON.stringify(r)); return r; };
const denied = async (p, msg) => { const r = await p; assert.equal(r.error, 'PERMISSION_DENIED', (msg || '') + ' expected denied, got ' + JSON.stringify(r)); return r; };

const G = 'games/ABCDE';
const [A, B, C, D, X] = ['uidA', 'uidB', 'uidC', 'uidD', 'uidX']; // A, D = hunters; B, C = hiders
const settings = { ...DEFAULTS, hideSecs: 60, gameMins: 240, campMins: 10 };
const LAT = 51.1, LNG = -1.65;
const mlon = Math.round(111320 * Math.cos(LAT * Math.PI / 180) * 100) / 100;
const r6 = (x) => Math.round(x * 1e6) / 1e6;
const pos = (dN, dE) => ({ lat: r6(LAT + dN / 111320), lng: r6(LNG + dE / mlon) });
const player = (name, role = 'hider') => ({ name, role, color: '#ff0000', joinedAt: 1 });

// The client mirrors the server's bookkeeping (out-of-area time and camping spot); so do we.
const last = {};
let now = 0;
let startAt = 0;
const AREA_R = 500;
function radiusNow(t) {
  const hs = startAt + settings.hideSecs * 1000, he = hs + settings.gameMins * 60000;
  return AREA_R * (1 - (100 - settings.shrinkPct) / 100 * (t - hs) / (he - hs));
}
const d2 = (a, b) => ((a.lat - b.lat) * 111320) ** 2 + ((a.lng - b.lng) * mlon) ** 2;
async function at(u, dN, dE, acc = 5, opts = {}) {
  const p = pos(dN, dE);
  const prev = last[u] || {};
  const v = { ...p, acc, t: TS };
  if (opts.live !== false && startAt) {
    const { now: srvNow } = await (await fetch(BASE + '/__db/time')).json();
    const outside = d2(p, { lat: LAT, lng: LNG }) > radiusNow(srvNow) ** 2;
    if (outside) v.out = prev.out || TS;
    const keep = prev.camp && d2(p, prev.camp) <= settings.campM ** 2;
    v.camp = keep ? prev.camp : { ...p, since: TS };
  }
  const r = await op(u, 'set', `${G}/locs/${u}`, v);
  if (r.ok) {
    const stored = (await tree()).games.ABCDE.locs[u];
    last[u] = stored;
  }
  return r;
}
const put = (u, dN, dE, acc) => ok(at(u, dN, dE, acc));
const refresh = async () => { for (const u of [A, B, C, D]) await at(u, ...(spots[u] || [0, 0])); };
const spots = {};
const place = async (u, dN, dE) => { spots[u] = [dN, dE]; return put(u, dN, dE); };

console.log('lobby');
await t('create a game with Hide Tag settings', () => ok(op(A, 'set', G + '/meta', { host: A, status: 'lobby', settings, createdAt: TS })));
await t('unknown settings are rejected', () => denied(op(A, 'set', G + '/meta/settings/cheatMode', 1)));
await t('out-of-range settings are rejected', () => denied(op(A, 'set', G + '/meta/settings/tagRadius', 500)));
await t('players join as hiders', async () => {
  for (const [u, n] of [[A, 'Ann'], [B, 'Bob'], [C, 'Cat'], [D, 'Dan']]) await ok(op(u, 'set', `${G}/players/${u}`, player(n)));
});
await t('a player cannot make themselves a hunter', () => denied(op(B, 'set', `${G}/players/${B}/role`, 'seeker')));
await t('organiser picks hunters and the area', async () => {
  await ok(op(A, 'set', `${G}/players/${A}/role`, 'seeker'));
  await ok(op(A, 'set', `${G}/players/${D}/role`, 'seeker'));
  await ok(op(A, 'set', G + '/meta/area', { lat: LAT, lng: LNG, r: AREA_R, mlon }));
});
await t('lobby locations need no bookkeeping', async () => { for (const u of [A, B, C, D]) await ok(at(u, 0, 0, 5, { live: false })); });
await t('organiser starts the game', async () => {
  await ok(op(A, 'update', G + '/meta', { status: 'live', startAt: TS }));
  startAt = (await tree()).games.ABCDE.meta.startAt;
});
await t('newcomers can join a running game as hunters only', async () => {
  await denied(op(X, 'set', `${G}/players/${X}`, player('Xi', 'hider')));
  await ok(op(X, 'set', `${G}/players/${X}`, player('Xi', 'seeker')));
  await ok(op(X, 'set', `${G}/players/${X}`, null));
});

console.log('server bookkeeping on locations');
await t('location updates must track time outside the area', async () => {
  const p = pos(600, 0);
  await denied(op(B, 'set', `${G}/locs/${B}`, { ...p, acc: 5, t: TS, camp: { ...p, since: TS } }), 'outside without out');
  await ok(at(B, 600, 0));
  const first = last[B].out;
  await advance(5000);
  await ok(at(B, 610, 0));
  assert.equal(last[B].out, first, 'out time is kept while outside');
  await denied(op(B, 'set', `${G}/locs/${B}`, { ...pos(610, 0), acc: 5, t: TS, out: TS, camp: last[B].camp }), 'cannot reset out time while outside');
  await ok(at(B, 0, 0));
  assert.equal(last[B].out, undefined, 'cleared when back inside');
});
await t('camping spot is tracked and cannot be faked', async () => {
  await ok(at(C, 100, 0));
  const since = last[C].camp.since;
  await advance(3000);
  await denied(op(C, 'set', `${G}/locs/${C}`, { ...pos(105, 0), acc: 5, t: TS, camp: { ...pos(105, 0), since: TS } }), 'resetting the camp clock without moving');
  await ok(at(C, 105, 0));
  assert.equal(last[C].camp.since, since);
  await ok(at(C, 200, 0));
  assert.notEqual(last[C].camp.since, since, 'moving away starts a new spot');
});

console.log('head start');
await place(A, 0, 0); await place(D, 0, 30); await place(B, 300, 0); await place(C, -250, 0);
await t('no catches, reveals or freezes during the head start', async () => {
  await denied(op(A, 'set', `${G}/caught/${B}`, { by: A, t: TS, how: 'gps' }));
  await denied(op(A, 'update', G, { reveal: { n: 1, t: TS, by: A }, rcut: null }));
  await denied(op(A, 'update', G, { freeze: { n: 1, t: TS, by: A }, fcut: null }));
});
await t('hiders see hunters during the head start; hunters never see hiders', async () => {
  await ok(op(B, 'get', `${G}/locs/${A}`));
  await denied(op(A, 'get', `${G}/locs/${B}`));
});

console.log('hunt');
await advance(61000); await refresh();
await t('hiders lose sight of hunters', () => denied(op(B, 'get', `${G}/locs/${A}`)));
await t('catch only within the catch distance', async () => {
  await denied(op(A, 'set', `${G}/caught/${B}`, { by: A, t: TS, how: 'gps' }));
  await place(A, 295, 0);
  await ok(op(A, 'set', `${G}/caught/${B}`, { by: A, t: TS, how: 'gps' }));
  await ok(op(A, 'set', `${G}/caught/${B}`, null)); // organiser undoes, to keep testing
  await place(A, 0, 0);
});
await t('a hider can accept an elimination (counts as out)', async () => {
  await ok(op(C, 'set', `${G}/caught/${C}`, { by: C, t: TS, how: 'out', why: 'area' }));
  await ok(op(A, 'set', `${G}/caught/${C}`, null));
});

console.log('exposure');
await t('outside the area for longer than the grace period: exposed', async () => {
  await place(B, 700, 0);
  await denied(op(A, 'get', `${G}/locs/${B}`), 'within grace');
  await advance(61000); await refresh();
  await ok(op(A, 'get', `${G}/locs/${B}`));
  await place(B, 300, 0);
  await denied(op(A, 'get', `${G}/locs/${B}`), 'back inside');
});
await t('the area shrinks: the edge moves in over the game', async () => {
  // 4-hour game: after 40 min the edge is at 500 * (1 - 0.3 * 40/240) = 475 m
  await place(B, 485, 0);
  assert.ok(!last[B].out, '485 m is inside at first');
  await advance(40 * 60000); await refresh();
  await place(B, 485, 0);
  assert.ok(last[B].out, 'out recorded at 485 m after 40 min');
  await place(B, 300, 0);
});
await t('camping in one spot too long: exposed', async () => {
  await place(C, -100, 0);
  await place(C, -250, 0);
  await advance(10 * 60000 + 30000); await refresh();
  await denied(op(A, 'get', `${G}/locs/${C}`), 'burned but within grace');
  await advance(60000); await refresh();
  await ok(op(A, 'get', `${G}/locs/${C}`), 'after the grace period');
  await place(C, -150, 0);
  await denied(op(A, 'get', `${G}/locs/${C}`), 'moved on');
  // turn camping off so the rest of the tests can stand still
  await ok(op(A, 'set', G + '/meta/settings/campMins', 0));
  settings.campMins = 0;
});
await t('going dark for 60 s: exposed', async () => {
  await advance(61000);
  for (const u of [A, B, D]) await at(u, ...spots[u]);
  await ok(op(A, 'get', `${G}/locs/${C}`));
  await refresh();
});

console.log('reveal');
await t('reveal is ready after its cooldown; hiders can\'t reveal', async () => {
  await denied(op(B, 'update', G, { reveal: { n: 1, t: TS, by: B }, rcut: null }));
  await ok(op(A, 'update', G, { reveal: { n: 1, t: TS, by: A }, rcut: null }));
  await denied(op(D, 'update', G, { reveal: { n: 2, t: TS, by: D }, rcut: null }), 'shared cooldown');
});
await t('hider answers with a circle that contains them', async () => {
  const far = pos(-100, 0);
  await denied(op(B, 'set', `${G}/circles/${B}`, { n: 1, ...far, r: 100, t: TS }));
  const near = pos(340, 30);
  await ok(op(B, 'set', `${G}/circles/${B}`, { n: 1, ...near, r: 100, t: TS }));
});
await t('ignoring a reveal for 20 s exposes you', async () => {
  await advance(21000); await refresh();
  await ok(op(A, 'get', `${G}/locs/${C}`));
  await denied(op(A, 'get', `${G}/locs/${B}`));
  const c = pos(-120, 20);
  await ok(op(C, 'set', `${G}/circles/${C}`, { n: 1, ...c, r: 100, t: TS }));
});

console.log('supply caches and power-ups');
const k0 = pos(300, 10), k1 = pos(0, 10), k2 = pos(-150, 5);
await t('only the organiser places caches; each side sees only its own', async () => {
  await denied(op(B, 'set', `${G}/caches/h/hc1`, { ...k0, k: 'smoke', t: TS }));
  await ok(op(A, 'update', G, {
    'caches/h/hsmk': { ...k0, k: 'smoke', t: TS }, 'caches/h/hspy': { ...k0, k: 'spy', t: TS },
    'caches/h/hjam': { ...k0, k: 'jamming', t: TS }, 'caches/h/hmis': { ...k0, k: 'misdirection', t: TS },
    'caches/h/hward': { ...k2, k: 'ward', t: TS }, 'caches/h/hfar': { ...k1, k: 'ghost', t: TS },
    'caches/h/hflr': { ...k0, k: 'flare', t: TS }, 'caches/h/hsil': { ...k0, k: 'silence', t: TS },
    'caches/s/srev': { ...k1, k: 'reveal_ready', t: TS }, 'caches/s/sfrz': { ...k1, k: 'freeze_ready', t: TS },
    'caches/s/sscn': { ...k1, k: 'scan', t: TS },
  }));
  await denied(op(A, 'set', `${G}/caches/s/bad`, { ...k1, k: 'ghost', t: TS }), 'hider power in a hunter cache');
  await ok(op(B, 'get', `${G}/caches/h`)); await denied(op(B, 'get', `${G}/caches/s`));
  await ok(op(A, 'get', `${G}/caches/s`)); await denied(op(A, 'get', `${G}/caches/h`));
});
const pick = (u, side, id, k) => op(u, 'set', `${G}/bag/${u}/${id}`, { k, src: 'cache', t: TS, _side: side });
const grab = (u, id, k) => op(u, 'set', `${G}/bag/${u}/${id}`, { k, src: 'cache', t: TS });
void pick;
await t('pick up only when standing at the cache, and only what\'s in it', async () => {
  await denied(grab(B, 'hfar', 'ghost'), 'cache 300 m away');
  await denied(grab(B, 'hsmk', 'flare'), 'wrong contents');
  await ok(grab(B, 'hsmk', 'smoke'));
  await denied(grab(B, 'hsmk', 'smoke'), 'only one copy each');
  await ok(grab(B, 'hspy', 'spy')); await ok(grab(B, 'hjam', 'jamming')); await ok(grab(B, 'hmis', 'misdirection')); await ok(grab(B, 'hflr', 'flare')); await ok(grab(B, 'hsil', 'silence'));
  await denied(grab(A, 'hsmk', 'smoke'), 'hunters can\'t take hider caches');
  await ok(grab(A, 'srev', 'reveal_ready')); await ok(grab(A, 'sfrz', 'freeze_ready')); await ok(grab(A, 'sscn', 'scan'));
});
await t('every player gets their own copy of a cache', async () => {
  await place(C, 295, 5);
  await ok(grab(C, 'hsmk', 'smoke'));
  await place(C, -150, 0);
});
await t('free hand-out: one at the whistle, a valid kind for your side', async () => {
  await ok(op(C, 'set', `${G}/bag/${C}/free1`, { k: 'ghost', src: 'free', t: TS }));
  await denied(op(C, 'set', `${G}/bag/${C}/free2`, { k: 'ghost', src: 'free', t: TS }), 'only one');
  await denied(op(D, 'set', `${G}/bag/${D}/free1`, { k: 'ghost', src: 'free', t: TS }), 'hunter taking a hider power');
  await ok(op(D, 'set', `${G}/bag/${D}/free1`, { k: 'scan', src: 'free', t: TS }));
});
await t('Lookout shows the hunters for 30 s, and only by spending it', async () => {
  await denied(op(B, 'set', `${G}/fx/${B}/spy`, { t: TS, item: 'hspy' }), 'effect without spending');
  await denied(op(B, 'update', G, { [`bag/${B}/hsmk/u`]: TS, [`fx/${B}/spy`]: { t: TS, item: 'hsmk' } }), 'wrong item');
  await ok(op(B, 'update', G, { [`bag/${B}/hspy/u`]: TS, [`fx/${B}/spy`]: { t: TS, item: 'hspy' } }));
  await ok(op(B, 'get', `${G}/locs/${A}`));
  await denied(op(B, 'update', G, { [`bag/${B}/hspy/u`]: TS, [`fx/${B}/spy`]: { t: TS, item: 'hspy' } }), 'used twice');
  await advance(31000); await refresh();
  await denied(op(B, 'get', `${G}/locs/${A}`), 'worn off');
});
await t('Reveal boost takes half the cooldown off', async () => {
  await advance(10000); await refresh();
  await denied(op(D, 'update', G, { reveal: { n: 2, t: TS, by: D }, rcut: null }), 'still cooling');
  await denied(op(A, 'set', `${G}/rcut`, { ms: 45000, item: 'srev' }), 'boost without spending');
  await ok(op(A, 'update', G, { [`bag/${A}/srev/u`]: TS, rcut: { ms: 45000, item: 'srev' } }));
  await ok(op(D, 'update', G, { reveal: { n: 2, t: TS, by: D }, rcut: null }), 'ready after boost');
});
await t('Smoke bomb, Jamming and Misdirection let a hider dodge a reveal', async () => {
  await ok(op(B, 'update', G, { [`bag/${B}/hsmk/u`]: TS, [`fx/${B}/smoke`]: { t: TS, item: 'hsmk' } }));
  await ok(op(B, 'set', `${G}/circles/${B}`, { n: 2, skip: 'smoke', t: TS }));
  await denied(op(C, 'set', `${G}/circles/${C}`, { n: 2, skip: 'smoke', t: TS }), 'no smoke active');
  // Cat arms jamming? Cat has no jamming. Bob arms his and Misdirection for later.
  await ok(op(B, 'set', `${G}/bag/${B}/hjam/a`, TS));
  await ok(op(B, 'update', `${G}/bag/${B}/hmis`, { a: TS, m: 100 }));
  const c = pos(-140, 10);
  await ok(op(C, 'set', `${G}/circles/${C}`, { n: 2, ...c, r: 100, t: TS }));
});
await t('freeze is shared, and only hits hiders within range', async () => {
  await place(A, 200, 0);
  await ok(op(A, 'update', G, { freeze: { n: 1, t: TS, by: A }, fcut: null }));
  await denied(op(D, 'update', G, { freeze: { n: 2, t: TS, by: D }, fcut: null }), 'on cooldown');
  await ok(op(B, 'set', `${G}/fz/${B}`, { n: 1, t: TS, by: A }), 'Bob is 100 m from Ann');
  await denied(op(C, 'set', `${G}/fz/${C}`, { n: 1, t: TS, by: A }), 'Cat is 350 m away');
  await denied(op(C, 'set', `${G}/fz/${C}`, { n: 1, t: TS, by: B }), 'Bob isn\'t a hunter');
});
await t('Freeze boost cuts the wait', async () => {
  await advance(80000 + 70000); await refresh();
  await denied(op(D, 'update', G, { freeze: { n: 2, t: TS, by: D }, fcut: null }), '50 s to go');
  await ok(op(A, 'update', G, { [`bag/${A}/sfrz/u`]: TS, fcut: { ms: 60000, item: 'sfrz' } }));
  await ok(op(D, 'update', G, { freeze: { n: 2, t: TS, by: D }, fcut: null }));
});
await t('a Ward blocks a freeze (and is spent)', async () => {
  await advance(200000); await refresh();
  await place(C, -150, 0);
  await ok(grab(C, 'hward', 'ward'));
  await denied(op(C, 'set', `${G}/bag/${C}/hspy/a`, TS), 'only wards, jamming and misdirection can be armed');
  await ok(op(C, 'set', `${G}/bag/${C}/hward/a`, TS));
  await ok(op(D, 'update', G, { freeze: { n: 3, t: TS, by: D }, fcut: null }));
  await denied(op(C, 'set', `${G}/fz/${C}`, { n: 3, t: TS, by: D, ward: 'hward' }), 'ward must be spent');
  await ok(op(C, 'update', G, { [`bag/${C}/hward/u`]: TS, [`fz/${C}`]: { n: 3, t: TS, by: D, ward: 'hward' } }));
  const tr = await tree();
  assert.ok(tr.games.ABCDE.bag[C].hward.u, 'ward used up');
});

console.log('jamming and misdirection');
await t('next reveal: Jamming spends a charge, Misdirection lands elsewhere', async () => {
  await advance(90000); await refresh();
  await ok(op(A, 'update', G, { reveal: { n: 3, t: TS, by: A }, rcut: null }));
  await ok(op(B, 'update', G, { [`bag/${B}/hjam/u`]: TS, [`circles/${B}`]: { n: 3, skip: 'jam', jam: 'hjam', t: TS } }));
  await denied(op(B, 'update', G, { [`bag/${B}/hjam/u`]: TS, [`circles/${B}`]: { n: 3, skip: 'jam', jam: 'hjam', t: TS } }), 'spent');
  await advance(91000); await refresh();
  await ok(op(D, 'update', G, { reveal: { n: 4, t: TS, by: D }, rcut: null }));
  const fake = pos(300 + 150, 0);
  await denied(op(B, 'set', `${G}/circles/${B}`, { n: 4, ...fake, r: 100, t: TS }), 'circle away from you without misdirection');
  await ok(op(B, 'update', G, { [`bag/${B}/hmis/u`]: TS, [`circles/${B}`]: { n: 4, ...fake, r: 100, mis: 'hmis', t: TS } }));
  const c = pos(-120, 20);
  await ok(op(C, 'set', `${G}/circles/${C}`, { n: 4, ...c, r: 100, t: TS }));
});

console.log('scan and flare');
await t('scan answers must be truthful', async () => {
  const me = pos(...spots[A]);
  await ok(op(A, 'update', G, { [`bag/${A}/sscn/u`]: TS, 'scan/sscn': { by: A, t: TS, r: 200, side: 's', ...me } }));
  await denied(op(B, 'set', `${G}/scan/sscn/a/${B}`, false), 'Bob is 100 m away: must say yes');
  await ok(op(B, 'set', `${G}/scan/sscn/a/${B}`, true));
  await denied(op(C, 'set', `${G}/scan/sscn/a/${C}`, true), 'Cat is far: must say no');
  await ok(op(C, 'set', `${G}/scan/sscn/a/${C}`, false));
  await denied(op(D, 'set', `${G}/scan/sscn/a/${D}`, true), 'hunters don\'t answer a hunter scan');
});
await t('flare: share your spot; after 10 s everyone sees everyone', async () => {
  await ok(op(B, 'update', G, { [`bag/${B}/hflr/u`]: TS, flare: { t: TS, by: B, item: 'hflr' } }));
  const ft = (await tree()).games.ABCDE.flare.t;
  for (const u of [A, B, D]) await ok(op(u, 'set', `${G}/snap/${u}`, { ...pos(...spots[u]), t: ft }));
  await denied(op(C, 'set', `${G}/snap/${C}`, { ...pos(400, 400), t: ft }), 'fake position');
  await denied(op(A, 'get', `${G}/snap`), 'not for 10 s');
  await advance(10500); await refresh();
  await ok(op(A, 'get', `${G}/snap`));
  await ok(op(A, 'get', `${G}/locs/${C}`), 'Cat didn\'t share, so her live position shows');
  await denied(op(B, 'get', `${G}/locs/${D}`), 'Dan shared, so only his snapshot shows');
});
await t('after the flare, everyone is hidden again', async () => {
  await advance(61000); await refresh();
  await denied(op(A, 'get', `${G}/locs/${C}`));
});

console.log('missions');
const ma = pos(-150, 60), mb = pos(250, 250);
await t('organiser opens a wave of two circles', async () => {
  await denied(op(B, 'set', `${G}/mission`, { id: 'w1', a: ma, b: mb, r: 150, t: TS }));
  await ok(op(A, 'set', `${G}/mission`, { id: 'w1', a: ma, b: mb, r: 150, t: TS }));
});
await t('start a mission only from inside its circle', async () => {
  const m = (await tree()).games.ABCDE.mission;
  assert.ok(m, 'mission exists');
  await denied(op(B, 'set', `${G}/mhold/${B}`, { w: 'w1', c: 'a', since: TS }), 'Bob is far from circle a');
  await ok(op(C, 'update', G, { [`mhold/${C}`]: { w: 'w1', c: 'a', since: TS }, 'mission/first': { by: C, t: TS } }));
});
await t('complete it after holding long enough, then everyone hiding is paid', async () => {
  await denied(op(C, 'set', `${G}/mission/done`, { by: C, t: TS }), 'too early');
  await advance(181000); await refresh();
  await ok(op(C, 'set', `${G}/mission/done`, { by: C, t: TS }));
  await ok(op(B, 'set', `${G}/bag/${B}/mw11`, { k: 'ghost', src: 'mission', t: TS }));
  await ok(op(B, 'set', `${G}/bag/${B}/mw12`, { k: 'ward', src: 'mission', t: TS }));
  await denied(op(B, 'set', `${G}/bag/${B}/mw13`, { k: 'ward', src: 'mission', t: TS }), 'pays 2');
  await denied(op(A, 'set', `${G}/bag/${A}/mw11`, { k: 'scan', src: 'mission', t: TS }), 'hunters aren\'t paid');
});
await t('a wave nobody starts fails: hunters see every hider for a minute and get paid', async () => {
  await ok(op(A, 'update', G, { mission: { id: 'w2', a: ma, b: mb, r: 150, t: TS }, mhold: null }));
  await denied(op(A, 'update', G, { 'mission/fail': TS, mfail: TS }), 'deadline not passed');
  await advance(301000); await refresh();
  await ok(op(A, 'update', G, { 'mission/fail': TS, mfail: TS }));
  await ok(op(A, 'get', `${G}/locs/${B}`)); await ok(op(A, 'get', `${G}/locs/${C}`));
  await ok(op(A, 'set', `${G}/bag/${A}/fw21`, { k: 'scan', src: 'fail', t: TS }));
  await advance(61000); await refresh();
  await denied(op(A, 'get', `${G}/locs/${B}`), 'only for a minute');
});

console.log('organiser handover');
const seen = (u) => op(u, 'set', `${G}/seen/${u}`, TS);
await t('cannot take over while the organiser is around', async () => { await ok(seen(A)); await ok(seen(B)); await denied(op(B, 'set', G + '/meta/host', B)); });
await t('cannot hand over to an outsider', () => denied(op(A, 'set', G + '/meta/host', X)));
await t('organiser can hand over; a quiet organiser is replaced', async () => {
  await ok(op(A, 'set', G + '/meta/host', B));
  await advance(46000); await refresh(); await ok(seen(C));
  await ok(op(C, 'set', G + '/meta/host', C));
  await ok(op(C, 'set', G + '/meta/host', A));
});

console.log('end');
await t('no catches after time runs out; everyone visible', async () => {
  await advance(240 * 60000); await refresh();
  await denied(op(A, 'set', `${G}/caught/${C}`, { by: A, t: TS, how: 'host' }));
  await ok(op(A, 'get', `${G}/locs/${C}`));
});
await t('organiser resets everything for a new round', () => ok(op(A, 'update', G, {
  caught: null, circles: null, reveal: null, rcut: null, freeze: null, fcut: null, fz: null, prints: null,
  caches: null, bag: null, fx: null, flare: null, snap: null, scan: null, mission: null, mhold: null, mfail: null,
  'meta/status': 'lobby', 'meta/endedAt': null,
})));
await t('non-organiser cannot reset', () => denied(op(B, 'update', G, { caught: null, 'meta/status': 'lobby' })));

srv.kill();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
