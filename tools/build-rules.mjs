// Generates firebase/database.rules.json.
//
// The Firebase server evaluates these rules on every read and write, so a modified app
// or a mis-tap can't get around them. Game mechanics follow Hide Tag (see
// docs/hide-tag-reference.md). What the server enforces:
//
//  - Catches need both phones live, accurate, and within the catch distance.
//  - Hunters can't see hiders' positions except when a hider:
//      * goes dark (no update for `darkSecs`), or ignores a reveal for 20 s,
//      * has been outside the (shrinking) play area for longer than the grace period,
//      * has camped in one spot for longer than allowed plus the grace period,
//      * is caught by a failed mission (everyone, 1 min) or a Flare (if they didn't share).
//  - Reveal circles must contain the hider (unless a Smoke bomb, Silence, Jamming or
//    Misdirection is active and paid for).
//  - Reveal and Freeze have shared cooldowns on the server clock, which only boosts
//    can shorten.
//  - Freezes only land on hiders within range of a hunter.
//  - Power-ups: you can only pick one up when you're standing at the cache, only use
//    what you hold, and only use each one once.
//  - Missions are checked: you must be in the circle long enough, and failures are
//    real.
//  - Timers use the server clock.
//
// Firebase silently rejects rules that use `auth` or `parent()` inside .validate, or
// regexes with groups, so this builder refuses to generate them.
//
// Run: node tools/build-rules.mjs

import { writeFileSync } from 'node:fs';

const one = (s) => s.replace(/\s+/g, ' ').trim();
const any = (...xs) => `(${xs.map((x) => `(${x})`).join(' || ')})`;
const all = (...xs) => `(${xs.map((x) => `(${x})`).join(' && ')})`;

const FRESH_MS = 12000;
const MAX_ACC = 30;
const REVEAL_ANSWER_MS = 20000;
const M_PER_DEG_LAT = 111320;
const NEAR_ME_M = 25;           // scans, flares and freezes are placed where you stand, within this
const MISSION_FAIL_MS = 60000;  // hunters see every hider for a minute
const FLARE_DELAY_MS = 10000;
const FLARE_SHOW_MS = 60000;
const HOST_GONE_MS = 45000;
const PRESENT_MS = 20000;
const POWER_MS = { ghost: 80000, spy: 30000, smoke: 60000, silence: 120000 };
const HIDER_KINDS = ['ghost', 'ward', 'spy', 'decoy', 'smoke', 'silence', 'jamming', 'misdirection', 'flare', 'scan'];
const HUNTER_KINDS = ['reveal_ready', 'freeze_ready', 'flare', 'scan'];
const ARMED_KINDS = ['ward', 'jamming', 'misdirection'];
const SCAN_RANGES = [50, 100, 200];
const MIS_RANGES = [50, 100, 200];

const G = `root.child('games/' + $g)`;
const M = `${G}.child('meta')`;
const S = (k) => `${M}.child('settings/${k}').val()`;
const HOST = `${M}.child('host').val()`;
const STATUS = `${M}.child('status').val()`;
const LIVE = `(${STATUS} == 'live')`;
const LOBBY = `(${STATUS} == 'lobby')`;
const HS = `(${M}.child('startAt').val() + ${S('hideSecs')} * 1000)`;
const HE = `(${HS} + ${S('gameMins')} * 60000)`;
const HIDING = `(${LIVE} && now < ${HS})`;
const HUNTING = `(${LIVE} && now >= ${HS} && now < ${HE})`;
const ENDED = `(${STATUS} == 'ended' || (${LIVE} && now >= ${HE}))`;
const NOT_ACTIVE = `(${ENDED} || ${LOBBY})`;

const P = (u) => `${G}.child('players/' + ${u})`;
const IN_GAME = (u) => `${P(u)}.exists()`;
const ROLE = (u) => `${P(u)}.child('role').val()`;
const CAUGHT = (u) => `${G}.child('caught/' + ${u}).exists()`;
const SEEKER = (u) => `(${IN_GAME(u)} && (${ROLE(u)} == 'seeker' || ${CAUGHT(u)}))`;
const HIDER = (u) => `(${ROLE(u)} == 'hider' && !${CAUGHT(u)})`;
const LOC = (u) => `${G}.child('locs/' + ${u})`;
const FRESH = (u) => `(${LOC(u)}.exists() && ${LOC(u)}.child('t').val() >= now - ${FRESH_MS})`;
const ACCURATE = (u) => `${LOC(u)}.child('acc').val() <= ${MAX_ACC}`;
const SEEN = (u) => `${G}.child('seen/' + ${u})`;
const AREA = `${M}.child('area')`;
const MLON = `${AREA}.child('mlon').val()`;

const sq = (x) => `(${x}) * (${x})`;
// Squared distance in metres between two snapshots with lat/lng children.
const D2 = (a, b) => `(${sq(`(${a}.child('lat').val() - ${b}.child('lat').val()) * ${M_PER_DEG_LAT}`)} + ${sq(`(${a}.child('lng').val() - ${b}.child('lng').val()) * ${MLON}`)})`;
// Current play-area radius: shrinks linearly from the start of the hunt to the end.
const R_NOW = `(${AREA}.child('r').val() * (1 - (100 - ${S('shrinkPct')}) / 100 * (now - ${HS}) / (${HE} - ${HS})))`;
const OUTSIDE = (snap) => `(${D2(snap, AREA)} > ${sq(R_NOW)})`;

const FX = (u, k) => `${G}.child('fx/' + ${u} + '/${k}')`;
const ACTIVE = (u, k) => `(${FX(u, k)}.child('t').val() > now - ${POWER_MS[k]})`;
const BAG = (u, id) => `${G}.child('bag/' + ${u} + '/' + ${id})`;
const MISSION = `${G}.child('mission')`;
const FLARE = `${G}.child('flare')`;
const MISSION_DL = `(${MISSION}.child('t').val() + ${S('missionStart')} * 1000)`;
const FLARE_WINDOW = `(${FLARE}.child('t').val() + ${FLARE_DELAY_MS} <= now && now < ${FLARE}.child('t').val() + ${FLARE_DELAY_MS + FLARE_SHOW_MS})`;
const NO_SNAP = (u) => `(${G}.child('snap/' + ${u} + '/t').val() != ${FLARE}.child('t').val())`;

// Paying for an action with an item from your bag. `ng` = post-write games/$g snapshot.
const PAYS = (ng, item, kinds, armed = false) => all(
  `${BAG('auth.uid', item)}.exists()`,
  `!${BAG('auth.uid', item)}.child('u').exists()`,
  `${ng}.child('bag/' + auth.uid + '/' + ${item} + '/u').val() == now`,
  any(...kinds.map((k) => `${BAG('auth.uid', item)}.child('k').val() == '${k}'`)),
  armed ? `${BAG('auth.uid', item)}.child('a').exists()` : 'true',
);

const num = (min, max) => ({ '.validate': `newData.isNumber() && newData.val() >= ${min} && newData.val() <= ${max}` });
const str = (maxLen) => ({ '.validate': `newData.isString() && newData.val().length >= 1 && newData.val().length <= ${maxLen}` });
const bool = { '.validate': 'newData.isBoolean()' };
const ts = { '.validate': 'newData.isNumber()' };
const s = { '.validate': 'newData.isString()' };
const ll = { lat: num(-90, 90), lng: num(-180, 180) };
const NO_OTHER = { $other: { '.validate': false } };
const hostReset = `auth != null && !newData.exists() && auth.uid == ${HOST} && ${NOT_ACTIVE}`;
const oneOf = (field, vals) => any(...vals.map((v) => `${field} == ${typeof v === 'string' ? `'${v}'` : v}`));

// Settings, with Hide Tag's ranges.
const SETTINGS = {
  hideSecs: [0, 7200], gameMins: [1, 240], tagRadius: [3, 25], shrinkPct: [1, 100],
  runKmh: [1, 40], printSecs: [5, 3600], printLead: [0, 60],
  staminaSecs: [0, 600], refillSecs: [5, 3600], groupM: [0, 500], breathSecs: [0, 600],
  freezeM: [5, 2000], freezeCd: [5, 3600], coverSecs: [0, 300], holdSecs: [5, 600], driftM: [3, 200],
  campMins: [0, 120], campM: [10, 1000], burnM: [10, 1000], graceSecs: [5, 3600],
  missions: [0, 20], missionHold: [5, 900], missionStart: [30, 3600], missionM: [10, 1000], missionPay: [1, 5],
  supplies: [0, 20], cacheEvery: [0, 3600], pickupM: [5, 500], freeHandout: [0, 10],
  revealCooldownSecs: [5, 3600], revealRadius: [5, 2000], revealNotice: [0, 100], darkSecs: [20, 600],
};

// ---------------------------------------------------------------- per-node rules

const locWrite = (() => {
  const n = 'newData';
  const d = 'data';
  const campM2 = sq(S('campM'));
  // While live, the server tracks when you went outside the play area and where you've been camping.
  const outOk = any(
    all(OUTSIDE(n), any(
      all(`${d}.child('out').exists()`, `${n}.child('out').val() == ${d}.child('out').val()`),
      all(`!${d}.child('out').exists()`, `${n}.child('out').val() == now`))),
    all(`!${OUTSIDE(n)}`, `!${n}.child('out').exists()`),
  );
  const campOk = any(
    all(`${d}.child('camp').exists()`, `${D2(n, `${d}.child('camp')`)} <= ${campM2}`,
      `${n}.child('camp/lat').val() == ${d}.child('camp/lat').val()`,
      `${n}.child('camp/lng').val() == ${d}.child('camp/lng').val()`,
      `${n}.child('camp/since').val() == ${d}.child('camp/since').val()`),
    all(`${n}.child('camp/lat').val() == ${n}.child('lat').val()`,
      `${n}.child('camp/lng').val() == ${n}.child('lng').val()`,
      `${n}.child('camp/since').val() == now`,
      any(`!${d}.child('camp').exists()`, `${D2(n, `${d}.child('camp')`)} > ${campM2}`)),
  );
  return one(`auth != null && auth.uid == $uid && (
    !newData.exists()
    || (${IN_GAME('$uid')} && ${STATUS} != 'ended' && (!${LIVE} || (${outOk} && ${campOk}))))`);
})();

const hiderExposed = one(any(
  `data.child('t').val() < now - ${S('darkSecs')} * 1000`,
  all(`data.child('out').exists()`, `data.child('out').val() < now - ${S('graceSecs')} * 1000`),
  all(`${S('campMins')} > 0`,
    `data.child('camp/since').val() < now - (${S('campMins')} * 60 + ${S('graceSecs')}) * 1000`,
    `${HS} < now - (${S('campMins')} * 60 + ${S('graceSecs')}) * 1000`),
  all(`${G}.child('reveal').exists()`,
    `${G}.child('reveal/t').val() < now - ${REVEAL_ANSWER_MS}`,
    `${G}.child('circles/' + $uid + '/n').val() != ${G}.child('reveal/n').val()`),
  `${G}.child('mfail').val() > now - ${MISSION_FAIL_MS}`,
  all(FLARE_WINDOW, NO_SNAP('$uid'), `!${ACTIVE('$uid', 'smoke')}`),
));

const locReadFixed = one(any(
  `auth != null && auth.uid == $uid`,
  all(`auth != null`, IN_GAME('auth.uid'), any(
    ENDED,
    LOBBY,
    all(SEEKER('$uid'), any(SEEKER('auth.uid'), HIDING,
      all(HIDER('auth.uid'), ACTIVE('auth.uid', 'spy')),
      all(FLARE_WINDOW, NO_SNAP('$uid')))),
    all(HIDER('$uid'), HIDER('auth.uid')),
    all(HIDER('$uid'), SEEKER('auth.uid'), LIVE, `now >= ${HS}`, `data.exists()`, hiderExposed))),
));

// Cooldown helper: ready when now >= base - cut, where cut comes from boosts.
const cooled = (node, base, cutNode) => any(
  `now >= ${base}`,
  all(`${cutNode}.exists()`, `now >= ${base} - ${cutNode}.child('ms').val()`),
);

const FREEZE_LEN = `(${S('coverSecs')} + ${S('holdSecs')}) * 1000`;

// Items you can create in your bag.
const sideKinds = (side) => (side === 'h' ? HIDER_KINDS : HUNTER_KINDS);
const kindFor = (side) => oneOf(`newData.child('k').val()`, sideKinds(side));
const bagCreate = one(any(
  // Collected from a supply cache of your side, standing within pick-up range.
  ...['h', 's'].map((side) => all(
    `newData.child('src').val() == 'cache'`,
    side === 'h' ? HIDER('$uid') : SEEKER('$uid'),
    `${G}.child('caches/${side}/' + $id).exists()`,
    `newData.child('k').val() == ${G}.child('caches/${side}/' + $id + '/k').val()`,
    FRESH('$uid'), ACCURATE('$uid'),
    `${D2(LOC('$uid'), `${G}.child('caches/${side}/' + $id)`)} <= ${sq(S('pickupM'))}`,
  )),
  // Free hand-out at the start of the hunt.
  all(`newData.child('src').val() == 'free'`,
    any(...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => `($id == 'free${i}' && ${S('freeHandout')} >= ${i})`)),
    any(all(HIDER('$uid'), kindFor('h')), all(SEEKER('$uid'), kindFor('s')))),
  // Mission completed: every hider is paid.
  all(`newData.child('src').val() == 'mission'`, HIDER('$uid'), `${MISSION}.child('done').exists()`, kindFor('h'),
    any(...[1, 2, 3, 4, 5].map((i) => `($id == 'm' + ${MISSION}.child('id').val() + '${i}' && ${S('missionPay')} >= ${i})`))),
  // Mission failed: every hunter is paid.
  all(`newData.child('src').val() == 'fail'`, SEEKER('$uid'), `${MISSION}.child('fail').exists()`, kindFor('s'),
    any(...[1, 2, 3, 4, 5].map((i) => `($id == 'f' + ${MISSION}.child('id').val() + '${i}' && ${S('missionPay')} >= ${i})`))),
));

const NG_FROM_ITEM = 'newData.parent().parent().parent()';           // bag/$uid/$id -> games/$g
const NG_FROM_ITEM_FIELD = 'newData.parent().parent().parent().parent()'; // bag/$uid/$id/u

// Using an item (writing its `u`) must come with the matching effect in the same update.
const ITEM = `${G}.child('bag/' + $uid + '/' + $id)`;
const itemUse = one(all(
  `auth != null`, `auth.uid == $uid`, `!data.exists()`, `newData.val() == now`, HUNTING, `${ITEM}.exists()`,
  any(
    ...['ghost', 'spy', 'smoke', 'silence'].map((k) => all(
      `${ITEM}.child('k').val() == '${k}'`, HIDER('$uid'),
      `${NG_FROM_ITEM_FIELD}.child('fx/' + $uid + '/${k}/item').val() == $id`,
      `${NG_FROM_ITEM_FIELD}.child('fx/' + $uid + '/${k}/t').val() == now`)),
    all(`${ITEM}.child('k').val() == 'decoy'`, HIDER('$uid')),
    all(`${ITEM}.child('k').val() == 'reveal_ready'`, SEEKER('$uid'), `${NG_FROM_ITEM_FIELD}.child('rcut/item').val() == $id`),
    all(`${ITEM}.child('k').val() == 'freeze_ready'`, SEEKER('$uid'), `${NG_FROM_ITEM_FIELD}.child('fcut/item').val() == $id`),
    all(`${ITEM}.child('k').val() == 'flare'`, `${NG_FROM_ITEM_FIELD}.child('flare/item').val() == $id`, `${NG_FROM_ITEM_FIELD}.child('flare/t').val() == now`),
    all(`${ITEM}.child('k').val() == 'scan'`, `${NG_FROM_ITEM_FIELD}.child('scan/' + $id + '/by').val() == $uid`),
    all(`${ITEM}.child('k').val() == 'ward'`, `${ITEM}.child('a').exists()`, `${NG_FROM_ITEM_FIELD}.child('fz/' + $uid + '/ward').val() == $id`),
    all(`${ITEM}.child('k').val() == 'jamming'`, `${ITEM}.child('a').exists()`, `${NG_FROM_ITEM_FIELD}.child('circles/' + $uid + '/jam').val() == $id`),
    all(`${ITEM}.child('k').val() == 'misdirection'`, `${ITEM}.child('a').exists()`, `${NG_FROM_ITEM_FIELD}.child('circles/' + $uid + '/mis').val() == $id`),
  ),
));

const missionCircle = (c, who) => `${MISSION}.child('${c}')`;
const IN_MISSION = (u, cField) => any(
  all(`${cField} == 'a'`, `${D2(LOC(u), `${MISSION}.child('a')`)} <= ${sq(`${MISSION}.child('r').val()`)}`),
  all(`${cField} == 'b'`, `${D2(LOC(u), `${MISSION}.child('b')`)} <= ${sq(`${MISSION}.child('r').val()`)}`),
);
void missionCircle;

const rules = {
  rules: {
    '.read': false,
    '.write': false,
    games: {
      $g: {
        '.validate': `$g.matches(/^[A-Z2-9]{5}$/)`,

        meta: {
          '.read': 'auth != null',
          '.write': one(`auth != null && (
            (!data.exists() && newData.child('host').val() == auth.uid)
            || (data.exists() && data.child('host').val() == auth.uid
                && (newData.child('host').val() == auth.uid
                    || newData.parent().child('players/' + newData.child('host').val()).exists())))`),
          '.validate': one(`newData.hasChildren(['host', 'status', 'settings', 'createdAt'])
            && (newData.child('status').val() != 'live'
                || (newData.child('area').exists() && newData.child('startAt').isNumber()))`),
          host: {
            '.write': one(`auth != null && newData.val() == auth.uid && data.exists() && data.val() != auth.uid
              && ${IN_GAME('auth.uid')} && ${SEEN('auth.uid')}.val() > now - ${PRESENT_MS}
              && (!${G}.child('players/' + ${HOST}).exists()
                  || ${SEEN(HOST)}.val() < now - ${HOST_GONE_MS}
                  || (!${SEEN(HOST)}.exists() && ${M}.child('createdAt').val() < now - ${HOST_GONE_MS}))`),
            '.validate': 'newData.isString()',
          },
          status: { '.validate': `newData.val() == 'lobby' || newData.val() == 'live' || newData.val() == 'ended'` },
          createdAt: ts,
          startAt: { '.validate': `newData.isNumber() && (newData.val() == now || newData.val() == data.val())` },
          endedAt: ts,
          settings: {
            '.validate': `newData.hasChildren(['hideSecs', 'gameMins', 'tagRadius', 'revealCooldownSecs', 'revealRadius', 'darkSecs'])`,
            ...Object.fromEntries(Object.entries(SETTINGS).map(([k, [a, b]]) => [k, num(a, b)])),
            strictHolds: bool,
            pool: { $k: bool },
            ...NO_OTHER,
          },
          area: { '.validate': `newData.hasChildren(['lat', 'lng', 'r', 'mlon'])`, ...ll, r: num(50, 20000), mlon: num(1, M_PER_DEG_LAT), ...NO_OTHER },
          ...NO_OTHER,
        },

        players: {
          '.read': 'auth != null',
          $uid: {
            // Join as a hider in the lobby, or as a hunter mid-game. Leave any time.
            '.write': one(`auth != null && (
              (${LOBBY} && auth.uid == ${HOST})
              || (auth.uid == $uid && !newData.exists())
              || (auth.uid == $uid && data.exists() && newData.exists() && newData.child('role').val() == data.child('role').val())
              || (auth.uid == $uid && !data.exists() && ((${LOBBY} && newData.child('role').val() == 'hider') || (${LIVE} && newData.child('role').val() == 'seeker'))))`),
            '.validate': `newData.hasChildren(['name', 'role', 'color', 'joinedAt'])`,
            name: str(20),
            role: { '.validate': `newData.val() == 'hider' || newData.val() == 'seeker'` },
            color: str(9),
            joinedAt: ts,
            ...NO_OTHER,
          },
        },

        seen: {
          '.read': `auth != null && ${IN_GAME('auth.uid')}`,
          $uid: {
            '.write': `auth != null && auth.uid == $uid && (${IN_GAME('$uid')} || !newData.exists())`,
            '.validate': 'newData.val() == now',
          },
        },

        locs: {
          $uid: {
            '.read': locReadFixed,
            '.write': locWrite,
            '.validate': `newData.hasChildren(['lat', 'lng', 'acc', 't']) && newData.child('t').val() == now`,
            ...ll,
            acc: num(0, 100000),
            t: ts,
            out: ts,
            camp: { '.validate': `newData.hasChildren(['lat', 'lng', 'since'])`, ...ll, since: ts, ...NO_OTHER },
            ...NO_OTHER,
          },
        },

        caught: {
          '.read': `auth != null && ${IN_GAME('auth.uid')}`,
          '.write': hostReset,
          $h: {
            '.write': one(`auth != null && (
              (!data.exists() && newData.exists() && ${HUNTING} && ${ROLE('$h')} == 'hider'
                && newData.child('by').val() == auth.uid && newData.child('t').val() == now
                && (
                  (newData.child('how').val() == 'gps' && $h != auth.uid && ${SEEKER('auth.uid')}
                    && ${FRESH('auth.uid')} && ${FRESH('$h')}
                    && ${ACCURATE('auth.uid')} && ${ACCURATE('$h')}
                    && ${D2(LOC('auth.uid'), LOC('$h'))} <= ${sq(S('tagRadius'))})
                  || ((newData.child('how').val() == 'self' || newData.child('how').val() == 'out' || newData.child('how').val() == 'quit') && auth.uid == $h)
                  || (newData.child('how').val() == 'host' && auth.uid == ${HOST})))
              || (data.exists() && !newData.exists() && auth.uid == ${HOST}))`),
            '.validate': `newData.hasChildren(['by', 't', 'how'])`,
            by: s,
            t: ts,
            how: { '.validate': oneOf('newData.val()', ['gps', 'self', 'host', 'out', 'quit']) },
            why: str(12),
            ...NO_OTHER,
          },
        },

        // ---------------- reveal ----------------
        reveal: {
          '.read': `auth != null && ${IN_GAME('auth.uid')}`,
          '.write': one(any(
            all(HUNTING, SEEKER('auth.uid'),
              `newData.child('by').val() == auth.uid`, `newData.child('t').val() == now`,
              `!newData.parent().child('rcut').exists()`,
              any(
                all(`!data.exists()`, `newData.child('n').val() == 1`,
                  cooled('reveal', `${HS} + ${S('revealCooldownSecs')} * 1000`, `${G}.child('rcut')`)),
                all(`data.exists()`, `newData.child('n').val() == data.child('n').val() + 1`,
                  cooled('reveal', `data.child('t').val() + ${S('revealCooldownSecs')} * 1000`, `${G}.child('rcut')`)))),
            `!newData.exists() && auth.uid == ${HOST} && ${NOT_ACTIVE}`)),
          '.validate': `newData.hasChildren(['n', 't', 'by'])`,
          n: ts, t: ts, by: s,
          ...NO_OTHER,
        },
        // Reveal boost: each one takes half the full cooldown off the remaining wait.
        rcut: {
          '.read': `auth != null && ${IN_GAME('auth.uid')}`,
          '.write': one(any(
            all(HUNTING, SEEKER('auth.uid'), PAYS('newData.parent()', `newData.child('item').val()`, ['reveal_ready']),
              any(all(`!data.exists()`, `newData.child('ms').val() == ${S('revealCooldownSecs')} * 500`),
                all(`data.exists()`, `newData.child('ms').val() == data.child('ms').val() + ${S('revealCooldownSecs')} * 500`))),
            // cleared when a reveal is sent
            all(`!newData.exists()`, `newData.parent().child('reveal/t').val() == now`),
            hostReset)),
          '.validate': `newData.hasChildren(['ms', 'item'])`,
          ms: ts, item: s, ...NO_OTHER,
        },

        circles: {
          '.read': `auth != null && ${IN_GAME('auth.uid')}`,
          '.write': hostReset,
          $h: {
            '.write': one(any(
              all(`auth != null`, `auth.uid == $h`, HIDER('$h'), LIVE, `${G}.child('reveal').exists()`,
                `newData.child('n').val() == ${G}.child('reveal/n').val()`,
                `data.child('n').val() != newData.child('n').val()`,
                `newData.child('t').val() == now`,
                any(
                  // A real circle that contains you.
                  all(`!newData.child('skip').exists()`, `!newData.child('jam').exists()`, `!newData.child('mis').exists()`,
                    `newData.child('r').val() == ${S('revealRadius')}`, FRESH('$h'),
                    `${D2('newData', LOC('$h'))} <= ${sq(S('revealRadius'))}`),
                  // Protected by an active Smoke bomb or Silence.
                  all(`newData.child('skip').val() == 'smoke'`, ACTIVE('$h', 'smoke')),
                  all(`newData.child('skip').val() == 'silence'`, ACTIVE('$h', 'silence')),
                  // Jamming charge spent on this reveal.
                  all(`newData.child('skip').val() == 'jam'`, PAYS('newData.parent().parent()', `newData.child('jam').val()`, ['jamming'], true)),
                  // Misdirection: the circle lands on a marker away from you.
                  all(`!newData.child('skip').exists()`, PAYS('newData.parent().parent()', `newData.child('mis').val()`, ['misdirection'], true),
                    `newData.child('r').val() == ${S('revealRadius')}`, FRESH('$h'),
                    `${D2('newData', LOC('$h'))} <= ${sq(`${BAG('auth.uid', `newData.child('mis').val()`)}.child('m').val() + ${S('revealRadius')}`)}`))),
              `!newData.exists() && auth.uid == ${HOST} && ${NOT_ACTIVE}`)),
            '.validate': `newData.hasChildren(['n', 't'])`,
            n: ts, t: ts, ...ll, r: ts, skip: s, jam: s, mis: s,
            ...NO_OTHER,
          },
        },

        // ---------------- freeze ----------------
        freeze: {
          '.read': `auth != null && ${IN_GAME('auth.uid')}`,
          '.write': one(any(
            all(HUNTING, SEEKER('auth.uid'), FRESH('auth.uid'),
              `newData.child('by').val() == auth.uid`, `newData.child('t').val() == now`,
              `!newData.parent().child('fcut').exists()`,
              any(
                all(`!data.exists()`, `newData.child('n').val() == 1`,
                  cooled('freeze', `${HS} + ${S('freezeCd')} * 1000`, `${G}.child('fcut')`)),
                all(`data.exists()`, `newData.child('n').val() == data.child('n').val() + 1`,
                  cooled('freeze', `data.child('t').val() + ${FREEZE_LEN} + ${S('freezeCd')} * 1000`, `${G}.child('fcut')`)))),
            `!newData.exists() && auth.uid == ${HOST} && ${NOT_ACTIVE}`)),
          '.validate': `newData.hasChildren(['n', 't', 'by'])`,
          n: ts, t: ts, by: s,
          ...NO_OTHER,
        },
        fcut: {
          '.read': `auth != null && ${IN_GAME('auth.uid')}`,
          '.write': one(any(
            all(HUNTING, SEEKER('auth.uid'), PAYS('newData.parent()', `newData.child('item').val()`, ['freeze_ready']),
              any(all(`!data.exists()`, `newData.child('ms').val() == ${S('freezeCd')} * 500`),
                all(`data.exists()`, `newData.child('ms').val() == data.child('ms').val() + ${S('freezeCd')} * 500`))),
            all(`!newData.exists()`, `newData.parent().child('freeze/t').val() == now`),
            hostReset)),
          '.validate': `newData.hasChildren(['ms', 'item'])`,
          ms: ts, item: s, ...NO_OTHER,
        },
        // A hider records that a freeze landed on them: only allowed if a hunter really was in range.
        fz: {
          '.read': `auth != null && ${IN_GAME('auth.uid')}`,
          '.write': hostReset,
          $h: {
            '.write': one(any(
              all(`auth != null`, `auth.uid == $h`, HIDER('$h'), HUNTING, `${G}.child('freeze').exists()`,
                `newData.child('n').val() == ${G}.child('freeze/n').val()`,
                `data.child('n').val() != newData.child('n').val()`,
                `newData.child('t').val() == now`,
                `now <= ${G}.child('freeze/t').val() + ${S('coverSecs')} * 1000 + 5000`,
                SEEKER(`newData.child('by').val()`), FRESH('$h'),
                `${LOC(`newData.child('by').val()`)}.child('t').val() >= now - 30000`,
                `${D2(LOC('$h'), LOC(`newData.child('by').val()`))} <= ${sq(S('freezeM'))}`,
                any(`!newData.child('ward').exists()`, PAYS('newData.parent().parent()', `newData.child('ward').val()`, ['ward'], true))),
              `!newData.exists() && auth.uid == ${HOST} && ${NOT_ACTIVE}`)),
            '.validate': `newData.hasChildren(['n', 't', 'by'])`,
            n: ts, t: ts, by: s, ward: s, broke: ts, out: ts,
            ...NO_OTHER,
          },
        },

        // ---------------- footprints ----------------
        prints: {
          '.read': `auth != null && ${IN_GAME('auth.uid')}`,
          '.write': hostReset,
          $uid: {
            $k: {
              '.write': `auth != null && auth.uid == $uid && ${HIDER('$uid')} && ${LIVE} && !data.exists()`,
              '.validate': `newData.hasChildren(['lat', 'lng', 't']) && newData.child('t').val() == now`,
              ...ll, t: ts, ...NO_OTHER,
            },
          },
        },

        // ---------------- supplies and power-ups ----------------
        caches: {
          '.write': hostReset,
          ...Object.fromEntries(['h', 's'].map((side) => [side, {
            '.read': `auth != null && ${side === 'h' ? HIDER('auth.uid') : SEEKER('auth.uid')}`,
            $c: {
              '.write': `auth != null && auth.uid == ${HOST} && ${LIVE} && !data.exists() && newData.exists()`,
              '.validate': `newData.hasChildren(['lat', 'lng', 'k', 't'])`,
              ...ll, t: ts,
              k: { '.validate': oneOf('newData.val()', sideKinds(side)) },
              ...NO_OTHER,
            },
          }])),
        },
        bag: {
          '.write': hostReset,
          $uid: {
            '.read': `auth != null && auth.uid == $uid`,
            $id: {
              '.write': one(`auth != null && auth.uid == $uid && ${HUNTING} && !data.exists() && newData.exists()
                && newData.child('t').val() == now && !newData.child('a').exists() && !newData.child('u').exists() && ${bagCreate}`),
              '.validate': `newData.hasChildren(['k', 'src', 't'])`,
              k: { '.validate': oneOf('newData.val()', [...new Set([...HIDER_KINDS, ...HUNTER_KINDS])]) },
              src: { '.validate': oneOf('newData.val()', ['cache', 'free', 'mission', 'fail']) },
              t: ts,
              // Arm a Ward, Jamming or Misdirection; it's spent later by the thing it protects against.
              a: {
                '.write': one(all(`auth != null`, `auth.uid == $uid`, `!data.exists()`, `newData.val() == now`, HUNTING, HIDER('$uid'),
                  `${ITEM}.exists()`, `!${ITEM}.child('u').exists()`,
                  oneOf(`${ITEM}.child('k').val()`, ARMED_KINDS),
                  any(`${ITEM}.child('k').val() != 'misdirection'`, oneOf(`newData.parent().child('m').val()`, MIS_RANGES)))),
                '.validate': 'newData.isNumber()',
              },
              m: {
                '.write': one(all(`auth != null`, `auth.uid == $uid`, `!data.exists()`, `${ITEM}.child('k').val() == 'misdirection'`, `newData.parent().child('a').val() == now`)),
                '.validate': oneOf('newData.val()', MIS_RANGES),
              },
              u: { '.write': itemUse, '.validate': 'newData.isNumber()' },
              ...NO_OTHER,
            },
          },
        },
        fx: {
          '.read': `auth != null && ${IN_GAME('auth.uid')}`,
          '.write': hostReset,
          $uid: {
            $kind: {
              '.write': one(all(`auth != null`, `auth.uid == $uid`, HUNTING, HIDER('$uid'),
                `newData.child('t').val() == now`,
                PAYS('newData.parent().parent().parent()', `newData.child('item').val()`, ['$kind']).replace(`'$kind'`, '$kind'),
                oneOf('$kind', ['ghost', 'spy', 'smoke', 'silence']))),
              '.validate': `newData.hasChildren(['t', 'item'])`,
              t: ts, item: s, ...NO_OTHER,
            },
          },
        },

        // Flare: everyone shares where they are; after 10 s everyone sees it for a minute.
        flare: {
          '.read': `auth != null && ${IN_GAME('auth.uid')}`,
          '.write': one(any(
            all(HUNTING, IN_GAME('auth.uid'), `newData.child('by').val() == auth.uid`, `newData.child('t').val() == now`,
              PAYS('newData.parent()', `newData.child('item').val()`, ['flare'])),
            hostReset)),
          '.validate': `newData.hasChildren(['t', 'by', 'item'])`,
          t: ts, by: s, item: s, ...NO_OTHER,
        },
        snap: {
          '.read': `auth != null && ${IN_GAME('auth.uid')} && ${FLARE}.child('t').val() + ${FLARE_DELAY_MS} <= now`,
          '.write': hostReset,
          $uid: {
            '.write': one(all(`auth != null`, `auth.uid == $uid`, LIVE, IN_GAME('$uid'),
              `newData.child('t').val() == ${FLARE}.child('t').val()`, `now <= ${FLARE}.child('t').val() + ${FLARE_DELAY_MS}`,
              FRESH('$uid'), `${D2('newData', LOC('$uid'))} <= ${NEAR_ME_M * NEAR_ME_M}`)),
            '.validate': `newData.hasChildren(['lat', 'lng', 't'])`,
            ...ll, t: ts, ...NO_OTHER,
          },
        },

        // Scan: counts the other side within range. Every answer is checked against real positions.
        scan: {
          '.read': `auth != null && ${IN_GAME('auth.uid')}`,
          '.write': hostReset,
          $id: {
            '.write': one(all(`auth != null`, HUNTING, `!data.exists()`, `newData.child('by').val() == auth.uid`,
              `newData.child('t').val() == now`, oneOf(`newData.child('r').val()`, SCAN_RANGES),
              any(all(`newData.child('side').val() == 'h'`, HIDER('auth.uid')), all(`newData.child('side').val() == 's'`, SEEKER('auth.uid'))),
              FRESH('auth.uid'), `${D2('newData', LOC('auth.uid'))} <= ${NEAR_ME_M * NEAR_ME_M}`,
              `${G}.child('bag/' + auth.uid + '/' + $id + '/k').val() == 'scan'`,
              `newData.parent().parent().child('bag/' + auth.uid + '/' + $id + '/u').val() == now`)),
            '.validate': `newData.hasChildren(['by', 't', 'r', 'side', 'lat', 'lng'])`,
            by: s, t: ts, r: ts, side: s, ...ll,
            a: {
              $uid: {
                '.write': one(all(`auth != null`, `auth.uid == $uid`, `!data.exists()`,
                  `now <= ${G}.child('scan/' + $id + '/t').val() + 30000`,
                  any(
                    all(`${G}.child('scan/' + $id + '/side').val() == 'h'`, SEEKER('$uid')),
                    all(`${G}.child('scan/' + $id + '/side').val() == 's'`, HIDER('$uid'))),
                  any(
                    all(`newData.val() == false`, ACTIVE('$uid', 'smoke')),
                    all(FRESH('$uid'), `newData.val() == (${D2(LOC('$uid'), `${G}.child('scan/' + $id)`)} <= ${sq(`${G}.child('scan/' + $id + '/r').val()`)})`)))),
                '.validate': 'newData.isBoolean()',
              },
            },
            ...NO_OTHER,
          },
        },

        // ---------------- missions ----------------
        mission: {
          '.read': `auth != null && ${IN_GAME('auth.uid')}`,
          '.write': one(any(
            // The organiser opens a new wave once the last one is over.
            all(`auth != null`, `auth.uid == ${HOST}`, LIVE, `newData.exists()`,
              any(`!data.exists()`, `data.child('done').exists()`, `data.child('fail').exists()`),
              `newData.child('id').val() != data.child('id').val()`,
              `newData.child('t').val() == now`,
              `newData.child('r').val() == ${S('missionM')}`,
              `!newData.child('done').exists()`, `!newData.child('fail').exists()`, `!newData.child('first').exists()`),
            hostReset)),
          '.validate': `newData.hasChildren(['id', 'a', 'b', 'r', 't'])`,
          id: str(12), t: ts, r: ts,
          a: { ...ll, ...NO_OTHER },
          b: { ...ll, ...NO_OTHER },
          // First hider to start the mission (before the deadline).
          first: {
            '.write': one(all(`auth != null`, `!data.exists()`, HIDER('auth.uid'), `newData.child('by').val() == auth.uid`,
              `newData.child('t').val() == now`, `now <= ${MISSION_DL}`,
              `newData.parent().parent().child('mhold/' + auth.uid + '/w').val() == ${MISSION}.child('id').val()`)),
            by: s, t: ts, ...NO_OTHER,
          },
          // Completed: you've held it long enough and you're still inside.
          done: {
            '.write': one(all(`auth != null`, `!data.exists()`, HUNTING, HIDER('auth.uid'), `!${MISSION}.child('fail').exists()`,
              `newData.child('by').val() == auth.uid`, `newData.child('t').val() == now`,
              `${G}.child('mhold/' + auth.uid + '/w').val() == ${MISSION}.child('id').val()`,
              `${G}.child('mhold/' + auth.uid + '/since').val() <= now - ${S('missionHold')} * 1000`,
              FRESH('auth.uid'), IN_MISSION('auth.uid', `${G}.child('mhold/' + auth.uid + '/c').val()`))),
            by: s, t: ts, ...NO_OTHER,
          },
          // Failed: nobody started in time, or everyone holding it left after the deadline.
          fail: {
            '.write': one(all(`auth != null`, `!data.exists()`, HUNTING, IN_GAME('auth.uid'), `newData.val() == now`,
              `!${MISSION}.child('done').exists()`, `now > ${MISSION_DL}`,
              any(`!${MISSION}.child('first').exists()`, `!newData.parent().parent().child('mhold').exists()`),
              `newData.parent().parent().child('mfail').val() == now`)),
            '.validate': 'newData.isNumber()',
          },
          ...NO_OTHER,
        },
        mfail: {
          '.read': `auth != null && ${IN_GAME('auth.uid')}`,
          '.write': one(any(all(`auth != null`, `newData.val() == now`, `newData.parent().child('mission/fail').val() == now`), hostReset)),
          '.validate': 'newData.isNumber()',
        },
        mhold: {
          '.read': `auth != null && ${IN_GAME('auth.uid')}`,
          '.write': `auth != null && auth.uid == ${HOST} && !newData.exists()`,
          $uid: {
            '.write': one(any(
              all(`auth != null`, `auth.uid == $uid`, `!newData.exists()`),
              all(`auth != null`, `auth.uid == $uid`, HUNTING, HIDER('$uid'), `${MISSION}.exists()`,
                `!${MISSION}.child('done').exists()`, `!${MISSION}.child('fail').exists()`,
                `newData.child('w').val() == ${MISSION}.child('id').val()`, `newData.child('since').val() == now`,
                FRESH('$uid'), IN_MISSION('$uid', `newData.child('c').val()`)))),
            '.validate': `newData.hasChildren(['w', 'c', 'since'])`,
            w: s, since: ts,
            c: { '.validate': `newData.val() == 'a' || newData.val() == 'b'` },
            ...NO_OTHER,
          },
        },

        ...NO_OTHER,
      },
    },
  },
};

// ---------------------------------------------------------------- guards + output

JSON.stringify(rules, (k, v) => {
  if (k === '.validate' && typeof v === 'string' && /\bauth\b|parent\(\)/.test(v)) throw new Error(`.validate can't use auth or parent(): ${v.slice(0, 80)}`);
  if (typeof v === 'string') {
    for (const m of v.matchAll(/\.matches\(\/(.*?)\/\)/g)) {
      if (/[|()]/.test(m[1])) throw new Error(`Unsupported regex in rule "${k}": /${m[1]}/ (no groups or |)`);
    }
    if (/\ball\(|\bany\(/.test(v)) throw new Error(`Unexpanded helper in rule "${k}": ${v.slice(0, 120)}`);
  }
  return v;
});

const out = new URL('../firebase/database.rules.json', import.meta.url);
writeFileSync(out, JSON.stringify(rules, null, 2) + '\n');
console.log('wrote', out.pathname, JSON.stringify(rules).length, 'bytes');
