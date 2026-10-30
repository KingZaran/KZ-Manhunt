// Shared state, helpers and UI building blocks.
import { isDenied } from './fb.js?v=mvvfeq0n';
import { GameMap, MAP_STYLES } from './map.js?v=mvvfeq0n';
import { distM, mPerDegLon, WakeLock, GpsFilter } from './geo.js?v=mvvfeq0n';
import { DEFAULTS, POWER_MS, MAX_ACC, PRESENT_MS, HOST_GONE_MS } from './rules-config.js?v=mvvfeq0n';
import { Movement, FreezeState } from './movement.js?v=mvvfeq0n';
import * as sound from './sound.js?v=mvvfeq0n';

export { isDenied, distM, mPerDegLon, DEFAULTS, POWER_MS, MAX_ACC, sound, MAP_STYLES };

/* ------------------------------------------------------------------ constants */

export const COLOURS = [
  '#E53935', '#FF7043', '#FB8C00', '#F9A825', '#C0CA33', '#43A047', '#00897B', '#00ACC1', '#039BE5',
  '#3949AB', '#5E35B1', '#8E24AA', '#D81B60', '#F06292', '#6D4C41', '#546E7A', '#212121', '#9E9E9E',
];
export const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const AREA_RADII = [250, 500, 1000, 2000, 5000];
export const SEND_EVERY = 2500;
export const HEARTBEAT = 4000;
export const POLL_EVERY = 4000;
export const SEEN_EVERY = 8000;

const min = (v) => (v % 60 ? `${Math.round(v / 6) / 10} min` : `${v / 60} min`);
const secs = (v) => (v >= 120 && v % 60 === 0 ? `${v / 60} min` : `${v} s`);
const m = (v) => (v >= 1000 ? `${v / 1000} km` : `${v} m`);
const off = (fmt) => (v) => (v ? fmt(v) : 'Off');

// Lobby rule editor, grouped like Hide Tag's settings. `basic` ones are shown to everyone.
export const SETTING_GROUPS = [
  { title: 'Basics', open: true, items: [
    { k: 'gameMins', label: 'Game length', opts: [15, 25, 30, 45, 60, 90], fmt: (v) => v + ' min', basic: true },
    { k: 'hideSecs', label: 'Head start', opts: [60, 120, 240, 300, 600], fmt: min, basic: true },
    { k: 'shrinkPct', label: 'Shrinking play area', opts: [100, 90, 70, 50], fmt: (v) => (v === 100 ? 'Off' : `to ${v}%`), note: 'After the head start, the edge slowly moves in', basic: true },
    { k: 'tagRadius', label: 'Catch distance', opts: [5, 8, 10, 15], fmt: m, note: 'How close a hunter must be, by GPS', basic: true },
  ] },
  { title: 'Reveal', items: [
    { k: 'revealCooldownSecs', label: 'Reveal every', opts: [60, 90, 120, 300], fmt: secs, note: 'Shared by all hunters', basic: true },
    { k: 'revealRadius', label: 'Reveal circle', opts: [50, 100, 150, 200], fmt: m, note: 'The hider is somewhere inside' },
    { k: 'groupM', label: 'Hiders share a circle within', opts: [0, 25, 40, 60], fmt: off(m) },
    { k: 'revealNotice', label: 'Revealed hider is told', opts: [0, 25, 50, 100], fmt: (v) => (v === 100 ? 'Always' : v ? `${v}% of the time` : 'Never') },
  ] },
  { title: 'Freeze', items: [
    { k: 'freezeM', label: 'Freeze range', opts: [50, 100, 200, 300], fmt: m, note: 'Hiders within this of any hunter', basic: true },
    { k: 'freezeCd', label: 'Cooldown after a freeze', opts: [60, 120, 180, 300], fmt: secs },
    { k: 'coverSecs', label: 'Time to find cover', opts: [10, 20, 30], fmt: secs },
    { k: 'holdSecs', label: 'Then hold still for', opts: [30, 60, 90], fmt: secs },
    { k: 'driftM', label: 'Allowed drift while frozen', opts: [10, 15, 25], fmt: m },
    { k: 'strictHolds', label: 'Moving while frozen', opts: [false, true], fmt: (v) => (v ? 'Eliminates you' : 'Restarts the hold') },
  ] },
  { title: 'Running', items: [
    { k: 'staminaSecs', label: 'Running stamina', opts: [0, 30, 60, 90], fmt: off(secs), note: 'Seconds of running before you\'re out of breath', basic: true },
    { k: 'refillSecs', label: 'Stamina refill', opts: [45, 120, 180, 300], fmt: secs },
    { k: 'runKmh', label: 'Counts as running at', opts: [6, 8, 10, 12], fmt: (v) => `${v} km/h` },
    { k: 'printSecs', label: 'Footprints last', opts: [30, 60, 90, 180], fmt: secs },
    { k: 'breathSecs', label: 'Out-of-breath warning', opts: [0, 10, 20, 45], fmt: off(secs) },
  ] },
  { title: 'Camping and boundary', items: [
    { k: 'campMins', label: 'A spot burns after', opts: [0, 5, 10, 15, 30], fmt: off((v) => v + ' min'), note: 'Staying within 50 m', basic: true },
    { k: 'burnM', label: 'Burned area size', opts: [30, 60, 100], fmt: m },
    { k: 'graceSecs', label: 'Grace before elimination', opts: [30, 60, 120], fmt: secs, note: 'Outside the area or in a burned spot' },
    { k: 'darkSecs', label: 'Exposed when offline for', opts: [30, 60, 120], fmt: secs, note: 'Locking your phone shows your last spot' },
  ] },
  { title: 'Missions', items: [
    { k: 'missions', label: 'Missions', opts: [0, 2], fmt: (v) => (v ? 'On' : 'Off'), basic: true },
    { k: 'missionStart', label: 'Time to start a mission', opts: [180, 300, 600], fmt: secs },
    { k: 'missionHold', label: 'Time you must stay', opts: [90, 180, 300], fmt: secs },
    { k: 'missionM', label: 'Mission size', opts: [50, 100, 150, 250], fmt: m },
    { k: 'missionPay', label: 'A mission pays', opts: [1, 2, 3], fmt: (v) => `${v} power-up${v === 1 ? '' : 's'}` },
  ] },
  { title: 'Power-ups', items: [
    { k: 'supplies', label: 'Opening supplies', opts: [0, 2, 4, 6], fmt: off((v) => `${v} caches`), note: 'Purple diamonds for each side', basic: true },
    { k: 'cacheEvery', label: 'A new cache every', opts: [0, 60, 120, 300], fmt: off(secs) },
    { k: 'pickupM', label: 'Pick-up range', opts: [10, 20, 40], fmt: m },
    { k: 'freeHandout', label: 'Free power-up at the start', opts: [0, 1, 2], fmt: (v) => (v ? `${v}` : 'None') },
  ] },
];

/* ------------------------------------------------------------------ helpers */

export const $ = (s) => document.querySelector(s);
export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const initial = (n) => esc(String(n || '?').trim().charAt(0).toUpperCase() || '?');
export const r6 = (x) => Math.round(x * 1e6) / 1e6;
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export function setHTML(el, html) { if (el && el._html !== html) { el._html = html; el.innerHTML = html; } }
export function fmtClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(mm)}:${pad(sec)}` : `${mm}:${pad(sec)}`;
}
export const fmtM = (d) => (d >= 1000 ? `${(d / 1000).toFixed(1)} km` : `${Math.round(d)} m`);
export function spokenTime(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} seconds`;
  const mins = Math.round(s / 60);
  return `${mins} minute${mins === 1 ? '' : 's'}`;
}
export function store(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
export function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
export const randId = (n = 8) => Array.from({ length: n }, () => 'abcdefghijkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 32)]).join('');

/* ------------------------------------------------------------------ state */

export const S = {
  db: null, uid: null, code: null, screen: null,
  meta: null, players: {}, caught: {}, seen: {},
  reveal: null, rcut: null, circles: {}, freeze: null, fcut: null, fz: {},
  prints: {}, caches: {}, bag: {}, fx: {}, flare: null, snap: {}, scan: {}, mission: null, mhold: {}, mfail: 0,
  locs: {}, myLoc: null, locSubs: {}, locFail: {}, exposed: {},
  subs: [], fix: null, rawFix: null, gpsErr: null, stopGps: null,
  lastSent: 0, lastPoll: 0, lastSeenSent: 0, lastHost: null,
  maps: {}, tick: null, renderQueued: false, threeD: false, follow: false, engine: 'leaflet',
  mapStyle: load('mapStyle') || 'light',
  seenCache: {}, claiming: false, leaving: false, endSent: false,
  ev: {},      // "already announced" markers, reset each round
};
export const knownNames = {};
export const hooks = { render: () => {} };
export const wake = new WakeLock(() => scheduleRender());
S.filter = new GpsFilter();
S.move = new Movement();
S.frz = new FreezeState();

export const path = (p) => `games/${S.code}/${p}`;
export const settings = () => Object.assign({}, DEFAULTS, (S.meta && S.meta.settings) || {});
export const huntStart = () => S.meta.startAt + settings().hideSecs * 1000;
export const huntEnd = () => huntStart() + settings().gameMins * 60000;
export const isHost = () => !!S.meta && S.meta.host === S.uid;
export const name = (u) => (S.players[u] ? S.players[u].name : knownNames[u] || 'a player who left');
export const roleOf = (u) => { const p = S.players[u]; if (!p) return null; return p.role === 'seeker' || S.caught[u] ? 'seeker' : 'hider'; };
export const myRole = () => roleOf(S.uid);
export const startingHiders = () => Object.keys(S.players).filter((u) => S.players[u].role === 'hider');
export const activeHiders = () => startingHiders().filter((u) => !S.caught[u]);
export const hunters = () => Object.keys(S.players).filter((u) => roleOf(u) === 'seeker');
export const area = () => S.meta && S.meta.area;
export const byJoin = (a, b) => ((S.players[a] || {}).joinedAt || 0) - ((S.players[b] || {}).joinedAt || 0);

// The play area shrinks linearly from the start of the hunt to the end (same formula as the rules).
export function radiusNow(t = S.db.now()) {
  const a = area();
  if (!a) return 0;
  const st = settings();
  if (!S.meta.startAt || S.meta.status === 'lobby') return a.r;
  const hs = huntStart(), he = huntEnd();
  const p = Math.max(0, Math.min(1, (t - hs) / (he - hs)));
  return a.r * (1 - (100 - st.shrinkPct) / 100 * p);
}
// Unclamped, exactly as the server computes it.
export function radiusServer(t) {
  const a = area(); const st = settings();
  const hs = huntStart(), he = huntEnd();
  return a.r * (1 - (100 - st.shrinkPct) / 100 * (t - hs) / (he - hs));
}
export const outside = (loc) => { const a = area(); return !!(a && loc && distM(loc, a, a.mlon) > radiusNow()); };

export const fxOf = (u, k) => (S.fx[u] && S.fx[u][k]) || null;
export const fxLeft = (u, k) => { const f = fxOf(u, k); return f ? Math.max(0, f.t + POWER_MS[k] - S.db.now()) : 0; };
export const fxActive = (u, k) => fxLeft(u, k) > 0;

export const present = (u) => !!S.seen[u] && S.db.now() - S.seen[u] < PRESENT_MS;
export function successor(exclude) {
  const ids = Object.keys(S.players).filter((u) => u !== exclude).sort(byJoin);
  return ids.find(present) || ids[0] || null;
}
export function hostGone() {
  const h = S.meta && S.meta.host;
  if (!h) return false;
  if (!S.players[h]) return true;
  const t = S.seen[h];
  return t ? S.db.now() - t > HOST_GONE_MS : S.db.now() - (S.meta.createdAt || 0) > HOST_GONE_MS;
}

export function phase() {
  const mm = S.meta;
  if (!mm) return 'none';
  if (mm.status === 'lobby' || !mm.startAt) return 'lobby';
  if (mm.status === 'ended') return 'ended';
  const now = S.db.now();
  if (now < huntStart()) return 'hiding';
  if (now < huntEnd() && activeHiders().length > 0) return 'hunt';
  return 'ended';
}

// Announce something once per round (keyed), e.g. once('reveal-ready-3', () => ...).
export function once(key, fn) { if (S.ev[key]) return false; S.ev[key] = true; fn(); return true; }

/* ------------------------------------------------------------------ location upload */

// Mirrors the server's bookkeeping: when you went outside the area, and your camping spot.
function bookkeeping(f, flip) {
  const a = area();
  if (!a || !S.meta || S.meta.status !== 'live') return {};
  const st = settings();
  const prev = S.myLoc || {};
  const now = S.db.now();
  const p = { lat: r6(f.lat), lng: r6(f.lng) };
  const d2 = (x, y) => ((x.lat - y.lat) * 111320) ** 2 + ((x.lng - y.lng) * a.mlon) ** 2;
  let out = d2(p, a) > radiusServer(now) ** 2;
  let keep = !!prev.camp && d2(p, prev.camp) <= st.campM ** 2;
  if (flip & 1) out = !out;
  if (flip & 2) keep = !keep && !!prev.camp;
  const extra = {};
  if (out) extra.out = prev.out || S.db.TS;
  extra.camp = keep ? prev.camp : { lat: p.lat, lng: p.lng, since: S.db.TS };
  return extra;
}

// `precise`: send the latest raw fix instead of the smoothed one (for catches and pick-ups).
export async function sendLocation(force, precise) {
  const f = precise && S.rawFix && Date.now() - S.rawFix.at < 5000 ? S.rawFix : S.fix;
  if (!f || !S.code || !S.meta || S.leaving) return false;
  if (S.meta.status === 'ended') return false;
  if (!force && Date.now() - S.lastSent < SEND_EVERY) return false;
  S.lastSent = Date.now();
  // Near the edge or the camping limit, our clock and the server's can disagree by a moment:
  // if the server refuses, try the other answer.
  for (const flip of [0, 1, 2, 3]) {
    const v = Object.assign({ lat: r6(f.lat), lng: r6(f.lng), acc: Math.min(f.acc, 99999), t: S.db.TS }, bookkeeping(f, flip));
    try { await S.db.set(path('locs/' + S.uid), v); return true; } catch (e) { if (!isDenied(e)) return false; }
  }
  return false;
}

export async function freshFix(maxAge, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (S.fix && Date.now() - S.fix.at <= maxAge) return S.fix;
    await wait(250);
  }
  return S.fix;
}

export function sendSeen() {
  if (!S.code || S.leaving) return;
  S.lastSeenSent = Date.now();
  S.db.set(path('seen/' + S.uid), S.db.TS).catch(() => {});
}

/* ------------------------------------------------------------------ sheets, toasts, overlays */

export function openSheet(html) {
  document.body.classList.add('sheet-open');
  $('#sheet').innerHTML = html;
  $('#sheet').hidden = false;
  $('#sheet-scrim').hidden = false;
  $('#sheet-scrim').onclick = closeSheet;
}
export function closeSheet() { $('#sheet').hidden = true; $('#sheet-scrim').hidden = true; document.body.classList.remove('sheet-open'); }
export function confirmSheet(title, body, okLabel, fn, danger) {
  openSheet(`<h2>${esc(title)}</h2><p>${esc(body)}</p><div class="pick"><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="sheet-ok">${esc(okLabel)}</button><button class="btn btn-quiet" data-action="close-sheet">Cancel</button></div>`);
  $('#sheet-ok').onclick = () => { closeSheet(); fn(); };
}
export function toast(text, kind, ms) {
  const el = document.createElement('div');
  el.className = 'toast ' + (kind || '');
  el.textContent = text;
  $('#toasts').appendChild(el);
  while ($('#toasts').children.length > 3) $('#toasts').firstChild.remove();
  setTimeout(() => el.remove(), ms || 4200);
}
let holdTimer = null;
export function showHold(html, ms, tone) {
  const el = $('#hold');
  el.dataset.kind = 'event';
  el.dataset.tone = tone || '';
  el.innerHTML = `<div>${html}</div>`;
  el.hidden = false;
  clearTimeout(holdTimer);
  holdTimer = setTimeout(() => { el.hidden = true; el.dataset.kind = ''; el.dataset.tone = ''; scheduleRender(); }, ms);
}
export function scheduleRender() {
  if (S.renderQueued) return;
  S.renderQueued = true;
  // setTimeout rather than requestAnimationFrame: rAF stops entirely in background views.
  setTimeout(() => { S.renderQueued = false; hooks.render(); }, 16);
}

/* ------------------------------------------------------------------ maps */

export const AREA_STYLE = { color: '#FF5B14', weight: 3, dashed: true, fill: 0.03 };
export const START_AREA_STYLE = { color: '#FF5B14', weight: 1.5, lineOpacity: 0.35, fill: 0 };
export const ACC_STYLE = { color: '#2D5BFF', weight: 1, lineOpacity: 0.45, fill: 0.1 };
export const REVEAL_STYLE = { color: '#E53935', weight: 2, fill: 0.18 };
export const OLD_REVEAL_STYLE = { color: '#E53935', weight: 1.5, lineOpacity: 0.5, fill: 0.06 };
export const MISSION_STYLE = { color: '#F9A825', weight: 3, fill: 0.14 };
export const MISSION_HELD_STYLE = { color: '#F9A825', weight: 4, dashed: true, fill: 0.3 };
export const BURN_STYLE = { color: '#D84315', weight: 2, fill: 0.22 };
export const FREEZE_STYLE = { color: '#2FA8E0', weight: 2, dashed: true, fill: 0.08 };
export const SCAN_STYLE = { color: '#7B3FE4', weight: 2, dashed: true, fill: 0.06 };

export function getMap(key, elId, onClick) {
  if (!S.maps[key]) {
    const mp = new GameMap($(elId), {
      engine: S.engine,
      style: S.mapStyle,
      onClick: onClick || (() => {}),
      onUserMove: () => { if (key === 'game') { S.follow = false; updateTools(); } },
    });
    mp._fitted = false;
    S.maps[key] = mp;
    fitOnce(mp);
    updateTools();
  }
  return S.maps[key];
}
export function pinHTML(cls, label, color, who) {
  return `<div class="pin ${cls}"><span class="pin-dot" style="background:${esc(color)}">${initial(who || label)}</span>${label ? `<span class="pin-label">${esc(label)}</span>` : ''}</div>`;
}
export function fitOnce(mp) {
  if (mp._fitted) return;
  const a = area();
  if (a) { mp.fitCircle(a.lat, a.lng, a.r); mp._fitted = true; }
  else if (S.fix) { mp.setView(S.fix.lat, S.fix.lng, 16); mp._fitted = true; }
}
export function drawArea(mp, live) {
  const a = area();
  if (!a) return;
  const r = radiusNow();
  if (live && r < a.r - 1) mp.circle('area0', a.lat, a.lng, a.r, START_AREA_STYLE);
  mp.circle('area', a.lat, a.lng, r, AREA_STYLE);
}
export function drawMe(mp) {
  if (!S.fix) return;
  mp.circle('me-acc', S.fix.lat, S.fix.lng, S.fix.acc, ACC_STYLE);
  const role = phase() === 'lobby' ? (S.players[S.uid] || {}).role : myRole();
  mp.pin('me', S.fix.lat, S.fix.lng, `<div class="pin me ${role || 'hider'}"><span class="me-dot"></span></div>`, 1000);
}
export function distLabel(l) { return S.fix && l ? fmtM(distM(S.fix, l)) : ''; }
export function recentre() {
  const mp = S.maps.game;
  if (!mp || !S.fix) { toast('Waiting for GPS…', 'warn'); return; }
  S.follow = true;
  mp.resetNorth();
  mp.setView(S.fix.lat, S.fix.lng, Math.max(mp.zoom(), 17.5), true);
  updateTools();
}
export function toggle3D() {
  const mp = S.maps.game;
  if (mp) S.threeD = mp.toggle3D();
  updateTools();
}
export function updateTools() {
  const mp = S.maps.game;
  const label = (MAP_STYLES.find((x) => x.id === S.mapStyle) || MAP_STYLES[0]).label;
  if ($('#lobby-style')) $('#lobby-style').textContent = `Map: ${label}`;
  $('#threed-btn').hidden = !(mp && mp.supports3D);
  $('#threed-btn').setAttribute('aria-pressed', String(!!S.threeD));
  $('#follow-btn').setAttribute('aria-pressed', String(!!S.follow));
}
export function mapStyleSheet() {
  openSheet(`<h2>Map style</h2><div class="pick">${MAP_STYLES.map((x) =>
    `<button class="btn ${x.id === S.mapStyle ? 'btn-ink' : 'btn-quiet'}" data-action="set-map-style" data-v="${x.id}">${x.label}</button>`).join('')}</div>`);
}
export function setMapStyle(v) {
  closeSheet();
  S.mapStyle = v;
  store('mapStyle', v);
  Object.values(S.maps).forEach((mp) => mp.setStyle(v));
  updateTools();
}

export function gpsLine() {
  if (S.gpsErr) return S.gpsErr.code === 1 ? 'Location is blocked' : 'No GPS signal. Move into the open.';
  if (!S.fix) return 'Waiting for GPS…';
  return `GPS ±${S.fix.acc} m${S.fix.acc > MAX_ACC ? ' (rough)' : ''}`;
}

export function playerRow(u, extra) {
  const p = S.players[u];
  const on = present(u) || u === S.uid;
  const tags = [u === S.uid ? 'you' : '', on ? '' : 'offline'].filter(Boolean).join(', ');
  return `<li class="player"><span class="player-dot${on ? '' : ' away'}" style="background:${esc(p.color)}">${initial(p.name)}</span>
    <span class="player-name">${S.meta && u === S.meta.host ? '<span class="crown" aria-label="Organiser">👑</span>' : ''}${esc(p.name)} <small>${esc(tags)}</small></span>${extra || ''}</li>`;
}

export function mPerDegLonAt(lat) { return mPerDegLon(lat); }
