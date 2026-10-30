// Game settings and power-ups, matching Hide Tag's defaults (see docs/hide-tag-reference.md).
// Shared by the app and the tests. Numbers that the server checks must match tools/build-rules.mjs.

export const DEFAULTS = {
  // basics
  hideSecs: 240, gameMins: 25, shrinkPct: 70, tagRadius: 10,
  // running and stamina
  runKmh: 10, printSecs: 180, printLead: 3, staminaSecs: 60, refillSecs: 120, breathSecs: 10,
  // reveal
  revealCooldownSecs: 90, revealRadius: 100, groupM: 40, revealNotice: 50,
  // freeze
  freezeM: 200, freezeCd: 120, coverSecs: 20, holdSecs: 60, driftM: 15, strictHolds: false,
  // camping and boundaries
  campMins: 10, campM: 50, burnM: 60, graceSecs: 60, darkSecs: 60,
  // missions
  missions: 2, missionHold: 180, missionStart: 300, missionM: 150, missionPay: 2,
  // supplies
  supplies: 4, cacheEvery: 60, pickupM: 20, freeHandout: 1,
};

// How long timed power-ups last (fixed, as in Hide Tag's defaults).
export const POWER_MS = { ghost: 80000, spy: 30000, smoke: 60000, silence: 120000 };

export const POWERS = {
  // hunters
  reveal_ready: { side: 'seeker', name: 'Reveal boost', icon: '📡', desc: 'Takes half the full reveal cooldown off the wait. Shared by all hunters.' },
  freeze_ready: { side: 'seeker', name: 'Freeze boost', icon: '🧊', desc: 'Takes half the full freeze cooldown off the wait. Shared by all hunters.' },
  // hiders
  ghost: { side: 'hider', name: 'Ghost', icon: '👻', desc: 'You leave no footprints for 80 seconds.' },
  ward: { side: 'hider', name: 'Ward', icon: '🛡️', armed: true, desc: 'Blocks one freeze aimed at you. Several stack.' },
  spy: { side: 'hider', name: 'Lookout', icon: '👁️', desc: 'Shows every hunter on your map for 30 seconds.' },
  decoy: { side: 'hider', name: 'Decoy', icon: '👣', desc: 'Lays a fake running trail about 150 m away.' },
  smoke: { side: 'hider', name: 'Smoke bomb', icon: '💨', desc: 'You can\'t be located for 60 seconds: reveals, scans and flares miss you. Hunters are told.' },
  silence: { side: 'hider', name: 'Silence', icon: '🤫', desc: 'Reveals miss you for 2 minutes, but only while you stay completely still. You\'re told when it ends.' },
  jamming: { side: 'hider', name: 'Jamming', icon: '📶', armed: true, desc: 'Makes one reveal miss you. Several stack, and every reveal uses one.' },
  misdirection: { side: 'hider', name: 'Misdirection', icon: '🧭', armed: true, options: [50, 100, 200], desc: 'The next reveal finds a marker this far away instead of you. You\'re shown where it lands.' },
  // both
  flare: { side: 'both', name: 'Flare', icon: '🎆', rare: true, desc: 'Captures everyone\'s location now and shows it to everyone after 10 seconds, fading over a minute.' },
  scan: { side: 'both', name: 'Scan', icon: '🔍', options: [50, 100, 200], desc: 'Counts the other side within the distance you pick. A count, never a direction.' },
};

export const kindsFor = (role) => Object.keys(POWERS).filter((k) => POWERS[k].side === 'both' || POWERS[k].side === role);

export const FRESH_MS = 12000;
export const MAX_ACC = 30;
export const REVEAL_ANSWER_MS = 20000;
export const PRESENT_MS = 20000;
export const HOST_GONE_MS = 45000;
export const FLARE_DELAY_MS = 10000;
export const FLARE_SHOW_MS = 60000;
export const MISSION_FAIL_MS = 60000;
export const NEAR_ME_M = 25;
export const DECOY_M = 150;
export const SILENCE_TOLERANCE_M = 50;
