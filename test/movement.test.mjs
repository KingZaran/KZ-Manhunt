// Unit tests for js/movement.js. Run: node test/movement.test.mjs
import assert from 'node:assert/strict';
import { Movement, FreezeState, seeded } from '../js/movement.js';
import { DEFAULTS } from '../js/rules-config.js';

let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  ok  ', name); } catch (e) { failed++; console.log('  FAIL', name, '\n      ', e.message); } }
const st = { ...DEFAULTS };
const LAT = 51.1, LNG = -1.65, M = 111320;
const fix = (n, at, speed = null) => ({ lat: LAT + n / M, lng: LNG, at, speed });

function runFor(m, secs, mps, start = 0, from = 0, ctx = {}) {
  const evs = [];
  let n = from;
  for (let s = 0; s <= secs; s++) {
    const at = start + s * 1000;
    n += mps;
    m.addFix(fix(n, at, mps));
    evs.push(...m.tick(at, st, { hunting: true, huntStart: 0, ...ctx }));
  }
  return { evs, n };
}

t('walking leaves no footprints and doesn\'t use stamina', () => {
  const m = new Movement();
  const { evs } = runFor(m, 20, 1.4);
  assert.ok(!evs.includes('print'));
  assert.equal(Math.round(m.stamina), 60);
});
t('running (10 km/h+) starts a trail after the 3 s grace', () => {
  const m = new Movement();
  const { evs } = runFor(m, 10, 3.5);
  assert.ok(evs.includes('run-start'));
  assert.ok(evs.filter((e) => e === 'print').length >= 3);
  assert.ok(m.stamina < 60);
});
t('a Ghost stops footprints', () => {
  const m = new Movement();
  const { evs } = runFor(m, 10, 3.5, 0, 0, { ghost: true });
  assert.ok(!evs.includes('print'));
});
t('stamina: warning at 5 s left, eliminated after running 5 s below zero', () => {
  const m = new Movement();
  const { evs } = runFor(m, 75, 3.5);
  const warnAt = evs.indexOf('breath-warn');
  assert.ok(warnAt > 0, 'warned');
  assert.ok(evs.includes('eliminate'), 'asked to accept elimination');
  assert.equal(m.violation.kind, 'breath');
});
t('walking refills stamina in about 92 s', () => {
  const m = new Movement();
  runFor(m, 60, 3.5);
  const low = m.stamina;
  runFor(m, 92, 1.0, 61000, 210);
  assert.ok(low < 5 && m.stamina > 58, `stamina ${low.toFixed(1)} -> ${m.stamina.toFixed(1)}`);
});
t('stamina is off during the head start', () => {
  const m = new Movement();
  for (let s = 0; s < 70; s++) { m.addFix(fix(s * 3.5, s * 1000, 3.5)); m.tick(s * 1000, st, { hunting: false }); }
  assert.equal(m.stamina, null);
});
t('outside the area: countdown, then asked to accept elimination', () => {
  const m = new Movement();
  m.addFix(fix(0, 0));
  let evs = m.tick(1000, st, { hunting: true, huntStart: 0, outSince: 1000 });
  assert.ok(evs.includes('violation'));
  evs = m.tick(62000, st, { hunting: true, huntStart: 0, outSince: 1000 });
  assert.ok(evs.includes('eliminate'));
  m.dismiss();
  evs = m.tick(63000, st, { hunting: true, huntStart: 0, outSince: 1000 });
  assert.ok(!evs.includes('violation'), '"Nope" stops asking until it clears');
  m.tick(64000, st, { hunting: true, huntStart: 0 });
  evs = m.tick(65000, st, { hunting: true, huntStart: 0, outSince: 65000 });
  assert.ok(evs.includes('violation'), 'asks again next time');
});
t('camping burns the spot after 10 min; standing in it is a violation', () => {
  const m = new Movement();
  m.addFix(fix(0, 0));
  const camp = { lat: LAT, lng: LNG };
  let evs = m.tick(5 * 60000, st, { hunting: true, huntStart: 0, campSince: 0, camp });
  assert.ok(m.burnsIn > 0 && !evs.includes('burned'));
  evs = m.tick(10 * 60000 + 1000, st, { hunting: true, huntStart: 0, campSince: 0, camp });
  assert.ok(evs.includes('burned'));
  evs = m.tick(10 * 60000 + 2000, st, { hunting: true, huntStart: 0, campSince: 0, camp });
  assert.equal(m.violation && m.violation.kind, 'burn');
  m.addFix(fix(100, 10 * 60000 + 3000));
  m.tick(10 * 60000 + 3000, st, { hunting: true, huntStart: 0, campSince: 10 * 60000, camp: { lat: LAT + 100 / M, lng: LNG } });
  assert.equal(m.violation, null, 'moved away');
});
t('freeze: cover, then hold; drifting restarts the hold; then released', () => {
  const f = new FreezeState();
  const fr = { n: 1, t: 0 };
  let evs = f.tick(1000, st, fr, { n: 1 }, fix(0, 1000));
  assert.deepEqual(evs, ['cover']);
  evs = f.tick(21000, st, fr, { n: 1 }, fix(10, 21000));
  assert.ok(evs.includes('hold'));
  evs = f.tick(40000, st, fr, { n: 1 }, fix(30, 40000));
  assert.ok(evs.includes('broke'), 'moved 20 m');
  evs = f.tick(81000, st, fr, { n: 1 }, fix(30, 81000));
  assert.ok(!evs.includes('released'), 'hold restarted at 40 s');
  evs = f.tick(100500, st, fr, { n: 1 }, fix(30, 100500));
  assert.ok(evs.includes('released'));
});
t('strict holds: breaking a hold eliminates', () => {
  const f = new FreezeState();
  const fr = { n: 2, t: 0 };
  f.tick(1000, { ...st, strictHolds: true }, fr, { n: 2 }, fix(0, 1000));
  f.tick(21000, { ...st, strictHolds: true }, fr, { n: 2 }, fix(0, 21000));
  const evs = f.tick(30000, { ...st, strictHolds: true }, fr, { n: 2 }, fix(40, 30000));
  assert.ok(evs.includes('broke-strict'));
});
t('seeded random is stable and spread out', () => {
  assert.equal(seeded('reveal3:abc'), seeded('reveal3:abc'));
  const xs = Array.from({ length: 1000 }, (_, i) => seeded('x' + i));
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  assert.ok(mean > 0.45 && mean < 0.55 && Math.max(...xs) < 1 && Math.min(...xs) >= 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
