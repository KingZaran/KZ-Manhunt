// A small stand-in for Firebase Realtime Database, used only for local testing.
// It evaluates firebase/database.rules.json the way Firebase does (cascading
// .read/.write from the root down, .validate on every changed node), so the
// anti-cheat rules can be exercised without a real Firebase project.
//
// It also serves the app's static files, so a browser can load the game from it.
//
// Usage: node test/mock-server.mjs [port]

import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';

const ROOT_DIR = new URL('..', import.meta.url).pathname;
const RULES = JSON.parse(readFileSync(join(ROOT_DIR, 'firebase/database.rules.json'), 'utf8')).rules;

// RTDB rules have String.matches(regex); give JS strings the same method.
// eslint-disable-next-line no-extend-native
String.prototype.matches = function (re) { return re.test(String(this)); };
// eslint-disable-next-line no-extend-native
String.prototype.beginsWith = function (x) { return String(this).startsWith(x); };
// eslint-disable-next-line no-extend-native
String.prototype.endsWith = String.prototype.endsWith;

let tree = {};
let clockOffset = 0;
const now = () => Date.now() + clockOffset;
const log = [];

// ---------- tree helpers ----------
const split = (p) => String(p || '').split('/').filter(Boolean);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
function getAt(t, segs) {
  let cur = t;
  for (const s of segs) {
    if (cur === null || typeof cur !== 'object' || !(s in cur)) return null;
    cur = cur[s];
  }
  return cur === undefined ? null : cur;
}
function prune(v) {
  if (v === null || typeof v !== 'object') return v;
  const out = {};
  for (const [k, c] of Object.entries(v)) {
    const p = prune(c);
    if (p !== null && p !== undefined) out[k] = p;
  }
  return Object.keys(out).length ? out : null;
}
function setAt(t, segs, value) {
  if (!segs.length) return prune(clone(value)) || {};
  const root = t && typeof t === 'object' ? t : {};
  let cur = root;
  for (let i = 0; i < segs.length - 1; i++) {
    if (cur[segs[i]] === null || typeof cur[segs[i]] !== 'object') cur[segs[i]] = {};
    cur = cur[segs[i]];
  }
  cur[segs[segs.length - 1]] = clone(value);
  return prune(root) || {};
}
function resolveTimestamps(v, ts) {
  if (v && typeof v === 'object') {
    if (v['.sv'] === 'timestamp') return ts;
    const out = Array.isArray(v) ? [] : {};
    for (const [k, c] of Object.entries(v)) out[k] = resolveTimestamps(c, ts);
    return out;
  }
  return v;
}

// ---------- snapshots + rule evaluation ----------
class Snap {
  constructor(t, segs) { this.t = t; this.segs = segs; }
  child(p) { return new Snap(this.t, [...this.segs, ...split(p)]); }
  parent() { return new Snap(this.t, this.segs.slice(0, -1)); }
  val() { const v = getAt(this.t, this.segs); return v === null ? null : clone(v); }
  exists() { return getAt(this.t, this.segs) !== null; }
  hasChild(p) { return this.child(p).exists(); }
  hasChildren(list) {
    const v = getAt(this.t, this.segs);
    if (!list) return v !== null && typeof v === 'object' && Object.keys(v).length > 0;
    return list.every((k) => this.hasChild(k));
  }
  isNumber() { return typeof getAt(this.t, this.segs) === 'number'; }
  isString() { return typeof getAt(this.t, this.segs) === 'string'; }
  isBoolean() { return typeof getAt(this.t, this.segs) === 'boolean'; }
}

const compiled = new Map();
function evalRule(expr, ctx) {
  if (typeof expr === 'boolean') return expr;
  const names = ['auth', 'now', 'root', 'data', 'newData', ...Object.keys(ctx.vars)];
  const key = names.join(',') + '|' + expr;
  let fn = compiled.get(key);
  if (!fn) {
    fn = new Function(...names, `return (${expr});`);
    compiled.set(key, fn);
  }
  try {
    const r = fn(ctx.auth, ctx.now, ctx.root, ctx.data, ctx.newData, ...Object.values(ctx.vars));
    return r === true;
  } catch (e) {
    // Firebase treats an error in a rule as "false".
    return false;
  }
}

// Walk the rule tree along a path; returns [{node, segs, vars}] for root..path.
function ruleChain(segs) {
  const chain = [];
  let node = RULES;
  let vars = {};
  chain.push({ node, segs: [], vars: { ...vars } });
  for (let i = 0; i < segs.length; i++) {
    if (!node) { chain.push({ node: null, segs: segs.slice(0, i + 1), vars: { ...vars } }); continue; }
    const s = segs[i];
    let next = node[s];
    if (next === undefined) {
      const wild = Object.keys(node).find((k) => k.startsWith('$'));
      if (wild) { next = node[wild]; vars = { ...vars, [wild]: s }; }
    }
    node = next || null;
    chain.push({ node, segs: segs.slice(0, i + 1), vars: { ...vars } });
  }
  return chain;
}

function canRead(uid, segs, ts) {
  const auth = uid ? { uid, provider: 'anonymous' } : null;
  for (const { node, segs: s, vars } of ruleChain(segs)) {
    if (node && node['.read'] !== undefined &&
        evalRule(node['.read'], { auth, now: ts, root: new Snap(tree, []), data: new Snap(tree, s), newData: new Snap(tree, s), vars })) {
      return true;
    }
  }
  return false;
}

function canWriteLocation(uid, segs, oldTree, newTree, ts) {
  const auth = uid ? { uid, provider: 'anonymous' } : null;
  for (const { node, segs: s, vars } of ruleChain(segs)) {
    if (node && node['.write'] !== undefined &&
        evalRule(node['.write'], { auth, now: ts, root: new Snap(oldTree, []), data: new Snap(oldTree, s), newData: new Snap(newTree, s), vars })) {
      return true;
    }
  }
  return false;
}

// Run .validate on ancestors of the written path and every node of the new value.
function validate(uid, segs, oldTree, newTree, ts, why) {
  const auth = uid ? { uid, provider: 'anonymous' } : null;
  const ctxFor = (s, vars) => ({ auth, now: ts, root: new Snap(oldTree, []), data: new Snap(oldTree, s), newData: new Snap(newTree, s), vars });
  const chain = ruleChain(segs);
  for (const { node, segs: s, vars } of chain) {
    if (!node || node['.validate'] === undefined) continue;
    if (getAt(newTree, s) === null) continue; // validate is skipped for deletes
    if (!evalRule(node['.validate'], ctxFor(s, vars))) { why.push('/' + s.join('/')); return false; }
  }
  const last = chain[chain.length - 1];
  const walk = (node, s, vars) => {
    const v = getAt(newTree, s);
    if (v === null || typeof v !== 'object' || !node) return true;
    for (const k of Object.keys(v)) {
      let child = node[k];
      let cvars = vars;
      if (child === undefined) {
        const wild = Object.keys(node).find((x) => x.startsWith('$'));
        if (wild) { child = node[wild]; cvars = { ...vars, [wild]: k }; }
      }
      if (!child) continue;
      const cs = [...s, k];
      if (child['.validate'] !== undefined && !evalRule(child['.validate'], ctxFor(cs, cvars))) { why.push('/' + cs.join('/')); return false; }
      if (!walk(child, cs, cvars)) return false;
    }
    return true;
  };
  return walk(last.node, segs, last.vars);
}

// writes: [{segs, value}] applied atomically
function applyWrites(uid, writes) {
  const ts = now();
  const oldTree = tree;
  let newTree = clone(tree);
  const resolved = writes.map((w) => ({ segs: w.segs, value: resolveTimestamps(w.value, ts) }));
  for (const w of resolved) newTree = setAt(newTree, w.segs, w.value === undefined ? null : w.value);
  for (const w of resolved) {
    if (!canWriteLocation(uid, w.segs, oldTree, newTree, ts)) return { error: 'PERMISSION_DENIED', where: '/' + w.segs.join('/'), reason: 'write' };
    const why = [];
    if (!validate(uid, w.segs, oldTree, newTree, ts, why)) return { error: 'PERMISSION_DENIED', where: why[0], reason: 'validate' };
  }
  tree = newTree;
  notify();
  return { ok: true };
}

// ---------- listeners (one server-sent-event stream per page, like Firebase's single socket) ----------
const streams = new Map(); // sid -> { res, uid, subs: Map(id -> {segs,last}) }
function notify() {
  for (const st of streams.values()) {
    for (const [id, sub] of st.subs) {
      const v = JSON.stringify(getAt(tree, sub.segs));
      if (v !== sub.last) { sub.last = v; st.res.write(`data: {"id":${JSON.stringify(id)},"v":${v}}\n\n`); }
    }
  }
}

// ---------- static files ----------
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.webmanifest': 'application/manifest+json' };
function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = normalize(join(ROOT_DIR, p));
  if (!file.startsWith(ROOT_DIR) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(file));
}

function body(req) {
  return new Promise((resolve) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => resolve(b ? JSON.parse(b) : {})); });
}
function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' });
    return res.end();
  }
  if (url.pathname === '/__db/time') return json(res, 200, { now: now() });
  if (url.pathname === '/__db/auth') return json(res, 200, { uid: randomUUID().replace(/-/g, '').slice(0, 28) });
  if (url.pathname === '/__db/op' && req.method === 'POST') {
    const { uid, op, path, value } = await body(req);
    const segs = split(path);
    if (op === 'get') {
      if (!canRead(uid, segs, now())) return json(res, 200, { error: 'PERMISSION_DENIED' });
      return json(res, 200, { ok: true, value: getAt(tree, segs) });
    }
    let r;
    if (op === 'set') r = applyWrites(uid, [{ segs, value }]);
    else if (op === 'update') r = applyWrites(uid, Object.entries(value).map(([k, v]) => ({ segs: [...segs, ...split(k)], value: v })));
    else r = { error: 'bad op' };
    log.push({ t: now(), uid, op, path, ok: !!r.ok, where: r.where, reason: r.reason });
    return json(res, 200, r);
  }
  if (url.pathname === '/__db/stream') {
    const sid = randomUUID();
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' });
    streams.set(sid, { res, uid: url.searchParams.get('uid'), subs: new Map() });
    res.write(`event: hello\ndata: ${JSON.stringify({ sid })}\n\n`);
    req.on('close', () => streams.delete(sid));
    return;
  }
  if (url.pathname === '/__db/sub' && req.method === 'POST') {
    const { sid, id, path, off } = await body(req);
    const st = streams.get(sid);
    if (!st) return json(res, 200, { error: 'no stream' });
    if (off) { st.subs.delete(id); return json(res, 200, { ok: true }); }
    const segs = split(path);
    if (!canRead(st.uid, segs, now())) { st.res.write(`data: {"id":${JSON.stringify(id)},"denied":true}\n\n`); return json(res, 200, { ok: true }); }
    const sub = { segs, last: JSON.stringify(getAt(tree, segs)) };
    st.subs.set(id, sub);
    st.res.write(`data: {"id":${JSON.stringify(id)},"v":${sub.last}}\n\n`);
    return json(res, 200, { ok: true });
  }
  // Test controls
  if (url.pathname === '/__test/advance' && req.method === 'POST') { const { ms } = await body(req); clockOffset += ms; return json(res, 200, { now: now() }); }
  if (url.pathname === '/__test/tree') return json(res, 200, tree);
  if (url.pathname === '/__test/log') return json(res, 200, log);
  if (url.pathname === '/__test/reset' && req.method === 'POST') { tree = {}; clockOffset = 0; log.length = 0; return json(res, 200, { ok: true }); }
  return serveStatic(req, res);
});

const port = Number(process.argv[2] || 8787);
server.listen(port, () => console.log(`mock firebase + static server on http://localhost:${port}`));
export { applyWrites, canRead };
