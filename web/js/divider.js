// The line that divides a model of two places: the first place on one side, the second on the
// other. Either the straight line through the centre (the usual), or a line the user draws: two or
// more points, a smooth curve through them (smooth.js), through the centre or not. The whole line
// turns about the centre.
//
// Metres: x east, y north, about the middle of the outline. Going along the line from its first
// point to its last, the first place lies on the left and the second on the right. Past its ends
// the line runs on straight, so it always cuts the whole outline in two.

import { smoothPath } from './smooth.js';
import { insideRowOf } from './outline.js';

const ARC_POINTS = 48;          // the far side of a half, closed round by an arc

export class Divider {
  // points: [[x, y], ...] as drawn (2 at least), or null for the line through the centre.
  // angleDeg: the line turned clockwise about the centre; at 0 the centre line runs north, with the
  // first place to the west. smooth: a curve through the points rather than straight lines.
  constructor({ points = null, angleDeg = 0, smooth = true } = {}) {
    if (points !== null && !(Array.isArray(points) && points.length >= 2)) throw new RangeError('a drawn line needs 2 points at least');
    if (!Number.isFinite(angleDeg)) throw new RangeError(`angleDeg must be a number, got ${angleDeg}`);
    this.points = points?.map(([x, y]) => [x, y]) ?? null;
    this.angleDeg = ((angleDeg % 360) + 360) % 360;
    this.smooth = Boolean(smooth);
    const a = this.angleDeg * Math.PI / 180;
    this._cos = Math.cos(a);
    this._sin = Math.sin(a);
    this._sides = new Map();       // reachM -> Sides
  }

  get drawn() { return this.points !== null; }

  // The same line turned to angleDeg.
  turnedTo(angleDeg) {
    return new Divider({ points: this.points, angleDeg, smooth: this.smooth });
  }

  // The same line with the places' sides swapped.
  swapped() {
    return this.drawn
      ? new Divider({ points: [...this.points].reverse(), angleDeg: this.angleDeg, smooth: this.smooth })
      : new Divider({ angleDeg: this.angleDeg + 180 });
  }

  // The line from end to end, turned, its ends carried on straight to at least reachM from the centre.
  path(reachM) {
    const drawn = this.drawn ? (this.smooth ? smoothPath(this.points, { closed: false }) : this.points) : [[0, -1], [0, 1]];
    return carriedOn(drawn.map(([x, y]) => this._turn(x, y)), reachM);
  }

  // Which side of the line each point is on, for an outline that reaches reachM from the centre.
  sides(reachM) {
    let sides = this._sides.get(reachM);
    if (!sides) {
      sides = new Sides(this.path(2 * reachM), 4 * reachM);
      this._sides.set(reachM, sides);
    }
    return sides;
  }

  toJSON() {
    return { points: this.points?.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]) ?? null, angleDeg: this.angleDeg, smooth: this.smooth };
  }

  _turn(x, y) {
    return [x * this._cos + y * this._sin, -x * this._sin + y * this._cos];
  }
}

// The two sides of a line, as far as reach: the second place's side as a polygon (the line, then
// round the far side by an arc of radius arcM), and the test of a point or a row of points.
class Sides {
  constructor(line, arcM) {
    this.line = line;
    const [ax, ay] = line[0], [bx, by] = line[line.length - 1];
    // From the line's last end back to its first, clockwise: round the right-hand side.
    const from = Math.atan2(by, bx), to = Math.atan2(ay, ax);
    const sweep = ((from - to) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI;
    const arc = [];
    for (let k = 0; k <= ARC_POINTS; k++) {
      const a = from - sweep * k / ARC_POINTS;
      arc.push([arcM * Math.cos(a), arcM * Math.sin(a)]);
    }
    this.second = [...line, ...arc];
    this._row = new Uint8Array(1);
  }

  // 0 for the first place, 1 for the second.
  sideOf(x, y) {
    this._row[0] = 0;
    insideRowOf(this.second, y, [x], this._row);
    return this._row[0];
  }

  // The side of each point (xs[i], y), into `out` (a Uint8Array).
  sideRow(y, xs, out) {
    insideRowOf(this.second, y, xs, out);
  }
}

// The line with its ends carried on straight, the way each end points, until they are at least
// reachM from the centre.
function carriedOn(points, reachM) {
  const out = points.map(([x, y]) => [x, y]);
  const away = (end, before) => {
    const [ex, ey] = out[end];
    let k = before;
    while (out[k] && Math.hypot(ex - out[k][0], ey - out[k][1]) < 1e-9) k += before - end;
    if (!out[k]) return null;
    const dx = ex - out[k][0], dy = ey - out[k][1], d = Math.hypot(dx, dy);
    const far = reachM + Math.hypot(ex, ey);
    return [ex + dx / d * far, ey + dy / d * far];
  };
  const first = away(0, 1), last = away(out.length - 1, out.length - 2);
  if (!first || !last) throw new RangeError('a line needs two points apart');
  return [first, ...out, last];
}
