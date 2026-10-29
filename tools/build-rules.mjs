// Generates firebase/database.rules.json.
//
// The anti-cheat lives here: the Firebase server evaluates these rules on every
// read and write, so a modified app or a mis-tap can't get around them.
//
//  - A GPS catch is only accepted if the seeker and the hider each sent a GPS fix
//    in the last 12 seconds, both fixes are reasonably accurate, and they are
//    within the game's catch radius (5-20 m) of each other.
//  - Seekers can NOT read hiders' positions, except when a hider:
//      * has gone dark (no location update for `darkSecs`),
//      * is outside the play area, or
//      * ignored a Reveal for more than 20 seconds (phone locked / app closed).
//  - Reveal circles are written by each hider's own phone, and the rules check
//    that the hider really is inside the circle they publish.
//  - Reveals have a shared cooldown enforced with the server clock.
//  - Timers use the server clock, so changing a phone's time does nothing.
//
// Run: node tools/build-rules.mjs

import { writeFileSync } from 'node:fs';

const FRESH_MS = 12000;      // a location counts as "live" for this long
const MAX_ACC = 30;          // metres; worse GPS than this can't be used for a catch
const REVEAL_ANSWER_MS = 20000;
const M_PER_DEG_LAT = 111320;

const G = `root.child('games/' + $g)`;
const M = `${G}.child('meta')`;
const S = (k) => `${M}.child('settings/${k}').val()`;
const HOST = `${M}.child('host').val()`;
const STATUS = `${M}.child('status').val()`;
const LIVE = `(${STATUS} == 'live')`;
const LOBBY = `(${STATUS} == 'lobby')`;
const HUNT_START = `(${M}.child('startAt').val() + ${S('hideSecs')} * 1000)`;
const HUNT_END = `(${HUNT_START} + ${S('gameMins')} * 60000)`;
const HIDING = `(${LIVE} && now < ${HUNT_START})`;
const HUNTING = `(${LIVE} && now >= ${HUNT_START} && now < ${HUNT_END})`;
const ENDED = `(${STATUS} == 'ended' || (${LIVE} && now >= ${HUNT_END}))`;
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

// Squared distance in metres between two snapshots with lat/lng children.
const sq = (x) => `(${x}) * (${x})`;
const DIST2 = (a, b) =>
  `${sq(`(${a}.child('lat').val() - ${b}.child('lat').val()) * ${M_PER_DEG_LAT}`)} + ` +
  `${sq(`(${a}.child('lng').val() - ${b}.child('lng').val()) * ${M}.child('area/mlon').val()`)}`;
const AREA = `${M}.child('area')`;

const num = (min, max) => ({ '.validate': `newData.isNumber() && newData.val() >= ${min} && newData.val() <= ${max}` });
const str = (maxLen) => ({ '.validate': `newData.isString() && newData.val().length >= 1 && newData.val().length <= ${maxLen}` });
const NO_OTHER = { $other: { '.validate': false } };
const hostReset = `auth != null && !newData.exists() && auth.uid == ${HOST} && ${NOT_ACTIVE}`;

const one = (s) => s.replace(/\s+/g, ' ').trim();

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
            || (data.exists() && data.child('host').val() == auth.uid))`),
          '.validate': one(`newData.hasChildren(['host', 'status', 'settings', 'createdAt'])
            && (newData.child('status').val() != 'live'
                || (newData.child('area').exists() && newData.child('startAt').isNumber()))`),
          host: { '.validate': `newData.isString() && (!data.exists() || newData.val() == data.val())` },
          status: { '.validate': `newData.val() == 'lobby' || newData.val() == 'live' || newData.val() == 'ended'` },
          createdAt: { '.validate': `newData.isNumber()` },
          // The game clock can only ever be set to the server's own time.
          startAt: { '.validate': `newData.isNumber() && (newData.val() == now || newData.val() == data.val())` },
          endedAt: { '.validate': `newData.isNumber()` },
          settings: {
            '.validate': `newData.hasChildren(['hideSecs', 'gameMins', 'tagRadius', 'revealCooldownSecs', 'revealRadius', 'darkSecs', 'hidersSeeSeekers'])`,
            hideSecs: num(10, 3600),
            gameMins: num(1, 240),
            tagRadius: num(3, 25),
            revealCooldownSecs: num(30, 1800),
            revealRadius: num(25, 500),
            darkSecs: num(20, 600),
            hidersSeeSeekers: { '.validate': 'newData.isBoolean()' },
            ...NO_OTHER,
          },
          area: {
            '.validate': `newData.hasChildren(['lat', 'lng', 'r', 'mlon'])`,
            lat: num(-90, 90),
            lng: num(-180, 180),
            r: num(50, 20000),
            mlon: num(1, M_PER_DEG_LAT),
            ...NO_OTHER,
          },
          ...NO_OTHER,
        },

        players: {
          '.read': 'auth != null',
          $uid: {
            // Join/leave/rename only in the lobby. Only the organiser picks teams.
            '.write': one(`auth != null && ${LOBBY} && (
              auth.uid == ${HOST}
              || (auth.uid == $uid && (
                   (!data.exists() && newData.child('role').val() == 'hider')
                   || (data.exists() && newData.exists() && newData.child('role').val() == data.child('role').val())
                   || !newData.exists())))`),
            '.validate': `newData.hasChildren(['name', 'role', 'color', 'joinedAt'])`,
            name: str(20),
            role: { '.validate': `newData.val() == 'hider' || newData.val() == 'seeker'` },
            color: str(9),
            joinedAt: { '.validate': 'newData.isNumber()' },
            ...NO_OTHER,
          },
        },

        locs: {
          $uid: {
            '.read': one(`auth != null && (
              auth.uid == $uid
              || (${IN_GAME('auth.uid')} && (
                   ${ENDED}
                   || ${LOBBY}
                   || (${SEEKER('$uid')} && (${SEEKER('auth.uid')} || ${HIDING} || ${S('hidersSeeSeekers')} == true))
                   || (${HIDER('$uid')} && ${HIDER('auth.uid')})
                   || (${HIDER('$uid')} && ${SEEKER('auth.uid')} && ${LIVE} && now >= ${HUNT_START} && data.exists() && (
                        data.child('t').val() < now - ${S('darkSecs')} * 1000
                        || ${DIST2('data', AREA)} > ${AREA}.child('r').val() * ${AREA}.child('r').val()
                        || (${G}.child('reveal').exists()
                            && ${G}.child('reveal/t').val() < now - ${REVEAL_ANSWER_MS}
                            && ${G}.child('circles/' + $uid + '/n').val() != ${G}.child('reveal/n').val()))))))`),
            '.write': `auth != null && auth.uid == $uid && ${IN_GAME('$uid')} && ${STATUS} != 'ended'`,
            '.validate': `newData.hasChildren(['lat', 'lng', 'acc', 't']) && newData.child('t').val() == now`,
            lat: num(-90, 90),
            lng: num(-180, 180),
            acc: num(0, 100000),
            t: { '.validate': 'newData.isNumber()' },
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
                    && ${DIST2(LOC('auth.uid'), LOC('$h'))} <= ${S('tagRadius')} * ${S('tagRadius')})
                  || (newData.child('how').val() == 'self' && auth.uid == $h)
                  || (newData.child('how').val() == 'host' && auth.uid == ${HOST})))
              || (data.exists() && !newData.exists() && auth.uid == ${HOST}))`),
            '.validate': `newData.hasChildren(['by', 't', 'how'])`,
            by: { '.validate': 'newData.isString()' },
            t: { '.validate': 'newData.isNumber()' },
            how: { '.validate': `newData.val() == 'gps' || newData.val() == 'self' || newData.val() == 'host'` },
            d: num(0, 100000),
            ...NO_OTHER,
          },
        },

        reveal: {
          '.read': `auth != null && ${IN_GAME('auth.uid')}`,
          '.write': one(`auth != null && (
            (${HUNTING} && ${SEEKER('auth.uid')}
              && newData.child('by').val() == auth.uid && newData.child('t').val() == now
              && ((!data.exists() && newData.child('n').val() == 1
                    && now >= ${HUNT_START} + ${S('revealCooldownSecs')} * 1000)
                  || (data.exists() && newData.child('n').val() == data.child('n').val() + 1
                    && now >= data.child('t').val() + ${S('revealCooldownSecs')} * 1000)))
            || (!newData.exists() && auth.uid == ${HOST} && ${NOT_ACTIVE}))`),
          '.validate': `newData.hasChildren(['n', 't', 'by'])`,
          n: { '.validate': 'newData.isNumber()' },
          t: { '.validate': 'newData.isNumber()' },
          by: { '.validate': 'newData.isString()' },
          ...NO_OTHER,
        },

        circles: {
          '.read': `auth != null && ${IN_GAME('auth.uid')}`,
          '.write': hostReset,
          $h: {
            // A hider answers a Reveal by publishing a circle that must contain
            // their real (fresh) position. One answer per Reveal.
            '.write': one(`auth != null && (
              (auth.uid == $h && ${HIDER('$h')} && ${LIVE} && ${G}.child('reveal').exists()
                && newData.child('n').val() == ${G}.child('reveal/n').val()
                && data.child('n').val() != newData.child('n').val()
                && newData.child('t').val() == now
                && newData.child('r').val() == ${S('revealRadius')}
                && ${FRESH('$h')}
                && ${DIST2('newData', LOC('$h'))} <= ${S('revealRadius')} * ${S('revealRadius')})
              || (!newData.exists() && auth.uid == ${HOST} && ${NOT_ACTIVE}))`),
            '.validate': `newData.hasChildren(['n', 'lat', 'lng', 'r', 't'])`,
            n: { '.validate': 'newData.isNumber()' },
            lat: num(-90, 90),
            lng: num(-180, 180),
            r: { '.validate': 'newData.isNumber()' },
            t: { '.validate': 'newData.isNumber()' },
            ...NO_OTHER,
          },
        },

        ...NO_OTHER,
      },
    },
  },
};

const out = new URL('../firebase/database.rules.json', import.meta.url);
writeFileSync(out, JSON.stringify(rules, null, 2) + '\n');
console.log('wrote', out.pathname, JSON.stringify(rules).length, 'bytes');
