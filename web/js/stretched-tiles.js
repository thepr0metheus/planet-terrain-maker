// The Moon's, Mars's and Venus's map tiles with their levels stretched (contrast.js).
// NASA Trek's mosaics are grey, and where the ground is even they are flat:
// around the Apollo 11 site 96% of Kaguya's pixels lie in 8 greys of 255, so a
// 2.6 km crater is a faint ring. How flat depends on the place (the maria are
// dark and even, the highlands and young craters bright and rough), so no one
// stretch suits a whole mosaic. This layer counts the greys of all its tiles in
// view together and spreads them over the full range: the tiles share one
// stretch and show no seams. When the view moves somewhere brighter or darker,
// a new stretch is made and the tiles on screen are drawn again from the
// pictures they keep.
//
// Each tile is a canvas one pixel larger on every side than the tile, laid one
// pixel over its neighbours, with a border from their pictures (tile-edges.js):
// zoomed past the tiles' own level, they blend into each other instead of
// meeting in a line the stretch would make plain.
//
// A canvas, not an <img> with a CSS filter: a filter on Leaflet's tiles makes
// Chromium draw the whole map black. The layer reads Leaflet's own _tiles,
// _tileZoom, _tileCoordsToKey and _tileCoordsToBounds; Leaflet is pinned at
// 1.9.4 (package.json, web/vendor).

import * as L from '../vendor/leaflet/leaflet-src.esm.js';
import { levelHistogram, levelsOf, widenLevels, levelTable, applyLevelTable, levelsClose } from './contrast.js';
import { borderedPicture } from './tile-edges.js';

// The darkest and brightest 1% are cut. At least 24 greys are spread over the
// range, so the gain stays under 11: past that the few greys of a flat mare
// become steps, and its noise grows.
const CUT = { low: 0.01, high: 0.99 };
const MIN_SPAN = 24;
// How long after a tile arrives the stretch is made again: tiles come in bursts.
const SETTLE_MS = 120;
// Before the first stretch the tiles are drawn as they came.
const AS_THEY_CAME = levelTable({ lo: 0, hi: 255 });
// The tile and its eight neighbours, as steps in x and y.
const AROUND = { n: [0, -1], s: [0, 1], w: [-1, 0], e: [1, 0], nw: [-1, -1], ne: [1, -1], sw: [-1, 1], se: [1, 1] };

export const StretchedTileLayer = L.TileLayer.extend({
  initialize(url, options) {
    L.TileLayer.prototype.initialize.call(this, url, options);
    this._stretchPictures = new WeakMap();   // canvas -> { picture, histogram, coords }
    this._stretch = null;                    // the { lo, hi } drawn now, or null
    this._stretchTable = AS_THEY_CAME;
    this._stretchTimer = null;
  },

  onAdd(map) {
    L.TileLayer.prototype.onAdd.call(this, map);
    this.on('load', this._restretch, this);
    map.on('moveend', this._restretch, this);
  },

  onRemove(map) {
    clearTimeout(this._stretchTimer);
    map.off('moveend', this._restretch, this);
    this.off('load', this._restretch, this);
    L.TileLayer.prototype.onRemove.call(this, map);
  },

  // The levels drawn now, for the tests in the browser: { lo, hi } or null.
  stretch() {
    return this._stretch;
  },

  createTile(coords, done) {
    const canvas = document.createElement('canvas');
    canvas.setAttribute('role', 'presentation');
    // Leaflet keeps a tile of the old zoom while the new ones load only if it is
    // `complete`, as an <img> would say.
    canvas.complete = false;
    const img = new Image();
    img.onload = () => {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const picture = ctx.getImageData(0, 0, canvas.width, canvas.height);
      this._stretchPictures.set(canvas, { picture, histogram: levelHistogram(picture.data), coords: { x: coords.x, y: coords.y, z: coords.z } });
      // This tile, and the neighbours whose borders it now fills.
      this._drawStretched(canvas);
      for (const [dx, dy] of Object.values(AROUND)) {
        const next = this._tileAt(coords, dx, dy);
        if (next) this._drawStretched(next);
      }
      canvas.complete = true;
      done(null, canvas);
      clearTimeout(this._stretchTimer);
      this._stretchTimer = setTimeout(() => this._restretch(), SETTLE_MS);
    };
    img.onerror = () => {
      canvas.complete = true;
      done(new Error(`tile ${coords.z}/${coords.y}/${coords.x} did not load`), canvas);
    };
    img.src = this.getTileUrl(coords);
    return canvas;
  },

  // One pixel larger on every side, and one pixel up and to the left: over the
  // neighbours' edges.
  _initTile(tile) {
    L.TileLayer.prototype._initTile.call(this, tile);
    const size = this.getTileSize();
    tile.style.setProperty('width', `${size.x + 2}px`);
    tile.style.setProperty('height', `${size.y + 2}px`);
    tile.style.setProperty('margin-left', '-1px');
    tile.style.setProperty('margin-top', '-1px');
  },

  // The canvas of the loaded tile dx, dy steps from `coords`, or null.
  _tileAt(coords, dx, dy) {
    const tile = this._tiles[this._tileCoordsToKey({ x: coords.x + dx, y: coords.y + dy, z: coords.z })];
    return tile && this._stretchPictures.has(tile.el) ? tile.el : null;
  },

  // Count the greys of the tiles in view; if they ask for another stretch than
  // the one drawn, draw every tile again with it.
  _restretch() {
    if (!this._map) return;
    const view = this._map.getBounds();
    const histogram = new Uint32Array(256);
    let counted = 0;
    for (const key in this._tiles) {
      const tile = this._tiles[key];
      const kept = this._stretchPictures.get(tile.el);
      // A tile of another zoom is on its way out; one off screen does not count.
      if (!kept || tile.coords.z !== this._tileZoom) continue;
      if (!view.intersects(this._tileCoordsToBounds(tile.coords))) continue;
      for (let v = 0; v < 256; v++) histogram[v] += kept.histogram[v];
      counted += 1;
    }
    if (counted === 0) return;
    const found = levelsOf(histogram, CUT);
    if (!found) return;
    const levels = widenLevels(found, MIN_SPAN);
    if (levelsClose(levels, this._stretch)) return;
    this._stretch = levels;
    this._stretchTable = levelTable(levels);
    for (const key in this._tiles) this._drawStretched(this._tiles[key].el);
  },

  // The tile's picture with its border, through the stretch, onto its canvas.
  _drawStretched(canvas) {
    const kept = this._stretchPictures.get(canvas);
    if (!kept) return;
    const neighbours = {};
    for (const [side, [dx, dy]] of Object.entries(AROUND)) {
      const next = this._tileAt(kept.coords, dx, dy);
      neighbours[side] = next && this._stretchPictures.get(next).picture;
    }
    const bordered = borderedPicture(kept.picture, neighbours);
    if (canvas.width !== bordered.width) canvas.width = bordered.width;
    if (canvas.height !== bordered.height) canvas.height = bordered.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const out = ctx.createImageData(bordered.width, bordered.height);
    applyLevelTable(bordered.data, this._stretchTable, out.data);
    ctx.putImageData(out, 0, 0);
  },
});
