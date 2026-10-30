// Sound effects and spoken call-outs, so you can play with the phone in your pocket.
//
// - Effects play through Web Audio (low latency, can overlap). Phones only allow audio after a
//   tap, so the first tap anywhere unlocks it.
// - On iPhone, the ringer switch would normally mute web audio. With "Play on silent" on, we ask
//   Safari for a playback audio session (Safari 16.4+). Older iPhones fall back to a silent
//   looping <audio> element, which switches the session the same way.
// - Call-outs use the phone's built-in voice (speechSynthesis), British English if available.

const BASE = new URL('../sounds/', import.meta.url).href;
const PREFS_KEY = 'soundPrefs';
const DEFAULT_PREFS = { sound: true, voice: true, vibrate: true, silentSwitch: true, volume: 0.9 };

let ctx = null;
let master = null;
let unlocked = false;
const buffers = {};
const loading = {};
const lastPlayed = {};
let prefs = loadPrefs();
let voice = null;
let keepAlive = null;

function loadPrefs() {
  try { return Object.assign({}, DEFAULT_PREFS, JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')); }
  catch (e) { return Object.assign({}, DEFAULT_PREFS); }
}
export function getPrefs() { return Object.assign({}, prefs); }
export function setPrefs(p) {
  prefs = Object.assign({}, prefs, p);
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* private mode */ }
  if (master) master.gain.value = prefs.volume;
  applySession();
  if (!prefs.voice && window.speechSynthesis) window.speechSynthesis.cancel();
}

function applySession() {
  try {
    if ('audioSession' in navigator) navigator.audioSession.type = prefs.silentSwitch ? 'playback' : 'auto';
  } catch (e) { /* not supported */ }
}

function startKeepAlive() {
  if (keepAlive || 'audioSession' in navigator || !prefs.silentSwitch) return;
  if (!/iPhone|iPad|iPod/.test(navigator.userAgent)) return;
  try {
    keepAlive = new Audio(BASE + 'silence.mp3');
    keepAlive.loop = true;
    keepAlive.setAttribute('playsinline', '');
    keepAlive.volume = 0.01;
    keepAlive.play().catch(() => { keepAlive = null; });
  } catch (e) { keepAlive = null; }
}

function pickVoice() {
  if (!window.speechSynthesis) return;
  const vs = window.speechSynthesis.getVoices();
  if (!vs.length) return;
  const score = (v) => (v.lang === 'en-GB' ? 4 : 0) + (/^en/.test(v.lang) ? 2 : 0) + (v.localService ? 1 : 0) + (/Daniel|Serena|Kate|Google UK|Arthur|Martha/.test(v.name) ? 2 : 0);
  voice = vs.slice().sort((a, b) => score(b) - score(a))[0] || null;
}
if (typeof window !== 'undefined' && window.speechSynthesis) {
  pickVoice();
  try { window.speechSynthesis.addEventListener('voiceschanged', pickVoice); } catch (e) { window.speechSynthesis.onvoiceschanged = pickVoice; }
}

// Call from a user gesture (we hook the first tap/click for you).
export function unlock() {
  try {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = prefs.volume;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    if (!unlocked) {
      // Play a moment of silence to finish unlocking on iOS.
      const b = ctx.createBuffer(1, 1, 22050);
      const s = ctx.createBufferSource();
      s.buffer = b; s.connect(ctx.destination); s.start(0);
      unlocked = true;
      applySession();
      startKeepAlive();
      if (window.speechSynthesis) {
        const u = new SpeechSynthesisUtterance(' ');
        u.volume = 0;
        window.speechSynthesis.speak(u);
      }
    }
  } catch (e) { /* audio unavailable */ }
}
if (typeof document !== 'undefined') {
  const once = () => { unlock(); };
  document.addEventListener('pointerdown', once, { capture: true });
  document.addEventListener('touchend', once, { capture: true });
  document.addEventListener('keydown', once, { capture: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
  });
}

async function load(name) {
  if (buffers[name]) return buffers[name];
  if (!loading[name]) {
    loading[name] = fetch(BASE + name + '.mp3')
      .then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
      .then((ab) => new Promise((res, rej) => ctx.decodeAudioData(ab, res, rej)))
      .then((b) => { buffers[name] = b; return b; })
      .catch(() => { delete loading[name]; return null; });
  }
  return loading[name];
}

// Fetch every sound in the background so the first play isn't delayed.
export function preload(names) {
  if (!ctx) return;
  names.forEach((n, i) => setTimeout(() => load(n), i * 40));
}

export async function play(name, opts = {}) {
  if (!prefs.sound || !ctx) return;
  const now = Date.now();
  if (lastPlayed[name] && now - lastPlayed[name] < (opts.gap || 250)) return;
  lastPlayed[name] = now;
  try {
    if (ctx.state === 'suspended') await ctx.resume();
    const b = await load(name);
    if (!b) return;
    const src = ctx.createBufferSource();
    src.buffer = b;
    const g = ctx.createGain();
    g.gain.value = opts.volume == null ? 1 : opts.volume;
    src.connect(g).connect(master);
    src.start(ctx.currentTime + (opts.delay || 0));
  } catch (e) { /* ignore */ }
}

// Speak a short call-out. High-priority lines cut off whatever is being said.
export function say(text, opts = {}) {
  if (!prefs.voice || !window.speechSynthesis || !text) return;
  try {
    const synth = window.speechSynthesis;
    if (opts.urgent) synth.cancel();
    else if (synth.pending) return; // don't let a backlog build up
    const u = new SpeechSynthesisUtterance(text);
    if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = 'en-GB';
    u.rate = opts.rate || 1.05;
    u.pitch = 1;
    u.volume = 1;
    setTimeout(() => synth.speak(u), opts.delay || 0);
  } catch (e) { /* ignore */ }
}

export function buzz(pattern) {
  if (!prefs.vibrate) return;
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) { /* iOS has no vibration */ }
}

// One call for the common case: a sound, a vibration and (optionally) a spoken line.
export function cue(name, line, opts = {}) {
  play(name, opts);
  if (opts.buzz) buzz(opts.buzz);
  if (line) say(line, { urgent: opts.urgent, delay: opts.voiceDelay == null ? 350 : opts.voiceDelay });
}

export const ALL_SOUNDS = ['tap', 'toast', 'warn', 'error', 'confirm', 'tick', 'tock', 'go', 'whistle_end', 'win', 'lose',
  'caught_me', 'caught_other', 'turned', 'reveal', 'revealed', 'reveal_ready', 'freeze_warn', 'frozen', 'released',
  'freeze_cast', 'freeze_ready', 'hold_broken', 'footprints', 'breath', 'stamina_back', 'doom', 'eliminated', 'burn',
  'out_of_area', 'mission_new', 'mission_held', 'mission_done', 'mission_fail', 'pickup', 'use', 'ghost', 'ward',
  'ward_block', 'lookout', 'decoy', 'smoke', 'silence', 'silence_end', 'jamming', 'jam_block', 'misdirection', 'flare',
  'flare_reveal', 'scan', 'boost', 'joined', 'ready'];
