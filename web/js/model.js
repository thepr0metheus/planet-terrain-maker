// A model: one place, or two places side by side, and the settings it is shown and printed with.
//
// The model gives the mesh what it is built from (heights, outline, frame) and the view what it
// shows (the picture). Two places share the first one's outline (a circle or a contour) and are
// composed into one grid and one picture (split.js); both are made again when the line, a turn, a
// raise or the height mode changes.
//
// It also turns itself into the files the library keeps on the server, and back.

import { HeightGrid } from './height-grid.js';
import { outlineFromJSON } from './outline.js';
import { Place } from './capture.js';
import { Divider } from './divider.js';
import { composeCanvas, composeHeights, defaultVertical, normalTurn, sideAnchors, toMetres, turnedSource } from './split.js';

export const SETTINGS = {
  sizeMm: { value: 100, min: 30, max: 300 },        // along the outline's longer side
  zScale: { value: 1, min: 0.5, max: 10 },          // the heights stretched this many times
  baseMm: { value: 2, min: 1, max: 10 },            // under the lowest point
};

export const DEFAULT_SETTINGS = {
  sizeMm: SETTINGS.sizeMm.value,
  zScale: SETTINGS.zScale.value,
  baseMm: SETTINGS.baseMm.value,
  detail: 'standard',
  style: 'photo',
  styleOptions: {},
  water: { on: false, levelM: 0, calm: false },
  buildings: false,
  light: { azimuthDeg: 315, elevationDeg: 40 },
};

export class TerrainModel {
  // places: one or two Place. compare: for two, { angleDeg, points, smooth, vertical, turns, raises }:
  // the line (divider.js; points null for the line through the centre), how the heights stand, and
  // each place's turn and raise.
  constructor({ places, compare = null, settings = {}, name = '', id = null }) {
    if (!(places?.length === 1 || places?.length === 2)) throw new RangeError('a model has one place or two');
    this.places = places;
    this.name = name;
    this.id = id;                   // the library's id once saved
    this.settings = structuredClone({ ...DEFAULT_SETTINGS, ...settings });
    this.compare = places.length === 2 ? TerrainModel.compareOf(places, compare) : null;
    this._heights = null;
    this._picture = null;
    this._divider = null;
  }

  static compareOf(places, compare) {
    return {
      angleDeg: normalTurn(compare?.angleDeg ?? 0),
      points: compare?.points?.length >= 2 ? compare.points.map(([x, y]) => [x, y]) : null,
      smooth: compare?.smooth ?? true,
      vertical: compare?.vertical ?? defaultVertical(places.map((p) => p.world)),
      turns: (compare?.turns ?? [0, 0]).map(normalTurn),
      raises: (compare?.raises ?? [0, 0]).map((m) => (Number.isFinite(m) ? m : 0)),
    };
  }

  get isSplit() {
    return this.places.length === 2;
  }

  get frame() {
    return this.places[0].frame;
  }

  // Two places share the first one's outline.
  get outline() {
    return this.places[0].outline;
  }

  // The line between two places.
  get divider() {
    const c = this.compare;
    if (c && !this._divider) this._divider = new Divider({ points: c.points, angleDeg: c.angleDeg, smooth: c.smooth });
    return c ? this._divider : null;
  }

  // Where each place's turn dial stands, in frame coordinates (null where a place has no ground).
  dialAnchors() {
    return this.isSplit ? sideAnchors(this.divider, this.outline, this.frame) : null;
  }

  get worlds() {
    return [...new Set(this.places.map((p) => p.world))];
  }

  heights() {
    if (!this._heights) {
      if (!this.isSplit) {
        this._heights = this.places[0].heights;
      } else {
        const c = this.compare;
        this._heights = composeHeights(this.places[0].heights, this.places[1].heights, {
          divider: this.divider, outline: this.outline, frame: this.frame, vertical: c.vertical, turns: c.turns, raises: c.raises,
        });
      }
    }
    return this._heights;
  }

  picture() {
    if (!this._picture) {
      if (!this.isSplit) {
        this._picture = this.places[0].picture;
      } else {
        const [a, b] = this.places.map((p) => p.picture);
        const c = this.compare;
        this._picture = composeCanvas(a, b, { w: Math.max(a.width, b.width), h: Math.max(a.height, b.height) },
          { divider: this.divider, outline: this.outline, frame: this.frame, turns: c.turns });
      }
    }
    return this._picture;
  }

  // Change how two places stand: any of angleDeg, points, smooth, vertical, turns, raises.
  arrange(changes) {
    if (!this.isSplit) return;
    this.compare = TerrainModel.compareOf(this.places, { ...this.compare, ...changes });
    this._heights = null;
    this._picture = null;
    this._divider = null;
  }

  // Another place for part `index`: turned and raised by nothing; the mode is picked again when
  // the mix of worlds changes. The model stays the same model (saved again under its id): one that is
  // to stay as it was is copied in the library first.
  replacePlace(index, place) {
    const before = defaultVertical(this.places.map((p) => p.world));
    this.places = this.places.map((p, i) => (i === index ? place : p));
    const after = defaultVertical(this.places.map((p) => p.world));
    const turns = [...this.compare.turns], raises = [...this.compare.raises];
    turns[index] = 0;
    raises[index] = 0;
    this.compare = TerrainModel.compareOf(this.places, {
      ...this.compare, turns, raises, vertical: before === after ? this.compare.vertical : after,
    });
    this._heights = null;
    this._picture = null;
    this._divider = null;
  }

  // Replace only the picture. Its old library file must stop being the file that Save sends.
  // Heights, the frame and the split's turns remain those chosen on the map and model.
  setPicture(index, { picture, source }) {
    const place = this.places[index];
    if (!place) throw new RangeError('Unknown place');
    place.picture = picture;
    place.stored = null;
    place.sources = { ...place.sources, picture: source.label, ...source.metadata };
    this._picture = null;
  }

  // The ground at (u, v): the height in metres as its source gives it, and which place it is (null
  // for a model of one place). On two places it is the place's own height: no lift, no raise.
  groundAt(u, v) {
    if (!this.isSplit) return { height: this.places[0].heights.sample(u, v), place: null };
    const c = this.compare;
    const side = this.divider.sides(this.outline.reachM).sideOf(...toMetres(u, v, this.frame));
    const [su, sv] = turnedSource(c.turns[side])(u, v);
    return { height: this.places[side].heights.sample(su, sv), place: side };
  }

  // ---------- the library ----------

  // { meta, files } for the server: files are { name: Blob | Uint8Array }. thumb: a JPEG Blob. A picture
  // from the library goes back as its own file: made again from the canvas it would lose a little at
  // each save, and a tablet holds it smaller than the file (device.js).
  async toLibrary(thumb, toJpeg) {
    const files = {};
    const places = [];
    for (const [i, place] of this.places.entries()) {
      const size = place.stored ?? place.picture;
      files[`place-${i}.bin`] = place.heights.toBytes();
      files[`place-${i}.jpg`] = await pictureFile(place, toJpeg);
      places.push({
        world: place.world, center: place.center, frame: place.frame, outline: place.outline.toJSON(),
        name: place.name, sources: place.sources, capturedAt: place.capturedAt,
        heights: { file: `place-${i}.bin`, cols: place.heights.cols, rows: place.heights.rows },
        picture: { file: `place-${i}.jpg`, width: size.width, height: size.height },
      });
    }
    if (thumb) files['thumb.jpg'] = thumb;
    const meta = {
      name: this.name, version: 1, worlds: this.worlds, places,
      compare: this.compare, settings: this.settings,
    };
    return { meta, files };
  }

  // A model from the library. fetchFile(name) -> Promise<ArrayBuffer>; picture(name) -> Promise<canvas>.
  static async fromLibrary(meta, fetchFile, picture) {
    const places = await Promise.all(meta.places.map(async (p) => new Place({
      world: p.world, center: p.center, frame: p.frame, outline: outlineFromJSON(p.outline), name: p.name,
      sources: p.sources, capturedAt: p.capturedAt,
      heights: HeightGrid.fromBytes(p.heights.cols, p.heights.rows, await fetchFile(p.heights.file)),
      picture: await picture(p.picture.file),
      stored: { width: p.picture.width, height: p.picture.height, bytes: () => fetchFile(p.picture.file) },
    })));
    return new TerrainModel({ places, compare: meta.compare, settings: meta.settings, name: meta.name, id: meta.id });
  }
}

// The JPEG of a place's picture for the library: its saved file, when it has one. When that file is
// gone (the model removed meanwhile), a picture on screen at the file's full size is made again; a
// smaller one never takes the file's place.
async function pictureFile(place, toJpeg) {
  if (!place.stored) return toJpeg(place.picture);
  try {
    return new Uint8Array(await place.stored.bytes());
  } catch (e) {
    if (!place.reduced) return toJpeg(place.picture);
    throw e;
  }
}
