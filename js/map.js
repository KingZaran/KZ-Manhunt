// One map API, two engines:
//  - MapLibre GL (vector OpenFreeMap tiles, 3D buildings, satellite): free, no API key.
//  - Leaflet (vendored) with OpenStreetMap raster tiles, used if MapLibre can't load
//    (no WebGL2, CDN blocked) or with ?map=leaflet.

const ML_VER = '5.24.0';
const ML_CDN = `https://cdn.jsdelivr.net/npm/maplibre-gl@${ML_VER}/dist/`;
const OFM = 'https://tiles.openfreemap.org/';
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const ESRI_ATTR = 'Imagery © Esri, Maxar, Earthstar Geographics';
const OSM = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTR = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';

const dark = () => !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);

function hasWebGL2() {
  try { return !!document.createElement('canvas').getContext('webgl2'); } catch (e) { return false; }
}
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true; s.crossOrigin = 'anonymous';
    s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}
function loadCss(href) {
  const l = document.createElement('link');
  l.rel = 'stylesheet'; l.href = href;
  document.head.appendChild(l);
}

let enginePromise = null;
export function loadEngine() {
  if (!enginePromise) {
    enginePromise = (async () => {
      if (new URLSearchParams(location.search).get('map') === 'leaflet' || !hasWebGL2()) return 'leaflet';
      try {
        loadCss(ML_CDN + 'maplibre-gl.css');
        await Promise.race([loadScript(ML_CDN + 'maplibre-gl.js'), new Promise((_, rej) => setTimeout(rej, 8000))]);
        return window.maplibregl ? 'gl' : 'leaflet';
      } catch (e) {
        return 'leaflet';
      }
    })();
  }
  return enginePromise;
}

// Approximate a circle of radius r metres as a polygon ring.
function ring(lat, lng, r, n = 72) {
  const out = [];
  const kLat = r / 111320, kLng = r / (111320 * Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * 2 * Math.PI;
    out.push([lng + kLng * Math.cos(a), lat + kLat * Math.sin(a)]);
  }
  return out;
}

function satelliteStyle() {
  return {
    version: 8,
    sources: {
      sat: { type: 'raster', tiles: [ESRI], tileSize: 256, maxzoom: 19, attribution: ESRI_ATTR },
      openmaptiles: { type: 'vector', url: OFM + 'planet' },
    },
    layers: [{ id: 'sat', type: 'raster', source: 'sat' }],
  };
}

export class GameMap {
  // opts: { engine, onClick(lat,lng), onUserMove() }
  constructor(el, opts) {
    this.el = el;
    this.engine = opts.engine;
    this.onClick = opts.onClick || (() => {});
    this.onUserMove = opts.onUserMove || (() => {});
    this.pins = new Map();
    this.circles = new Map();
    this.seen = new Set();
    this.satellite = false;
    this.threeD = false;
    this.ready = false;
    if (this.engine === 'gl') this.initGL(); else this.initLeaflet();
  }

  /* ---------- MapLibre ---------- */
  initGL() {
    const ml = window.maplibregl;
    this.map = new ml.Map({
      container: this.el,
      style: dark() ? OFM + 'styles/dark' : OFM + 'styles/liberty',
      center: [-1.5, 52.5], zoom: 5,
      attributionControl: { compact: true },
      maxPitch: 70,
      dragRotate: true,
      pitchWithRotate: true,
      fadeDuration: 0,
    });
    this.map.touchZoomRotate.enableRotation();
    // Follow the phone's light/dark setting.
    if (window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const onTheme = () => { if (!this.satellite) { this.ready = false; this.map.setStyle(dark() ? OFM + 'styles/dark' : OFM + 'styles/liberty'); } };
      if (mq.addEventListener) mq.addEventListener('change', onTheme); else if (mq.addListener) mq.addListener(onTheme);
    }
    // Start with the attribution collapsed to its (i) button so it doesn't cover a small map.
    this.map.once('load', () => {
      const a = this.el.querySelector('.maplibregl-ctrl-attrib');
      if (a) a.classList.remove('maplibregl-compact-show');
    });
    this.map.on('style.load', () => { this.ready = true; this.addOverlay(); this.apply3D(false); this.flushCircles(); });
    this.map.on('click', (e) => this.onClick(e.lngLat.lat, e.lngLat.lng));
    this.map.on('dragstart', (e) => { if (e.originalEvent) this.onUserMove(); });
  }
  addOverlay() {
    const m = this.map;
    if (m.getSource('mh')) return;
    m.addSource('mh', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    m.addLayer({ id: 'mh-fill', type: 'fill', source: 'mh', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['get', 'fo'] } });
    m.addLayer({ id: 'mh-line', type: 'line', source: 'mh', filter: ['!', ['get', 'dashed']], paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'w'], 'line-opacity': ['get', 'lo'] } });
    m.addLayer({ id: 'mh-dash', type: 'line', source: 'mh', filter: ['get', 'dashed'], layout: { 'line-cap': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'w'], 'line-dasharray': [2, 2] } });
  }
  apply3D(animate) {
    const m = this.map;
    if (!this.ready) return;
    const hasOwn = m.getStyle().layers.some((l) => l.type === 'fill-extrusion' && l.id !== 'mh-3d');
    if (!hasOwn && m.getSource('openmaptiles') && !m.getLayer('mh-3d')) {
      m.addLayer({
        id: 'mh-3d', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 14,
        paint: {
          'fill-extrusion-color': this.satellite ? '#e8e8e8' : (dark() ? '#3a4a44' : '#d9d4cc'),
          'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 6],
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
          'fill-extrusion-opacity': this.satellite ? 0.3 : 0.85,
        },
      }, 'mh-fill');
    }
    if (m.getLayer('mh-3d')) m.setLayoutProperty('mh-3d', 'visibility', this.threeD ? 'visible' : 'none');
    const pitch = this.threeD ? 60 : 0;
    if (Math.round(m.getPitch()) === pitch) return;
    const go = () => {
      if (animate) m.easeTo({ pitch, bearing: this.threeD ? m.getBearing() : 0, duration: 600 });
      else m.jumpTo({ pitch });
    };
    // Don't cut short a zoom/pan that's already animating (e.g. "follow me").
    if (animate && m.isMoving()) m.once('moveend', go); else go();
  }

  /* ---------- Leaflet ---------- */
  initLeaflet() {
    const m = L.map(this.el, { zoomControl: false, attributionControl: true });
    this.street = L.tileLayer(OSM, { maxZoom: 19, attribution: OSM_ATTR }).addTo(m);
    this.sat = L.tileLayer(ESRI, { maxZoom: 19, attribution: ESRI_ATTR });
    m.setView([52.5, -1.5], 5);
    m.on('click', (e) => this.onClick(e.latlng.lat, e.latlng.lng));
    m.on('dragstart', () => this.onUserMove());
    this.map = m;
    this.ready = true;
  }

  /* ---------- shared API ---------- */
  get supports3D() { return this.engine === 'gl'; }

  begin() { this.seen.clear(); }

  pin(key, lat, lng, html, z) {
    this.seen.add('p:' + key);
    let p = this.pins.get(key);
    if (!p) {
      const el = document.createElement('div');
      el.className = 'pin-wrap';
      el.innerHTML = html;
      if (this.engine === 'gl') {
        p = { el, html, m: new window.maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([lng, lat]).addTo(this.map) };
      } else {
        p = { el: null, html, m: L.marker([lat, lng], { icon: L.divIcon({ className: 'pin-wrap', html, iconSize: [0, 0] }), keyboard: false, interactive: false, zIndexOffset: z || 0 }).addTo(this.map) };
      }
      if (z && p.el) p.el.style.zIndex = String(z);
      this.pins.set(key, p);
      return;
    }
    if (this.engine === 'gl') {
      p.m.setLngLat([lng, lat]);
      if (p.html !== html) { p.el.innerHTML = html; p.html = html; }
    } else {
      p.m.setLatLng([lat, lng]);
      if (p.html !== html) { p.m.setIcon(L.divIcon({ className: 'pin-wrap', html, iconSize: [0, 0] })); p.html = html; }
    }
  }

  // style: { color, fill (opacity 0..1), weight, dashed, lineOpacity }
  circle(key, lat, lng, r, style, labelHtml) {
    this.seen.add('c:' + key);
    const c = { lat, lng, r, style };
    const prev = this.circles.get(key);
    const sig = JSON.stringify(c);
    if (labelHtml) this.pin('lbl:' + key, lat, lng, labelHtml, 50);
    if (prev && prev.sig === sig) return;
    if (this.engine === 'gl') {
      this.circles.set(key, { sig, c });
      this.dirty = true;
    } else {
      const opts = { radius: r, color: style.color, weight: style.weight || 2, opacity: style.lineOpacity == null ? 1 : style.lineOpacity, fill: !!style.fill, fillColor: style.color, fillOpacity: style.fill || 0, dashArray: style.dashed ? '10 8' : null, interactive: false };
      if (prev) { prev.shape.setLatLng([lat, lng]); prev.shape.setRadius(r); prev.shape.setStyle(opts); prev.sig = sig; }
      else this.circles.set(key, { sig, shape: L.circle([lat, lng], opts).addTo(this.map) });
    }
  }

  end() {
    for (const [k, p] of this.pins) {
      if (!this.seen.has('p:' + k)) { p.m.remove(); this.pins.delete(k); }
    }
    for (const [k, c] of this.circles) {
      if (!this.seen.has('c:' + k)) {
        if (c.shape) c.shape.remove();
        this.circles.delete(k);
        this.dirty = true;
      }
    }
    if (this.engine === 'gl' && this.dirty) this.flushCircles();
  }

  flushCircles() {
    if (this.engine !== 'gl' || !this.ready || !this.map.getSource('mh')) return;
    this.dirty = false;
    const features = [];
    for (const { c } of this.circles.values()) {
      const s = c.style;
      features.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [ring(c.lat, c.lng, c.r)] },
        properties: { color: s.color, fo: s.fill || 0, w: s.weight || 2, dashed: !!s.dashed, lo: s.lineOpacity == null ? 1 : s.lineOpacity },
      });
    }
    this.map.getSource('mh').setData({ type: 'FeatureCollection', features });
  }

  setView(lat, lng, zoom, animate) {
    if (this.engine === 'gl') {
      const opts = { center: [lng, lat], zoom: zoom == null ? this.map.getZoom() : zoom };
      if (animate) this.map.easeTo(Object.assign({ duration: 500 }, opts)); else this.map.jumpTo(opts);
    } else {
      this.map.setView([lat, lng], zoom == null ? this.map.getZoom() : zoom, { animate: !!animate });
    }
  }
  zoom() { return this.map.getZoom(); }

  fitCircle(lat, lng, r) {
    const k = 1.15;
    const dLat = (r * k) / 111320, dLng = (r * k) / (111320 * Math.cos((lat * Math.PI) / 180));
    if (this.engine === 'gl') this.map.fitBounds([[lng - dLng, lat - dLat], [lng + dLng, lat + dLat]], { padding: 20, duration: 0, pitch: this.threeD ? 60 : 0 });
    else this.map.fitBounds([[lat - dLat, lng - dLng], [lat + dLat, lng + dLng]], { animate: false });
  }

  toggleSatellite() {
    this.satellite = !this.satellite;
    if (this.engine === 'gl') {
      this.ready = false;
      this.map.setStyle(this.satellite ? satelliteStyle() : (dark() ? OFM + 'styles/dark' : OFM + 'styles/liberty'));
    } else if (this.satellite) { this.map.removeLayer(this.street); this.sat.addTo(this.map); }
    else { this.map.removeLayer(this.sat); this.street.addTo(this.map); }
    return this.satellite;
  }

  toggle3D() {
    if (this.engine !== 'gl') return false;
    this.threeD = !this.threeD;
    this.apply3D(true);
    return this.threeD;
  }

  resetNorth() { if (this.engine === 'gl' && this.map.getBearing() !== 0) this.map.easeTo({ bearing: 0, duration: 400 }); }

  resize() { if (this.engine === 'gl') this.map.resize(); else this.map.invalidateSize(); }
  remove() { this.map.remove(); this.pins.clear(); this.circles.clear(); }
}
