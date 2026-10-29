// Test stand-in for firebase-auth.js (anonymous sign-in only).
let base = '';
const auth = { currentUser: null, _cbs: [] };

export function getAuth(app) {
  base = app.options.databaseURL;
  const uid = localStorage.getItem('shimUid');
  if (uid) { auth.currentUser = { uid }; window.__shimUid = uid; }
  return auth;
}
export async function signInAnonymously(a) {
  const { uid } = await (await fetch(base + '/__db/auth')).json();
  localStorage.setItem('shimUid', uid);
  window.__shimUid = uid;
  a.currentUser = { uid };
  a._cbs.forEach((cb) => cb(a.currentUser));
  return { user: a.currentUser };
}
export function onAuthStateChanged(a, cb) {
  a._cbs.push(cb);
  setTimeout(() => cb(a.currentUser), 0);
  return () => { a._cbs = a._cbs.filter((x) => x !== cb); };
}
