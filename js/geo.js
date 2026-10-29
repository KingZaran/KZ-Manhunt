// GPS, distance maths and keeping the screen awake.

export const M_PER_DEG_LAT = 111320;
export const mPerDegLon = (lat) => M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);

// Same flat-earth maths the security rules use (accurate to centimetres at game scale).
export function distM(a, b, mlon) {
  const k = mlon || mPerDegLon((a.lat + b.lat) / 2);
  const dy = (a.lat - b.lat) * M_PER_DEG_LAT;
  const dx = (a.lng - b.lng) * k;
  return Math.sqrt(dx * dx + dy * dy);
}

// A random point within `maxR` metres of `p`, spread evenly over the disc.
export function randomPointNear(p, maxR) {
  const d = maxR * Math.sqrt(Math.random());
  const a = Math.random() * 2 * Math.PI;
  return { lat: p.lat + (d * Math.cos(a)) / M_PER_DEG_LAT, lng: p.lng + (d * Math.sin(a)) / mPerDegLon(p.lat) };
}

export function watchLocation(onFix, onError) {
  if (!('geolocation' in navigator)) { onError({ code: -1, message: 'This browser has no GPS access.' }); return () => {}; }
  const id = navigator.geolocation.watchPosition(
    (p) => onFix({ lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy || 999), speed: p.coords.speed, at: Date.now() }),
    (e) => onError(e),
    { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
  );
  return () => navigator.geolocation.clearWatch(id);
}

// iOS < 18.4 ignores wake locks in apps opened from the Home Screen.
export function iosWakeLockBroken() {
  const m = navigator.userAgent.match(/OS (\d+)_(\d+)/);
  const standalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  if (!m || !/iPhone|iPad|iPod/.test(navigator.userAgent) || !standalone) return false;
  const major = +m[1], minor = +m[2];
  return major < 18 || (major === 18 && minor < 4);
}

export class WakeLock {
  constructor(onChange) {
    this.want = false;
    this.lock = null;
    this.onChange = onChange || (() => {});
    document.addEventListener('visibilitychange', () => { if (this.want && document.visibilityState === 'visible') this.acquire(); });
  }
  get supported() { return 'wakeLock' in navigator; }
  async enable() { this.want = true; await this.acquire(); }
  async acquire() {
    if (!this.supported || this.lock) return;
    try {
      this.lock = await navigator.wakeLock.request('screen');
      this.lock.addEventListener('release', () => { this.lock = null; this.onChange(false); });
      this.onChange(true);
    } catch (e) {
      this.onChange(false);
    }
  }
  disable() { this.want = false; if (this.lock) this.lock.release().catch(() => {}); this.lock = null; }
  get active() { return !!this.lock; }
}

export function vibrate(pattern) { try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) { /* iOS has no vibration API */ } }

// Smooths raw GPS so a phone lying still doesn't wander around the map, without lagging
// behind someone who's running. A Kalman filter weights each fix by its reported accuracy;
// how much movement it expects depends on whether you're moving (from the phone's own speed
// reading, or from how far recent fixes have drifted). While you're still, a dead-band also
// ignores wobble smaller than the GPS noise.
export class GpsFilter {
  constructor() { this.reset(); }
  reset() { this.k = null; this.out = null; this.hist = []; }
  moving(f) {
    if (f.speed != null && f.speed >= 0) return f.speed > 0.8;
    // No speed reading: compare the average of the last 5 fixes with the 5 before.
    const h = this.hist;
    if (h.length < 10) return true;
    const avg = (a) => ({ lat: a.reduce((x, p) => x + p.lat, 0) / a.length, lng: a.reduce((x, p) => x + p.lng, 0) / a.length });
    return distM(avg(h.slice(-5)), avg(h.slice(-10, -5))) > Math.max(5, f.acc * 0.8);
  }
  push(f) {
    this.hist.push(f);
    if (this.hist.length > 10) this.hist.shift();
    const R = Math.pow(Math.max(f.acc, 3), 2);
    // A fix far outside the noise means you've set off; stop smoothing straight away.
    const jumped = this.k && distM(f, this.k) > Math.max(20, f.acc * 2.5);
    const moving = jumped || this.moving(f);
    if (!this.k) {
      this.k = { lat: f.lat, lng: f.lng, v: R, t: f.at };
      this.out = { lat: f.lat, lng: f.lng };
    } else {
      const dt = Math.min(30, Math.max(0, (f.at - this.k.t) / 1000));
      this.k.t = f.at;
      this.k.v += dt * (moving ? 36 : 0.25); // expected drift: ~6 m/s moving, ~0.5 m/s still
      const g = this.k.v / (this.k.v + R);
      this.k.lat += g * (f.lat - this.k.lat);
      this.k.lng += g * (f.lng - this.k.lng);
      this.k.v *= 1 - g;
    }
    const acc = Math.round(Math.max(3, Math.min(f.acc, Math.sqrt(this.k.v) * 1.5)));
    const est = { lat: this.k.lat, lng: this.k.lng };
    if (moving || distM(est, this.out) > Math.max(3, acc * 0.8)) this.out = est;
    return { lat: this.out.lat, lng: this.out.lng, acc, rawAcc: Math.round(f.acc), at: f.at, moving };
  }
}

// One-off position request, used to wake GPS up when updates stall (iOS pauses them when you're still).
export function nudgeLocation(onFix) {
  try {
    navigator.geolocation.getCurrentPosition(
      (p) => onFix({ lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy || 999), speed: p.coords.speed, at: Date.now() }),
      () => {},
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
    );
  } catch (e) { /* ignore */ }
}
