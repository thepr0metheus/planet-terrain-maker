// The map screen's map: a world's map (Leaflet), and the circle a place is framed with.
//
// The circle stands in the middle of the part of the map the panels leave free. Its size on the
// ground follows the zoom, unless a width is held (the second of two places keeps the first one's
// width). Earth's map is Web Mercator, where a circle on the ground is a circle on the screen. The
// Moon's, Mars's and Venus's maps are in plain degrees, stretched east-west away from the equator:
// there the circle on the ground is an oval on the screen, and is drawn so.

import * as L from '../vendor/leaflet/leaflet-src.esm.js';
import { StretchedTileLayer } from './stretched-tiles.js';
import { LonLat, Mercator } from './geo.js';
import { mPerDegOf, worldOf } from './worlds.js';
import { SOURCES_CREDIT } from './credits.js';
import { freePart } from './free-part.js';
import { ShapeOverlay } from './shape-overlay.js';
import { number, t } from './i18n.js';

const FRAME_SHARE = 0.78;      // of the free area's smaller side, when the width follows the zoom
const GAP = 12;                // px between a panel and the free area
// A screen with two pixels to a point (Retina) gets tiles of the next zoom, drawn at half size:
// the map is as sharp as the screen. Leaflet's detectRetina asks for zoom + 1, so the layer's own
// zooms are given one less (it would ask the server for tiles past the layer's last zoom), and one
// more as the map's limit (it takes one off it).
const RETINA = typeof window !== 'undefined' && (window.devicePixelRatio || 1) > 1.4;
function sharp(maxZoom, maxNativeZoom) {
  return RETINA
    ? { detectRetina: true, maxZoom: maxZoom + 1, maxNativeZoom: maxNativeZoom - 1 }
    : { maxZoom, maxNativeZoom };
}

export class MapView {
  // element: the map's box. frame: the circle's element; sizeLabel: the width written on it.
  // shape: the <svg> a model of two places is drawn on (shape-overlay.js).
  // panels(): the panels beside the map: their boxes are taken out of the free area, and the circle
  // is sized and placed in what is left. bars(): bars over the map (the guide's): the circle keeps
  // clear of them, but keeps its size — a bar that comes and goes must not change the place framed.
  // onMove(): the map moved or zoomed (the frame's width changed).
  constructor({ element, frame, sizeLabel, shape, panels = () => [], bars = () => [], onMove = () => {} }) {
    this._element = element;
    this._frame = frame;
    this._overlay = new ShapeOverlay(shape);
    this._sizeLabel = sizeLabel;
    this._panels = panels;
    this._bars = bars;
    this._freeKey = null;       // the free area at the last refresh, to see it change
    this._kept = null;          // the circle's centre on the ground at the last refresh: { lat, lon }
    this._onMove = onMove;
    this._map = null;
    this._grid = null;
    this._world = null;
    this._layers = [];
    this._heldWidthM = null;
    this._circle = true;
    this._resize = new ResizeObserver(() => this.refresh());
    this._resize.observe(element);
  }

  get map() { return this._map; }
  get world() { return this._world; }

  // Open a world's map, at `view` ({ lat, lon, zoom }) or at its start. The map is made anew when
  // the kind of map changes (Leaflet cannot change it on a map that exists). base: the picture
  // layers ({ layer, maxNativeZoom, detail? }) when they are not the world's usual ones.
  showWorld(id, view = null, base = null) {
    const world = worldOf(id);
    if (!this._map || this._grid !== world.grid) {
      this._map?.remove();
      this._edge = null;
      this._mark = null;              // went with the map
      this._map = L.map(this._element, {
        crs: world.grid === 'mercator' ? L.CRS.EPSG3857 : L.CRS.EPSG4326,
        zoomSnap: 0, zoomDelta: 0.5, wheelPxPerZoomLevel: 90, attributionControl: false, zoomControl: false,
        worldCopyJump: false, maxBoundsViscosity: 0.7,
      });
      L.control.zoom({ position: 'bottomright' }).addTo(this._map);
      L.control.attribution({ prefix: false, position: 'bottomright' }).addTo(this._map);
      this._map.on('move zoom', () => this.refresh());
      this._map.on('moveend zoomend', () => this._onMove());
      this._grid = world.grid;
    }
    this._world = world;
    this._putLayers(base);
    if (world.grid === 'mercator') {
      this._map.setMinZoom(2);
      this._map.setMaxBounds(null);
    } else {
      this._map.setMinZoom(1);
      this._map.setMaxBounds([[-95, -200], [95, 200]]);
    }
    this._map.setMaxZoom(world.maxZoom);
    const at = view ?? world.start;
    this._kept = null;            // a centre on another world means nothing here
    this._map.setView([at.lat, at.lon], at.zoom, { animate: false });
    this._centreAt(at.lat, at.lon, at.zoom);
    this.refresh();
  }

  // The picture on the map: the one the model will get (base), or the world's usual one (null).
  setBase(base) {
    if (this._map && this._world) this._putLayers(base);
  }

  // The world's picture layers (and Earth's names over them) in place of those on the map.
  _putLayers(base) {
    for (const layer of this._layers) layer.remove();
    this._layers = [];
    const world = this._world;
    const look = base ?? world.map;
    const tiles = (layer) => `/api/tile/${layer}/{z}/{x}/{y}`;
    if (world.grid === 'mercator') {
      this._layers.push(L.tileLayer(tiles(look.layer), { ...sharp(world.maxZoom, look.maxNativeZoom), attribution: SOURCES_CREDIT[look.layer] }));
      if (world.map.labels) {
        // the names stay at their own size: on a Retina screen they would come out half as big
        this._layers.push(L.tileLayer(tiles(world.map.labels), { maxNativeZoom: 19, maxZoom: world.maxZoom, opacity: 0.85 }));
      }
    } else {
      const whole = { noWrap: true, bounds: [[-90, -180], [90, 180]] };
      // a layer of 512-point tiles says so (CTX): Leaflet asks for its level one below the map's zoom
      this._layers.push(new StretchedTileLayer(tiles(look.layer), {
        ...sharp(world.maxZoom, look.maxNativeZoom), ...whole, attribution: SOURCES_CREDIT[look.layer],
        tileSize: look.tileSize ?? 256, zoomOffset: look.zoomOffset ?? 0,
      }));
      if (look.detail) {
        this._layers.push(new StretchedTileLayer(tiles(look.detail.layer), {
          minZoom: look.detail.minZoom, ...sharp(world.maxZoom, look.detail.maxNativeZoom), ...whole,
          attribution: SOURCES_CREDIT[look.detail.layer],
        }));
      }
    }
    for (const layer of this._layers) layer.addTo(this._map);
  }

  // Put (lat, lon) in the middle of the circle, at zoom z.
  _centreAt(lat, lon, z) {
    const free = this.freeArea();
    const size = this._map.getSize();
    const offset = L.point((free.left + free.right) / 2 - size.x / 2, (free.top + free.bottom) / 2 - size.y / 2);
    const centre = this._map.unproject(this._map.project([lat, lon], z).subtract(offset), z);
    this._map.setView(centre, z, { animate: false });
  }

  // ---------- the frame ----------

  // 'circle' shows the circle; 'contour' hides it (the contour tool draws on the map itself).
  setShape(shape) {
    this._circle = shape === 'circle';
    this.refresh();
  }

  // Hold the circle at a width on the ground (metres), or let it follow the zoom (null).
  holdWidth(widthM) {
    this._heldWidthM = widthM || null;
    this.refresh();
  }

  get heldWidthM() { return this._heldWidthM; }

  // The edge found in the relief ([{ lat, lon }], on the ground), or null.
  showEdge(points) {
    this._edge?.remove();
    this._edge = points && this._map
      ? L.polygon(points.map((p) => [p.lat, p.lon]), { color: '#8e90ff', weight: 3, opacity: 0.95, fillColor: '#8e90ff', fillOpacity: 0.12, interactive: false }).addTo(this._map)
      : null;
  }

  // The shape of a model of two places (shape-overlay.js: its outline, line and parts), in place
  // of the circle; null takes it away.
  setOverlay(spec) {
    this._overlay.set(spec);
    this.refresh();
  }

  get overlay() { return this._overlay.spec; }

  // The free part of the map, in its own pixels: { left, top, right, bottom }: where the circle's
  // centre stands. Each panel and bar takes away the side of the free part it stands on: of the
  // parts left of it, right of it, above and below it, the biggest stays free (the guide's bar at
  // the bottom takes the bottom, not the right).
  freeArea() {
    return this._partFree([...this._panels(), ...this._bars()]);
  }

  // The part the circle is sized by: the map without the panels, the bars left on it.
  sizeArea() {
    return this._partFree(this._panels());
  }

  _partFree(elements) {
    const box = this._element.getBoundingClientRect();
    return freePart({ left: 0, top: 0, right: box.width, bottom: box.height },
      elements.filter((panel) => panel && !panel.hidden).map((panel) => {
        const p = panel.getBoundingClientRect();
        return { left: p.left - box.left, right: p.right - box.left, top: p.top - box.top, bottom: p.bottom - box.top };
      }).filter((p) => p.right > p.left && p.bottom > p.top));
  }

  // Ground metres a screen pixel covers at a latitude now: { ew, ns }.
  metresPerPx(lat) {
    const z = this._map.getZoom();
    if (this._world.grid === 'mercator') {
      const m = Mercator.metresPerPx(lat, z);
      return { ew: m, ns: m };
    }
    const ns = LonLat.degPerPx(z) * mPerDegOf(this._world);
    return { ew: ns * Math.cos(lat * Math.PI / 180), ns };
  }

  // Where the circle stands and how big: its centre in map pixels and on the ground, its radius on
  // the ground (metres) and its size on the screen (px). null while the map is hidden: it has no
  // size, and a circle on it none either.
  frameNow() {
    const free = this.freeArea();
    if (free.right - free.left < 1 || free.bottom - free.top < 1) return null;
    const cx = (free.left + free.right) / 2, cy = (free.top + free.bottom) / 2;
    const centre = this._map.containerPointToLatLng([cx, cy]);
    const scale = this.metresPerPx(centre.lat);
    let radiusM = this._heldWidthM ? this._heldWidthM / 2 : null;
    if (!radiusM) {
      const size = this.sizeArea();
      const w = (size.right - size.left) * FRAME_SHARE, h = (size.bottom - size.top) * FRAME_SHARE;
      radiusM = Math.min(w * scale.ew, h * scale.ns) / 2;
    }
    return { cx, cy, lat: centre.lat, lon: centre.lng, radiusM, w: 2 * radiusM / scale.ew, h: 2 * radiusM / scale.ns };
  }

  // Draw the circle where frameNow() says. Run on every move, zoom and resize.
  refresh() {
    if (!this._map || !this._world) return;
    this._map.invalidateSize({ pan: false });
    // A panel or a bar came, went or changed its size, the map did not move: the map moves instead,
    // so that the ground in the middle of the circle stays there.
    const free = this.freeArea();
    if (free.right - free.left >= 1 && free.bottom - free.top >= 1) {
      const key = [free.left, free.top, free.right, free.bottom].map(Math.round).join(',');
      const moved = this._freeKey !== null && key !== this._freeKey && this._kept;
      this._freeKey = key;
      if (moved) {
        this._centreAt(this._kept.lat, this._kept.lon, this._map.getZoom());       // comes back here
        return;
      }
    }
    const shape = this._overlay.spec;
    const f = this._circle || shape ? this.frameNow() : null;
    this._frame.hidden = !f || Boolean(shape);
    this._overlay.draw(f && this._map, this._world, f);
    const centre = this.frameNow();
    if (centre) this._kept = { lat: centre.lat, lon: centre.lon };
    if (!f) return;
    if (Math.abs((this._shownRadius ?? 0) - f.radiusM) > f.radiusM * 1e-3) {
      this._shownRadius = f.radiusM;
      this._onMove();          // the picture's hint follows the circle
    }
    if (shape) return;
    const style = this._frame.style;
    style.setProperty('--frame-x', `${f.cx}px`);
    style.setProperty('--frame-y', `${f.cy}px`);
    style.setProperty('--frame-w', `${f.w}px`);
    style.setProperty('--frame-h', `${f.h}px`);
    this._sizeLabel.textContent = `⌀ ${formatDistance(2 * f.radiusM)}`;
  }

  // The zoom at which `widthM` fills wPx x hPx of the screen at a latitude.
  _zoomFor(lat, widthM, wPx, hPx) {
    let z;
    if (this._world.grid === 'mercator') {
      const m = widthM / Math.min(wPx, hPx);
      z = Math.log2(2 * Math.PI * Mercator.EARTH_RADIUS * Math.cos(lat * Math.PI / 180) / (256 * m));
    } else {
      const cos = Math.cos(lat * Math.PI / 180);
      const ns = Math.max(widthM / hPx, widthM / (wPx * cos));
      z = Math.log2(360 * mPerDegOf(this._world) / (512 * ns));
    }
    return Math.max(this._map.getMinZoom(), Math.min(this._world.maxZoom, z));
  }

  // Put a place in the middle of the circle. widthM: how much ground to show around it (the zoom is
  // kept when the width is held, or when there is no width to go by). zoom: a zoom to go to instead.
  showPlace(lat, lon, widthM = null, zoom = null) {
    const free = this.sizeArea();
    if (zoom !== null && !this._heldWidthM) {
      this._centreAt(lat, lon, zoom);
      return;
    }
    let z = this._map.getZoom();
    if (widthM && !this._heldWidthM) {
      z = this._zoomFor(lat, widthM, (free.right - free.left) * FRAME_SHARE, (free.bottom - free.top) * FRAME_SHARE);
    } else if (this._heldWidthM) {
      // a held width: zoom so that the circle fits the free area
      z = this._zoomFor(lat, this._heldWidthM / FRAME_SHARE, (free.right - free.left), (free.bottom - free.top));
    }
    this._centreAt(lat, lon, z);
  }

  // A mark at a point with its name (a craft on the surface), or none for null: one at a time.
  showMark(mark) {
    this._mark?.remove();
    this._mark = null;
    if (!mark || !this._map) return;
    this._mark = L.circleMarker([mark.lat, mark.lon], { radius: 7, weight: 2, color: '#ffffff', fillColor: '#7c7dff', fillOpacity: 1, interactive: false })
      .bindTooltip(mark.name, { permanent: true, direction: 'top', offset: [0, -8], className: 'lander-name' })
      .addTo(this._map);
  }

  // The map's state, to come back to: { lat, lon, zoom } of the circle's centre.
  where() {
    const f = this.frameNow() ?? { lat: this._map.getCenter().lat, lon: this._map.getCenter().lng };
    return { lat: f.lat, lon: f.lon, zoom: this._map.getZoom() };
  }
}

// "850 m", "4.25 km", "37.4 km", "120 km", in the language in use.
export function formatDistance(m) {
  if (m < 1000) return t('{n} m', { n: Math.round(m) });
  const km = m / 1000;
  return t('{n} km', { n: number(km, km < 10 ? 2 : km < 100 ? 1 : 0) });
}
