// In-game mechanics (Hide Tag rules) and the game screen.
import {
  S, $, esc, initial, r6, wait, setHTML, fmtClock, fmtM, spokenTime, randId, once,
  path, settings, huntStart, huntEnd, isHost, name, roleOf, myRole, startingHiders, activeHiders, hunters, area,
  radiusNow, fxActive, fxLeft, fxOf, phase, sendLocation, freshFix,
  openSheet, closeSheet, confirmSheet, toast, showHold, scheduleRender,
  getMap, pinHTML, drawArea, drawMe, distLabel, gpsLine, playerRow, wake,
  isDenied, distM, MAX_ACC, POWER_MS, sound,
  REVEAL_STYLE, OLD_REVEAL_STYLE, MISSION_STYLE, MISSION_HELD_STYLE, BURN_STYLE, FREEZE_STYLE, SCAN_STYLE, POLL_EVERY,
} from './core.js?v=mvwv1q6e';
import { POWERS, kindsFor, REVEAL_ANSWER_MS, FLARE_DELAY_MS, FLARE_SHOW_MS, MISSION_FAIL_MS, DECOY_M, SILENCE_TOLERANCE_M } from './rules-config.js?v=mvwv1q6e';
import { randomPointNear, mPerDegLon, iosWakeLockBroken } from './geo.js?v=mvwv1q6e';
import { seeded } from './movement.js?v=mvwv1q6e';

const { cue, say, play, buzz } = sound;
const side = (role) => (role === 'hider' ? 'h' : 's');
const now = () => S.db.now();
const st = () => settings();

/* ------------------------------------------------------------------ subscriptions */

export function subscribeGame(on) {
  on('reveal', (v) => { S.reveal = v; onReveal(); });
  on('rcut', (v) => { S.rcut = v; });
  on('circles', (v) => { S.circles = v || {}; });
  on('freeze', (v) => { S.freeze = v; onFreeze(); });
  on('fcut', (v) => { S.fcut = v; });
  on('fz', (v) => { S.fz = v || {}; onFreezeHits(); });
  on('prints', (v) => { S.prints = v || {}; });
  on('fx', (v) => { S.fx = v || {}; onEffects(); });
  on('flare', (v) => { S.flare = v; onFlare(); });
  on('scan', (v) => { S.scan = v || {}; onScans(); });
  on('mission', (v) => { S.mission = v; onMission(); });
  on('mhold', (v) => { S.mhold = v || {}; onHolds(); });
  on('mfail', (v) => { S.mfail = v || 0; });
  on('bag/' + S.uid, (v) => { S.bag = v || {}; });
}

// Caches are per side, so listen to the right ones (and switch when a hider is caught).
let cacheSub = null, cacheSide = null;
function reconcileCaches() {
  const want = S.players[S.uid] && phase() !== 'lobby' ? side(myRole()) : null;
  if (want === cacheSide) return;
  if (cacheSub) cacheSub();
  cacheSub = null; cacheSide = want; S.caches = {};
  if (want) cacheSub = S.db.on(path('caches/' + want), (v) => { S.caches = v || {}; }, () => { cacheSide = null; });
}
export function stopGame() {
  if (cacheSub) cacheSub();
  cacheSub = null; cacheSide = null;
}

export function resetRound() {
  S.ev = {};
  S.move.reset();
  S.frz.reset();
  S.exposed = {};
  S.myScans = {};
  S.answering = null;
  S.picking = false;
  S.freezeTry = null;
  S.lastHeldBy = null;
}

/* ------------------------------------------------------------------ the second-by-second loop */

export function onFix(f) {
  if (phase() === 'hiding' || phase() === 'hunt') S.move.addFix(f);
}

export function tickGame(ph) {
  reconcileCaches();
  if (ph !== 'hiding' && ph !== 'hunt') return;
  const t = now();
  const role = myRole();
  const s = st();

  headStartCues(ph, t, role);
  if (ph === 'hunt') {
    timeCues(t);
    if (role === 'hider') hiderTick(t, s);
    else hunterTick(t, s);
    autoPickup();
    claimFree(role);
    missionTick(t, s, role);
    answerScans();
    flareSnap();
    if (isHost()) hostTick(t, s);
  }
}

function headStartCues(ph, t, role) {
  if (ph === 'hiding') {
    const left = huntStart() - t;
    once('hs-start', () => {
      if (role === 'seeker') cue('ready', `Hunters, wait here. The hunt begins in ${spokenTime(left)}.`);
      else cue('go', `Go! Run and hide. The hunt begins in ${spokenTime(left)}. You can run freely during the head start.`, { buzz: [200, 100, 200] });
    });
    if (left <= 60000 && left > 55000) once('hs-60', () => say('One minute until the hunt.'));
    const s10 = Math.ceil(left / 1000);
    if (s10 <= 10 && s10 >= 1) once('hs-tick-' + s10, () => { play(s10 <= 3 ? 'tock' : 'tick'); if (s10 <= 5) say(String(s10), { urgent: true, rate: 1.2, delay: 0 }); });
  }
}

function timeCues(t) {
  const left = huntEnd() - t;
  for (const mins of [10, 5, 1]) {
    if (left <= mins * 60000 && left > mins * 60000 - 5000) once('left-' + mins, () => cue('warn', `${mins} minute${mins === 1 ? '' : 's'} left.`));
  }
  if (left <= 10000 && left > 0) { const s = Math.ceil(left / 1000); once('end-tick-' + s, () => play('tick')); }
}

/* ------------------------------------------------------------------ hider */

function hiderTick(t, s) {
  const loc = S.myLoc || {};
  const evs = S.move.tick(t, s, {
    hunting: true,
    huntStart: huntStart(),
    ghost: fxActive(S.uid, 'ghost'),
    outSince: loc.out || null,
    campSince: loc.camp ? loc.camp.since : null,
    camp: loc.camp,
  });
  for (const e of evs) movementEvent(e, s);

  // Camping warning a minute before the spot burns.
  if (S.move.burnsIn != null && S.move.burnsIn < 60000 && S.move.burnsIn > 0) {
    once('burn-warn-' + (loc.camp && loc.camp.since), () => cue('warn', 'This spot burns in one minute. Keep moving.'));
  }
  // Countdown beeps while you're about to be eliminated.
  const v = S.move.violation;
  if (v) {
    const left = Math.ceil((v.deadline - t) / 1000);
    if (left > 0 && (left <= 10 || left % 10 === 0)) once(`doom-${v.kind}-${v.since}-${left}`, () => play('doom'));
  }
  // Near the (shrinking) edge.
  const a = area();
  if (a && S.fix) {
    const toEdge = radiusNow() - distM(S.fix, a, a.mlon);
    if (toEdge < 30 && toEdge > 0) { if (!S.ev.nearEdge) { S.ev.nearEdge = true; cue('warn', 'You\'re near the edge of the play area.'); } }
    else if (toEdge > 60) S.ev.nearEdge = false;
  }

  freezeTick(t, s);
  answerReveal();
  silenceWatch();
  effectEnds(t);
}

function movementEvent(e, s) {
  switch (e) {
    case 'run-start':
      if (fxActive(S.uid, 'ghost')) return;
      if (!S.ev.lastRunCue || Date.now() - S.ev.lastRunCue > 60000) { S.ev.lastRunCue = Date.now(); cue('footprints', 'You\'re running and leaving footprints.'); }
      break;
    case 'print': dropPrint(); break;
    case 'breath-warn': cue('breath', 'Out of breath in five seconds. Stop running.', { urgent: true, buzz: [300, 100, 300] }); break;
    case 'breath-ok': play('stamina_back'); break;
    case 'burned': cue('burn', `This spot has burned. Move out within ${spokenTime(s.graceSecs * 1000)}.`, { urgent: true, buzz: [400, 150, 400] }); break;
    case 'violation': {
      const v = S.move.violation;
      if (!v) break;
      if (v.kind === 'area') cue('out_of_area', `You're outside the play area. Get back inside within ${spokenTime(Math.max(0, v.deadline - now()))}.`, { urgent: true, buzz: [400, 150, 400] });
      if (v.kind === 'breath') cue('breath', 'You\'re out of breath. Walk now.', { urgent: true, buzz: [500, 150, 500] });
      break;
    }
    case 'eliminate': askElimination(); break;
    default:
  }
}

const VIOLATION_TEXT = {
  area: 'Outside the play area', burn: 'Standing in a spot you burned', breath: 'Out of breath', hold: 'You moved while frozen',
};
function askElimination(kind) {
  const k = kind || (S.move.violation && S.move.violation.kind);
  if (!k) return;
  cue('eliminated', 'It looks like you might have been eliminated. You decide.', { urgent: true, buzz: [600, 200, 600] });
  openSheet(`<h2>Was that fair?</h2>
    <p>It looks like you might have been eliminated: <b>${esc(VIOLATION_TEXT[k] || '')}</b>.</p>
    <p>The app is only guessing from your phone's position, and phones get it wrong among trees and tall buildings. You decide.</p>
    <div class="pick">
      <button class="btn btn-hider" id="pen-no">Nope. I played by the rules</button>
      <button class="btn btn-quiet" id="pen-yes">Fine, I got eliminated</button>
    </div>`);
  $('#pen-no').onclick = () => { closeSheet(); S.move.dismiss(); toast('Still a hider. Play on.', 'hider'); };
  $('#pen-yes').onclick = async () => {
    closeSheet();
    try { await S.db.set(path('caught/' + S.uid), { by: S.uid, t: S.db.TS, how: 'out', why: k }); }
    catch (e) { toast('Couldn\'t record that. Try again from the menu.', 'bad'); }
  };
}

let printSeq = 0;
function dropPrint() {
  const f = S.rawFix || S.fix;
  if (!f) return;
  S.db.set(path(`prints/${S.uid}/${Date.now().toString(36)}${(printSeq++ % 36).toString(36)}`), { lat: r6(f.lat), lng: r6(f.lng), t: S.db.TS }).catch(() => {});
}

/* Freeze, from a hider's side: register a hit (if a hunter is really in range), then cover/hold. */
function onFreeze() {
  const f = S.freeze;
  if (!f || phase() !== 'hunt') return;
  if (myRole() === 'hider') {
    S.freezeTry = { n: f.n, until: f.t + st().coverSecs * 1000, next: 0 };
  } else {
    once('freeze-cast-' + f.n, () => cue('freeze_cast', f.by === S.uid ? 'Freeze sent.' : `${name(f.by)} used freeze.`));
  }
}

async function freezeTick(t, s) {
  const ft = S.freezeTry;
  const f = S.freeze;
  if (ft && f && ft.n === f.n && t < ft.until + 4000 && Date.now() >= ft.next && !(S.fz[S.uid] && S.fz[S.uid].n === f.n)) {
    ft.next = Date.now() + 2500;
    if (!S.fix) return;
    await sendLocation(true, true);
    const wards = Object.entries(S.bag).filter(([, it]) => it.k === 'ward' && it.a && !it.u).map(([id]) => id);
    for (const h of hunters()) {
      const base = { n: f.n, t: S.db.TS, by: h };
      try {
        if (wards.length) await S.db.update(path(''), { [`bag/${S.uid}/${wards[0]}/u`]: S.db.TS, [`fz/${S.uid}`]: Object.assign(base, { ward: wards[0] }) });
        else await S.db.set(path('fz/' + S.uid), base);
        S.freezeTry = null;
        break;
      } catch (e) { /* that hunter isn't in range */ }
    }
  }
  // Cover / hold / release.
  const mine = S.fz[S.uid];
  const hit = mine && f && mine.n === f.n && !mine.ward ? mine : null;
  const evs = S.frz.tick(t, s, f, hit, S.rawFix || S.fix);
  for (const e of evs) {
    if (e === 'cover') cue('freeze_warn', `You will be frozen! Find cover. ${s.coverSecs} seconds.`, { urgent: true, buzz: [600, 120, 600, 120, 900] });
    if (e === 'hold') cue('frozen', `Frozen. Hold still for ${spokenTime(s.holdSecs * 1000)}.`, { urgent: true, buzz: [400, 120, 400, 120, 600] });
    if (e === 'broke') cue('hold_broken', 'You moved. Hold still. Your hold has restarted.', { urgent: true, buzz: [200, 100, 200] });
    if (e === 'broke-strict') { cue('hold_broken', 'You moved while frozen.', { urgent: true }); askElimination('hold'); }
    if (e === 'released') cue('released', 'Free again. You can move.', { buzz: [120, 80, 120] });
  }
  if (S.frz.phase === 'cover' || S.frz.phase === 'hold') {
    const sLeft = Math.ceil(S.frz.left / 1000);
    if (sLeft <= 5 && sLeft >= 1) once(`frz-${S.frz.n}-${S.frz.phase}-${sLeft}`, () => play('tick'));
  }
}

function onFreezeHits() {
  const f = S.freeze;
  if (!f) return;
  const mine = S.fz[S.uid];
  if (mine && mine.n === f.n && mine.ward) once('ward-' + f.n, () => {
    const left = Object.values(S.bag).filter((it) => it.k === 'ward' && it.a && !it.u).length;
    cue('ward_block', `Your ward blocked a freeze. ${left} left.`);
  });
}

/* Reveal, from a hider's side: answer with a circle (shared with hiders nearby), or a protection. */
function onReveal() {
  const rv = S.reveal;
  if (!rv || phase() !== 'hunt') return;
  if (myRole() === 'hider') answerReveal();
}

function groupCircle(rv, s) {
  // Hiders within groupM of each other share one circle, drawn around the "leader".
  const me = S.fix;
  const group = [S.uid];
  if (s.groupM > 0) {
    for (const u of activeHiders()) {
      if (u === S.uid) continue;
      const l = S.locs[u];
      if (l && now() - l.t < 15000 && distM(l, me) <= s.groupM) group.push(u);
    }
  }
  group.sort();
  const leader = group[0];
  const lp = leader === S.uid ? me : S.locs[leader];
  const maxOff = Math.max(0, s.revealRadius - s.groupM - 8);
  const a = seeded(`${rv.n}:${leader}:a`) * 2 * Math.PI;
  const d = maxOff * Math.sqrt(seeded(`${rv.n}:${leader}:d`));
  const c = { lat: lp.lat + (d * Math.cos(a)) / 111320, lng: lp.lng + (d * Math.sin(a)) / mPerDegLon(lp.lat) };
  // Make sure it still contains us (group members' positions may have moved a little).
  return distM(c, me) <= s.revealRadius - 3 ? c : randomPointNear(me, s.revealRadius * 0.8);
}

async function answerReveal() {
  const rv = S.reveal;
  if (!rv || phase() !== 'hunt' || myRole() !== 'hider') return;
  const mine = S.circles[S.uid];
  if (mine && mine.n === rv.n) return;
  if (S.answering === rv.n) return;
  S.answering = rv.n;
  const s = st();
  try {
    const f = await freshFix(6000);
    if (!f) throw new Error('no gps');
    await sendLocation(true, true);
    const base = { n: rv.n, t: S.db.TS };
    const items = Object.entries(S.bag).filter(([, it]) => it.a && !it.u);
    const jam = items.find(([, it]) => it.k === 'jamming');
    const mis = items.find(([, it]) => it.k === 'misdirection');
    let told = null;
    if (fxActive(S.uid, 'smoke')) {
      await S.db.set(path('circles/' + S.uid), Object.assign(base, { skip: 'smoke' }));
    } else if (fxActive(S.uid, 'silence') && S.silenceOk) {
      await S.db.set(path('circles/' + S.uid), Object.assign(base, { skip: 'silence' }));
    } else if (jam) {
      await S.db.update(path(''), { [`bag/${S.uid}/${jam[0]}/u`]: S.db.TS, [`circles/${S.uid}`]: Object.assign(base, { skip: 'jam', jam: jam[0] }) });
      const left = items.filter(([, it]) => it.k === 'jamming').length - 1;
      told = () => cue('jam_block', `Jamming blocked a reveal. ${left} left.`);
    } else if (mis) {
      const m = mis[1].m || 100;
      const ang = Math.random() * 2 * Math.PI;
      const c = { lat: f.lat + (m * Math.cos(ang)) / 111320, lng: f.lng + (m * Math.sin(ang)) / mPerDegLon(f.lat) };
      await S.db.update(path(''), { [`bag/${S.uid}/${mis[0]}/u`]: S.db.TS, [`circles/${S.uid}`]: Object.assign(base, { lat: r6(c.lat), lng: r6(c.lng), r: s.revealRadius, mis: mis[0] }) });
      S.misMarker = { lat: c.lat, lng: c.lng, n: rv.n };
      told = () => cue('misdirection', 'A hunter revealed you, and found your marker instead. That\'s where they\'ll walk.');
    } else {
      const c = groupCircle(rv, s);
      await S.db.set(path('circles/' + S.uid), Object.assign(base, { lat: r6(c.lat), lng: r6(c.lng), r: s.revealRadius }));
      // Only sometimes are you told, and only after a delay (as in Hide Tag).
      if (seeded(`${rv.n}:${S.uid}:told`) * 100 < s.revealNotice) {
        told = () => { S.toldReveal = rv.n; cue('revealed', 'You were revealed. The hunters have a circle around where you were.', { buzz: [150, 100, 150] }); };
      }
    }
    if (told) setTimeout(told, 10000);
  } catch (e) {
    console.warn('reveal answer failed', e);
    S.answering = null;
    setTimeout(() => answerReveal(), 3000);
  }
}

// Silence only works while you stay completely still.
function silenceWatch() {
  const f = fxOf(S.uid, 'silence');
  if (!f || !fxActive(S.uid, 'silence')) { S.silenceAnchor = null; S.silenceOk = false; return; }
  const here = S.rawFix || S.fix;
  if (!here) return;
  if (!S.silenceAnchor || S.silenceAnchor.item !== f.item) { S.silenceAnchor = { lat: here.lat, lng: here.lng, item: f.item }; S.silenceOk = true; }
  if (S.silenceOk && distM(S.silenceAnchor, here) > SILENCE_TOLERANCE_M) {
    S.silenceOk = false;
    cue('silence_end', 'You moved, so Silence has ended. Reveals can find you again.');
  }
}

function effectEnds(t) {
  for (const k of ['ghost', 'spy', 'smoke', 'silence']) {
    const f = fxOf(S.uid, k);
    if (f && !fxActive(S.uid, k)) once(`fx-end-${k}-${f.item}`, () => {
      if (k === 'silence' && S.silenceOk === false) return;
      cue(k === 'silence' ? 'silence_end' : 'toast', `${POWERS[k].name} has ended.`);
    });
  }
}

/* ------------------------------------------------------------------ hunter */

function hunterTick(t, s) {
  if (Date.now() - S.lastPoll > POLL_EVERY) pollExposed();
  const rr = nextRevealAt();
  if (t >= rr) once('reveal-ready-' + (S.reveal ? S.reveal.n : 0), () => cue('reveal_ready', 'Reveal ready.'));
  const fr = nextFreezeAt();
  if (t >= fr) once('freeze-ready-' + (S.freeze ? S.freeze.n : 0), () => cue('freeze_ready', 'Freeze ready.'));
  // Freeze results, once the cover period is over.
  const f = S.freeze;
  if (f && t > f.t + s.coverSecs * 1000 + 4000) once('freeze-result-' + f.n, () => {
    const hits = Object.entries(S.fz).filter(([, v]) => v.n === f.n);
    const frozen = hits.filter(([, v]) => !v.ward).map(([u]) => name(u));
    const blocked = hits.filter(([, v]) => v.ward).map(([u]) => name(u));
    let line = frozen.length ? `Froze ${frozen.length > 2 ? frozen.length + ' hiders' : frozen.join(' and ')}.` : `Nobody within ${s.freezeM} metres.`;
    if (blocked.length) line += ` ${blocked.length === 1 ? 'One freeze was' : blocked.length + ' freezes were'} blocked by a ward.`;
    cue(frozen.length ? 'frozen' : 'toast', line);
  });
}

export function nextRevealAt() {
  const cd = st().revealCooldownSecs * 1000;
  const base = S.reveal ? S.reveal.t + cd : huntStart() + cd;
  return base - (S.rcut ? S.rcut.ms : 0);
}
export function nextFreezeAt() {
  const s = st();
  const base = S.freeze ? S.freeze.t + (s.coverSecs + s.holdSecs) * 1000 + s.freezeCd * 1000 : huntStart() + s.freezeCd * 1000;
  return base - (S.fcut ? S.fcut.ms : 0);
}

async function pollExposed() {
  S.lastPoll = Date.now();
  const found = {};
  await Promise.all(activeHiders().map(async (u) => {
    try { const v = await S.db.get(path('locs/' + u)); if (v) found[u] = v; } catch (e) { /* hidden, as it should be */ }
  }));
  const before = Object.keys(S.exposed);
  S.exposed = found;
  const newly = Object.keys(found).filter((u) => !before.includes(u));
  if (newly.length && phase() === 'hunt') {
    const why = exposedReason(found[newly[0]], newly[0]);
    if (why !== 'flare' && why !== 'mission failed') cue('warn', `${newly.map(name).join(' and ')} ${newly.length === 1 ? 'is' : 'are'} exposed: ${why}.`);
  }
}

export function exposedReason(loc, u) {
  const t = now();
  const s = st();
  if (!loc) return 'position visible';
  if (S.mfail && t - S.mfail < MISSION_FAIL_MS) return 'mission failed';
  if (S.flare && t >= S.flare.t + FLARE_DELAY_MS && t < S.flare.t + FLARE_DELAY_MS + FLARE_SHOW_MS) return 'flare';
  if (t - loc.t > s.darkSecs * 1000) return `offline for ${Math.round((t - loc.t) / 1000)} seconds`;
  if (loc.out && t - loc.out > s.graceSecs * 1000) return 'outside the play area';
  if (loc.camp && s.campMins > 0) return 'camping in one spot';
  const c = S.circles[u];
  if (S.reveal && (!c || c.n !== S.reveal.n)) return 'missed the reveal';
  return 'position visible';
}

export async function triggerReveal() {
  const n = (S.reveal ? S.reveal.n : 0) + 1;
  try { await S.db.update(path(''), { reveal: { n, t: S.db.TS, by: S.uid }, rcut: null }); cue('reveal', null); }
  catch (e) { cue('error', null); toast(isDenied(e) ? 'Reveal isn\'t ready yet.' : 'Couldn\'t reach the server.', 'bad'); }
}

export function freezeSheet() {
  const s = st();
  openSheet(`<h2>❄️ Freeze</h2><p>Every hider within ${s.freezeM} m of any hunter gets ${s.coverSecs} s to find cover, then must hold still for ${s.holdSecs} s.</p>
    <div class="pick"><button class="btn btn-freeze" id="do-freeze">Freeze now</button><button class="btn btn-quiet" data-action="close-sheet">Cancel</button></div>`);
  $('#do-freeze').onclick = () => { closeSheet(); triggerFreeze(); };
}
async function triggerFreeze() {
  const n = (S.freeze ? S.freeze.n : 0) + 1;
  await sendLocation(true, true);
  try { await S.db.update(path(''), { freeze: { n, t: S.db.TS, by: S.uid }, fcut: null }); }
  catch (e) { cue('error', null); toast(isDenied(e) ? 'Freeze isn\'t ready yet.' : 'Couldn\'t reach the server.', 'bad'); }
}

export function catchMenu(override) {
  const hs = activeHiders();
  const s = st();
  const list = hs.map((u) => `<button class="btn btn-hider" data-action="catch" data-how="${override ? 'host' : 'gps'}" data-uid="${esc(u)}"><span class="player-dot" style="background:${esc(S.players[u].color)}">${initial(name(u))}</span>${esc(name(u))}</button>`).join('');
  const gps = S.fix ? `Your GPS: ±${S.fix.acc} m${S.fix.acc > MAX_ACC ? ' (too rough to count)' : ''}.` : 'No GPS fix yet.';
  openSheet(override
    ? `<h2>Organiser override</h2><p>Marks a hider as caught without the GPS check. Everyone sees that you used it.</p><div class="pick">${list || '<p>No hiders left.</p>'}<button class="btn btn-quiet" data-action="close-sheet">Cancel</button></div>`
    : `<h2>Who did you catch?</h2><p>You have to be close enough to touch them: within ${s.tagRadius} m by GPS. ${gps}</p><div class="pick">${list || '<p>No hiders left.</p>'}${isHost() ? '<button class="btn btn-quiet" data-action="override-menu">Organiser override</button>' : ''}<button class="btn btn-quiet" data-action="close-sheet">Cancel</button></div>`);
}

export async function tryCatch(u, how) {
  closeSheet();
  const r = st().tagRadius;
  if (how === 'gps') {
    if (!S.fix) { toast('No GPS fix yet. Make sure location is allowed.', 'bad'); return; }
    if (S.fix.acc > MAX_ACC) { cue('error', 'GPS too rough.'); toast(`Your GPS is too rough (±${S.fix.acc} m). Step into the open and try again in a moment.`, 'bad', 6000); return; }
    toast('Catching…');
    await freshFix(4000, 5000);
    await sendLocation(true, true);
  }
  try {
    await S.db.set(path('caught/' + u), { by: S.uid, t: S.db.TS, how });
  } catch (e) {
    if (!isDenied(e)) { toast('Couldn\'t reach the server. Try again.', 'bad'); return; }
    if (S.caught[u]) toast(`${name(u)} has already been caught.`);
    else if (how === 'gps') { cue('error', `${name(u)} is not close enough.`); toast(`${name(u)} isn't within ${r} m of you by GPS. Both phones need the game open. Stay next to them a few seconds and try again.`, 'bad', 7000); }
    else toast('Not allowed right now.', 'bad');
  }
}

/* ------------------------------------------------------------------ supplies and power-ups */

function pickKind(role) {
  const pool = (S.meta.settings && S.meta.settings.pool) || {};
  const kinds = kindsFor(role).filter((k) => pool[k] !== false);
  const weights = kinds.map((k) => (POWERS[k].rare ? 0.25 : 1));
  let x = Math.random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < kinds.length; i++) { x -= weights[i]; if (x <= 0) return kinds[i]; }
  return kinds[0];
}

function cacheSpot() {
  const a = area();
  return randomPointNear(a, radiusNow() * 0.85);
}

// Opening supplies, plus a new cache per side every so often (the organiser's phone does this).
export function openingCaches() {
  const s = st();
  const out = {};
  for (let i = 0; i < s.supplies; i++) {
    for (const [sd, role] of [['h', 'hider'], ['s', 'seeker']]) {
      const p = cacheSpot();
      out[`caches/${sd}/${sd}${randId(9)}`] = { lat: r6(p.lat), lng: r6(p.lng), k: pickKind(role), t: S.db.TS };
    }
  }
  return out;
}

function hostTick(t, s) {
  // New caches.
  if (s.cacheEvery > 0) {
    const due = Math.floor((t - huntStart()) / (s.cacheEvery * 1000));
    if (due > 0) once('cache-wave-' + due, () => {
      const upd = {};
      for (const [sd, role] of [['h', 'hider'], ['s', 'seeker']]) {
        const p = cacheSpot();
        upd[`caches/${sd}/${sd}${randId(9)}`] = { lat: r6(p.lat), lng: r6(p.lng), k: pickKind(role), t: S.db.TS };
      }
      S.db.update(path(''), upd).catch(() => {});
    });
  }
  // Mission waves.
  if (s.missions > 0) {
    const mi = S.mission;
    const over = mi && (mi.done || mi.fail);
    const endedAt = mi && (mi.done ? mi.done.t : mi.fail);
    if (!mi || (over && t - endedAt > 60000)) {
      if (huntEnd() - t > s.missionStart * 1000 + s.missionHold * 1000 && Date.now() - (S.ev.missionOpenAt || 0) > 8000) {
        S.ev.missionOpenAt = Date.now();
        const id = 'w' + randId(6);
        once('mission-open-' + id, () => {
          const a = cacheSpot(), b = cacheSpot();
          S.db.update(path(''), { mission: { id, a: { lat: r6(a.lat), lng: r6(a.lng) }, b: { lat: r6(b.lat), lng: r6(b.lng) }, r: s.missionM, t: S.db.TS }, mhold: null }).catch(() => {});
        });
      }
    }
  }
}

async function autoPickup() {
  if (!S.fix || S.fix.acc > MAX_ACC || S.picking) return;
  const s = st();
  const range = Math.max(5, s.pickupM - 3);
  const near = Object.entries(S.caches).find(([id, c]) => !S.bag[id] && distM(S.fix, c) <= range && Date.now() - ((S.ev['pick-' + id]) || 0) > 6000);
  if (!near) return;
  const [id, c] = near;
  S.ev['pick-' + id] = Date.now();
  S.picking = true;
  try {
    await sendLocation(true, true);
    await S.db.set(path(`bag/${S.uid}/${id}`), { k: c.k, src: 'cache', t: S.db.TS });
    const P = POWERS[c.k];
    cue('pickup', `Picked up ${P.name}.`, { buzz: [80, 60, 80] });
    toast(`Picked up ${P.icon} ${P.name}. Tap it below to use it.`, myRole());
  } catch (e) { /* GPS disagreed; we'll try again */ }
  S.picking = false;
}

function claimFree(role) {
  const n = st().freeHandout;
  for (let i = 1; i <= n; i++) {
    const id = 'free' + i;
    if (S.bag[id] || S.ev['free-' + id]) continue;
    S.ev['free-' + id] = true;
    const k = pickKind(role);
    S.db.set(path(`bag/${S.uid}/${id}`), { k, src: 'free', t: S.db.TS })
      .then(() => { if (i === 1) cue('pickup', `Free power-up: ${POWERS[k].name}.`); })
      .catch(() => { S.ev['free-' + id] = false; });
  }
}

export function bagItems() {
  const role = myRole();
  const byKind = {};
  for (const [id, it] of Object.entries(S.bag)) {
    if (it.u) continue;
    const P = POWERS[it.k];
    if (!P) continue;
    const usable = P.side === 'both' || P.side === role;
    if (it.a) { (byKind[it.k + ':armed'] = byKind[it.k + ':armed'] || { k: it.k, armed: true, ids: [], usable }).ids.push(id); continue; }
    (byKind[it.k] = byKind[it.k] || { k: it.k, ids: [], usable }).ids.push(id);
  }
  return Object.values(byKind);
}

export function powerSheet(kind) {
  const P = POWERS[kind];
  const g = bagItems().find((x) => x.k === kind && !x.armed);
  if (!P || !g) return;
  if (!g.usable) {
    openSheet(`<h2>${P.icon} ${esc(P.name)}</h2><p>This is a ${P.side === 'hider' ? 'hider' : 'hunter'} power-up, so you can't use it now you're a ${myRole() === 'hider' ? 'hider' : 'hunter'}.</p><div class="pick"><button class="btn btn-quiet" data-action="close-sheet">Close</button></div>`);
    return;
  }
  const opts = P.options ? `<div class="seg power-range" role="group" aria-label="${kind === 'misdirection' ? 'False marker distance' : 'Range'}">${P.options.map((o, i) => `<button data-opt="${o}" aria-pressed="${i === 1}">${o} m</button>`).join('')}</div>` : '';
  openSheet(`<h2>${P.icon} ${esc(P.name)} ${g.ids.length > 1 ? `<small>×${g.ids.length}</small>` : ''}</h2><p>${esc(P.desc)}</p>${opts}
    <div class="pick"><button class="btn ${P.side === 'seeker' ? 'btn-primary' : 'btn-hider'}" id="use-pw">Use</button><button class="btn btn-quiet" data-action="close-sheet">Not now</button></div>`);
  let opt = P.options ? P.options[1] : null;
  const seg = $('#sheet .power-range');
  if (seg) seg.onclick = (e) => { const b = e.target.closest('[data-opt]'); if (!b) return; opt = Number(b.dataset.opt); seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); };
  $('#use-pw').onclick = () => { closeSheet(); usePower(kind, g.ids[0], opt); };
}

async function usePower(kind, id, opt) {
  if (phase() !== 'hunt') { toast('Power-ups work once the hunt has started.', 'warn'); return; }
  const s = st();
  const P = POWERS[kind];
  const U = { [`bag/${S.uid}/${id}/u`]: S.db.TS };
  try {
    switch (kind) {
      case 'ghost': case 'spy': case 'smoke': case 'silence':
        await S.db.update(path(''), Object.assign(U, { [`fx/${S.uid}/${kind}`]: { t: S.db.TS, item: id } }));
        if (kind === 'ghost') cue('ghost', 'Ghost on. You leave no footprints for 80 seconds.');
        if (kind === 'spy') cue('lookout', 'Lookout. The hunters are on your map for 30 seconds.');
        if (kind === 'smoke') cue('smoke', 'Smoke bomb. You can\'t be located for one minute.');
        if (kind === 'silence') cue('silence', 'Silence. Stay completely still and reveals will miss you.');
        break;
      case 'ward': case 'jamming':
        await S.db.set(path(`bag/${S.uid}/${id}/a`), S.db.TS);
        cue(kind === 'ward' ? 'ward' : 'jamming', kind === 'ward' ? 'Ward up. It will block the next freeze aimed at you.' : 'Jamming armed. The next reveal will miss you.');
        break;
      case 'misdirection':
        await S.db.update(path(`bag/${S.uid}/${id}`), { a: S.db.TS, m: opt || 100 });
        cue('misdirection', `Misdirection armed. The next reveal will find a marker ${opt || 100} metres away.`);
        break;
      case 'decoy': {
        const f = S.fix;
        if (!f) throw new Error('no gps');
        const ang = Math.random() * 2 * Math.PI;
        const start = { lat: f.lat + (DECOY_M * Math.cos(ang)) / 111320, lng: f.lng + (DECOY_M * Math.sin(ang)) / mPerDegLon(f.lat) };
        const dir = Math.random() * 2 * Math.PI;
        for (let i = 0; i < 10; i++) {
          const d = i * 7;
          U[`prints/${S.uid}/d${randId(7)}${i}`] = { lat: r6(start.lat + (d * Math.cos(dir)) / 111320), lng: r6(start.lng + (d * Math.sin(dir)) / mPerDegLon(f.lat)), t: S.db.TS };
        }
        await S.db.update(path(''), U);
        cue('decoy', 'Decoy trail laid.');
        break;
      }
      case 'reveal_ready': case 'freeze_ready': {
        const node = kind === 'reveal_ready' ? 'rcut' : 'fcut';
        const cur = kind === 'reveal_ready' ? S.rcut : S.fcut;
        const half = (kind === 'reveal_ready' ? s.revealCooldownSecs : s.freezeCd) * 500;
        await S.db.update(path(''), Object.assign(U, { [node]: { ms: (cur ? cur.ms : 0) + half, item: id } }));
        cue('boost', `${P.name}. Cooldown cut.`);
        break;
      }
      case 'flare':
        await S.db.update(path(''), Object.assign(U, { flare: { t: S.db.TS, by: S.uid, item: id } }));
        break;
      case 'scan': {
        await sendLocation(true, true);
        const f = S.rawFix || S.fix;
        await S.db.update(path(''), Object.assign(U, { [`scan/${id}`]: { by: S.uid, t: S.db.TS, r: opt || 100, side: side(myRole()), lat: r6(f.lat), lng: r6(f.lng) } }));
        S.myScans = S.myScans || {};
        S.myScans[id] = { at: Date.now() };
        cue('scan', null);
        break;
      }
      default:
    }
  } catch (e) {
    console.warn(e);
    cue('error', null);
    toast(isDenied(e) ? `Couldn't use ${P.name} right now.` : 'Couldn\'t reach the server.', 'bad');
  }
}

function onEffects() {
  // Hunters are told about smoke bombs.
  if (myRole() !== 'seeker') return;
  for (const [u, fx] of Object.entries(S.fx)) {
    const sm = fx.smoke;
    if (sm && now() - sm.t < 10000) once('smoke-' + sm.item, () => cue('smoke', `${name(u)} used a smoke bomb.`));
  }
}

/* Flare: everyone shares where they are; after 10 s everyone sees it. */
function onFlare() {
  const fl = S.flare;
  if (!fl || phase() !== 'hunt') return;
  once('flare-' + fl.t, () => {
    cue('flare', `${fl.by === S.uid ? 'You fired' : name(fl.by) + ' fired'} a flare. Everyone will be revealed in 10 seconds.`, { urgent: true });
    setTimeout(async () => {
      cue('flare_reveal', 'Flare. Everyone\'s location is showing.');
      try { S.snap = (await S.db.get(path('snap'))) || {}; } catch (e) { S.snap = {}; }
      S.lastPoll = 0;
    }, FLARE_DELAY_MS + 600);
  });
}
async function flareSnap() {
  const fl = S.flare;
  if (!fl || now() > fl.t + FLARE_DELAY_MS || S.ev['snap-' + fl.t]) return;
  if (myRole() === 'hider' && fxActive(S.uid, 'smoke')) return;
  S.ev['snap-' + fl.t] = true;
  const f = S.rawFix || S.fix;
  if (!f) return;
  await sendLocation(true, true);
  S.db.set(path('snap/' + S.uid), { lat: r6(f.lat), lng: r6(f.lng), t: fl.t }).catch(() => { S.ev['snap-' + fl.t] = false; });
}

/* Scan: the other side answers truthfully; the scanner gets a count. */
async function answerScans() {
  const mine = myRole();
  for (const [id, sc] of Object.entries(S.scan)) {
    if (sc.by === S.uid || (sc.a && sc.a[S.uid] != null) || S.ev['ans-' + id]) continue;
    if (now() > sc.t + 25000) continue;
    if ((sc.side === 'h' && mine !== 'seeker') || (sc.side === 's' && mine !== 'hider')) continue;
    S.ev['ans-' + id] = true;
    const smoke = mine === 'hider' && fxActive(S.uid, 'smoke');
    const f = S.myLoc;
    const inRange = !smoke && f && distM(f, sc) <= sc.r;
    S.db.set(path(`scan/${id}/a/${S.uid}`), !!inRange).catch(async () => {
      // our position just moved; try the other answer
      try { await S.db.set(path(`scan/${id}/a/${S.uid}`), !inRange); } catch (e) { /* too late */ }
    });
  }
}
function onScans() {
  for (const [id, sc] of Object.entries(S.scan)) {
    if (sc.by !== S.uid) continue;
    if (now() - sc.t < 6000) { setTimeout(onScans, 6500 - (now() - sc.t)); continue; }
    once('scan-' + id, () => {
      const n = Object.values(sc.a || {}).filter(Boolean).length;
      const who = sc.side === 's' ? 'hider' : 'hunter';
      cue('toast', n ? `${n} ${who}${n === 1 ? '' : 's'} within ${sc.r} metres.` : `Nobody within ${sc.r} metres.`);
      toast(n ? `🔍 ${n} ${who}${n === 1 ? '' : 's'} within ${sc.r} m — no direction.` : `🔍 Nobody within ${sc.r} m.`, 'warn', 7000);
    });
  }
}

/* ------------------------------------------------------------------ missions */

function missionDeadline() { return S.mission ? S.mission.t + st().missionStart * 1000 : 0; }

function onMission() {
  const mi = S.mission;
  if (!mi || phase() !== 'hunt') return;
  const role = myRole();
  const s = st();
  once('mission-new-' + mi.id, () => {
    if (role === 'hider') cue('mission_new', `New missions on the map. Someone must start one within ${spokenTime(s.missionStart * 1000)}.`);
    else cue('mission_new', 'New missions on the map. Watch for hiders holding them.');
  });
  if (mi.done) once('mission-done-' + mi.id, () => {
    if (role === 'hider') cue('mission_done', `Mission complete. ${s.missionPay} power-up${s.missionPay === 1 ? '' : 's'} each.`, { buzz: [100, 60, 100] });
    else cue('mission_done', 'The hiders completed a mission.');
  });
  if (mi.fail) once('mission-fail-' + mi.id, () => {
    if (role === 'hider') cue('mission_fail', 'Mission failed. Your exact location is shown to the hunters for one minute.', { urgent: true, buzz: [400, 150, 400] });
    else { cue('mission_fail', `Mission failed. Every hider is showing for one minute, and you get ${s.missionPay} power-up${s.missionPay === 1 ? '' : 's'}.`, { urgent: true }); S.lastPoll = 0; }
  });
}
function onHolds() {
  const mi = S.mission;
  if (!mi || myRole() !== 'seeker') return;
  const held = Object.values(S.mhold).some((h) => h.w === mi.id);
  if (held) once('mission-held-' + mi.id, () => cue('mission_held', 'A mission is being held. It\'s on your map.'));
}

async function missionTick(t, s, role) {
  const mi = S.mission;
  if (!mi || s.missions <= 0) return;
  // Rewards.
  if (mi.done && role === 'hider') claimMission('m', mi.id, 'hider');
  if (mi.fail && role === 'seeker') claimMission('f', mi.id, 'seeker');
  if (mi.done || mi.fail) return;
  // Failure check: anyone's phone can record it (the server checks it's true).
  const anyHold = Object.values(S.mhold).some((h) => h.w === mi.id);
  if (t > missionDeadline() + 1500 && (!mi.first || !anyHold) && !S.ev['fail-try-' + mi.id + Math.floor(t / 5000)]) {
    S.ev['fail-try-' + mi.id + Math.floor(t / 5000)] = true;
    S.db.update(path(''), { 'mission/fail': S.db.TS, mfail: S.db.TS }).catch(() => {});
  }
  if (role !== 'hider' || !S.fix) return;
  // Holding: step into a circle to start; leaving resets your own contribution.
  const mine = S.mhold[S.uid];
  const inA = distM(S.fix, mi.a) <= mi.r - 3, inB = distM(S.fix, mi.b) <= mi.r - 3;
  const c = inA ? 'a' : inB ? 'b' : null;
  if (c && (!mine || mine.w !== mi.id || mine.c !== c) && !S.ev['hold-try'] && !mi.done) {
    S.ev['hold-try'] = true;
    await sendLocation(true, true);
    const upd = { [`mhold/${S.uid}`]: { w: mi.id, c, since: S.db.TS } };
    if (!mi.first && t <= missionDeadline()) upd['mission/first'] = { by: S.uid, t: S.db.TS };
    try {
      await S.db.update(path(''), upd);
      cue('confirm', `Mission started. Stay in the circle for ${spokenTime(s.missionHold * 1000)}.`);
    } catch (e) {
      try { await S.db.set(path(`mhold/${S.uid}`), { w: mi.id, c, since: S.db.TS }); cue('confirm', `Holding the mission. Stay for ${spokenTime(s.missionHold * 1000)}.`); } catch (e2) { /* not inside by GPS */ }
    }
    S.ev['hold-try'] = false;
  } else if (!c && mine && mine.w === mi.id && !inA && !inB && distM(S.fix, mine.c === 'a' ? mi.a : mi.b) > mi.r + 3) {
    S.db.remove(path(`mhold/${S.uid}`)).catch(() => {});
    cue('warn', 'You left the mission circle. Your time there is lost.');
  }
  // Complete.
  if (mine && mine.w === mi.id && t - mine.since >= s.missionHold * 1000 && !S.ev['done-try-' + Math.floor(t / 4000)]) {
    S.ev['done-try-' + Math.floor(t / 4000)] = true;
    await sendLocation(true, true);
    S.db.set(path('mission/done'), { by: S.uid, t: S.db.TS }).catch(() => {});
  }
}

function claimMission(prefix, id, role) {
  const pay = st().missionPay;
  for (let i = 1; i <= pay; i++) {
    const key = prefix + id + i;
    if (S.bag[key] || S.ev['claim-' + key]) continue;
    S.ev['claim-' + key] = true;
    S.db.set(path(`bag/${S.uid}/${key}`), { k: pickKind(role), src: prefix === 'm' ? 'mission' : 'fail', t: S.db.TS }).catch(() => { S.ev['claim-' + key] = false; });
  }
}

/* ------------------------------------------------------------------ rendering */

export function renderGame(ph) {
  const s = st();
  const t = now();
  const role = myRole();
  const hs = startingHiders(), left = activeHiders();

  $('#clock').className = 'clock team-' + role;
  $('#clock-time').textContent = fmtClock((ph === 'hiding' ? huntStart() : huntEnd()) - t);
  $('#clock-phase').textContent = ph === 'hiding' ? 'Head start' : role === 'seeker' ? 'Hunting' : 'Hiding';
  $('#clock-sub').textContent = ph === 'hiding'
    ? (role === 'seeker' ? 'Hunters, wait here' : 'Run freely and find cover')
    : `${left.length} of ${hs.length} hider${hs.length === 1 ? '' : 's'} left`;

  renderHold(ph, role, t, s);
  renderBanner(ph, role, t, s);
  renderDock(ph, role, t, s);
  renderMap(ph, role, t, s);
}

function renderHold(ph, role, t, s) {
  const hold = $('#hold');
  if (hold.dataset.kind === 'event') return;
  let html = null, tone = '';
  if (ph === 'hiding' && role === 'seeker') {
    html = `<h2>Hunters, wait here</h2><p>Hiders are getting hidden. They can see you on their map until the hunt starts, so no sneaking off.</p><div class="big">${fmtClock(huntStart() - t)}</div><p>Your hunt begins when this reaches zero.</p>`;
  } else if (ph === 'hunt' && role === 'hider' && (S.frz.phase === 'cover' || S.frz.phase === 'hold')) {
    const cover = S.frz.phase === 'cover';
    html = `<h2>${cover ? 'YOU WILL BE FROZEN — MOVE!' : 'YOU ARE FROZEN — HOLD STILL'}</h2><p>${cover ? 'Get to cover before the countdown ends.' : `Stay still until the timer reaches zero. Moving more than ${s.driftM} m ${s.strictHolds ? 'eliminates you' : 'restarts the hold'}.`}</p><div class="big">${Math.ceil(S.frz.left / 1000)}</div>`;
    tone = cover ? 'warn' : 'freeze';
  }
  if (html) { setHTML(hold, `<div>${html}</div>`); hold.dataset.tone = tone; hold.hidden = false; }
  else { hold.hidden = true; hold.dataset.tone = ''; }
}

function renderBanner(ph, role, t, s) {
  let banner = null, danger = false, action = '';
  const v = S.move.violation;
  if (S.gpsErr && S.gpsErr.code === 1) { banner = 'Location is blocked, so the game can\'t see where you are. Tap for how to fix it.'; danger = true; action = 'gps-help'; }
  else if (S.gpsErr || !S.fix) banner = gpsLine();
  else if (role === 'hider' && ph === 'hunt' && v) {
    const msg = { area: 'Get back inside the play area', burn: 'Move out of this spot', breath: 'Stop running. Walk to recover', hold: 'Hold still' }[v.kind];
    banner = `You're about to be eliminated: ${msg} — ${Math.max(0, Math.ceil((v.deadline - t) / 1000))} s`; danger = true;
  } else if (role === 'hider' && ph === 'hunt' && S.move.running && !fxActive(S.uid, 'ghost')) banner = 'Running — leaving footprints.';
  else if (role === 'hider' && ph === 'hunt' && S.mfail && t - S.mfail < MISSION_FAIL_MS) { banner = `Mission failed — your exact location is revealed to hunters (${Math.ceil((MISSION_FAIL_MS - (t - S.mfail)) / 1000)} s left).`; danger = true; }
  else if (role === 'hider' && ph === 'hunt' && S.move.burnsIn != null && S.move.burnsIn < 120000 && S.move.burnsIn > 0) banner = `This spot burns in ${fmtClock(S.move.burnsIn)}. Keep moving.`;
  else if (iosWakeLockBroken()) banner = 'This iPhone can\'t keep a Home Screen app awake. Open the game in Safari, or set Auto-Lock to Never.';
  else if (!wake.active) { banner = wake.supported ? 'Keep this open with the screen on. Tap here to keep it awake.' : 'Set Auto-Lock to Never while you play. If the screen locks, your location stops updating.'; action = 'wake'; }
  const bEl = $('#banner');
  bEl.hidden = !banner;
  if (banner) { bEl.textContent = banner; bEl.className = 'banner' + (danger ? ' danger' : ''); bEl.dataset.action = action; }
}

function cdButton(action, label, readyAt, t, cls) {
  const ready = t >= readyAt;
  return `<button class="btn ${cls}" data-action="${action}" ${ready ? '' : 'disabled'}><span>${label}</span>${ready ? '' : `<small>${fmtClock(readyAt - t)}</small>`}</button>`;
}

// The bottom panel can be swiped down (or closed with ×) to see more of the map.
function renderMini(ph, role, t, s) {
  const me = S.players[S.uid] || {};
  const bits = [];
  if (ph === 'hunt' && role === 'hider' && s.staminaSecs > 0 && S.move.stamina != null) {
    const st = S.move.stamina;
    bits.push(`<span class="${st <= s.breathSecs / 2 ? 'mini-low' : ''}">🏃 ${st <= 0 ? 'Walk!' : Math.ceil(st) + ' s'}</span>`);
  }
  if (ph === 'hunt' && role === 'seeker') {
    const rv = nextRevealAt(), fr = nextFreezeAt();
    bits.push(`<span>📡 ${t >= rv ? '<b>Ready</b>' : fmtClock(rv - t)}</span>`, `<span>❄️ ${t >= fr ? '<b>Ready</b>' : fmtClock(fr - t)}</span>`);
  }
  if (ph === 'hiding') bits.push(`<span>Hunt in ${fmtClock(huntStart() - t)}</span>`);
  const n = ph === 'hunt' ? bagItems().filter((x) => !x.armed && x.usable).reduce((a, g) => a + g.ids.length, 0) : 0;
  if (n) bits.push(`<span>⚡ ${n} power-up${n === 1 ? '' : 's'}</span>`);
  const mi = S.mission, mine = S.mhold[S.uid];
  if (ph === 'hunt' && role === 'hider' && mi && !mi.done && !mi.fail && mine && mine.w === mi.id) bits.push(`<span>🎯 ${fmtClock(s.missionHold * 1000 - (t - mine.since))}</span>`);
  const catchBtn = ph === 'hunt' && role === 'seeker' ? '<button class="btn btn-primary mini-catch" data-action="catch-menu">Catch</button>' : '';
  setHTML($('#dock-mini'), `<button class="mini-open" data-action="dock-toggle" aria-label="Show the controls"><span class="player-dot" style="background:${esc(me.color)}">${initial(me.name)}</span><span class="mini-bits">${bits.join('') || `<span>${role === 'seeker' ? 'Hunter' : 'Hider'}</span>`}</span><span class="mini-chev" aria-hidden="true">▲</span></button>${catchBtn}`);
}

function renderDock(ph, role, t, s) {
  const dock = $('#dock');
  dock.classList.toggle('min', !!S.dockMin);
  $('#dock-mini').hidden = !S.dockMin;
  if (S.dockMin) { renderMini(ph, role, t, s); return; }
  let edge = '';
  const a = area();
  if (a && S.fix) {
    const d = Math.round(radiusNow() - distM(S.fix, a, a.mlon));
    edge = d >= 0 ? `${d} m to edge` : `${-d} m outside`;
  }
  const me = S.players[S.uid] || {};
  setHTML($('#dock-status'), `<button class="me-btn" data-action="profile" aria-label="Edit your name and colour"><span class="player-dot" style="background:${esc(me.color)}">${initial(me.name)}</span><b>${role === 'seeker' ? 'Hunter' : 'Hider'}</b></button><span class="muted">${esc(edge)}</span><span class="muted">${esc(gpsLine())}</span>`);

  // Stamina (hiders, during the hunt).
  const stam = S.move.stamina;
  const showStam = ph === 'hunt' && role === 'hider' && s.staminaSecs > 0 && stam != null;
  $('#stamina').hidden = !showStam;
  if (showStam) {
    const pct = Math.max(0, Math.min(100, (stam / s.staminaSecs) * 100));
    $('#stamina-fill').style.width = pct + '%';
    $('#stamina').classList.toggle('low', stam <= s.breathSecs / 2);
    $('#stamina-text').textContent = stam <= 0 ? 'Out of breath! Walk' : stam <= s.breathSecs / 2 ? `Out of breath in ${Math.ceil(stam)} s` : `Running left ${Math.ceil(stam)} s`;
  }

  // Active effects + power-ups.
  const chips = [];
  if (ph === 'hunt') {
    for (const k of ['ghost', 'spy', 'smoke', 'silence']) {
      if (!fxActive(S.uid, k)) continue;
      if (k === 'silence' && !S.silenceOk) continue;
      chips.push(`<span class="fx-chip">${POWERS[k].icon} ${esc(POWERS[k].name)} · ${Math.ceil(fxLeft(S.uid, k) / 1000)} s</span>`);
    }
    for (const g of bagItems().filter((x) => x.armed)) chips.push(`<span class="fx-chip">${POWERS[g.k].icon} ${esc(POWERS[g.k].name)} ×${g.ids.length} active</span>`);
    if (role === 'seeker') {
      for (const [u, fx] of Object.entries(S.fx)) if (fx.smoke && now() - fx.smoke.t < POWER_MS.smoke) chips.push(`<span class="fx-chip">💨 ${esc(name(u))}: smoke bomb</span>`);
    }
  }
  const bag = ph === 'hunt' ? bagItems().filter((x) => !x.armed).map((g) => `<button class="power ${g.usable ? POWERS[g.k].side : 'dead'}" data-action="power" data-kind="${g.k}" aria-label="${esc(POWERS[g.k].name)}"><span>${POWERS[g.k].icon}</span>${esc(POWERS[g.k].name)}${g.ids.length > 1 ? `<i>×${g.ids.length}</i>` : ''}</button>`) : [];
  const pw = chips.concat(bag).join('');
  setHTML($('#dock-powers'), pw);
  $('#dock-powers').hidden = !pw;

  // Missions HUD.
  const mi = S.mission;
  let mhud = '';
  if (ph === 'hunt' && mi && s.missions > 0) {
    const mine = S.mhold[S.uid];
    if (mi.done) mhud = `<span>🎯 Mission complete</span>`;
    else if (mi.fail) mhud = `<span>🎯 Mission failed</span>`;
    else if (role === 'hider' && mine && mine.w === mi.id) mhud = `<span>🎯 Hold the mission</span><b>${fmtClock(s.missionHold * 1000 - (t - mine.since))}</b>`;
    else if (Object.values(S.mhold).some((h) => h.w === mi.id)) mhud = `<span>🎯 Mission in progress…</span>`;
    else mhud = `<span>🎯 ${role === 'hider' ? 'Start a mission by' : 'Missions must start by'}</span><b>${fmtClock(missionDeadline() - t)}</b>`;
  }
  setHTML($('#dock-mission'), mhud);
  $('#dock-mission').hidden = !mhud;

  // Actions.
  let actions = '';
  if (ph === 'hunt' && role === 'seeker') {
    actions = cdButton('reveal', 'Reveal', nextRevealAt(), t, 'btn-quiet btn-cd')
      + cdButton('freeze', 'Freeze', nextFreezeAt(), t, 'btn-quiet btn-cd btn-freeze-q')
      + `<button class="btn btn-primary" data-action="catch-menu">Catch</button>`;
  } else if (ph === 'hunt' && role === 'hider') {
    actions = `<button class="btn btn-quiet" data-action="self-caught">I was caught</button>`;
  } else {
    actions = `<button class="btn btn-quiet" disabled>Hunt starts in ${fmtClock(huntStart() - t)}</button>`;
  }
  setHTML($('#dock-actions'), actions);
}

function renderMap(ph, role, t, s) {
  const mp = getMap('game', '#game-map');
  mp.begin();
  drawArea(mp, ph === 'hunt');

  // Players we're allowed to see.
  for (const [u, l] of Object.entries(S.locs)) {
    if (!l || !S.players[u]) continue;
    const stale = t - l.t > 30000;
    const label = name(u) + (stale ? ` · ${Math.round((t - l.t) / 1000)} s ago` : (distLabel(l) ? ` · ${distLabel(l)}` : ''));
    mp.pin(u, l.lat, l.lng, pinHTML(`${roleOf(u)}${stale ? ' stale' : ''}`, label, S.players[u].color, name(u)), 100);
  }
  if (ph === 'hunt') {
    // Exposed hiders (hunters).
    if (role === 'seeker') {
      for (const [u, l] of Object.entries(S.exposed)) {
        if (!S.players[u] || S.caught[u]) continue;
        mp.pin('x-' + u, l.lat, l.lng, pinHTML('exposed', `${name(u)} · ${distLabel(l)} · ${exposedReason(l, u)}`, S.players[u].color, name(u)), 500);
      }
    }
    // Flare snapshot (fades over a minute).
    const fl = S.flare;
    if (fl && t >= fl.t + FLARE_DELAY_MS && t < fl.t + FLARE_DELAY_MS + FLARE_SHOW_MS) {
      const age = (t - fl.t - FLARE_DELAY_MS) / FLARE_SHOW_MS;
      for (const [u, sn] of Object.entries(S.snap || {})) {
        if (sn.t !== fl.t || !S.players[u] || u === S.uid) continue;
        mp.pin('fl-' + u, sn.lat, sn.lng, `<div class="pin flare" style="opacity:${(1 - age * 0.8).toFixed(2)}">${pinHTML(roleOf(u), `${name(u)} (flare)`, S.players[u].color, name(u)).replace(/^<div class="pin [^"]*">|<\/div>$/g, '')}</div>`, 90);
      }
    }
    // Footprints (hunters see confirmed trails; they fade from the oldest end).
    if (role === 'seeker') {
      for (const [u, ps] of Object.entries(S.prints || {})) {
        for (const [k, p] of Object.entries(ps || {})) {
          const age = t - p.t;
          if (age > s.printSecs * 1000) continue;
          mp.pin(`fp-${u}-${k}`, p.lat, p.lng, `<div class="pin print" style="opacity:${(1 - age / (s.printSecs * 1000) * 0.85).toFixed(2)}">👣</div>`, 5);
        }
      }
    }
    // Reveal circles.
    if (S.reveal) {
      const seen = [];
      for (const [u, c] of Object.entries(S.circles)) {
        if (c.n !== S.reveal.n || c.skip || c.lat == null) continue;
        if (role === 'hider') {
          if (u === S.uid && c.mis && S.misMarker && S.misMarker.n === c.n) mp.circle('rv-me', c.lat, c.lng, c.r, OLD_REVEAL_STYLE, '<div class="circle-label">Where they\'ll look</div>');
          else if (u === S.uid && S.toldReveal === c.n) mp.circle('rv-me', c.lat, c.lng, c.r, REVEAL_STYLE, '<div class="circle-label">Hunters see this</div>');
          continue;
        }
        if (seen.some((x) => distM(x, c) < 12)) continue;
        seen.push(c);
        const age = Math.round((t - c.t) / 60000);
        mp.circle('rv-' + u, c.lat, c.lng, c.r, REVEAL_STYLE, `<div class="circle-label">${age >= 1 ? `${age} min ago` : 'Revealed'}</div>`);
      }
    }
    // Missions.
    const mi = S.mission;
    if (mi && !mi.done && !mi.fail) {
      for (const c of ['a', 'b']) {
        const held = Object.values(S.mhold).some((h) => h.w === mi.id && h.c === c);
        mp.circle('mi-' + c, mi[c].lat, mi[c].lng, mi.r, held ? MISSION_HELD_STYLE : MISSION_STYLE, `<div class="circle-label mission">${held ? 'Being held' : 'Mission'}</div>`);
      }
    }
    // Supply caches I haven't collected.
    for (const [id, c] of Object.entries(S.caches)) {
      if (S.bag[id]) continue;
      const near = S.fix && distM(S.fix, c) < 80;
      mp.pin('d-' + id, c.lat, c.lng, `<div class="pin drop${near ? ' near' : ''}"><span class="drop-gem"></span>${near ? `<span class="pin-label">${distLabel(c)}</span>` : ''}</div>`, 1);
    }
    // Burned spots (hider) and my scans.
    if (role === 'hider') S.move.burned.forEach((b, i) => mp.circle('burn-' + i, b.lat, b.lng, s.burnM, BURN_STYLE, '<div class="circle-label burn">Burned</div>'));
    for (const [id, sc] of Object.entries(S.scan)) {
      if (sc.by === S.uid && t - sc.t < 120000) mp.circle('sc-' + id, sc.lat, sc.lng, sc.r, SCAN_STYLE);
    }
    // Freeze range preview for hunters while a freeze is happening.
    const f = S.freeze;
    if (role === 'seeker' && f && t < f.t + s.coverSecs * 1000) {
      for (const u of hunters()) {
        const l = u === S.uid ? S.fix : S.locs[u];
        if (l) mp.circle('fr-' + u, l.lat, l.lng, s.freezeM, FREEZE_STYLE);
      }
    }
  }
  drawMe(mp);
  mp.end();
  if (S.follow && S.fix && S.fix.at !== S.followedAt) { S.followedAt = S.fix.at; mp.setView(S.fix.lat, S.fix.lng, null, true); }
}

export function canListen(u) {
  if (u === S.uid || !S.players[u]) return false;
  const ph = phase();
  if (ph === 'lobby' || ph === 'ended') return true;
  const me = myRole(), them = roleOf(u);
  const t = now();
  const flare = S.flare && t >= S.flare.t + FLARE_DELAY_MS && t < S.flare.t + FLARE_DELAY_MS + FLARE_SHOW_MS && !(S.snap && S.snap[u] && S.snap[u].t === S.flare.t);
  if (them === 'seeker') return me === 'seeker' || ph === 'hiding' || (me === 'hider' && fxActive(S.uid, 'spy')) || flare;
  return them === 'hider' && me === 'hider';
}

export { askElimination };
