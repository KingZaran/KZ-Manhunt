// Test stand-in for firebase-database.js, talking to test/mock-server.mjs.
let base = '';
const split = (p) => String(p || '').split('/').filter(Boolean);
const mkref = (path) => { const s = split(path); return { path: s.join('/'), key: s.length ? s[s.length - 1] : null }; };
const snap = (r, v) => ({ key: r.key, val: () => (v === undefined ? null : v), exists: () => v !== null && v !== undefined });
const denied = () => { const e = new Error('PERMISSION_DENIED: Permission denied'); e.code = 'PERMISSION_DENIED'; return e; };

async function call(op, path, value) {
  const r = await (await fetch(base + '/__db/op', { method: 'POST', body: JSON.stringify({ uid: window.__shimUid, op, path, value }) })).json();
  if (r.error) throw denied();
  return r;
}

export function getDatabase(app) { base = app.options.databaseURL; return { app }; }
export function ref(db, path) { return mkref(path); }
export function child(r, p) { return mkref(r.path + '/' + p); }
export async function get(r) { const res = await call('get', r.path); return snap(r, res.value); }
export async function set(r, v) { await call('set', r.path, v); }
export async function update(r, v) { await call('update', r.path, v); }
export async function remove(r) { await call('set', r.path, null); }
export function serverTimestamp() { return { '.sv': 'timestamp' }; }
export function onDisconnect() { return { remove: async () => {}, set: async () => {}, cancel: async () => {} }; }

export function onValue(r, cb, errCb) {
  if (r.path === '.info/serverTimeOffset') {
    let stop = false;
    const tick = async () => {
      if (stop) return;
      try { const { now } = await (await fetch(base + '/__db/time')).json(); cb(snap(r, now - Date.now())); } catch (e) { /* ignore */ }
      setTimeout(tick, 1000);
    };
    tick();
    return () => { stop = true; };
  }
  if (r.path === '.info/connected') { setTimeout(() => cb(snap(r, true)), 0); return () => {}; }
  const id = String(++nextId);
  handlers.set(id, { cb: (v) => cb(snap(r, v)), err: () => { handlers.delete(id); if (errCb) errCb(denied()); } });
  stream().then((sid) => fetch(base + '/__db/sub', { method: 'POST', body: JSON.stringify({ sid, id, path: r.path }) }));
  return () => {
    if (!handlers.delete(id)) return;
    stream().then((sid) => fetch(base + '/__db/sub', { method: 'POST', body: JSON.stringify({ sid, id, off: true }) }));
  };
}

// One event stream per page (Firebase uses one WebSocket); browsers cap open connections per host.
let nextId = 0;
const handlers = new Map();
let streamP = null;
function stream() {
  if (!streamP) {
    streamP = new Promise((resolve) => {
      const es = new EventSource(base + '/__db/stream?uid=' + encodeURIComponent(window.__shimUid || ''));
      es.addEventListener('hello', (e) => resolve(JSON.parse(e.data).sid));
      es.onmessage = (e) => {
        const m = JSON.parse(e.data);
        const h = handlers.get(m.id);
        if (!h) return;
        if (m.denied) h.err(); else h.cb(m.v);
      };
    });
  }
  return streamP;
}
