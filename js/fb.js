// Thin wrapper around the Firebase SDK (loaded from Google's CDN, no build step).
import { firebaseConfig } from './config.js?v=mvvfeq0n';

const CDN = 'https://www.gstatic.com/firebasejs/10.12.2/';

export const isConfigured = () => !String(firebaseConfig.apiKey || '').includes('PASTE_ME');

export function isDenied(e) {
  return !!e && (e.code === 'PERMISSION_DENIED' || /permission.denied/i.test(String(e.message || '')));
}

export async function connect() {
  const [appM, authM, dbM] = await Promise.all([
    import(CDN + 'firebase-app.js'),
    import(CDN + 'firebase-auth.js'),
    import(CDN + 'firebase-database.js'),
  ]);
  const app = appM.initializeApp(firebaseConfig);
  const auth = authM.getAuth(app);
  const db = dbM.getDatabase(app);

  const uid = await new Promise((resolve, reject) => {
    let unsub = null;
    let done = false;
    unsub = authM.onAuthStateChanged(auth, (user) => {
      if (user) {
        if (!done) { done = true; resolve(user.uid); }
        if (unsub) unsub();
      } else {
        authM.signInAnonymously(auth).catch(reject);
      }
    });
  });

  let offset = 0;
  dbM.onValue(dbM.ref(db, '.info/serverTimeOffset'), (s) => { offset = Number(s.val()) || 0; });

  const r = (p) => dbM.ref(db, p);
  return {
    uid,
    TS: dbM.serverTimestamp(),
    now: () => Date.now() + offset,
    get: async (p) => (await dbM.get(r(p))).val(),
    set: (p, v) => dbM.set(r(p), v),
    update: (p, v) => dbM.update(r(p), v),
    remove: (p) => dbM.remove(r(p)),
    on: (p, cb, err) => dbM.onValue(r(p), (s) => cb(s.val()), (e) => err && err(e)),
  };
}
