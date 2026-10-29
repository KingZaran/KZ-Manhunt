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
    (p) => onFix({ lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy || 999), at: Date.now() }),
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
