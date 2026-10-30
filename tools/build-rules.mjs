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

const one = (s) => s.replace(/\s+/g, ' ').trim();

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

// ---- power-ups ----
// Drops are placed by the organiser. Anyone standing within PICKUP_M of one can collect it
// (it becomes theirs, tied to the team they were on). Using one marks the drop used in the same
// atomic write that switches the effect on, and the rules check both halves.
const PICKUP_M = 15;
const FREEZE_M = 75;
const FREEZE_MS = 20000;
const POWER_MS = { lookout: 20000, shield: 30000, cloak: 180000, tracker: 15000 };
const DROP = (id) => `${G}.child('drops/' + ${id})`;
const FX = (u, k) => `${G}.child('fx/' + ${u} + '/${k}')`;
const ACTIVE = (u, k) => `(${FX(u, k)}.child('t').val() > now - ${POWER_MS[k]})`;
// `ng` = the post-write snapshot of games/$g, reached from wherever the rule sits.
const CONSUME = (id, kind, ng) => `(${DROP(id)}.child('c/by').val() == auth.uid && !${DROP(id)}.child('u').exists()
  && ${ng}.child('drops/' + ${id} + '/u').val() == now
  && ((${DROP(id)}.child('c/as').val() == 'hider' && ${HIDER('auth.uid')} && ${DROP(id)}.child('h').val() == ${kind})
   || (${DROP(id)}.child('c/as').val() == 'seeker' && ${SEEKER('auth.uid')} && ${DROP(id)}.child('s').val() == ${kind})))`;
const FREEZE = `${G}.child('freeze')`;

// ---- presence / organiser handover ----
// Every phone writes seen/<uid> = server time every few seconds while the game is open.
// If the organiser leaves, or their phone has been silent for HOST_GONE_MS, any player whose
// own phone is live can take over as organiser.
const HOST_GONE_MS = 45000;
const PRESENT_MS = 20000;
const SEEN = (u) => `${G}.child('seen/' + ${u})`;
const HOST_GONE = one(`(!${G}.child('players/' + ${HOST}).exists()
  || ${SEEN(HOST)}.val() < now - ${HOST_GONE_MS}
  || (!${SEEN(HOST)}.exists() && ${M}.child('createdAt').val() < now - ${HOST_GONE_MS}))`);

const num = (min, max) => ({ '.validate': `newData.isNumber() && newData.val() >= ${min} && newData.val() <= ${max}` });
const str = (maxLen) => ({ '.validate': `newData.isString() && newData.val().length >= 1 && newData.val().length <= ${maxLen}` });
const NO_OTHER = { $other: { '.validate': false } };
const hostReset = `auth != null && !newData.exists() && auth.uid == ${HOST} && ${NOT_ACTIVE}`;


const rules = {
  rules: {
    '.read': false,
    '.write': false,
    games: {
      $g: {
        '.validate': `$g.matches(/^[A-Z2-9]{5}$/)`,

        meta: {
          '.read': 'auth != null',
          // The organiser edits the game. They can hand the role to another player in the game.
          '.write': one(`auth != null && (
            (!data.exists() && newData.child('host').val() == auth.uid)
            || (data.exists() && data.child('host').val() == auth.uid
                && (newData.child('host').val() == auth.uid
                    || newData.parent().child('players/' + newData.child('host').val()).exists())))`),
          '.validate': one(`newData.hasChildren(['host', 'status', 'settings', 'createdAt'])
            && (newData.child('status').val() != 'live'
                || (newData.child('area').exists() && newData.child('startAt').isNumber()))`),
          host: {
            // Claim the organiser role when the current organiser has gone.
            '.write': one(`auth != null && newData.val() == auth.uid && data.exists() && data.val() != auth.uid
              && ${IN_GAME('auth.uid')} && ${SEEN('auth.uid')}.val() > now - ${PRESENT_MS} && ${HOST_GONE}`),
            '.validate': 'newData.isString()',
          },
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
            powerups: num(0, 20),
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
            // Join only in the lobby; leave any time; name and colour can change any time.
            // Only the organiser picks teams (or removes people) in the lobby.
            '.write': one(`auth != null && (
              (${LOBBY} && auth.uid == ${HOST})
              || (auth.uid == $uid && !newData.exists())
              || (auth.uid == $uid && data.exists() && newData.exists() && newData.child('role').val() == data.child('role').val())
              || (${LOBBY} && auth.uid == $uid && !data.exists() && newData.child('role').val() == 'hider'))`),
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
                   || (${SEEKER('$uid')} && (${SEEKER('auth.uid')} || ${HIDING} || ${S('hidersSeeSeekers')} == true
                        || (${HIDER('auth.uid')} && ${ACTIVE('auth.uid', 'lookout')})))
                   || (${HIDER('$uid')} && ${HIDER('auth.uid')})
                   || (${HIDER('$uid')} && ${SEEKER('auth.uid')} && ${LIVE} && now >= ${HUNT_START} && data.exists() && (
                        data.child('t').val() < now - ${S('darkSecs')} * 1000
                        || ${DIST2('data', AREA)} > ${AREA}.child('r').val() * ${AREA}.child('r').val()
                        || (${G}.child('reveal').exists()
                            && ${G}.child('reveal/t').val() < now - ${REVEAL_ANSWER_MS}
                            && ${G}.child('circles/' + $uid + '/n').val() != ${G}.child('reveal/n').val()
                            && !(${FX('$uid', 'cloak')}.child('t').val() > ${G}.child('reveal/t').val() - ${POWER_MS.cloak}))
                        || (${FX('auth.uid', 'tracker')}.child('target').val() == $uid && ${ACTIVE('auth.uid', 'tracker')})
                        || (${FREEZE}.child('t').val() > now - ${FREEZE_MS} && ${DIST2('data', FREEZE)} <= ${FREEZE_M * FREEZE_M}))))))`),
            '.write': `auth != null && auth.uid == $uid && ((${IN_GAME('$uid')} && ${STATUS} != 'ended') || !newData.exists())`,
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
                    && !${ACTIVE('$h', 'shield')}
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
                    && (now >= ${HUNT_START} + ${S('revealCooldownSecs')} * 1000 || newData.child('boost').exists()))
                  || (data.exists() && newData.child('n').val() == data.child('n').val() + 1
                    && (now >= data.child('t').val() + ${S('revealCooldownSecs')} * 1000 || newData.child('boost').exists())))
              && (!newData.child('boost').exists() || ${CONSUME("newData.child('boost').val()", "'reveal'", 'newData.parent()')}))
            || (!newData.exists() && auth.uid == ${HOST} && ${NOT_ACTIVE}))`),
          '.validate': `newData.hasChildren(['n', 't', 'by'])`,
          n: { '.validate': 'newData.isNumber()' },
          t: { '.validate': 'newData.isNumber()' },
          by: { '.validate': 'newData.isString()' },
          boost: { '.validate': 'newData.isString()' },
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

        seen: {
          '.read': `auth != null && ${IN_GAME('auth.uid')}`,
          $uid: {
            '.write': `auth != null && auth.uid == $uid && (${IN_GAME('$uid')} || !newData.exists())`,
            '.validate': 'newData.val() == now',
          },
        },

        drops: {
          '.read': `auth != null && ${IN_GAME('auth.uid')}`,
          '.write': hostReset,
          $id: {
            '.write': `auth != null && auth.uid == ${HOST} && !data.exists() && newData.exists() && (${LOBBY} || ${LIVE})`,
            '.validate': `$id.length >= 6 && $id.length <= 12 && newData.hasChildren(['lat', 'lng', 'h', 's'])`,
            lat: num(-90, 90),
            lng: num(-180, 180),
            h: { '.validate': `newData.val() == 'lookout' || newData.val() == 'shield' || newData.val() == 'cloak'` },
            s: { '.validate': `newData.val() == 'reveal' || newData.val() == 'tracker' || newData.val() == 'freeze'` },
            // Collect: only while hunting, only within ${PICKUP_M} m by fresh, accurate GPS.
            c: {
              '.write': one(`auth != null && !data.exists() && ${HUNTING}
                && newData.child('by').val() == auth.uid && newData.child('t').val() == now
                && ((newData.child('as').val() == 'hider' && ${HIDER('auth.uid')})
                    || (newData.child('as').val() == 'seeker' && ${SEEKER('auth.uid')}))
                && ${FRESH('auth.uid')} && ${ACCURATE('auth.uid')}
                && ${DIST2(LOC('auth.uid'), DROP('$id'))} <= ${PICKUP_M * PICKUP_M}`),
              '.validate': `newData.hasChildren(['by', 'as', 't'])`,
              by: { '.validate': 'newData.isString()' },
              as: { '.validate': `newData.val() == 'hider' || newData.val() == 'seeker'` },
              t: { '.validate': 'newData.isNumber()' },
              ...NO_OTHER,
            },
            // Use: written together with the effect it switches on.
            u: {
              '.write': one(`auth != null && !data.exists() && newData.val() == now && ${HUNTING}
                && ${DROP('$id')}.child('c/by').val() == auth.uid
                && (${['lookout', 'shield', 'cloak', 'tracker'].map((k) =>
                  `(newData.parent().parent().parent().child('fx/' + auth.uid + '/${k}/drop').val() == $id && newData.parent().parent().parent().child('fx/' + auth.uid + '/${k}/t').val() == now)`).join(' || ')}
                  || (newData.parent().parent().parent().child('freeze/drop').val() == $id && newData.parent().parent().parent().child('freeze/t').val() == now)
                  || (newData.parent().parent().parent().child('reveal/boost').val() == $id && newData.parent().parent().parent().child('reveal/t').val() == now))`),
              '.validate': 'newData.isNumber()',
            },
            ...NO_OTHER,
          },
        },

        // Active effects: fx/<player>/<lookout|shield|cloak|tracker> = { t, drop, target? }
        fx: {
          '.read': `auth != null && ${IN_GAME('auth.uid')}`,
          '.write': hostReset,
          $uid: {
            $kind: {
              '.write': one(`auth != null && auth.uid == $uid && ${HUNTING}
                && newData.child('t').val() == now
                && ${CONSUME("newData.child('drop').val()", '$kind', 'newData.parent().parent().parent()')}
                && ($kind != 'tracker' || ${HIDER("newData.child('target').val()")})`),
              '.validate': `($kind == 'lookout' || $kind == 'shield' || $kind == 'cloak' || $kind == 'tracker') && newData.hasChildren(['t', 'drop'])`,
              t: { '.validate': 'newData.isNumber()' },
              drop: { '.validate': 'newData.isString()' },
              target: { '.validate': 'newData.isString()' },
              ...NO_OTHER,
            },
          },
        },

        // Freeze: hiders within ${FREEZE_M} m of where a seeker used it are visible to seekers for ${FREEZE_MS / 1000} s.
        freeze: {
          '.read': `auth != null && ${IN_GAME('auth.uid')}`,
          '.write': one(`auth != null && (
            (${HUNTING} && ${SEEKER('auth.uid')} && newData.child('by').val() == auth.uid && newData.child('t').val() == now
              && ${CONSUME("newData.child('drop').val()", "'freeze'", 'newData.parent()')}
              && ${FRESH('auth.uid')} && ${DIST2('newData', LOC('auth.uid'))} <= 625)
            || (!newData.exists() && auth.uid == ${HOST} && ${NOT_ACTIVE}))`),
          '.validate': `newData.hasChildren(['lat', 'lng', 't', 'by', 'drop'])`,
          lat: num(-90, 90),
          lng: num(-180, 180),
          t: { '.validate': 'newData.isNumber()' },
          by: { '.validate': 'newData.isString()' },
          drop: { '.validate': 'newData.isString()' },
          ...NO_OTHER,
        },

        ...NO_OTHER,
      },
    },
  },
};

// Firebase silently refuses .validate rules that use auth or newData.parent().
JSON.stringify(rules, (k, v) => {
  if (k === '.validate' && typeof v === 'string' && /\bauth\b|parent\(\)/.test(v)) throw new Error(`.validate can't use auth or parent(): ${v.slice(0, 80)}`);
  return v;
});

// Firebase silently refuses rules whose regexes use groups or alternation (the deploy
// "succeeds" but the old rules stay live), so refuse to build them.
JSON.stringify(rules, (k, v) => {
  if (typeof v === 'string') {
    for (const m of v.matchAll(/\.matches\(\/(.*?)\/\)/g)) {
      if (/[|()]/.test(m[1])) throw new Error(`Unsupported regex in rule "${k}": /${m[1]}/ (no groups or |)`);
    }
  }
  return v;
});

const out = new URL('../firebase/database.rules.json', import.meta.url);
writeFileSync(out, JSON.stringify(rules, null, 2) + '\n');
console.log('wrote', out.pathname, JSON.stringify(rules).length, 'bytes');
