// Tests the anti-cheat security rules against the mock database.
// Run: node test/rules.test.mjs   (starts its own mock server)

import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const PORT = 8799;
const BASE = `http://localhost:${PORT}`;
const srv = spawn(process.execPath, [new URL('./mock-server.mjs', import.meta.url).pathname, String(PORT)], { stdio: 'pipe' });
await new Promise((r) => srv.stdout.once('data', r));

const TS = { '.sv': 'timestamp' };
const op = async (uid, o, path, value) => (await fetch(BASE + '/__db/op', { method: 'POST', body: JSON.stringify({ uid, op: o, path, value }) })).json();
const advance = async (ms) => fetch(BASE + '/__test/advance', { method: 'POST', body: JSON.stringify({ ms }) });

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ok  ', name); }
  catch (e) { failed++; console.log('  FAIL', name, '\n      ', e.message); }
}
const ok = async (p, msg) => { const r = await p; assert.ok(r.ok, (msg || '') + ' expected ok, got ' + JSON.stringify(r)); return r; };
const denied = async (p, msg) => { const r = await p; assert.equal(r.error, 'PERMISSION_DENIED', (msg || '') + ' expected denied, got ' + JSON.stringify(r)); return r; };

const G = 'games/ABCDE';
const [A, B, C, D, X] = ['uidA', 'uidB', 'uidC', 'uidD', 'uidX'];
const settings = { hideSecs: 60, gameMins: 30, tagRadius: 10, revealCooldownSecs: 120, revealRadius: 75, darkSecs: 60, hidersSeeSeekers: false };
const BASE_LAT = 51.1, BASE_LNG = -1.65;
const mlon = 111320 * Math.cos(BASE_LAT * Math.PI / 180);
const at = (dN, dE, acc = 5) => ({ lat: BASE_LAT + dN / 111320, lng: BASE_LNG + dE / mlon, acc, t: TS });
const player = (name, role = 'hider') => ({ name, role, color: '#ff0000', joinedAt: 1 });

console.log('lobby');
await t('anyone signed in can create a game as its host', () => ok(op(A, 'set', G + '/meta', { host: A, status: 'lobby', settings, createdAt: TS })));
await t('cannot overwrite someone else\'s game', () => denied(op(X, 'set', G + '/meta', { host: X, status: 'lobby', settings, createdAt: TS })));
await t('bad game codes are rejected', () => denied(op(A, 'set', 'games/abc/meta', { host: A, status: 'lobby', settings, createdAt: TS })));
await t('players join as hiders', async () => {
  await ok(op(A, 'set', G + '/players/' + A, player('Ann')));
  await ok(op(B, 'set', G + '/players/' + B, player('Bob')));
  await ok(op(C, 'set', G + '/players/' + C, player('Cat')));
  await ok(op(D, 'set', G + '/players/' + D, player('Dan')));
});
await t('a player cannot make themselves a seeker', async () => {
  await denied(op(X, 'set', G + '/players/' + X, player('Xi', 'seeker')));
  await denied(op(B, 'set', G + '/players/' + B + '/role', 'seeker'));
});
await t('a player cannot change someone else', () => denied(op(B, 'set', G + '/players/' + C + '/name', 'lol')));
await t('only the host can change settings', () => denied(op(B, 'set', G + '/meta/settings/tagRadius', 25)));
await t('host picks teams and area', async () => {
  await ok(op(A, 'set', G + '/players/' + A + '/role', 'seeker'));
  await ok(op(A, 'set', G + '/meta/area', { lat: BASE_LAT, lng: BASE_LNG, r: 500, mlon }));
});
await t('game clock can only be set to server time', () => denied(op(A, 'update', G + '/meta', { status: 'live', startAt: 12345 })));
await t('everyone posts locations in lobby', async () => {
  await ok(op(A, 'set', G + '/locs/' + A, at(0, 0)));
  await ok(op(B, 'set', G + '/locs/' + B, at(6, 0)));      // 6 m from A
  await ok(op(C, 'set', G + '/locs/' + C, at(200, 0)));    // 200 m from A
  await ok(op(D, 'set', G + '/locs/' + D, at(-100, 50)));
});
await t('cannot post a location for someone else, or with a fake time', async () => {
  await denied(op(B, 'set', G + '/locs/' + C, at(0, 0)));
  await denied(op(B, 'set', G + '/locs/' + B, { ...at(6, 0), t: 1 }));
});
await t('host starts the game', () => ok(op(A, 'update', G + '/meta', { status: 'live', startAt: TS })));
await t('cannot join once started', () => denied(op(X, 'set', G + '/players/' + X, player('Late'))));

console.log('hiding phase');
await t('no catches during the head start', () => denied(op(A, 'set', G + '/caught/' + B, { by: A, t: TS, how: 'gps' })));
await t('hiders can watch the seekers during the head start', () => ok(op(B, 'get', G + '/locs/' + A)));
await t('seekers cannot see hiders', () => denied(op(A, 'get', G + '/locs/' + B)));
await t('hiders can see fellow hiders', () => ok(op(B, 'get', G + '/locs/' + C)));

console.log('hunt');
await advance(61000);
const refresh = async () => {
  await ok(op(A, 'set', G + '/locs/' + A, at(0, 0)));
  await ok(op(B, 'set', G + '/locs/' + B, at(6, 0)));
  await ok(op(C, 'set', G + '/locs/' + C, at(200, 0)));
  await ok(op(D, 'set', G + '/locs/' + D, at(-100, 50)));
};
await refresh();
await t('hiders lose sight of seekers once the hunt starts', () => denied(op(B, 'get', G + '/locs/' + A)));
await t('seekers still cannot see hiders', () => denied(op(A, 'get', G + '/locs/' + C)));
await t('CANNOT catch a hider 200 m away', () => denied(op(A, 'set', G + '/caught/' + C, { by: A, t: TS, how: 'gps' })));
await t('cannot catch on someone else\'s behalf', () => denied(op(C, 'set', G + '/caught/' + B, { by: A, t: TS, how: 'gps' })));
await t('a hider cannot "catch" another hider', () => denied(op(C, 'set', G + '/caught/' + B, { by: C, t: TS, how: 'gps' })));
await t('cannot catch with poor GPS accuracy (±50 m)', async () => {
  await ok(op(A, 'set', G + '/locs/' + A, at(0, 0, 50)));
  await denied(op(A, 'set', G + '/caught/' + B, { by: A, t: TS, how: 'gps' }));
  await ok(op(A, 'set', G + '/locs/' + A, at(0, 0)));
});
await t('cannot catch using a stale location', async () => {
  await advance(13000);
  await denied(op(A, 'set', G + '/caught/' + B, { by: A, t: TS, how: 'gps' }));
  await refresh();
});
await t('CAN catch a hider 6 m away', () => ok(op(A, 'set', G + '/caught/' + B, { by: A, t: TS, how: 'gps', d: 6 })));
await t('cannot catch the same person twice', () => denied(op(A, 'set', G + '/caught/' + B, { by: A, t: TS, how: 'gps' })));
await t('caught hider is now a seeker and sees seekers', () => ok(op(B, 'get', G + '/locs/' + A)));
await t('caught hider can no longer see hiders', () => denied(op(B, 'get', G + '/locs/' + C)));

console.log('reveals');
await t('no reveal before the first cooldown', () => denied(op(A, 'set', G + '/reveal', { n: 1, t: TS, by: A })));
await advance(120000);
await refresh();
await ok(op(B, 'set', G + '/locs/' + B, at(0, 3)));
await t('seeker triggers reveal #1', () => ok(op(A, 'set', G + '/reveal', { n: 1, t: TS, by: A })));
await t('reveal is on cooldown', () => denied(op(B, 'set', G + '/reveal', { n: 2, t: TS, by: B })));
await t('hiders cannot trigger reveals', () => denied(op(C, 'set', G + '/reveal', { n: 2, t: TS, by: C })));
await t('a hider cannot publish a fake circle far from where they are', () => {
  const p = at(-300, 0);
  return denied(op(C, 'set', G + '/circles/' + C, { n: 1, lat: p.lat, lng: p.lng, r: 75, t: TS }));
});
await t('a hider cannot shrink/grow the circle', () => {
  const p = at(200, 10);
  return denied(op(C, 'set', G + '/circles/' + C, { n: 1, lat: p.lat, lng: p.lng, r: 500, t: TS }));
});
await t('hider answers with a circle that contains them', () => {
  const p = at(240, 30); // 50 m off-centre
  return ok(op(C, 'set', G + '/circles/' + C, { n: 1, lat: p.lat, lng: p.lng, r: 75, t: TS }));
});
await t('one answer per reveal', () => {
  const p = at(200, 0);
  return denied(op(C, 'set', G + '/circles/' + C, { n: 1, lat: p.lat, lng: p.lng, r: 75, t: TS }));
});
await t('a hider who answered stays hidden', async () => { await advance(21000); await refresh(); await ok(op(B, 'set', G + '/locs/' + B, at(0, 3))); await denied(op(A, 'get', G + '/locs/' + C)); });
await t('a hider who ignored the reveal for 20 s is exposed', () => ok(op(A, 'get', G + '/locs/' + D)));
await t('late answer hides them again', async () => {
  const p = at(-100, 40);
  await ok(op(D, 'set', G + '/circles/' + D, { n: 1, lat: p.lat, lng: p.lng, r: 75, t: TS }));
  await denied(op(A, 'get', G + '/locs/' + D));
});

console.log('going dark / out of bounds');
await t('hider outside the play area is exposed', async () => {
  await ok(op(C, 'set', G + '/locs/' + C, at(600, 0)));
  await ok(op(A, 'get', G + '/locs/' + C));
  await ok(op(C, 'set', G + '/locs/' + C, at(200, 0)));
  await denied(op(A, 'get', G + '/locs/' + C));
});
await t('hider who goes dark for 60 s is exposed', async () => {
  await advance(61000);
  await ok(op(A, 'set', G + '/locs/' + A, at(0, 0)));
  await ok(op(A, 'get', G + '/locs/' + C));
  await refresh();
});

console.log('other ways to be caught');
await t('host cannot GPS-catch from afar', () => denied(op(A, 'set', G + '/caught/' + D, { by: A, t: TS, how: 'gps' })));
await t('non-host cannot use host override', () => denied(op(B, 'set', G + '/caught/' + D, { by: B, t: TS, how: 'host' })));
await t('a hider can own up to being caught', () => ok(op(C, 'set', G + '/caught/' + C, { by: C, t: TS, how: 'self' })));
await t('host override works (logged as host)', () => ok(op(A, 'set', G + '/caught/' + D, { by: A, t: TS, how: 'host' })));
await t('host can undo a catch', () => ok(op(A, 'set', G + '/caught/' + D, null)));
await t('non-host cannot undo a catch', () => denied(op(B, 'set', G + '/caught/' + C, null)));

console.log('end');
await t('no catches after time runs out', async () => {
  await advance(31 * 60000);
  await refresh();
  await ok(op(A, 'set', G + '/locs/' + D, at(-100, 50))).catch(() => {});
  await denied(op(A, 'set', G + '/caught/' + D, { by: A, t: TS, how: 'host' }));
});
await t('everyone can see everyone after the game', () => ok(op(A, 'get', G + '/locs/' + D)));
await t('non-host cannot reset', () => denied(op(B, 'update', G, { caught: null, circles: null, reveal: null, 'meta/status': 'lobby' })));
await t('host resets to lobby', () => ok(op(A, 'update', G, { caught: null, circles: null, reveal: null, 'meta/status': 'lobby' })));

srv.kill();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
