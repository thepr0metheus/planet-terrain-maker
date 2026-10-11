// Between the model's frame and an Earth's source tiles, including a comparison part's rotation.
import { LocalFrame, Mercator } from './geo.js';
import { mPerDegOf, WORLDS } from './worlds.js';
import { turnedSource, toFrame, toMetres } from './split.js';

export class TileFrame {
  constructor(place, turn = 0) {
    this.place = place;
    this.local = new LocalFrame(place.center.lat, place.center.lon, mPerDegOf(WORLDS.earth));
    this._source = turnedSource(turn);
    this._model = turnedSource(-turn);
  }

  pixel(u, v, z) {
    const [su, sv] = this._source(u, v);
    const [x, y] = toMetres(su, sv, this.place.frame);
    const ll = this.local.toLatLon(x, y);
    return Mercator.px(ll.lat, ll.lon, z);
  }

  modelUv(x, y, z) {
    const ll = Mercator.latLon(x, y, z), xy = this.local.toXY(ll.lat, ll.lon);
    return this._model(...toFrame(xy.x, xy.y, this.place.frame));
  }

  bounds(x, y, z, size) {
    const points = [[x, y], [x + size, y], [x, y + size], [x + size, y + size]].map((p) => this.modelUv(...p, z));
    return { left: Math.max(0, Math.min(...points.map((p) => p[0])) - 1e-6), right: Math.min(1, Math.max(...points.map((p) => p[0])) + 1e-6),
      top: Math.max(0, Math.min(...points.map((p) => p[1])) - 1e-6), bottom: Math.min(1, Math.max(...points.map((p) => p[1])) + 1e-6) };
  }
}
