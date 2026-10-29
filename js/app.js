import { connect, isConfigured, isDenied } from './fb.js?v=mvu1ybvp';
import { GameMap, loadEngine, MAP_STYLES } from './map.js?v=mvu1ybvp';
import { distM, mPerDegLon, randomPointNear, watchLocation, WakeLock, iosWakeLockBroken, vibrate, GpsFilter, nudgeLocation } from './geo.js?v=mvu1ybvp';

/* ------------------------------------------------------------------ constants */

const COLOURS = [
  '#E53935', '#FF7043', '#FB8C00', '#F9A825', '#C0CA33', '#43A047', '#00897B', '#00ACC1', '#039BE5',
  '#3949AB', '#5E35B1', '#8E24AA', '#D81B60', '#F06292', '#6D4C41', '#546E7A', '#212121', '#9E9E9E',
];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DEFAULTS = { hideSecs: 120, gameMins: 30, tagRadius: 10, revealCooldownSecs: 180, revealRadius: 100, darkSecs: 60, hidersSeeSeekers: false, powerups: 4 };
const AREA_RADII = [150, 250, 400, 600, 1000, 1500];
const MAX_ACC = 30;              // must match tools/build-rules.mjs
const REVEAL_ANSWER_MS = 20000;  // must match tools/build-rules.mjs
const SEND_EVERY = 2500;         // min gap between location uploads
const HEARTBEAT = 4000;          // re-send last fix so we stay "live" while standing still
const POLL_EVERY = 4000;         // seekers check for exposed hiders

const SETTING_DEFS = [
  { k: 'hideSecs', label: 'Head start', opts: [60, 120, 180, 300, 600], fmt: (v) => v / 60 + ' min', note: 'Seekers wait while hiders hide' },
  { k: 'gameMins', label: 'Hunt length', opts: [10, 20, 30, 45, 60, 90], fmt: (v) => v + ' min' },
  { k: 'tagRadius', label: 'Catch distance', opts: [5, 8, 10, 15], fmt: (v) => v + ' m', note: 'How close the seeker must be, by GPS' },
  { k: 'revealCooldownSecs', label: 'Reveal every', opts: [120, 180, 300, 480], fmt: (v) => v / 60 + ' min', note: 'Shared by all seekers' },
  { k: 'revealRadius', label: 'Reveal circle', opts: [50, 100, 150, 250], fmt: (v) => v + ' m', note: 'The hider is somewhere inside' },
  { k: 'darkSecs', label: 'Exposed when offline for', opts: [30, 60, 120], fmt: (v) => v + ' s', note: 'Locking your phone shows your last spot' },
  { k: 'hidersSeeSeekers', label: 'Hiders see seekers', opts: [false, true], fmt: (v) => (v ? 'Always' : 'Head start only') },
  { k: 'powerups', label: 'Power-ups', opts: [0, 4, 8, 12], fmt: (v) => (v ? v + ' drops' : 'Off'), note: 'Supply drops to collect on the map' },
];

// Power-ups. Durations must match tools/build-rules.mjs.
const POWERS = {
  lookout: { team: 'hider', name: 'Lookout', icon: '👁️', ms: 20000, desc: 'See every seeker on your map for 20 seconds.' },
  shield: { team: 'hider', name: 'Shield', icon: '🛡️', ms: 30000, desc: 'You can\'t be caught for 30 seconds. Save it for when a seeker is closing in.' },
  cloak: { team: 'hider', name: 'Cloak', icon: '🌫️', ms: 180000, desc: 'For the next 3 minutes you don\'t show up in reveals, and missing one won\'t expose you.' },
  reveal: { team: 'seeker', name: 'Extra reveal', icon: '📡', ms: 0, desc: 'Reveal every hider right now, even if reveals are on cooldown.' },
  tracker: { team: 'seeker', name: 'Tracker', icon: '🎯', ms: 15000, desc: 'Pick a hider and see exactly where they are for 15 seconds.' },
  freeze: { team: 'seeker', name: 'Freeze', icon: '❄️', ms: 20000, desc: 'Hiders within 75 m of you must freeze for 20 seconds, and every seeker can see them.' },
};
const HIDER_POWERS = ['lookout', 'shield', 'cloak'];
const SEEKER_POWERS = ['reveal', 'tracker', 'freeze'];
const FREEZE_M = 75;
const PICKUP_M = 12;   // rules allow 15 m; pick up a little inside that
const BAG_MAX = 3;
const RESPAWN_MS = 120000;

/* ------------------------------------------------------------------ helpers */

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initial = (name) => esc(String(name || '?').trim().charAt(0).toUpperCase() || '?');
const r6 = (x) => Math.round(x * 1e6) / 1e6;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function setHTML(el, html) { if (el && el._html !== html) { el._html = html; el.innerHTML = html; } }
function fmtClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
function store(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

/* ------------------------------------------------------------------ state */

const S = {
  db: null, uid: null, code: null,
  meta: null, players: {}, caught: {}, reveal: null, circles: {},
  locs: {}, locSubs: {}, locFail: {}, exposed: {},
  subs: [], fix: null, gpsErr: null, stopGps: null,
  lastSent: 0, lastPoll: 0, answering: null, answerFail: 0,
  seenCaught: null, seenReveal: null, lastPhase: null, hiddenAt: null,
  maps: {}, tick: null, renderQueued: false, threeD: false, follow: false, engine: 'leaflet', endSent: false,
  drops: {}, fx: {}, freeze: null, pickTried: {}, lastSpawn: 0, seenFreeze: null, seenFx: null,
  mapStyle: load('mapStyle') || 'light',
};
const wake = new WakeLock(() => scheduleRender());
S.filter = new GpsFilter();

const path = (p) => `games/${S.code}/${p}`;
const settings = () => Object.assign({}, DEFAULTS, (S.meta && S.meta.settings) || {});
const huntStart = () => S.meta.startAt + settings().hideSecs * 1000;
const huntEnd = () => huntStart() + settings().gameMins * 60000;
const isHost = () => !!S.meta && S.meta.host === S.uid;
const name = (u) => (S.players[u] ? S.players[u].name : 'Someone');
const roleOf = (u) => { const p = S.players[u]; if (!p) return null; return p.role === 'seeker' || S.caught[u] ? 'seeker' : 'hider'; };
const myRole = () => roleOf(S.uid);
const startingHiders = () => Object.keys(S.players).filter((u) => S.players[u].role === 'hider');
const activeHiders = () => startingHiders().filter((u) => !S.caught[u]);
const area = () => S.meta && S.meta.area;
const fxOf = (u, k) => (S.fx[u] && S.fx[u][k]) || null;
const fxLeft = (u, k) => { const f = fxOf(u, k); return f ? Math.max(0, f.t + POWERS[k].ms - S.db.now()) : 0; };
const fxActive = (u, k) => fxLeft(u, k) > 0;
const freezeLeft = () => (S.freeze ? Math.max(0, S.freeze.t + POWERS.freeze.ms - S.db.now()) : 0);
const frozenAt = (loc) => !!loc && freezeLeft() > 0 && distM(loc, S.freeze) <= FREEZE_M;
const cloakedFor = (u, rv) => { const c = fxOf(u, 'cloak'); return !!(c && rv && c.t > rv.t - POWERS.cloak.ms); };
const powerOf = (d) => (d.c && d.c.as === 'hider' ? d.h : d.s);
function myBag() {
  return Object.entries(S.drops)
    .filter(([, d]) => d.c && d.c.by === S.uid && !d.u)
    .map(([id, d]) => ({ id, kind: powerOf(d), usable: d.c.as === myRole() }));
}
const takenColours = () => {
  const out = {};
  for (const [u, p] of Object.entries(S.players)) if (u !== S.uid) out[p.color] = p.name;
  return out;
};
const outside = (loc) => { const a = area(); return !!(a && loc && distM(loc, a, a.mlon) > a.r); };

function phase() {
  const m = S.meta;
  if (!m) return 'none';
  if (m.status === 'lobby' || !m.startAt) return 'lobby';
  if (m.status === 'ended') return 'ended';
  const now = S.db.now();
  if (now < huntStart()) return 'hiding';
  if (now < huntEnd() && activeHiders().length > 0) return 'hunt';
  return 'ended';
}

/* ------------------------------------------------------------------ boot */

async function boot() {
  const msg = $('.boot-msg');
  if (!isConfigured()) {
    msg.innerHTML = 'This copy of Manhunt isn\'t connected to a database yet. Add your Firebase settings to <code>js/config.js</code>.';
    return;
  }
  try {
    const [db, engine] = await Promise.all([connect(), loadEngine()]);
    S.db = db;
    S.engine = engine;
    S.uid = S.db.uid;
  } catch (e) {
    console.error(e);
    msg.textContent = 'Couldn\'t reach the game server. Check your connection and reload.';
    return;
  }
  setupHome();
  document.addEventListener('click', onClick);
  document.addEventListener('visibilitychange', onVisibility);
  $('#boot').hidden = true;

  const saved = load('game');
  if (saved) {
    try {
      const me = await S.db.get(`games/${saved}/players/${S.uid}`);
      if (me) return enterGame(saved);
    } catch (e) { /* fall through */ }
    store('game', null);
  }
  show('home');
}

function show(screen) {
  for (const id of ['home', 'lobby', 'game', 'end']) $('#' + id).hidden = id !== screen;
  if (S.screen !== screen) {
    S.screen = screen;
    window.scrollTo(0, 0);
    if (screen === 'game') wake.enable(); else wake.disable();
    setTimeout(() => Object.values(S.maps).forEach((m) => m.resize()), 50);
  }
}

/* ------------------------------------------------------------------ home */

function setupHome() {
  const nameEl = $('#name');
  nameEl.value = load('name') || '';
  let colour = load('colour') || COLOURS[Math.floor(Math.random() * COLOURS.length)];
  const renderColours = () => {
    $('#colours').innerHTML = COLOURS.map((c) => `<button class="colour" role="radio" aria-checked="${c === colour}" aria-label="Colour ${c}" data-colour="${c}" style="background:${c}"></button>`).join('');
  };
  renderColours();
  $('#colours').addEventListener('click', (e) => {
    const b = e.target.closest('[data-colour]');
    if (b) { colour = b.dataset.colour; store('colour', colour); renderColours(); }
  });
  const me = () => {
    const n = nameEl.value.trim();
    if (!n) { homeError('Add your name first.'); nameEl.focus(); return null; }
    store('name', n);
    store('colour', colour);
    return { name: n.slice(0, 20), color: colour };
  };
  $('#create').addEventListener('click', async () => {
    const p = me(); if (!p) return;
    busy($('#create'), true);
    try { await createGame(p); } catch (e) { console.error(e); homeError('Couldn\'t create the game. Try again.'); }
    busy($('#create'), false);
  });
  $('#join-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const p = me(); if (!p) return;
    const code = $('#code').value.trim().toUpperCase();
    if (!/^[A-Z2-9]{5}$/.test(code)) { homeError('Codes are 5 letters and numbers.'); return; }
    busy($('#join-form button'), true);
    try { await joinGame(code, p); } catch (err) { console.error(err); homeError('Couldn\'t join. Check the code and try again.'); }
    busy($('#join-form button'), false);
  });
  const params = new URLSearchParams(location.search);
  if (params.get('code')) $('#code').value = params.get('code').toUpperCase();
}
function homeError(t) { $('#home-error').textContent = t; }
function busy(btn, on) { btn.disabled = on; }

async function createGame(p) {
  for (let attempt = 0; attempt < 5; attempt++) {
    let code = '';
    for (let i = 0; i < 5; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    try {
      await S.db.set(`games/${code}/meta`, { host: S.uid, status: 'lobby', settings: DEFAULTS, createdAt: S.db.TS });
    } catch (e) {
      if (isDenied(e)) continue; // code taken
      throw e;
    }
    await S.db.set(`games/${code}/players/${S.uid}`, { name: p.name, color: p.color, role: 'hider', joinedAt: S.db.TS });
    return enterGame(code);
  }
  throw new Error('no free code');
}

async function joinGame(code, p) {
  homeError('');
  const meta = await S.db.get(`games/${code}/meta`);
  if (!meta) { homeError(`There's no game with code ${code}.`); return; }
  const already = await S.db.get(`games/${code}/players/${S.uid}`);
  if (!already) {
    if (meta.status !== 'lobby') { homeError('That game has already started. Ask the organiser to take everyone back to the lobby.'); return; }
    const others = Object.values((await S.db.get(`games/${code}/players`)) || {});
    const used = new Set(others.map((o) => o.color));
    let color = p.color;
    if (used.has(color)) {
      color = COLOURS.find((c) => !used.has(c)) || color;
      store('colour', color);
      setTimeout(() => toast('Someone already had your colour, so you\'ve got a new one. Tap your name to change it.', 'warn', 6000), 800);
    }
    await S.db.set(`games/${code}/players/${S.uid}`, { name: p.name, color, role: 'hider', joinedAt: S.db.TS });
  }
  return enterGame(code);
}

/* ------------------------------------------------------------------ game session */

function enterGame(code) {
  S.code = code;
  store('game', code);
  history.replaceState(null, '', location.pathname);
  const on = (p, cb) => S.subs.push(S.db.on(path(p), cb, (e) => console.warn('listen failed', p, e)));
  on('meta', (v) => {
    if (!v) { toast('That game was closed.', 'bad'); leaveGame(true); return; }
    S.meta = v; scheduleRender();
  });
  on('players', (v) => {
    S.players = v || {};
    if (S.meta && !S.players[S.uid] && S.code) { toast('You were removed from the game.', 'bad'); leaveGame(true); return; }
    scheduleRender();
  });
  on('caught', (v) => { S.caught = v || {}; onCaughtChange(); scheduleRender(); });
  on('reveal', (v) => { S.reveal = v; onRevealChange(); scheduleRender(); });
  on('circles', (v) => { S.circles = v || {}; scheduleRender(); });
  on('drops', (v) => { S.drops = v || {}; scheduleRender(); });
  on('fx', (v) => { S.fx = v || {}; onFxChange(); scheduleRender(); });
  on('freeze', (v) => { S.freeze = v; onFreezeChange(); scheduleRender(); });

  S.filter.reset();
  S.stopGps = watchLocation(
    (f) => onRawFix(f),
    (e) => { S.gpsErr = e; scheduleRender(); },
  );
  S.tick = setInterval(tick, 1000);
  $('#code-big').textContent = code;
}

function leaveGame(silent) {
  const code = S.code;
  if (!silent && code && S.meta && S.meta.status === 'lobby') S.db.remove(`games/${code}/players/${S.uid}`).catch(() => {});
  S.subs.forEach((u) => u()); S.subs = [];
  Object.values(S.locSubs).forEach((u) => u()); S.locSubs = {};
  if (S.stopGps) S.stopGps();
  clearInterval(S.tick);
  Object.values(S.maps).forEach((m) => m.remove()); S.maps = {};
  Object.assign(S, { code: null, meta: null, players: {}, caught: {}, reveal: null, circles: {}, locs: {}, locFail: {}, exposed: {}, seenCaught: null, seenReveal: null, lastPhase: null, answering: null, endSent: false, drops: {}, fx: {}, freeze: null, pickTried: {}, seenFreeze: null, seenFx: null });
  store('game', null);
  show('home');
}

function onRawFix(f) {
  S.rawAt = Date.now();
  S.rawFix = f;
  S.fix = S.filter.push(f);
  S.gpsErr = null;
  sendLocation(false);
  scheduleRender();
}

function tick() {
  if (!S.code || !S.meta) return;
  const ph = phase();
  // iPhones can stop sending updates while you stand still; ask for a fresh fix so you don't look offline.
  if (Date.now() - (S.rawAt || 0) > 12000 && Date.now() - (S.nudgedAt || 0) > 12000) { S.nudgedAt = Date.now(); nudgeLocation(onRawFix); }
  if (Date.now() - S.lastSent > HEARTBEAT) sendLocation(true);
  reconcileLocListeners();
  if (ph === 'hunt' && myRole() === 'seeker' && Date.now() - S.lastPoll > POLL_EVERY) pollExposed();
  if (ph === 'hunt' && myRole() === 'hider') answerReveal();
  if (ph === 'hunt') autoPickup();
  if (ph === 'hunt' && isHost()) respawnDrops();
  if (ph === 'ended' && isHost() && S.meta.status === 'live' && !S.endSent) {
    S.endSent = true;
    S.db.update(path('meta'), { status: 'ended', endedAt: S.db.TS }).catch(() => { S.endSent = false; });
  }
  if (S.lastPhase && S.lastPhase !== ph) onPhaseChange(S.lastPhase, ph);
  S.lastPhase = ph;
  scheduleRender();
}

function onPhaseChange(from, to) {
  if (to === 'hunt') { toast('The hunt is on.', myRole() === 'seeker' ? 'seeker' : 'hider'); vibrate([300, 120, 300]); }
  if (to === 'hiding') vibrate(200);
  if (to === 'ended') vibrate([200, 100, 200, 100, 400]);
  if (to === 'lobby') { S.endSent = false; S.answering = null; S.exposed = {}; S.seenCaught = null; S.seenReveal = null; S.pickTried = {}; S.seenFreeze = null; S.seenFx = null; }
  if (to === 'hunt') S.lastSpawn = Date.now();
}

function onVisibility() {
  if (document.visibilityState === 'hidden') { S.hiddenAt = Date.now(); return; }
  const away = S.hiddenAt ? Date.now() - S.hiddenAt : 0;
  S.hiddenAt = null;
  if (!S.code || !S.meta) return;
  sendLocation(true);
  if (phase() === 'hunt' && myRole() === 'hider' && away > settings().darkSecs * 1000) {
    toast(`You were away for ${Math.round(away / 1000)} s, so seekers could see where you were.`, 'warn', 6000);
  }
}

/* ------------------------------------------------------------------ location */

// `precise`: send the latest raw GPS fix rather than the smoothed one (used for catches and
// pick-ups, where being current matters more than being steady).
async function sendLocation(force, precise) {
  const f = precise && S.rawFix && Date.now() - S.rawFix.at < 5000 ? S.rawFix : S.fix;
  if (!f || !S.code || !S.meta) return;
  if (S.meta.status === 'ended') return;
  if (!force && Date.now() - S.lastSent < SEND_EVERY) return;
  S.lastSent = Date.now();
  try {
    await S.db.set(path('locs/' + S.uid), { lat: r6(f.lat), lng: r6(f.lng), acc: Math.min(f.acc, 99999), t: S.db.TS });
  } catch (e) { console.warn('location upload failed', e); }
}

// Wait (up to `timeout`) for a GPS fix newer than `maxAge`.
async function freshFix(maxAge, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (S.fix && Date.now() - S.fix.at <= maxAge) return S.fix;
    await wait(250);
  }
  return S.fix;
}

function canListen(u) {
  if (u === S.uid || !S.players[u]) return false;
  const ph = phase();
  if (ph === 'lobby' || ph === 'ended') return true;
  const me = myRole(), them = roleOf(u);
  if (them === 'seeker') return me === 'seeker' || ph === 'hiding' || settings().hidersSeeSeekers === true || (me === 'hider' && fxActive(S.uid, 'lookout'));
  return them === 'hider' && me === 'hider';
}

function reconcileLocListeners() {
  const ids = new Set(Object.keys(S.players).concat(Object.keys(S.locSubs)));
  for (const u of ids) {
    const want = canListen(u);
    if (want && !S.locSubs[u] && !(Date.now() - (S.locFail[u] || 0) < 5000)) {
      S.locSubs[u] = S.db.on(path('locs/' + u), (v) => { S.locs[u] = v; scheduleRender(); }, () => {
        if (S.locSubs[u]) delete S.locSubs[u];
        S.locFail[u] = Date.now();
        delete S.locs[u];
      });
    } else if (!want && S.locSubs[u]) {
      S.locSubs[u]();
      delete S.locSubs[u];
      delete S.locs[u];
    }
  }
}

// Seekers can only read a hider's position when the server says they're exposed.
async function pollExposed() {
  S.lastPoll = Date.now();
  const found = {};
  await Promise.all(activeHiders().map(async (u) => {
    try { const v = await S.db.get(path('locs/' + u)); if (v) found[u] = v; } catch (e) { /* hidden: as it should be */ }
  }));
  const before = Object.keys(S.exposed).join();
  S.exposed = found;
  const newly = Object.keys(found).filter((u) => !before.split(',').includes(u));
  if (newly.length && phase() === 'hunt') {
    toast(`${newly.map(name).join(', ')} exposed: ${exposedReason(found[newly[0]], newly[0])}.`, 'warn');
    vibrate(150);
  }
  scheduleRender();
}

function exposedReason(loc, u) {
  const now = S.db.now();
  if (!loc) return 'position visible';
  const tr = fxOf(S.uid, 'tracker');
  if (tr && tr.target === u && fxActive(S.uid, 'tracker')) return `tracked, ${Math.ceil(fxLeft(S.uid, 'tracker') / 1000)} s`;
  if (frozenAt(loc)) return `frozen, ${Math.ceil(freezeLeft() / 1000)} s`;
  if (now - loc.t > settings().darkSecs * 1000) return `offline for ${Math.round((now - loc.t) / 1000)} s`;
  if (outside(loc)) return 'outside the play area';
  const c = S.circles[u];
  if (S.reveal && (!c || c.n !== S.reveal.n)) return 'didn\'t answer the reveal';
  return 'position visible';
}

/* ------------------------------------------------------------------ reveal / catch */

async function answerReveal() {
  const rv = S.reveal;
  if (!rv || phase() !== 'hunt' || myRole() !== 'hider') return;
  const mine = S.circles[S.uid];
  if (mine && mine.n === rv.n) return;
  if (cloakedFor(S.uid, rv)) return; // cloaked: don't show up in this reveal
  if (S.answering === rv.n) return;
  if (Date.now() - S.answerFail < 3000) return;
  S.answering = rv.n;
  try {
    const f = await freshFix(6000);
    if (!f) throw new Error('no gps');
    await sendLocation(true);
    const r = settings().revealRadius;
    const c = randomPointNear(f, r * 0.85);
    await S.db.set(path('circles/' + S.uid), { n: rv.n, lat: r6(c.lat), lng: r6(c.lng), r, t: S.db.TS });
  } catch (e) {
    console.warn('reveal answer failed', e);
    S.answering = null;
    S.answerFail = Date.now();
  }
}

function onRevealChange() {
  const n = S.reveal ? S.reveal.n : 0;
  if (S.seenReveal === null) { S.seenReveal = n; return; }
  if (n > S.seenReveal && phase() === 'hunt') {
    if (myRole() === 'hider') {
      if (cloakedFor(S.uid, S.reveal)) toast('Reveal! Your cloak kept you out of it.', 'hider', 5000);
      else { toast('Reveal! Seekers can see a circle you\'re somewhere inside.', 'bad', 5000); vibrate([400, 150, 400]); answerReveal(); }
    } else {
      const cloaked = activeHiders().filter((u) => cloakedFor(u, S.reveal));
      toast(`${name(S.reveal.by)} used ${S.reveal.boost ? 'an extra' : 'a'} reveal. Search the circles.${cloaked.length ? ` ${cloaked.map(name).join(', ')} ${cloaked.length === 1 ? 'is' : 'are'} cloaked.` : ''}`, 'seeker', 5000);
      vibrate(200);
    }
  }
  S.seenReveal = n;
}

function onCaughtChange() {
  const keys = Object.keys(S.caught);
  if (S.seenCaught === null) { S.seenCaught = keys; return; }
  const fresh = keys.filter((k) => !S.seenCaught.includes(k));
  S.seenCaught = keys;
  for (const h of fresh) {
    const c = S.caught[h];
    if (h === S.uid) {
      showHold(`<h2>You've been caught</h2><p>${c.how === 'self' ? 'You owned up.' : `${esc(name(c.by))} got you.`} You're a seeker now: go and help find the others.</p>`, 4500);
      vibrate([500, 200, 500]);
    } else {
      const how = c.how === 'host' ? ' (organiser override)' : c.how === 'self' ? ' (owned up)' : '';
      toast(c.how === 'self' ? `${name(h)} was caught${how}.` : `${name(c.by)} caught ${name(h)}${how}.`, 'seeker');
      vibrate(150);
    }
  }
}

async function tryCatch(u, how) {
  closeSheet();
  const r = settings().tagRadius;
  if (how === 'gps') {
    if (!S.fix) { toast('No GPS fix yet. Make sure location is allowed.', 'bad'); return; }
    if (S.fix.acc > MAX_ACC) { toast(`Your GPS is too rough (±${S.fix.acc} m). Step into the open and try again in a moment.`, 'bad', 6000); return; }
    toast('Checking distance…');
    await freshFix(4000, 5000);
    await sendLocation(true, true);
  }
  try {
    await S.db.set(path('caught/' + u), { by: S.uid, t: S.db.TS, how });
  } catch (e) {
    if (!isDenied(e)) { toast('Couldn\'t reach the server. Try again.', 'bad'); return; }
    if (S.caught[u]) toast(`${name(u)} has already been caught.`);
    else if (how === 'gps' && fxActive(u, 'shield')) toast(`${name(u)} has a shield for ${Math.ceil(fxLeft(u, 'shield') / 1000)} more seconds.`, 'bad', 5000);
    else if (how === 'gps') toast(`Not counted: ${name(u)} isn't within ${r} m of you by GPS. Both phones need the app open. Stay next to them a few seconds and try again.`, 'bad', 7000);
    else toast('Not allowed right now.', 'bad');
  }
}

async function triggerReveal() {
  const n = (S.reveal ? S.reveal.n : 0) + 1;
  try { await S.db.set(path('reveal'), { n, t: S.db.TS, by: S.uid }); }
  catch (e) { toast(isDenied(e) ? 'Reveal isn\'t ready yet.' : 'Couldn\'t reach the server.', 'bad'); }
}

function nextRevealAt() {
  const cd = settings().revealCooldownSecs * 1000;
  return S.reveal ? S.reveal.t + cd : huntStart() + cd;
}

/* ------------------------------------------------------------------ clicks */

async function onClick(e) {
  if (S.screen === 'game' && !wake.active) wake.enable();
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  const u = el.dataset.uid;
  switch (a) {
    case 'leave': return confirmSheet('Leave this game?', S.meta && S.meta.status === 'lobby' ? 'You can rejoin with the code while it\'s in the lobby.' : 'You won\'t be able to rejoin until the organiser takes everyone back to the lobby.', 'Leave', () => leaveGame(false));
    case 'share-code': return shareCode();
    case 'toggle-role':
      if (!isHost()) return;
      return S.db.set(path(`players/${u}/role`), S.players[u].role === 'seeker' ? 'hider' : 'seeker').catch(() => toast('Couldn\'t change teams.', 'bad'));
    case 'shuffle': return shuffleSeekers();
    case 'setting': {
      if (!isHost()) return;
      const k = el.dataset.k;
      const v = el.dataset.v === 'true' ? true : el.dataset.v === 'false' ? false : Number(el.dataset.v);
      return S.db.set(path('meta/settings/' + k), v).catch(() => toast('Couldn\'t save that setting.', 'bad'));
    }
    case 'area-radius': {
      if (!isHost()) return;
      const a2 = area() || (S.fix && { lat: S.fix.lat, lng: S.fix.lng, mlon: mPerDegLon(S.fix.lat) });
      if (!a2) return toast('Waiting for GPS. Or tap the map to place the play area.', 'warn');
      return setArea(a2.lat, a2.lng, Number(el.dataset.v));
    }
    case 'area-here':
      if (!S.fix) return toast('Waiting for GPS…', 'warn');
      return setArea(S.fix.lat, S.fix.lng, (area() && area().r) || 400);
    case 'start': return startGame();
    case 'catch-menu': return catchMenu();
    case 'catch': return tryCatch(u, el.dataset.how);
    case 'override-menu': return catchMenu(true);
    case 'reveal': return triggerReveal();
    case 'self-caught': return confirmSheet('Were you caught?', 'Only use this if a seeker tagged you and their Catch button didn\'t work. You\'ll join the seekers.', 'Yes, I was caught', () => tryCatch(S.uid, 'self'));
    case 'end-now': return confirmSheet('End the game now?', 'Everyone goes to the results screen.', 'End game', () => S.db.update(path('meta'), { status: 'ended', endedAt: S.db.TS }));
    case 'recentre': return recentre();
    case 'map-style': return mapStyleSheet();
    case 'set-map-style': return setMapStyle(el.dataset.v);
    case 'three-d': return toggle3D();
    case 'profile': return profileSheet();
    case 'power': return powerSheet(el.dataset.id);
    case 'use-power': return usePower(el.dataset.id, u);
    case 'gps-help': return gpsHelp();
    case 'again': return backToLobby();
    case 'close-sheet': return closeSheet();
    case 'wake': return wake.enable();
    default: return undefined;
  }
}

async function shareCode() {
  const url = `${location.origin}${location.pathname}?code=${S.code}`;
  const text = `Join my Manhunt game: code ${S.code}`;
  try {
    if (navigator.share) await navigator.share({ title: 'Manhunt', text, url });
    else { await navigator.clipboard.writeText(`${text} ${url}`); toast('Invite link copied.'); }
  } catch (e) { /* cancelled */ }
}

function shuffleSeekers() {
  const ids = Object.keys(S.players);
  if (ids.length < 2) return toast('Need at least 2 players.', 'warn');
  const pick = ids[Math.floor(Math.random() * ids.length)];
  const upd = {};
  ids.forEach((u) => { upd[`${u}/role`] = u === pick ? 'seeker' : 'hider'; });
  S.db.update(path('players'), upd).then(() => toast(`${name(pick)} is the seeker.`, 'seeker')).catch(() => toast('Couldn\'t shuffle teams.', 'bad'));
}

function setArea(lat, lng, r) {
  return S.db.set(path('meta/area'), { lat: r6(lat), lng: r6(lng), r, mlon: Math.round(mPerDegLon(lat) * 100) / 100 }).catch(() => toast('Couldn\'t save the play area.', 'bad'));
}

async function startGame() {
  const seekers = Object.keys(S.players).filter((u) => S.players[u].role === 'seeker');
  if (!area()) return toast('Set the play area first.', 'warn');
  if (!seekers.length) return toast('Pick at least one seeker.', 'warn');
  if (seekers.length === Object.keys(S.players).length) return toast('Someone has to hide.', 'warn');
  const upd = { 'meta/status': 'live', 'meta/startAt': S.db.TS };
  Object.assign(upd, makeDrops(settings().powerups));
  try { await S.db.update(`games/${S.code}`, upd); }
  catch (e) { toast('Couldn\'t start the game.', 'bad'); }
}

async function backToLobby() {
  try {
    if (S.meta.status === 'live') await S.db.update(path('meta'), { status: 'ended', endedAt: S.db.TS });
    await S.db.update(`games/${S.code}`, { caught: null, circles: null, reveal: null, drops: null, fx: null, freeze: null, 'meta/status': 'lobby' });
  }
  catch (e) { toast('Couldn\'t reset the game.', 'bad'); }
}

/* ------------------------------------------------------------------ power-ups */

function makeDrops(n) {
  const a = area();
  const out = {};
  if (!a || !n) return out;
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  for (let i = 0; i < n; i++) {
    let id = '';
    for (let j = 0; j < 8; j++) id += 'abcdefghijkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 32)];
    const p = randomPointNear(a, a.r * 0.85);
    out['drops/' + id] = { lat: r6(p.lat), lng: r6(p.lng), h: pick(HIDER_POWERS), s: pick(SEEKER_POWERS) };
  }
  return out;
}

// The organiser's phone tops up supply drops as they get collected.
function respawnDrops() {
  const want = settings().powerups;
  if (!want || Date.now() - S.lastSpawn < RESPAWN_MS) return;
  const left = Object.values(S.drops).filter((d) => !d.c).length;
  S.lastSpawn = Date.now();
  if (left >= want) return;
  S.db.update(`games/${S.code}`, makeDrops(1)).catch(() => {});
}

async function autoPickup() {
  if (!S.fix || S.fix.acc > MAX_ACC || S.picking) return;
  const near = Object.entries(S.drops).find(([id, d]) => !d.c && distM(S.fix, d) <= PICKUP_M && Date.now() - (S.pickTried[id] || 0) > 6000);
  if (!near) return;
  if (myBag().length >= BAG_MAX) {
    if (Date.now() - (S.bagFullAt || 0) > 30000) { S.bagFullAt = Date.now(); toast(`Your bag is full (${BAG_MAX}). Use a power-up to pick up more.`, 'warn'); }
    return;
  }
  const [id, d] = near;
  S.pickTried[id] = Date.now();
  S.picking = true;
  try {
    await sendLocation(true, true);
    const as = myRole();
    await S.db.set(path(`drops/${id}/c`), { by: S.uid, as, t: S.db.TS });
    const k = as === 'hider' ? d.h : d.s;
    toast(`Picked up ${POWERS[k].icon} ${POWERS[k].name}. Tap it below to use it.`, as, 5000);
    vibrate([80, 60, 80]);
  } catch (e) { /* someone beat us to it, or GPS disagreed */ }
  S.picking = false;
}

function powerSheet(id) {
  const d = S.drops[id];
  if (!d || !d.c) return;
  const k = powerOf(d), P = POWERS[k];
  if (d.c.as !== myRole()) {
    openSheet(`<h2>${P.icon} ${esc(P.name)}</h2><p>This was a ${d.c.as} power-up, so you can't use it now you're a ${myRole()}.</p><div class="pick"><button class="btn btn-quiet" data-action="close-sheet">Close</button></div>`);
    return;
  }
  const body = k === 'tracker'
    ? `<p>${esc(P.desc)}</p><div class="pick">${activeHiders().map((u) => `<button class="btn btn-hider" data-action="use-power" data-id="${esc(id)}" data-uid="${esc(u)}"><span class="player-dot" style="background:${esc(S.players[u].color)}">${initial(name(u))}</span>Track ${esc(name(u))}</button>`).join('') || '<p>No hiders left.</p>'}<button class="btn btn-quiet" data-action="close-sheet">Not now</button></div>`
    : `<p>${esc(P.desc)}</p><div class="pick"><button class="btn ${P.team === 'hider' ? 'btn-hider' : 'btn-primary'}" data-action="use-power" data-id="${esc(id)}">Use ${esc(P.name)}</button><button class="btn btn-quiet" data-action="close-sheet">Not now</button></div>`;
  openSheet(`<h2>${P.icon} ${esc(P.name)}</h2>${body}`);
}

async function usePower(id, target) {
  closeSheet();
  const d = S.drops[id];
  if (!d || !d.c || d.u) return;
  const k = powerOf(d);
  if (phase() !== 'hunt') { toast('Power-ups work once the hunt has started.', 'warn'); return; }
  if (k === 'reveal' && S.reveal && S.db.now() - S.reveal.t < 3000) { toast('A reveal just happened. Try again in a moment.', 'warn'); return; }
  const upd = { [`drops/${id}/u`]: S.db.TS };
  if (k === 'reveal') upd.reveal = { n: (S.reveal ? S.reveal.n : 0) + 1, t: S.db.TS, by: S.uid, boost: id };
  else if (k === 'freeze') {
    await freshFix(4000, 5000);
    const f = S.rawFix && Date.now() - S.rawFix.at < 5000 ? S.rawFix : S.fix;
    if (!f) { toast('Waiting for GPS…', 'warn'); return; }
    await sendLocation(true, true);
    upd.freeze = { lat: r6(f.lat), lng: r6(f.lng), t: S.db.TS, by: S.uid, drop: id };
  } else {
    upd[`fx/${S.uid}/${k}`] = Object.assign({ t: S.db.TS, drop: id }, k === 'tracker' ? { target } : {});
  }
  try {
    await S.db.update(`games/${S.code}`, upd);
    vibrate(120);
    if (k === 'tracker' || k === 'freeze') S.lastPoll = 0;
    if (k === 'lookout') reconcileLocListeners();
  } catch (e) {
    toast(isDenied(e) ? `Couldn't use ${POWERS[k].name} right now.` : 'Couldn\'t reach the server.', 'bad');
  }
}

function onFxChange() {
  // Tell players about their own effects switching on.
  const mine = S.fx[S.uid] || {};
  const sig = Object.entries(mine).map(([k, f]) => k + f.t).join();
  if (S.seenFx !== null && sig !== S.seenFx) {
    for (const [k, f] of Object.entries(mine)) {
      if (!S.seenFx.includes(k + f.t) && S.db.now() - f.t < 10000) {
        const P = POWERS[k];
        toast(k === 'tracker' ? `${P.icon} Tracking ${name(f.target)} for 15 s` : `${P.icon} ${P.name} on`, P.team);
      }
    }
  }
  S.seenFx = sig;
}

function onFreezeChange() {
  const t = S.freeze ? S.freeze.t : 0;
  if (S.seenFreeze === null) { S.seenFreeze = t; return; }
  if (t > S.seenFreeze && phase() === 'hunt') {
    if (myRole() === 'hider' && frozenAt(S.fix)) { vibrate([600, 200, 600]); }
    else if (myRole() === 'hider') toast(`${name(S.freeze.by)} used Freeze, but you were out of range.`, 'hider');
    else { toast(`${name(S.freeze.by)} used Freeze: hiders within ${FREEZE_M} m are frozen and visible for 20 s.`, 'seeker', 5000); S.lastPoll = 0; }
  }
  S.seenFreeze = t;
}

function powersHTML() {
  const me = S.uid;
  const chips = [];
  for (const k of ['lookout', 'shield', 'cloak', 'tracker']) {
    if (!fxActive(me, k)) continue;
    const left = fxLeft(me, k);
    const label = k === 'cloak' ? `${Math.ceil(left / 60000)} min` : `${Math.ceil(left / 1000)} s`;
    chips.push(`<span class="fx-chip ${POWERS[k].team}">${POWERS[k].icon} ${esc(POWERS[k].name)}${k === 'tracker' ? ': ' + esc(name(fxOf(me, k).target)) : ''} · ${label}</span>`);
  }
  const bag = myBag().map((b) => `<button class="power ${b.usable ? POWERS[b.kind].team : 'dead'}" data-action="power" data-id="${esc(b.id)}" aria-label="${esc(POWERS[b.kind].name)}"><span>${POWERS[b.kind].icon}</span>${esc(POWERS[b.kind].name)}</button>`);
  return chips.concat(bag).join('');
}

/* ------------------------------------------------------------------ profile + map style */

function profileSheet() {
  const me = S.players[S.uid] || {};
  let colour = me.color;
  const taken = takenColours();
  const grid = () => COLOURS.map((c) => {
    const who = taken[c];
    return `<button class="colour" role="radio" aria-checked="${c === colour}" data-pc="${c}" style="background:${c}" ${who ? `disabled aria-label="Taken by ${esc(who)}"` : `aria-label="Colour ${c}"`}>${who ? initial(who) : ''}</button>`;
  }).join('');
  openSheet(`<h2>Your profile</h2>
    <label class="field"><span>Name</span><input id="pf-name" maxlength="20" value="${esc(me.name || '')}" autocomplete="nickname"></label>
    <div class="field"><span>Colour</span><div class="colours" id="pf-colours" role="radiogroup" aria-label="Colour">${grid()}</div>
    <p class="small muted">Colours with a letter are taken.</p></div>
    <div class="pick"><button class="btn btn-primary" id="pf-save">Save</button><button class="btn btn-quiet" data-action="close-sheet">Cancel</button></div>`);
  $('#pf-colours').onclick = (e) => {
    const b = e.target.closest('[data-pc]');
    if (!b || b.disabled) return;
    colour = b.dataset.pc;
    $('#pf-colours').innerHTML = grid();
  };
  $('#pf-save').onclick = async () => {
    const n = $('#pf-name').value.trim().slice(0, 20);
    if (!n) { $('#pf-name').focus(); return; }
    if (takenColours()[colour]) { toast('Someone just took that colour. Pick another.', 'warn'); return; }
    try {
      await S.db.update(path('players/' + S.uid), { name: n, color: colour });
      store('name', n); store('colour', colour);
      closeSheet();
    } catch (e) { toast('Couldn\'t save your profile.', 'bad'); }
  };
}

function mapStyleSheet() {
  openSheet(`<h2>Map style</h2><div class="pick">${MAP_STYLES.map((m) =>
    `<button class="btn ${m.id === S.mapStyle ? 'btn-ink' : 'btn-quiet'}" data-action="set-map-style" data-v="${m.id}">${m.label}</button>`).join('')}</div>`);
}
function setMapStyle(v) {
  closeSheet();
  S.mapStyle = v;
  store('mapStyle', v);
  Object.values(S.maps).forEach((m) => m.setStyle(v));
  updateTools();
}

/* ------------------------------------------------------------------ sheets, toasts, overlays */

function openSheet(html) {
  $('#sheet').innerHTML = html;
  $('#sheet').hidden = false;
  $('#sheet-scrim').hidden = false;
  $('#sheet-scrim').onclick = closeSheet;
}
function closeSheet() { $('#sheet').hidden = true; $('#sheet-scrim').hidden = true; }
function confirmSheet(title, body, okLabel, fn) {
  openSheet(`<h2>${esc(title)}</h2><p>${esc(body)}</p><div class="pick"><button class="btn btn-primary" id="sheet-ok">${esc(okLabel)}</button><button class="btn btn-quiet" data-action="close-sheet">Cancel</button></div>`);
  $('#sheet-ok').onclick = () => { closeSheet(); fn(); };
}
function catchMenu(override) {
  const hs = activeHiders();
  const r = settings().tagRadius;
  const list = hs.map((u) => `<button class="btn btn-hider" data-action="catch" data-how="${override ? 'host' : 'gps'}" data-uid="${esc(u)}"><span class="player-dot" style="background:${esc(S.players[u].color)}">${initial(name(u))}</span>${esc(name(u))}${fxActive(u, 'shield') ? ' <small>🛡️ shielded</small>' : ''}</button>`).join('');
  const gps = S.fix ? `Your GPS: ±${S.fix.acc} m${S.fix.acc > MAX_ACC ? ' (too rough to count)' : ''}.` : 'No GPS fix yet.';
  openSheet(override
    ? `<h2>Organiser override</h2><p>Marks a hider as caught without the GPS check. Everyone sees that you used it.</p><div class="pick">${list || '<p>No hiders left.</p>'}<button class="btn btn-quiet" data-action="close-sheet">Cancel</button></div>`
    : `<h2>Who did you catch?</h2><p>Tag them first. It only counts if your phones are within ${r} m by GPS. ${gps}</p><div class="pick">${list || '<p>No hiders left.</p>'}${isHost() ? '<button class="btn btn-quiet" data-action="override-menu">Organiser override</button>' : ''}<button class="btn btn-quiet" data-action="close-sheet">Cancel</button></div>`);
}
function toast(text, kind, ms) {
  const el = document.createElement('div');
  el.className = 'toast ' + (kind || '');
  el.textContent = text;
  $('#toasts').appendChild(el);
  while ($('#toasts').children.length > 3) $('#toasts').firstChild.remove();
  setTimeout(() => el.remove(), ms || 3800);
}
let holdTimer = null;
function showHold(html, ms) {
  const el = $('#hold');
  el.dataset.kind = 'event';
  el.innerHTML = `<div>${html}</div>`;
  el.hidden = false;
  clearTimeout(holdTimer);
  holdTimer = setTimeout(() => { el.hidden = true; el.dataset.kind = ''; scheduleRender(); }, ms);
}

/* ------------------------------------------------------------------ maps */

const AREA_STYLE = { color: '#FF5B14', weight: 3, dashed: true, fill: 0.04 };
const ACC_STYLE = { color: '#2D5BFF', weight: 1, lineOpacity: 0.45, fill: 0.1 };
const REVEAL_STYLE = { color: '#FF5B14', weight: 2, fill: 0.16 };
const FREEZE_STYLE = { color: '#2FA8E0', weight: 2, dashed: true, fill: 0.14 };

function getMap(key, elId) {
  if (!S.maps[key]) {
    const m = new GameMap($(elId), {
      engine: S.engine,
      style: S.mapStyle,
      onClick: (lat, lng) => { if (key === 'lobby' && isHost()) setArea(lat, lng, (area() && area().r) || 400); },
      onUserMove: () => { if (key === 'game') { S.follow = false; updateTools(); } },
    });
    m._fitted = false;
    S.maps[key] = m;
    fitOnce(m);
    updateTools();
  }
  return S.maps[key];
}
function pinHTML(cls, label, color, who) {
  return `<div class="pin ${cls}"><span class="pin-dot" style="background:${esc(color)}">${initial(who || label)}</span>${label ? `<span class="pin-label">${esc(label)}</span>` : ''}</div>`;
}
function fitOnce(map) {
  if (map._fitted) return;
  const a = area();
  if (a) { map.fitCircle(a.lat, a.lng, a.r); map._fitted = true; }
  else if (S.fix) { map.setView(S.fix.lat, S.fix.lng, 16); map._fitted = true; }
}
function drawArea(map) {
  const a = area();
  if (a) map.circle('area', a.lat, a.lng, a.r, AREA_STYLE);
}
function drawMe(map) {
  if (!S.fix) return;
  map.circle('me-acc', S.fix.lat, S.fix.lng, S.fix.acc, ACC_STYLE);
  const role = phase() === 'lobby' ? (S.players[S.uid] || {}).role : myRole();
  map.pin('me', S.fix.lat, S.fix.lng, `<div class="pin me ${role || 'hider'}"><span class="me-dot"></span></div>`, 1000);
}
function distLabel(l) {
  if (!S.fix || !l) return '';
  const d = distM(S.fix, l);
  return d >= 1000 ? `${(d / 1000).toFixed(1)} km` : `${Math.round(d)} m`;
}
function recentre() {
  const m = S.maps.game;
  if (!m || !S.fix) { toast('Waiting for GPS…', 'warn'); return; }
  S.follow = true;
  m.resetNorth();
  m.setView(S.fix.lat, S.fix.lng, Math.max(m.zoom(), 17.5), true);
  updateTools();
}
function toggle3D() {
  const m = S.maps.game;
  if (m) S.threeD = m.toggle3D();
  updateTools();
}
function updateTools() {
  const m = S.maps.game;
  const label = (MAP_STYLES.find((x) => x.id === S.mapStyle) || MAP_STYLES[0]).label;
  $('#lobby-style').textContent = `Map: ${label}`;
  $('#threed-btn').hidden = !(m && m.supports3D);
  $('#threed-btn').setAttribute('aria-pressed', String(!!S.threeD));
  $('#follow-btn').setAttribute('aria-pressed', String(!!S.follow));
}

/* ------------------------------------------------------------------ rendering */

function scheduleRender() {
  if (S.renderQueued) return;
  S.renderQueued = true;
  // setTimeout rather than requestAnimationFrame: rAF stops entirely in background/hidden views.
  setTimeout(() => { S.renderQueued = false; render(); }, 16);
}

function render() {
  if (!S.code || !S.meta || !S.db) return;
  document.body.classList.toggle('is-host', isHost());
  const ph = phase();
  if (ph === 'lobby') { show('lobby'); renderLobby(); }
  else if (ph === 'hiding' || ph === 'hunt') { show('game'); renderGame(ph); }
  else if (ph === 'ended') { show('end'); renderEnd(); }
}

function gpsLine() {
  if (S.gpsErr) return S.gpsErr.code === 1 ? 'Location is blocked' : 'No GPS signal. Move into the open.';
  if (!S.fix) return 'Waiting for GPS…';
  return `GPS ±${S.fix.acc} m${S.fix.acc > MAX_ACC ? ' (rough)' : ''}`;
}
function gpsHelp() {
  openSheet(`<h2>Allow location</h2>
    <p>The game needs your location to work. After changing the setting, reload the page.</p>
    <p><b>iPhone:</b> Settings → Privacy &amp; Security → Location Services → Safari Websites → While Using the App. Also make sure Precise Location is on.</p>
    <p><b>Android (Chrome):</b> tap the icon left of the address bar → Permissions → Location → Allow.</p>
    <div class="pick"><button class="btn btn-primary" id="sheet-ok">Reload</button><button class="btn btn-quiet" data-action="close-sheet">Close</button></div>`);
  $('#sheet-ok').onclick = () => location.reload();
}

function renderLobby() {
  const host = isHost();
  const ids = Object.keys(S.players).sort((a, b) => (S.players[a].joinedAt || 0) - (S.players[b].joinedAt || 0));
  const seekers = ids.filter((u) => S.players[u].role === 'seeker').length;
  $('#code-big').textContent = S.code;
  $('#host-name').textContent = name(S.meta.host);
  const me = S.players[S.uid] || {};
  setHTML($('#profile-btn'), `<span class="player-dot" style="background:${esc(me.color)}">${initial(me.name)}</span><span>${esc(me.name || 'You')}</span>`);
  $('#team-counts').textContent = `${seekers} seeker${seekers === 1 ? '' : 's'}, ${ids.length - seekers} hider${ids.length - seekers === 1 ? '' : 's'}`;
  $('#team-hint').textContent = host ? 'Tap a team to switch it.' : 'The organiser picks the teams.';
  const now = S.db.now();
  setHTML($('#player-list'), ids.map((u) => {
    const p = S.players[u];
    const loc = u === S.uid ? (S.fix && { t: now }) : S.locs[u];
    const gps = loc && now - loc.t < 15000 ? 'GPS ok' : 'no GPS yet';
    const tags = [u === S.uid ? 'you' : '', u === S.meta.host ? 'organiser' : '', gps].filter(Boolean).join(', ');
    return `<li class="player"><span class="player-dot" style="background:${esc(p.color)}">${initial(p.name)}</span>
      <span class="player-name">${esc(p.name)} <small>${tags}</small></span>
      <button class="role-chip ${p.role}" data-action="toggle-role" data-uid="${esc(u)}" ${host ? '' : 'tabindex="-1"'}>${p.role === 'seeker' ? 'Seeker' : 'Hider'}</button></li>`;
  }).join(''));

  const a = area();
  $('#area-size').textContent = a ? `${a.r} m radius` : 'Not set';
  $('#area-hint').textContent = host ? (a ? 'Tap the map to move the centre.' : 'Tap the map, or centre it on yourself.') : (a ? 'Set by the organiser. Stay inside the dashed line.' : 'The organiser hasn\'t set it yet.');
  setHTML($('#area-radius'), `<div class="setting"><div class="setting-label">Size</div>${seg('area-radius', null, AREA_RADII, a ? a.r : null, (v) => (v >= 1000 ? v / 1000 + ' km' : v + ' m'), true)}</div>`);

  const st = settings();
  setHTML($('#settings'), SETTING_DEFS.map((d) => `<div class="setting"><div class="setting-label"><span>${d.label}</span>${d.note ? `<span class="muted">${d.note}</span>` : ''}</div>${seg('setting', d.k, d.opts, st[d.k], d.fmt, host)}</div>`).join(''));

  setHTML($('#gps-status'), S.gpsErr && S.gpsErr.code === 1 ? `${esc(gpsLine())}. <button class="btn-link" data-action="gps-help">How to fix</button>` : esc(gpsLine()));
  const hiders = ids.length - seekers;
  $('#start').disabled = !(a && seekers && hiders);
  $('#start').textContent = !a ? 'Set the play area to start' : !seekers ? 'Pick a seeker to start' : !hiders ? 'Someone has to hide' : 'Start game';

  const map = getMap('lobby', '#lobby-map');
  map.begin();
  drawArea(map);
  for (const u of ids) {
    if (u === S.uid) continue;
    const l = S.locs[u];
    if (l) map.pin(u, l.lat, l.lng, pinHTML(S.players[u].role, S.players[u].name, S.players[u].color));
  }
  drawMe(map);
  map.end();
  fitOnce(map);
  const ak = a ? `${a.lat},${a.lng},${a.r}` : '';
  if (a && map._areaKey !== ak) { map._areaKey = ak; map.fitCircle(a.lat, a.lng, a.r); }
}

function seg(action, k, opts, cur, fmt, enabled) {
  return `<div class="seg" role="group" ${enabled ? '' : 'aria-disabled="true"'}>${opts.map((v) =>
    `<button data-action="${action}" ${k ? `data-k="${k}"` : ''} data-v="${v}" aria-pressed="${v === cur}" ${enabled ? '' : 'tabindex="-1"'}>${fmt(v)}</button>`).join('')}</div>`;
}

function renderGame(ph) {
  const st = settings();
  const now = S.db.now();
  const role = myRole();
  const hs = startingHiders(), left = activeHiders();

  // clock band
  $('#clock').className = 'clock team-' + role;
  $('#clock-time').textContent = fmtClock((ph === 'hiding' ? huntStart() : huntEnd()) - now);
  $('#clock-phase').textContent = ph === 'hiding' ? 'Head start' : 'Hunt';
  $('#clock-sub').textContent = ph === 'hiding'
    ? (role === 'seeker' ? 'Stay put. Hiders can see you.' : 'Get hidden. Seekers are waiting.')
    : `${left.length} of ${hs.length} hider${hs.length === 1 ? '' : 's'} left`;

  // hold screen for seekers during the head start
  const hold = $('#hold');
  if (hold.dataset.kind !== 'event') {
    if (ph === 'hiding' && role === 'seeker') {
      setHTML(hold, `<div><h2>Wait here</h2><p>Hiders are getting hidden. They can see you on their map until the hunt starts, so no sneaking off.</p><div class="big">${fmtClock(huntStart() - now)}</div><p>Keep this screen open.</p></div>`);
      hold.hidden = false;
    } else if (ph === 'hunt' && role === 'hider' && frozenAt(S.fix)) {
      setHTML(hold, `<div><h2>❄️ Frozen</h2><p>${esc(name(S.freeze.by))} used Freeze. Stand still: seekers can see exactly where you are.</p><div class="big">${Math.ceil(freezeLeft() / 1000)}</div><p>seconds</p></div>`);
      hold.hidden = false;
      hold.classList.add('freeze');
    } else { hold.hidden = true; hold.classList.remove('freeze'); }
  }

  // warnings
  const myLoc = S.fix && { lat: S.fix.lat, lng: S.fix.lng };
  const mineC = S.circles[S.uid];
  let banner = null, danger = false;
  if (S.gpsErr && S.gpsErr.code === 1) { banner = 'Location is blocked, so the game can\'t see where you are. Tap for how to fix it.'; danger = true; }
  else if (S.gpsErr || !S.fix) banner = gpsLine();
  else if (role === 'hider' && ph === 'hunt' && outside(myLoc)) { banner = 'You\'re outside the play area. Seekers can see exactly where you are.'; danger = true; }
  else if (role === 'hider' && ph === 'hunt' && S.reveal && (!mineC || mineC.n !== S.reveal.n) && now - S.reveal.t > REVEAL_ANSWER_MS && !cloakedFor(S.uid, S.reveal)) { banner = 'Your phone missed the reveal, so seekers can see exactly where you are.'; danger = true; }
  else if (outside(myLoc)) banner = 'You\'re outside the play area.';
  else if (iosWakeLockBroken()) banner = 'This iPhone can\'t keep a Home Screen app awake. Open the game in Safari, or set Auto-Lock to Never.';
  else if (!wake.active) banner = wake.supported ? 'Tap here to keep the screen on. If it locks, your location stops updating.' : 'Set Auto-Lock to Never while you play. If the screen locks, your location stops updating.';
  const bEl = $('#banner');
  bEl.hidden = !banner;
  if (banner) { bEl.textContent = banner; bEl.className = 'banner' + (danger ? ' danger' : ''); bEl.dataset.action = S.gpsErr && S.gpsErr.code === 1 ? 'gps-help' : (wake.active ? '' : 'wake'); }

  // dock
  let edge = '';
  const a = area();
  if (a && S.fix) {
    const d = Math.round(a.r - distM(S.fix, a, a.mlon));
    edge = d >= 0 ? ` · ${d} m to edge` : ` · ${-d} m outside`;
  }
  const me = S.players[S.uid] || {};
  setHTML($('#dock-status'), `<button class="me-btn" data-action="profile" aria-label="Edit your name and colour"><span class="player-dot" style="background:${esc(me.color)}">${initial(me.name)}</span><b>${role === 'seeker' ? 'Seeker' : 'Hiding'}</b><span class="muted">${esc(edge)}</span></button><span class="muted">${esc(gpsLine())}</span>`);
  const pw = ph === 'hunt' ? powersHTML() : '';
  setHTML($('#dock-powers'), pw);
  $('#dock-powers').hidden = !pw;
  let actions = '';
  if (ph === 'hunt' && role === 'seeker') {
    const next = nextRevealAt();
    const ready = now >= next;
    actions = `<button class="btn btn-primary" data-action="catch-menu">Catch</button>
      <button class="btn btn-quiet" data-action="reveal" ${ready ? '' : 'disabled'}>${ready ? 'Reveal' : 'Reveal in ' + fmtClock(next - now)}</button>`;
  } else if (ph === 'hunt' && role === 'hider') {
    actions = `<button class="btn btn-quiet" data-action="self-caught">I was caught</button>`;
  } else {
    actions = `<button class="btn btn-quiet" disabled>Hunt starts in ${fmtClock(huntStart() - now)}</button>`;
  }
  if (isHost()) actions += `<button class="btn btn-quiet" data-action="end-now" style="flex:0 0 auto">End</button>`;
  setHTML($('#dock-actions'), actions);

  // map
  const map = getMap('game', '#game-map');
  map.begin();
  drawArea(map);
  for (const [u, l] of Object.entries(S.locs)) {
    if (!l || !S.players[u]) continue;
    const stale = now - l.t > 30000;
    const label = name(u) + (stale ? ` · ${Math.round((now - l.t) / 1000)} s ago` : (distLabel(l) ? ` · ${distLabel(l)}` : ''));
    map.pin(u, l.lat, l.lng, pinHTML(`${roleOf(u)}${stale ? ' stale' : ''}`, label, S.players[u].color, name(u)), 100);
  }
  if (role === 'seeker') {
    for (const [u, l] of Object.entries(S.exposed)) {
      if (!S.players[u] || S.caught[u]) continue;
      map.pin('x-' + u, l.lat, l.lng, pinHTML('exposed', `${name(u)} · ${distLabel(l)} · ${exposedReason(l, u)}`, S.players[u].color, name(u)), 500);
    }
  }
  if (ph === 'hunt') {
    for (const [id, d] of Object.entries(S.drops)) {
      if (d.c) continue;
      const near = S.fix && distM(S.fix, d) < 60;
      map.pin('d-' + id, d.lat, d.lng, `<div class="pin drop${near ? ' near' : ''}"><span class="drop-gem"></span>${near ? `<span class="pin-label">${distLabel(d)}</span>` : ''}</div>`, 1);
    }
    if (freezeLeft() > 0) {
      map.circle('freeze', S.freeze.lat, S.freeze.lng, FREEZE_M, FREEZE_STYLE, `<div class="circle-label freeze">❄️ ${Math.ceil(freezeLeft() / 1000)} s</div>`);
    }
  }
  if (S.reveal && ph === 'hunt') {
    for (const [u, c] of Object.entries(S.circles)) {
      if (c.n !== S.reveal.n || S.caught[u]) continue;
      if (role === 'hider' && u !== S.uid) continue;
      const age = Math.round((now - c.t) / 60000);
      const label = role === 'hider' ? 'Seekers see this' : `${name(u)}${age >= 1 ? `, ${age} min ago` : ''}`;
      map.circle('rv-' + u, c.lat, c.lng, c.r, REVEAL_STYLE, `<div class="circle-label">${esc(label)}</div>`);
    }
  }
  drawMe(map);
  map.end();
  fitOnce(map);
  if (S.follow && S.fix && S.fix.at !== S.followedAt) { S.followedAt = S.fix.at; map.setView(S.fix.lat, S.fix.lng, null, true); }
}

function renderEnd() {
  const hs = startingHiders(), left = activeHiders();
  const hidersWin = left.length > 0;
  const head = $('#end-head');
  head.className = 'end-head ' + (hidersWin ? 'hider' : 'seeker');
  setHTML(head, hidersWin
    ? `<h1>Hiders win</h1><p>${esc(left.map(name).join(', '))} ${left.length === 1 ? 'was' : 'were'} never caught.</p>`
    : `<h1>Seekers win</h1><p>All ${hs.length} hider${hs.length === 1 ? '' : 's'} caught${S.meta.endedAt && S.meta.startAt ? ` in ${fmtClock(S.meta.endedAt - huntStart())}` : ''}.</p>`);

  const t0 = huntStart();
  const rows = [`<li><time>0:00</time><span>The hunt started</span></li>`];
  Object.entries(S.caught).sort((a, b) => a[1].t - b[1].t).forEach(([h, c]) => {
    const how = c.how === 'host' ? ' (organiser override)' : c.how === 'self' ? ' (owned up)' : '';
    const who = c.how === 'self' ? `${esc(name(h))} was caught${how}` : `${esc(name(c.by))} caught ${esc(name(h))}${how}`;
    rows.push(`<li><time>${fmtClock(c.t - t0)}</time><span>${who}</span></li>`);
  });
  if (S.reveal) rows.push(`<li><time>&nbsp;</time><span>Seekers used ${S.reveal.n} reveal${S.reveal.n === 1 ? '' : 's'}</span></li>`);
  if (hidersWin && S.meta.endedAt && S.meta.endedAt < huntEnd() - 2000) rows.push(`<li><time>${fmtClock(S.meta.endedAt - t0)}</time><span>The organiser ended the game early</span></li>`);
  else rows.push(`<li><time>${fmtClock((S.meta.endedAt || huntEnd()) - t0)}</time><span>${hidersWin ? 'Time ran out' : 'Last hider caught'}</span></li>`);
  setHTML($('#end-log'), rows.join(''));

  const map = getMap('end', '#end-map');
  map.begin();
  drawArea(map);
  for (const [u, l] of Object.entries(S.locs)) {
    if (l && S.players[u]) map.pin(u, l.lat, l.lng, pinHTML(roleOf(u), name(u), S.players[u].color));
  }
  drawMe(map);
  map.end();
  fitOnce(map);
}

boot();
