// Buildings on a model of a place on Earth: their outlines and heights from OpenStreetMap (the
// server's /api/buildings), stood on the ground of the model as closed solids, in the model's
// millimetres. Only the buildings whose middle lies inside the outline.

import { ShapeUtils, Vector2 } from '../vendor/three/three.module.js';
import { t } from './i18n.js';

export const MAX_SIDE_KM = 10;
const SINK_MM = 0.2;              // into the ground, so that no gap shows under a building on a slope
const SMALLEST_MM2 = 0.25;        // a footprint smaller than this on the model is left out

export class BuildingsError extends Error {}

export class Buildings {
  constructor(fetchFn = (...a) => fetch(...a)) {
    this._fetch = fetchFn;
    this._kept = new Map();       // place -> Promise of the buildings in its frame's metres
  }

  // Whether a place can have buildings: on Earth, and small enough.
  static fits(place) {
    return place.world === 'earth' && Math.max(place.frame.widthM, place.frame.heightM) <= MAX_SIDE_KM * 1000 * 1.15;
  }

  // The buildings of a place: [{ ring: [[x, y], ...] metres about its centre, height: metres }].
  load(place) {
    if (!this._kept.has(place)) {
      const job = this._ask(place);
      job.catch(() => this._kept.delete(place));
      this._kept.set(place, job);
    }
    return this._kept.get(place);
  }

  async _ask(place) {
    const frame = place.localFrame;
    const box = frame.boxOf(place.frame.widthM / 2, place.frame.heightM / 2);
    const query = new URLSearchParams({ south: box.south, north: box.north, west: box.west, east: box.east });
    const response = await this._fetch(`/api/buildings?${query}`);
    const said = await response.json().catch(() => ({}));
    if (!response.ok) throw new BuildingsError(said.error || t('The buildings did not come ({status}).', { status: response.status }));
    return {
      cut: said.cut,
      buildings: said.buildings.map(({ ring, height }) => ({
        ring: ring.map(([lon, lat]) => {
          const { x, y } = frame.toXY(lat, lon);
          return [x, y];
        }),
        height,
      })),
    };
  }
}

// One closed solid of all the buildings inside the outline. scale: the mesh's { mmPerM, zMmPerM };
// groundMm(x, y): the top of the model's ground at a point (metres about the centre), millimetres.
export function buildingsSolid(buildings, outline, scale, groundMm) {
  const positions = [];
  const indices = [];
  for (const { ring, height } of buildings) {
    if (ring.length < 3) continue;
    let cx = 0, cy = 0;
    for (const [x, y] of ring) { cx += x; cy += y; }
    cx /= ring.length;
    cy /= ring.length;
    if (!outline.contains(cx, cy)) continue;
    const contour = ring.map(([x, y]) => new Vector2(x * scale.mmPerM, y * scale.mmPerM));
    if (Math.abs(ShapeUtils.area(contour)) < SMALLEST_MM2) continue;
    if (ShapeUtils.isClockWise(contour)) contour.reverse();
    const grounds = ring.map(([x, y]) => groundMm(x, y)).concat(groundMm(cx, cy));
    const bottom = Math.min(...grounds) - SINK_MM;
    const top = Math.max(...grounds) + height * scale.zMmPerM;
    const n = contour.length;
    const first = positions.length / 3;
    for (const p of contour) positions.push(p.x, p.y, bottom);
    for (const p of contour) positions.push(p.x, p.y, top);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      // a wall faces out: the contour runs anticlockwise, so outward is on its right
      indices.push(first + i, first + j, first + n + j, first + i, first + n + j, first + n + i);
    }
    for (const [a, b, c] of ShapeUtils.triangulateShape([...contour], [])) {
      // earcut's own order is not promised: each triangle is put anticlockwise first
      const [p, q, r] = ShapeUtils.isClockWise([contour[a], contour[b], contour[c]]) ? [a, c, b] : [a, b, c];
      indices.push(first + n + p, first + n + q, first + n + r);     // the roof, facing up
      indices.push(first + p, first + r, first + q);                 // the floor, facing down
    }
  }
  if (!indices.length) return null;
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}
