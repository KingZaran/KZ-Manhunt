// Boot, home, lobby, session plumbing and the results screen. The in-game rules live in play.js.
import { connect, isConfigured } from './fb.js?v=mvwv1q6e';
import { loadEngine } from './map.js?v=mvwv1q6e';
import qrcode from '../vendor/qrcode/qrcode.js';
import { watchLocation, nudgeLocation } from './geo.js?v=mvwv1q6e';
import { POWERS } from './rules-config.js?v=mvwv1q6e';
import {
  S, $, esc, initial, r6, setHTML, fmtClock, store, load, once,
  COLOURS, CODE_CHARS, AREA_RADII, SETTING_GROUPS, HEARTBEAT, SEEN_EVERY, DEFAULTS,
  path, settings, huntStart, huntEnd, isHost, name, roleOf, myRole, startingHiders, activeHiders, area, byJoin,
  present, successor, hostGone, phase, sendLocation, sendSeen, knownNames, hooks, wake,
  openSheet, closeSheet, confirmSheet, toast, showHold, scheduleRender,
  getMap, pinHTML, fitOnce, drawArea, drawMe, recentre, toggle3D, mapStyleSheet, setMapStyle, gpsLine, playerRow,
  isDenied, mPerDegLon, sound,
} from './core.js?v=mvwv1q6e';
import {
  subscribeGame, stopGame, resetRound, onFix, tickGame, renderGame, canListen, openingCaches,
  triggerReveal, freezeSheet, catchMenu, tryCatch, powerSheet,
} from './play.js?v=mvwv1q6e';

const { cue, play, say } = sound;
hooks.render = render;

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
  setupDockSwipe();
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
    setTimeout(() => Object.values(S.maps).forEach((mp) => mp.resize()), 50);
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
    $('#create').disabled = true;
    try { await createGame(p); } catch (e) { console.error(e); homeError('Couldn\'t create the game. Try again.'); }
    $('#create').disabled = false;
  });
  $('#join-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const p = me(); if (!p) return;
    const code = $('#code').value.trim().toUpperCase();
    if (!/^[A-Z2-9]{5}$/.test(code)) { homeError('Codes are 5 letters and numbers.'); return; }
    $('#join-form button').disabled = true;
    try { await joinGame(code, p); } catch (err) { console.error(err); homeError('Couldn\'t join. Check the code and try again.'); }
    $('#join-form button').disabled = false;
  });
  const params = new URLSearchParams(location.search);
  const invite = (params.get('code') || '').toUpperCase();
  if (/^[A-Z2-9]{5}$/.test(invite)) {
    $('#code').value = invite;
    document.body.classList.add('has-invite');
    $('#invite-code').textContent = invite;
    $('#join-form button').textContent = `Join ${invite}`;
    if (!nameEl.value) setTimeout(() => nameEl.focus(), 300);
  }
}
function homeError(t) { $('#home-error').textContent = t; }

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
    const st = Object.assign({}, DEFAULTS, meta.settings || {});
    const ends = (meta.startAt || 0) + st.hideSecs * 1000 + st.gameMins * 60000;
    const live = meta.status === 'live' && S.db.now() < ends;
    if (meta.status !== 'lobby' && !live) { homeError('That game has just finished. Ask the organiser to take everyone back to the lobby, then join.'); return; }
    const others = Object.values((await S.db.get(`games/${code}/players`)) || {});
    const used = new Set(others.map((o) => o.color));
    let color = p.color;
    if (used.has(color)) {
      color = COLOURS.find((c) => !used.has(c)) || color;
      store('colour', color);
      setTimeout(() => toast('Someone already had your colour, so you\'ve got a new one. Tap your name to change it.', 'warn', 6000), 800);
    }
    // Joining a game that's already running? You join the hunters (as in Hide Tag).
    await S.db.set(`games/${code}/players/${S.uid}`, { name: p.name, color, role: live ? 'seeker' : 'hider', joinedAt: S.db.TS });
    if (live) setTimeout(() => toast('This game has already started, so you\'ve joined the hunters.', 'seeker', 6000), 600);
  }
  return enterGame(code);
}

/* ------------------------------------------------------------------ game session */

function enterGame(code) {
  S.code = code;
  store('game', code);
  history.replaceState(null, '', location.pathname);
  const on = (p, cb, onErr) => S.subs.push(S.db.on(path(p), (v) => { if (!S.leaving) { cb(v); scheduleRender(); } }, onErr || ((e) => console.warn('listen failed', p, e))));
  on('meta', (v) => {
    if (!v) { toast('That game was closed.', 'bad'); leaveGame(true); return; }
    S.meta = v;
    onHostChange();
  });
  on('players', (v) => {
    const before = S.players;
    S.players = v || {};
    for (const [u, p] of Object.entries(S.players)) knownNames[u] = p.name;
    if (S.meta && !S.players[S.uid] && S.code) { toast('The organiser removed you from the game.', 'bad'); leaveGame(true); return; }
    const joined = Object.keys(S.players).filter((u) => !before[u] && u !== S.uid);
    if (Object.keys(before).length && joined.length) {
      play('joined');
      if (phase() !== 'lobby') joined.forEach((u) => toast(`${name(u)} joined the hunters.`, 'seeker'));
    }
  });
  on('caught', (v) => { S.caught = v || {}; onCaughtChange(); });
  on('seen', (v) => { S.seen = v || {}; });
  on('locs/' + S.uid, (v) => { S.myLoc = v; });
  subscribeGame(on);
  S.leaving = false;
  sendSeen();

  S.filter.reset();
  S.stopGps = watchLocation(
    (f) => onRawFix(f),
    (e) => { S.gpsErr = e; scheduleRender(); },
  );
  S.tick = setInterval(tick, 1000);
  $('#code-big').textContent = code;
}

async function leaveGame(silent) {
  const code = S.code;
  const wasHider = phase() === 'hunt' && myRole() === 'hider';
  S.leaving = true;
  if (!silent && code && S.players[S.uid]) {
    // A hider who walks away mid-game is out (the results say they quit).
    if (wasHider) { try { await S.db.set(`games/${code}/caught/${S.uid}`, { by: S.uid, t: S.db.TS, how: 'quit' }); } catch (e) { /* fine */ } }
    const upd = { [`players/${S.uid}`]: null, [`locs/${S.uid}`]: null, [`seen/${S.uid}`]: null };
    const next = isHost() ? successor(S.uid) : null;
    if (next) upd['meta/host'] = next;
    S.db.update(`games/${code}`, upd).catch((e) => console.warn('leave failed', e));
  }
  S.subs.forEach((u) => u()); S.subs = [];
  stopGame();
  Object.values(S.locSubs).forEach((u) => u()); S.locSubs = {};
  if (S.stopGps) S.stopGps();
  clearInterval(S.tick);
  Object.values(S.maps).forEach((mp) => mp.remove()); S.maps = {};
  closeSheet();
  $('#hold').hidden = true;
  Object.assign(S, {
    seen: {}, lastHost: null, code: null, meta: null, players: {}, caught: {}, reveal: null, rcut: null, circles: {},
    freeze: null, fcut: null, fz: {}, prints: {}, caches: {}, bag: {}, fx: {}, flare: null, snap: {}, scan: {},
    mission: null, mhold: {}, mfail: 0, locs: {}, myLoc: null, locFail: {}, exposed: {}, endSent: false,
    seenCaught: null, lastPhase: null,
  });
  resetRound();
  store('game', null);
  show('home');
}

function onRawFix(f) {
  S.rawAt = Date.now();
  S.rawFix = f;
  S.fix = S.filter.push(f);
  S.gpsErr = null;
  onFix(f);
  sendLocation(false);
  scheduleRender();
}

function tick() {
  if (!S.code || !S.meta) return;
  const ph = phase();
  // iPhones can stop sending updates while you stand still; ask for a fresh fix so you don't look offline.
  if (Date.now() - (S.rawAt || 0) > 12000 && Date.now() - (S.nudgedAt || 0) > 12000) { S.nudgedAt = Date.now(); nudgeLocation(onRawFix); }
  if (Date.now() - S.lastSent > HEARTBEAT) sendLocation(true);
  if (Date.now() - S.lastSeenSent > SEEN_EVERY) sendSeen();
  maybeClaimHost();
  reconcileLocListeners();
  if (S.lastPhase && S.lastPhase !== ph) onPhaseChange(S.lastPhase, ph);
  S.lastPhase = ph;
  try { tickGame(ph); } catch (e) { console.error('tick', e); }
  if (ph === 'ended' && isHost() && S.meta.status === 'live' && !S.endSent) {
    S.endSent = true;
    S.db.update(path('meta'), { status: 'ended', endedAt: S.db.TS }).catch(() => { S.endSent = false; });
  }
  scheduleRender();
}

async function maybeClaimHost() {
  if (S.claiming || !S.players[S.uid] || isHost() || !hostGone()) return;
  if (successor(S.meta.host) !== S.uid || !present(S.uid)) return;
  S.claiming = true;
  try { await S.db.set(path('meta/host'), S.uid); } catch (e) { /* someone else got there first, or the organiser is back */ }
  S.claiming = false;
}

function onHostChange() {
  const h = S.meta.host;
  if (S.lastHost && h !== S.lastHost) {
    if (h === S.uid) {
      const ended = phase() === 'ended';
      cue('confirm', null, { buzz: [100, 60, 100] });
      toast(`You're now the organiser${ended ? '. You can take everyone back to the lobby.' : '.'}`, 'seeker', 6000);
    } else toast(`${name(h)} is now the organiser.`);
  }
  S.lastHost = h;
}

function onPhaseChange(from, to) {
  if (to === 'hiding' || to === 'lobby') { resetRound(); S.seenCaught = Object.keys(S.caught); }
  if (to === 'lobby') { S.endSent = false; }
  if (to === 'hunt') {
    const seeker = myRole() === 'seeker';
    showHold(seeker ? '<h2>Go!</h2><p>The hunt is on. Find the hiders.</p>' : '<h2>They\'re coming</h2><p>The hunt is on. Stay hidden, and don\'t run unless you have to.</p>', 2600, seeker ? 'seeker' : 'hider');
    cue('whistle_end', seeker ? 'The hunt has begun. Go and find them.' : 'The hunt has begun. Hunters are coming. Running now leaves footprints.', { urgent: true, buzz: [300, 120, 300] });
  }
  if (to === 'ended' && from !== 'lobby') {
    const hidersWin = activeHiders().length > 0;
    const orig = (S.players[S.uid] || {}).role;
    const iWon = hidersWin ? orig === 'hider' && !S.caught[S.uid] : orig === 'seeker';
    cue(iWon ? 'win' : 'lose', hidersWin ? 'Time\'s up. The hiders win.' : 'Every hider has been caught. The hunters win.', { urgent: true, buzz: [200, 100, 200, 100, 400] });
  }
}

let hiddenAt = null;
function onVisibility() {
  if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
  const away = hiddenAt ? Date.now() - hiddenAt : 0;
  hiddenAt = null;
  if (!S.code || !S.meta) return;
  sendSeen();
  nudgeLocation(onRawFix);
  sendLocation(true);
  if (phase() === 'hunt' && myRole() === 'hider' && away > settings().darkSecs * 1000) {
    cue('warn', null);
    toast(`You were away for ${Math.round(away / 1000)} s, so hunters could see where you were.`, 'warn', 6000);
  }
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

function onCaughtChange() {
  const keys = Object.keys(S.caught);
  if (S.seenCaught == null) { S.seenCaught = keys; return; }
  const fresh = keys.filter((k) => !S.seenCaught.includes(k));
  S.seenCaught = keys;
  const left = activeHiders().length;
  const leftLine = left ? `${left} hider${left === 1 ? '' : 's'} left.` : '';
  for (const h of fresh) {
    const c = S.caught[h];
    if (h === S.uid) {
      const why = c.how === 'out' ? 'You were eliminated.' : c.how === 'self' ? 'You owned up.' : c.how === 'quit' ? 'You left the game.' : `${esc(name(c.by))} got you.`;
      showHold(`<h2>You're out</h2><p>${why} You're a hunter now: go and help find the others.</p>`, 4500, 'seeker');
      cue('caught_me', `${c.how === 'out' ? 'Eliminated' : 'Caught'}. You're a hunter now. ${leftLine}`, { urgent: true, buzz: [500, 200, 500] });
    } else {
      const how = c.how === 'host' ? ' (organiser override)' : '';
      const text = c.how === 'out' ? `${name(h)} was eliminated.` : c.how === 'quit' ? `${name(h)} left the game.` : c.how === 'self' ? `${name(h)} was caught.` : `${name(c.by)} caught ${name(h)}${how}.`;
      toast(text, 'seeker');
      cue(myRole() === 'seeker' ? 'caught_other' : 'turned', `${text} ${leftLine}`, { buzz: 150 });
    }
  }
}

/* ------------------------------------------------------------------ clicks */

let preloaded = false;
async function onClick(e) {
  if (!preloaded) { preloaded = true; sound.unlock(); sound.preload(sound.ALL_SOUNDS); }
  if (S.screen === 'game' && !wake.active) wake.enable();
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  const u = el.dataset.uid;
  if (a !== 'close-sheet') play('tap', { volume: 0.5, gap: 60 });
  switch (a) {
    case 'leave': return leaveSheet();
    case 'share-code': return shareCode();
    case 'invite': return inviteSheet();
    case 'copy-link': return copyLink();
    case 'menu': return menuSheet();
    case 'roster': return rosterSheet();
    case 'help': return helpSheet();
    case 'sound': return soundSheet();
    case 'player-menu': return playerSheet(u);
    case 'make-host': closeSheet(); return S.db.set(path('meta/host'), u).catch(() => toast('Couldn\'t hand over the organiser role.', 'bad'));
    case 'set-role': closeSheet(); return S.db.set(path(`players/${u}/role`), el.dataset.v).catch(() => toast('Couldn\'t change teams.', 'bad'));
    case 'kick': return confirmSheet(`Remove ${name(u)}?`, 'They can rejoin with the code.', 'Remove', () => S.db.remove(path('players/' + u)).catch(() => toast('Couldn\'t remove them.', 'bad')), true);
    case 'toggle-role':
      if (!isHost()) return undefined;
      return S.db.set(path(`players/${u}/role`), S.players[u].role === 'seeker' ? 'hider' : 'seeker').catch(() => toast('Couldn\'t change teams.', 'bad'));
    case 'shuffle': return shuffleHunters();
    case 'setting': {
      if (!isHost()) return undefined;
      const k = el.dataset.k;
      const v = el.dataset.v === 'true' ? true : el.dataset.v === 'false' ? false : Number(el.dataset.v);
      return S.db.set(path('meta/settings/' + k), v).catch(() => toast('Couldn\'t save that setting.', 'bad'));
    }
    case 'pool': {
      if (!isHost()) return undefined;
      const k = el.dataset.k;
      const pool = (S.meta.settings && S.meta.settings.pool) || {};
      return S.db.set(path('meta/settings/pool/' + k), pool[k] === false).catch(() => toast('Couldn\'t save that setting.', 'bad'));
    }
    case 'preset': return applyPreset(el.dataset.v);
    case 'area-radius': {
      if (!isHost()) return undefined;
      const a2 = area() || (S.fix && { lat: S.fix.lat, lng: S.fix.lng });
      if (!a2) return toast('Waiting for GPS. Or tap the map to place the play area.', 'warn');
      return setArea(a2.lat, a2.lng, Number(el.dataset.v));
    }
    case 'area-here':
      if (!S.fix) return toast('Waiting for GPS…', 'warn');
      return setArea(S.fix.lat, S.fix.lng, (area() && area().r) || 500);
    case 'start': return startGame();
    case 'catch-menu': return catchMenu();
    case 'catch': return tryCatch(u, el.dataset.how);
    case 'override-menu': return catchMenu(true);
    case 'reveal': return triggerReveal();
    case 'freeze': return freezeSheet();
    case 'self-caught': return confirmSheet('Were you caught?', 'Only use this if a hunter tagged you and their Catch button didn\'t work. You\'ll join the hunters.', 'Yes, I was caught', () => tryCatch(S.uid, 'self'));
    case 'end-now': return confirmSheet('End the game now?', 'Everyone goes to the results screen.', 'End game', () => S.db.update(path('meta'), { status: 'ended', endedAt: S.db.TS }), true);
    case 'recentre': return recentre();
    case 'map-style': return mapStyleSheet();
    case 'set-map-style': return setMapStyle(el.dataset.v);
    case 'three-d': return toggle3D();
    case 'profile': return profileSheet();
    case 'power': return powerSheet(el.dataset.kind);
    case 'gps-help': return gpsHelp();
    case 'again': return backToLobby();
    case 'close-sheet': return closeSheet();
    case 'wake': return wake.enable();
    case 'dock-toggle': return setDockMin(!S.dockMin);
    default: return undefined;
  }
}

// Minimise the bottom panel with × or by swiping it down; tap or swipe up to bring it back.
function setDockMin(on) {
  if (!!S.dockMin === on) return;
  S.dockMin = on;
  store('dockMin', on ? '1' : null);
  render();
  setTimeout(() => { if (S.maps.game) S.maps.game.resize(); }, 60);
}
function setupDockSwipe() {
  const dock = $('#dock');
  let y0 = null, x0 = 0, dy = 0, vertical = null;
  dock.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    y0 = e.touches[0].clientY; x0 = e.touches[0].clientX; dy = 0; vertical = null;
  }, { passive: true });
  dock.addEventListener('touchmove', (e) => {
    if (y0 == null) return;
    const ddx = e.touches[0].clientX - x0;
    dy = e.touches[0].clientY - y0;
    if (vertical == null && (Math.abs(dy) > 8 || Math.abs(ddx) > 8)) vertical = Math.abs(dy) > Math.abs(ddx);
    if (vertical && !S.dockMin && dy > 0) { dock.style.transition = 'none'; dock.style.transform = `translateY(${dy * 0.7}px)`; }
  }, { passive: true });
  const end = () => {
    if (y0 == null) return;
    dock.style.transition = ''; dock.style.transform = '';
    if (vertical && !S.dockMin && dy > 45) setDockMin(true);
    else if (vertical && S.dockMin && dy < -25) setDockMin(false);
    y0 = null;
  };
  dock.addEventListener('touchend', end);
  dock.addEventListener('touchcancel', end);
}

const inviteUrl = () => `${location.origin}${location.pathname}?code=${S.code}`;

async function shareCode() {
  const text = `Join my Manhunt game: code ${S.code}`;
  try {
    if (navigator.share) await navigator.share({ title: 'Manhunt', text, url: inviteUrl() });
    else copyLink();
  } catch (e) { /* cancelled */ }
}
async function copyLink() {
  try { await navigator.clipboard.writeText(inviteUrl()); toast('Invite link copied.'); }
  catch (e) { toast(inviteUrl()); }
}

function qrSvg(text) {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  return q.createSvgTag({ cellSize: 6, margin: 3, scalable: true, alt: 'QR code to join', title: 'Scan to join' });
}

function inviteSheet() {
  openSheet(`<h2>Invite friends</h2>
    <p>Scan with a phone camera, or enter the code on the Manhunt home screen.${phase() !== 'lobby' ? ' The game has started, so they\'ll join the hunters.' : ''}</p>
    <div class="qr">${qrSvg(inviteUrl())}</div>
    <div class="invite-code" aria-label="Join code">${esc(S.code)}</div>
    <div class="pick">
      ${navigator.share ? '<button class="btn btn-primary" data-action="share-code">Share invite link</button>' : ''}
      <button class="btn btn-quiet" data-action="copy-link">Copy link</button>
      <button class="btn btn-quiet" data-action="close-sheet">Done</button>
    </div>`);
}

function leaveSheet() {
  const ph = phase();
  const next = isHost() ? successor(S.uid) : null;
  const handover = next ? ` ${name(next)} will become the organiser.` : '';
  const body = ph === 'lobby'
    ? `You can rejoin with the code.${handover}`
    : ph === 'ended'
      ? `You can rejoin with the code.${handover}`
      : `${myRole() === 'hider' && ph === 'hunt' ? 'Leaving counts as being out. ' : ''}You can rejoin with the code as a hunter.${handover}`;
  confirmSheet('Leave this game?', body, 'Leave', () => leaveGame(false), true);
}

function menuSheet() {
  const ph = phase();
  openSheet(`<h2>Menu</h2><div class="pick">
    <button class="btn btn-quiet" data-action="roster">Players</button>
    <button class="btn btn-quiet" data-action="invite">Invite</button>
    <button class="btn btn-quiet" data-action="profile">Your name and colour</button>
    <button class="btn btn-quiet" data-action="sound">Sound and voice</button>
    <button class="btn btn-quiet" data-action="help">How to play</button>
    ${isHost() && (ph === 'hiding' || ph === 'hunt') ? '<button class="btn btn-quiet" data-action="end-now">End the game for everyone</button>' : ''}
    <button class="btn btn-danger" data-action="leave">Leave game</button>
    <button class="btn btn-quiet" data-action="close-sheet">Close</button>
  </div>`);
}

function rosterSheet() {
  const ph = phase();
  const ids = Object.keys(S.players).sort(byJoin);
  const status = (u) => {
    const c = S.caught[u];
    if (S.players[u].role === 'seeker') return '<span class="tag seeker">Hunter</span>';
    if (c) return `<span class="tag caught">${c.how === 'out' ? 'Eliminated' : 'Caught'} ${ph === 'lobby' ? '' : fmtClock(c.t - huntStart())}</span>`;
    return '<span class="tag hider">Hiding</span>';
  };
  openSheet(`<h2>Players</h2><ul class="players">${ids.map((u) => playerRow(u, status(u))).join('')}</ul>
    <div class="pick"><button class="btn btn-quiet" data-action="close-sheet">Close</button></div>`);
}

function playerSheet(u) {
  const p = S.players[u];
  if (!p || !isHost()) return;
  const other = p.role === 'seeker' ? 'hider' : 'seeker';
  openSheet(`<h2>${esc(p.name)}</h2><p>${present(u) ? 'Online now.' : 'Their phone hasn\'t been in touch for a while.'}</p><div class="pick">
    <button class="btn btn-quiet" data-action="set-role" data-uid="${esc(u)}" data-v="${other}">Make ${other === 'seeker' ? 'hunter' : 'hider'}</button>
    ${u !== S.uid ? `<button class="btn btn-quiet" data-action="make-host" data-uid="${esc(u)}">Make organiser</button>
    <button class="btn btn-danger" data-action="kick" data-uid="${esc(u)}">Remove from game</button>` : ''}
    <button class="btn btn-quiet" data-action="close-sheet">Close</button></div>`);
}

function helpSheet() {
  const st = settings();
  const hk = Object.keys(POWERS).filter((k) => POWERS[k].side !== 'seeker');
  const sk = Object.keys(POWERS).filter((k) => POWERS[k].side !== 'hider');
  const list = (ks) => ks.map((k) => `<li>${POWERS[k].icon} <b>${esc(POWERS[k].name)}</b>: ${esc(POWERS[k].desc)}</li>`).join('');
  openSheet(`<h2>How to play</h2>
    <div class="help">
      <p><b>Hiders</b> get a ${fmtClock(st.hideSecs * 1000)} head start, then the hunt lasts ${st.gameMins} minutes. Stay inside the dashed circle${st.shrinkPct < 100 ? `, which slowly shrinks to ${st.shrinkPct}% of its size` : ''}.</p>
      <p><b>Hunters</b> catch a hider by tagging them, then tapping <b>Catch</b>. It only counts if your phones are within ${st.tagRadius} m by GPS. Caught hiders join the hunters. Hunters win if they catch everyone; hiders win if anyone is still out there when time runs out.</p>
      <p><b>Reveal</b> (every ${fmtClock(st.revealCooldownSecs * 1000)}) shows hunters a ${st.revealRadius} m circle each hider is somewhere inside. Hiders aren't always told.</p>
      <p><b>Freeze</b>: any hider within ${st.freezeM} m of a hunter gets ${st.coverSecs} s to find cover, then must hold still for ${st.holdSecs} s.</p>
      ${st.staminaSecs ? `<p><b>Running</b> faster than ${st.runKmh} km/h leaves footprints hunters can follow, and uses up your ${st.staminaSecs} s of stamina. Run out and keep running and you're out.</p>` : ''}
      ${st.campMins ? `<p><b>Camping</b>: stay within ${st.campM} m of one spot for ${st.campMins} min and it burns. Hunters see you, and you must leave the burned area.</p>` : ''}
      <p><b>You're exposed</b> (hunters see exactly where you are) if you leave the play area, miss a reveal, or close the game or lock your screen for ${st.darkSecs} s. Being outside the area or in a burned spot for ${st.graceSecs} s eliminates you, but you get the final say.</p>
      ${st.missions ? `<p><b>Missions</b>: two yellow circles appear. One hider must step into one within ${fmtClock(st.missionStart * 1000)} and stay ${fmtClock(st.missionHold * 1000)}. Succeed and every hider gets ${st.missionPay} power-up${st.missionPay === 1 ? '' : 's'}; fail and every hider is shown to the hunters for a minute.</p>` : ''}
      <p><b>Power-ups</b>: walk to a purple diamond to pick one up, then tap it in your bar to use it.</p>
      <p class="small">Hiders:</p><ul class="small power-list">${list(hk)}</ul>
      <p class="small">Hunters:</p><ul class="small power-list">${list(sk)}</ul>
      <p><b>Sounds</b>: everything is announced out loud, so you can keep your phone in your pocket. Change it in Menu → Sound and voice.</p>
    </div>
    <div class="pick"><button class="btn btn-quiet" data-action="close-sheet">Got it</button></div>`);
}

function soundSheet() {
  const p = sound.getPrefs();
  const row = (k, label, note) => `<label class="toggle"><span><b>${label}</b>${note ? `<small>${note}</small>` : ''}</span><input type="checkbox" data-pref="${k}" ${p[k] ? 'checked' : ''}></label>`;
  openSheet(`<h2>Sound and voice</h2>
    ${row('sound', 'Sound effects')}
    ${row('voice', 'Spoken call-outs', 'Says what\'s happening, like "Reveal ready" or "Stop running"')}
    ${row('vibrate', 'Vibration', 'Android only. iPhones don\'t let websites vibrate')}
    ${row('silentSwitch', 'Play when the iPhone is on silent')}
    <label class="field"><span>Volume</span><input type="range" min="0.2" max="1" step="0.1" value="${p.volume}" id="snd-vol"></label>
    <p class="small muted">Turn your phone's volume up. Sounds play while the game is open, including with the screen dimmed.</p>
    <div class="pick"><button class="btn btn-quiet" id="snd-test">Test</button><button class="btn btn-primary" data-action="close-sheet">Done</button></div>`);
  $('#sheet').querySelectorAll('[data-pref]').forEach((el) => { el.onchange = () => sound.setPrefs({ [el.dataset.pref]: el.checked }); });
  $('#snd-vol').oninput = (e) => sound.setPrefs({ volume: Number(e.target.value) });
  $('#snd-test').onclick = () => { sound.unlock(); cue('reveal_ready', 'Reveal ready.', { buzz: [100, 60, 100] }); };
}

function shuffleHunters() {
  const ids = Object.keys(S.players);
  if (ids.length < 2) return toast('Need at least 2 players.', 'warn');
  const pick = ids[Math.floor(Math.random() * ids.length)];
  const upd = {};
  ids.forEach((u) => { upd[`${u}/role`] = u === pick ? 'seeker' : 'hider'; });
  return S.db.update(path('players'), upd).then(() => { play('confirm'); toast(`${name(pick)} is the hunter.`, 'seeker'); }).catch(() => toast('Couldn\'t shuffle teams.', 'bad'));
}

function setArea(lat, lng, r) {
  return S.db.set(path('meta/area'), { lat: r6(lat), lng: r6(lng), r, mlon: Math.round(mPerDegLon(lat) * 100) / 100 }).catch(() => toast('Couldn\'t save the play area.', 'bad'));
}

// Hide Tag's presets.
const PRESETS = {
  standard: { label: 'Standard', v: {} },
  quick: { label: 'Quick', v: { gameMins: 15, hideSecs: 120, revealCooldownSecs: 60, freezeCd: 60, missions: 0, campMins: 5 } },
  long: { label: 'Long', v: { gameMins: 60, hideSecs: 300, revealCooldownSecs: 120, freezeCd: 180, campMins: 15 } },
  casual: { label: 'Casual', v: { staminaSecs: 0, campMins: 0, shrinkPct: 100, missions: 0 } },
};
function applyPreset(k) {
  if (!isHost() || !PRESETS[k]) return undefined;
  const v = Object.assign({}, DEFAULTS, PRESETS[k].v);
  const pool = S.meta.settings && S.meta.settings.pool;
  if (pool) v.pool = pool;
  return S.db.set(path('meta/settings'), v).then(() => toast(`${PRESETS[k].label} rules.`)).catch(() => toast('Couldn\'t save the rules.', 'bad'));
}

async function startGame() {
  const hunters = Object.keys(S.players).filter((u) => S.players[u].role === 'seeker');
  if (!area()) return toast('Set the play area first.', 'warn');
  if (!hunters.length) return toast('Pick at least one hunter.', 'warn');
  if (hunters.length === Object.keys(S.players).length) return toast('Someone has to hide.', 'warn');
  try {
    await S.db.update(`games/${S.code}`, { 'meta/status': 'live', 'meta/startAt': S.db.TS, 'meta/endedAt': null });
  } catch (e) { toast('Couldn\'t start the game.', 'bad'); return undefined; }
  // Opening supplies (needs the game to be live first).
  if (settings().supplies > 0) {
    for (let i = 0; i < 3; i++) {
      try { await S.db.update(`games/${S.code}`, openingCaches()); break; } catch (e) { await new Promise((r) => setTimeout(r, 800)); }
    }
  }
  return undefined;
}

async function backToLobby() {
  try {
    if (S.meta.status === 'live') await S.db.update(path('meta'), { status: 'ended', endedAt: S.db.TS });
    await S.db.update(`games/${S.code}`, {
      caught: null, circles: null, reveal: null, rcut: null, freeze: null, fcut: null, fz: null, prints: null,
      caches: null, bag: null, fx: null, flare: null, snap: null, scan: null, mission: null, mhold: null, mfail: null,
      'meta/status': 'lobby', 'meta/endedAt': null,
    });
  } catch (e) { toast('Couldn\'t reset the game.', 'bad'); }
}

/* ------------------------------------------------------------------ profile */

const takenColours = () => {
  const out = {};
  for (const [u, p] of Object.entries(S.players)) if (u !== S.uid) out[p.color] = p.name;
  return out;
};

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
    <div class="pick"><button class="btn btn-primary" id="pf-save">Save</button><button class="btn btn-quiet" data-action="sound">Sound and voice</button><button class="btn btn-quiet" data-action="close-sheet">Cancel</button></div>`);
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

function gpsHelp() {
  openSheet(`<h2>Allow location</h2>
    <p>The game needs your location to work. After changing the setting, reload the page.</p>
    <p><b>iPhone:</b> Settings → Privacy &amp; Security → Location Services → Safari Websites → While Using the App. Also make sure Precise Location is on.</p>
    <p><b>Android (Chrome):</b> tap the icon left of the address bar → Permissions → Location → Allow.</p>
    <div class="pick"><button class="btn btn-primary" id="sheet-ok">Reload</button><button class="btn btn-quiet" data-action="close-sheet">Close</button></div>`);
  $('#sheet-ok').onclick = () => location.reload();
}

/* ------------------------------------------------------------------ rendering */

function render() {
  if (!S.code || !S.meta || !S.db) return;
  document.body.classList.toggle('is-host', isHost());
  const ph = phase();
  if (ph === 'lobby') { show('lobby'); renderLobby(); }
  else if (ph === 'hiding' || ph === 'hunt') { show('game'); renderGame(ph); fitOnce(S.maps.game); }
  else if (ph === 'ended') { show('end'); renderEnd(); }
}

function seg(action, k, opts, cur, fmt, enabled) {
  return `<div class="seg" role="group" ${enabled ? '' : 'aria-disabled="true"'}>${opts.map((v) =>
    `<button data-action="${action}" ${k ? `data-k="${k}"` : ''} data-v="${v}" aria-pressed="${v === cur}" ${enabled ? '' : 'tabindex="-1"'}>${fmt(v)}</button>`).join('')}</div>`;
}

const openGroups = { Basics: true };
function settingsHTML(host) {
  const st = settings();
  const pool = st.pool || {};
  if (!host) {
    const rows = SETTING_GROUPS.flatMap((g) => g.items.filter((d) => d.basic)).map((d) => `<div><dt>${d.label}</dt><dd>${esc(d.fmt(st[d.k]))}</dd></div>`).join('');
    const all = SETTING_GROUPS.map((g) => `<h4>${g.title}</h4><dl class="rules-summary">${g.items.map((d) => `<div><dt>${d.label}</dt><dd>${esc(d.fmt(st[d.k]))}</dd></div>`).join('')}</dl>`).join('');
    return `<dl class="rules-summary">${rows}</dl><details class="rules-more"><summary>All rules</summary>${all}</details>`;
  }
  const presets = `<div class="setting"><div class="setting-label"><span>Start from</span><span class="muted">Hide Tag presets</span></div><div class="seg">${Object.entries(PRESETS).map(([k, p]) => `<button data-action="preset" data-v="${k}">${p.label}</button>`).join('')}</div></div>`;
  return presets + SETTING_GROUPS.map((g) => {
    const body = g.items.map((d) => `<div class="setting"><div class="setting-label"><span>${d.label}</span>${d.note ? `<span class="muted">${d.note}</span>` : ''}</div>${seg('setting', d.k, d.opts, st[d.k], d.fmt, true)}</div>`).join('');
    const poolHTML = g.title === 'Power-ups'
      ? `<div class="setting"><div class="setting-label"><span>Power-ups in play</span><span class="muted">Tap to switch one off</span></div><div class="pool">${Object.entries(POWERS).map(([k, P]) => `<button data-action="pool" data-k="${k}" aria-pressed="${pool[k] !== false}" class="${P.side}">${P.icon} ${esc(P.name)}</button>`).join('')}</div></div>`
      : '';
    const summary = g.items.filter((d) => d.basic).map((d) => d.fmt(st[d.k])).join(' · ');
    return `<details class="set-group" data-group="${g.title}" ${openGroups[g.title] ? 'open' : ''}><summary><b>${g.title}</b><span class="muted">${esc(summary)}</span></summary>${body}${poolHTML}</details>`;
  }).join('');
}

function renderLobby() {
  const host = isHost();
  const ids = Object.keys(S.players).sort(byJoin);
  const hunters = ids.filter((u) => S.players[u].role === 'seeker').length;
  $('#code-big').textContent = S.code;
  $('#host-name').textContent = name(S.meta.host);
  const me = S.players[S.uid] || {};
  setHTML($('#profile-btn'), `<span class="player-dot" style="background:${esc(me.color)}">${initial(me.name)}</span><span>${esc(me.name || 'You')}</span>`);
  $('#team-counts').textContent = `${hunters} hunter${hunters === 1 ? '' : 's'}, ${ids.length - hunters} hider${ids.length - hunters === 1 ? '' : 's'}`;
  $('#team-hint').textContent = host ? 'Tap a team to switch it, or ⋯ for more.' : 'The organiser picks the teams.';
  const t = S.db.now();
  setHTML($('#player-list'), ids.map((u) => {
    const p = S.players[u];
    const loc = u === S.uid ? (S.fix && { t }) : S.locs[u];
    const noGps = !(loc && t - loc.t < 15000);
    const chip = `<button class="role-chip ${p.role}" data-action="toggle-role" data-uid="${esc(u)}" ${host ? '' : 'tabindex="-1"'}>${p.role === 'seeker' ? 'Hunter' : 'Hider'}</button>`;
    const more = host ? `<button class="more-btn" data-action="player-menu" data-uid="${esc(u)}" aria-label="More options for ${esc(p.name)}">⋯</button>` : '';
    return playerRow(u, (noGps && (present(u) || u === S.uid) ? '<span class="tag warn">No GPS</span>' : '') + chip + more);
  }).join(''));

  const a = area();
  $('#area-size').textContent = a ? `${a.r >= 1000 ? a.r / 1000 + ' km' : a.r + ' m'} radius` : 'Not set';
  $('#area-hint').textContent = host ? (a ? 'Tap the map to move the centre.' : 'Tap the map, or centre it on yourself.') : (a ? 'Set by the organiser. Stay inside the dashed line.' : 'The organiser hasn\'t set it yet.');
  setHTML($('#area-radius'), `<div class="setting"><div class="setting-label">Size</div>${seg('area-radius', null, AREA_RADII, a ? a.r : null, (v) => (v >= 1000 ? v / 1000 + ' km' : v + ' m'), true)}</div>`);

  // Keep open/closed groups as the host left them.
  $('#settings').querySelectorAll('details.set-group').forEach((d) => { openGroups[d.dataset.group] = d.open; });
  setHTML($('#settings'), settingsHTML(host));

  setHTML($('#gps-status'), S.gpsErr && S.gpsErr.code === 1 ? `${esc(gpsLine())}. <button class="btn-link" data-action="gps-help">How to fix</button>` : esc(gpsLine()));
  const hiders = ids.length - hunters;
  $('#start').disabled = !(a && hunters && hiders);
  $('#start').textContent = !a ? 'Set the play area to start' : !hunters ? 'Pick a hunter to start' : !hiders ? 'Someone has to hide' : 'Start game';

  const mp = getMap('lobby', '#lobby-map', (lat, lng) => { if (isHost()) setArea(lat, lng, (area() && area().r) || 500); });
  mp.begin();
  drawArea(mp, false);
  for (const u of ids) {
    if (u === S.uid) continue;
    const l = S.locs[u];
    if (l) mp.pin(u, l.lat, l.lng, pinHTML(S.players[u].role, S.players[u].name, S.players[u].color));
  }
  drawMe(mp);
  mp.end();
  fitOnce(mp);
  const ak = a ? `${a.lat},${a.lng},${a.r}` : '';
  if (a && mp._areaKey !== ak) { mp._areaKey = ak; mp.fitCircle(a.lat, a.lng, a.r); }
}

const WHY = { area: 'outside the play area', burn: 'in a burned spot', breath: 'out of breath', hold: 'moved while frozen' };
function renderEnd() {
  const hs = startingHiders(), left = activeHiders();
  const hidersWin = left.length > 0;
  const t0 = huntStart();
  const catches = Object.entries(S.caught).sort((a, b) => a[1].t - b[1].t);
  const lastCatch = catches.length ? catches[catches.length - 1][1].t : null;
  const finish = hidersWin ? (S.meta.endedAt && S.meta.endedAt < huntEnd() ? S.meta.endedAt : huntEnd()) : (lastCatch || S.meta.endedAt || huntEnd());
  const head = $('#end-head');
  head.className = 'end-head ' + (hidersWin ? 'hider' : 'seeker');
  setHTML(head, hidersWin
    ? `<h1>Hiders win</h1><p>${esc(left.map(name).join(', '))} ${left.length === 1 ? 'was' : 'were'} never caught.</p>`
    : `<h1>Hunters win</h1><p>${hs.length ? `All ${hs.length} hider${hs.length === 1 ? '' : 's'} out in ${fmtClock(finish - t0)}.` : 'Nobody was left hiding.'}</p>`);

  const score = {};
  for (const [, c] of catches) if (c.how === 'gps' || c.how === 'host') score[c.by] = (score[c.by] || 0) + 1;
  const top = Math.max(0, ...Object.values(score));
  const ids = Object.keys(S.players).sort((a, b) => (score[b] || 0) - (score[a] || 0) || byJoin(a, b));
  setHTML($('#end-board'), ids.map((u) => {
    const c = S.caught[u];
    const n = score[u] || 0;
    let line;
    if (S.players[u].role === 'hider' && !c) line = `<span class="tag hider">Never caught</span>`;
    else if (c) line = `<span class="tag caught">${c.how === 'out' ? 'Eliminated' : 'Lasted'} ${fmtClock(c.t - t0)}</span>`;
    else line = `<span class="tag seeker">Hunter</span>`;
    const caughtN = n ? `<span class="tag">${n} catch${n === 1 ? '' : 'es'}${n === top && top > 0 ? ' 🏆' : ''}</span>` : '';
    return playerRow(u, caughtN + line);
  }).join(''));

  const rows = [`<li><time>0:00</time><span>The hunt started</span></li>`];
  catches.forEach(([h, c]) => {
    let who;
    if (c.how === 'out') who = `${esc(name(h))} was eliminated${c.why && WHY[c.why] ? ` (${WHY[c.why]})` : ''}`;
    else if (c.how === 'quit') who = `${esc(name(h))} left the game`;
    else if (c.how === 'self') who = `${esc(name(h))} was caught (owned up)`;
    else who = `${esc(name(c.by))} caught ${esc(name(h))}${c.how === 'host' ? ' (organiser override)' : ''}`;
    rows.push(`<li><time>${fmtClock(c.t - t0)}</time><span>${who}</span></li>`);
  });
  if (S.reveal) rows.push(`<li><time>&nbsp;</time><span>Hunters used ${S.reveal.n} reveal${S.reveal.n === 1 ? '' : 's'}${S.freeze ? ` and ${S.freeze.n} freeze${S.freeze.n === 1 ? '' : 's'}` : ''}</span></li>`);
  if (hidersWin && S.meta.endedAt && S.meta.endedAt < huntEnd() - 2000) rows.push(`<li><time>${fmtClock(S.meta.endedAt - t0)}</time><span>The organiser ended the game early</span></li>`);
  else if (hidersWin) rows.push(`<li><time>${fmtClock(huntEnd() - t0)}</time><span>Time ran out</span></li>`);
  setHTML($('#end-log'), rows.join(''));
  $('#end-host').textContent = name(S.meta.host);

  const mp = getMap('end', '#end-map');
  mp.begin();
  drawArea(mp, false);
  for (const [u, l] of Object.entries(S.locs)) {
    if (l && S.players[u]) mp.pin(u, l.lat, l.lng, pinHTML(roleOf(u), name(u), S.players[u].color));
  }
  drawMe(mp);
  mp.end();
  fitOnce(mp);
}

// For quick checks from the console.
window.__mh = { S, say, once };

boot();
