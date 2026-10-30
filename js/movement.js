// A hider's own movement, worked out on their phone, as in Hide Tag:
// running speed, footprints, stamina, camping spots, the play-area boundary, and holding still
// while frozen. Pure logic, no DOM: the app feeds in GPS fixes and the clock and reads the state.

import { distM } from './geo.js?v=mvvfeq0n';

export class Movement {
  constructor() { this.reset(); }

  reset() {
    this.track = [];          // recent raw fixes {lat, lng, at, speed}
    this.runningSince = 0;    // when sustained running began (0 = not running)
    this.stamina = null;      // seconds of running left; null until the hunt starts
    this.lastTick = 0;
    this.lastPrint = null;
    this.burned = [];         // [{lat, lng}] spots this hider has burned
    this.violation = null;    // { kind: 'area'|'burn'|'breath'|'hold', since, deadline }
    this.dismissed = {};      // kind -> true after "Nope, I played by the rules", until it clears
  }

  // Speed in m/s, from the phone if it reports one, otherwise from the last ~4 s of fixes.
  speed(now) {
    const recent = this.track.filter((f) => now - f.at <= 4500);
    const last = recent[recent.length - 1];
    if (last && last.speed != null && last.speed >= 0 && now - last.at < 3000) return last.speed;
    if (recent.length < 2) return 0;
    const a = recent[0], b = recent[recent.length - 1];
    const dt = (b.at - a.at) / 1000;
    return dt >= 1.5 ? distM(a, b) / dt : 0;
  }

  addFix(f) {
    this.track.push(f);
    const cut = f.at - 10000;
    while (this.track.length && this.track[0].at < cut) this.track.shift();
  }

  // Called about once a second during the game with the settings and context.
  // Returns events (strings) the app should react to, e.g. 'run-start', 'print', 'breath-warn'.
  tick(now, st, ctx) {
    const ev = [];
    const dt = this.lastTick ? Math.min(5, (now - this.lastTick) / 1000) : 0;
    this.lastTick = now;
    const runSpeed = st.runKmh / 3.6;
    const fast = this.speed(now) >= runSpeed;

    // Sustained running, after a short grace (Hide Tag: 3 s before a trail starts).
    if (fast) {
      if (!this.runningSince) this.runningSince = now;
    } else if (this.runningSince) {
      this.runningSince = 0;
      ev.push('run-stop');
    }
    const running = !!this.runningSince && now - this.runningSince >= st.printLead * 1000;
    if (running && !this.wasRunning) ev.push('run-start');
    this.wasRunning = running;
    this.running = running;

    if (!ctx.hunting) { this.stamina = null; return ev; }

    // Footprints: one every few metres while running (not while a Ghost is active).
    const here = this.track[this.track.length - 1];
    if (running && here && !ctx.ghost && (!this.lastPrint || distM(this.lastPrint, here) >= 6 || now - this.lastPrint.at > 4000)) {
      this.lastPrint = { lat: here.lat, lng: here.lng, at: now };
      ev.push('print');
    }

    // Stamina (seconds of running). Recovery is boosted 30 %, as in Hide Tag.
    if (st.staminaSecs > 0) {
      if (this.stamina == null) this.stamina = st.staminaSecs;
      const floor = -st.breathSecs / 2;
      if (running) this.stamina = Math.max(floor - 1, this.stamina - dt);
      else this.stamina = Math.min(st.staminaSecs, this.stamina + dt * st.staminaSecs / (st.refillSecs / 1.3));
      if (st.breathSecs > 0) {
        if (running && this.stamina <= st.breathSecs / 2 && !this.breathWarned) { this.breathWarned = true; ev.push('breath-warn'); }
        if (!running && this.breathWarned && this.stamina > st.breathSecs / 2) { this.breathWarned = false; ev.push('breath-ok'); }
        if (running && this.stamina <= floor) this.flag('breath', now, 0, ev);
        else this.clear('breath');
      }
    }

    // Boundary: the server records when we went outside (ctx.outSince).
    if (ctx.outSince) this.flag('area', ctx.outSince, st.graceSecs, ev, now);
    else this.clear('area');

    // Camping: the server tracks our spot; once burned, we must leave it.
    if (st.campMins > 0 && ctx.campSince != null && ctx.camp && here) {
      const burnAt = Math.max(ctx.campSince, ctx.huntStart) + st.campMins * 60000;
      this.burnsIn = burnAt - now;
      if (now >= burnAt) {
        if (!this.burned.some((b) => distM(b, ctx.camp) < 5)) { this.burned.push({ lat: ctx.camp.lat, lng: ctx.camp.lng }); ev.push('burned'); }
      }
    } else this.burnsIn = null;
    const inBurn = here && this.burned.some((b) => distM(b, here) <= st.burnM);
    if (inBurn) this.flag('burn', this.burnSince || (this.burnSince = now), st.graceSecs, ev, now);
    else { this.burnSince = 0; this.clear('burn'); }

    return ev;
  }

  // A rule is being broken. After `grace` seconds the hider is asked to accept elimination.
  flag(kind, since, grace, ev, now = since) {
    if (this.dismissed[kind]) return;
    const v = this.violation;
    if (!v || v.kind !== kind) {
      this.violation = { kind, since, deadline: since + grace * 1000 };
      ev.push('violation');
    }
    if (now >= this.violation.deadline && !this.violation.asked) { this.violation.asked = true; ev.push('eliminate'); }
  }

  clear(kind) {
    if (this.violation && this.violation.kind === kind) this.violation = null;
    delete this.dismissed[kind];
  }

  dismiss() {
    if (this.violation) { this.dismissed[this.violation.kind] = true; this.violation = null; }
  }
}

// Freeze, from a hider's point of view: find cover, then hold still.
export class FreezeState {
  constructor() { this.reset(); }
  reset() { this.n = 0; this.phase = 'free'; this.anchor = null; }

  // freeze: {n, t}; hit: true if this freeze landed on us. Returns events.
  tick(now, st, freeze, hit, fix) {
    const ev = [];
    if (!freeze || !hit || freeze.n !== hit.n) { if (this.phase !== 'free' && this.phase !== 'released') { this.phase = 'free'; } return ev; }
    const coverEnd = freeze.t + st.coverSecs * 1000;
    if (this.n !== freeze.n) { this.n = freeze.n; this.phase = 'cover'; this.holdEnd = coverEnd + st.holdSecs * 1000; this.anchor = null; ev.push('cover'); }
    if (this.phase === 'cover' && now >= coverEnd) { this.phase = 'hold'; this.anchor = fix ? { lat: fix.lat, lng: fix.lng } : null; ev.push('hold'); }
    if (this.phase === 'hold') {
      if (!this.anchor && fix) this.anchor = { lat: fix.lat, lng: fix.lng };
      if (this.anchor && fix && distM(this.anchor, fix) > st.driftM) {
        ev.push(st.strictHolds ? 'broke-strict' : 'broke');
        // Held again: the hold restarts from where you are now.
        this.anchor = { lat: fix.lat, lng: fix.lng };
        this.holdEnd = now + st.holdSecs * 1000;
      }
      if (now >= this.holdEnd) { this.phase = 'released'; ev.push('released'); }
    }
    this.left = this.phase === 'cover' ? coverEnd - now : this.phase === 'hold' ? this.holdEnd - now : 0;
    return ev;
  }
}

// Deterministic pseudo-random number in [0, 1) from a string: lets every phone agree on shared
// reveal circles, and decide "is this hider told they were revealed?" without talking.
export function seeded(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
