// The outline of a model on the ground, in metres about the centre of its place (x east, y north):
// a circle, or a contour the user draws. The model is the ground inside it.
//
// The mesh (terrain-mesh.js) asks an outline three things: which grid nodes are inside (a whole
// row at a time), where a grid edge crosses it, and how big it is.

export class CircleOutline {
  constructor(radiusM) {
    if (!(radiusM > 0)) throw new RangeError(`a circle needs a radius, not ${radiusM}`);
    this.kind = 'circle';
    this.radiusM = radiusM;
  }

  get bounds() {
    const r = this.radiusM;
    return { minX: -r, maxX: r, minY: -r, maxY: r };
  }

  // How far from the centre the outline reaches at most.
  get reachM() {
    return this.radiusM;
  }

  contains(x, y) {
    return x * x + y * y < this.radiusM * this.radiusM;
  }

  // Which of the points (xs[i], y) are inside, into `out` (a Uint8Array, 1 inside).
  insideRow(y, xs, out) {
    const r2 = this.radiusM * this.radiusM - y * y;
    for (let i = 0; i < xs.length; i++) out[i] = xs[i] * xs[i] < r2 ? 1 : 0;
  }

  // Where the segment from (ax, ay) inside to (bx, by) outside leaves the outline: 0..1 along it.
  crossing(ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const a = dx * dx + dy * dy, b = 2 * (ax * dx + ay * dy), c = ax * ax + ay * ay - this.radiusM ** 2;
    const t = (-b + Math.sqrt(Math.max(0, b * b - 4 * a * c))) / (2 * a);
    return Math.min(1, Math.max(0, t));
  }

  toJSON() {
    return { kind: 'circle', radiusM: this.radiusM };
  }
}

export class PolygonOutline {
  // points: [[x, y], ...] in metres, in either order, not closed (the last point is not the first).
  constructor(points) {
    if (!Array.isArray(points) || points.length < 3) throw new RangeError('a contour needs 3 points at least');
    this.kind = 'polygon';
    this.points = points.map(([x, y]) => [x, y]);
    if (this.crossesItself()) throw new RangeError('the contour crosses itself');
  }

  get bounds() {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of this.points) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    return { minX, maxX, minY, maxY };
  }

  get reachM() {
    return Math.max(...this.points.map(([x, y]) => Math.hypot(x, y)));
  }

  // Area in square metres.
  get area() {
    let twice = 0;
    const p = this.points;
    for (let i = 0; i < p.length; i++) {
      const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length];
      twice += x1 * y2 - x2 * y1;
    }
    return Math.abs(twice) / 2;
  }

  contains(x, y) {
    let inside = false;
    const p = this.points;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const [xi, yi] = p[i], [xj, yj] = p[j];
      if ((yi > y) !== (yj > y) && x < xj + (y - yj) * (xi - xj) / (yi - yj)) inside = !inside;
    }
    return inside;
  }

  // As contains(), for a row of points at once: where the row crosses the contour, sorted, then
  // a point is inside past an odd number of crossings.
  insideRow(y, xs, out) {
    insideRowOf(this.points, y, xs, out);
  }

  crossing(ax, ay, bx, by) {
    // The first crossing on the way out: the one nearest the inside end.
    let best = 1;
    const p = this.points;
    const dx = bx - ax, dy = by - ay;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const [x1, y1] = p[j], [x2, y2] = p[i];
      const ex = x2 - x1, ey = y2 - y1;
      const den = dx * ey - dy * ex;
      if (den === 0) continue;
      const t = ((x1 - ax) * ey - (y1 - ay) * ex) / den;
      const s = ((x1 - ax) * dy - (y1 - ay) * dx) / den;
      if (t >= 0 && t <= 1 && s >= 0 && s <= 1 && t < best) best = t;
    }
    return best;
  }

  // Whether two edges that do not share a point cross.
  crossesItself() {
    const p = this.points, n = p.length;
    const side = (a, b, c) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
    for (let i = 0; i < n; i++) {
      const a = p[i], b = p[(i + 1) % n];
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;       // neighbours across the closing edge
        const c = p[j], d = p[(j + 1) % n];
        if (side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0) return true;
      }
    }
    return false;
  }

  toJSON() {
    return { kind: 'polygon', points: this.points.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]) };
  }
}

// Which of the points (xs[i], y) are inside the polygon `points` (even-odd), into `out`: where the
// row crosses the polygon's edges, sorted; a point is inside past an odd number of crossings.
export function insideRowOf(points, y, xs, out) {
  const cuts = [];
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i], [xj, yj] = points[j];
    if ((yi > y) !== (yj > y)) cuts.push(xj + (y - yj) * (xi - xj) / (yi - yj));
  }
  cuts.sort((a, b) => a - b);
  let k = 0;
  for (let i = 0; i < xs.length; i++) {
    while (k < cuts.length && cuts[k] <= xs[i]) k += 1;
    out[i] = k % 2;
  }
}

export function outlineFromJSON(json) {
  if (json?.kind === 'circle') return new CircleOutline(json.radiusM);
  if (json?.kind === 'polygon') return new PolygonOutline(json.points);
  throw new RangeError(`unknown outline: ${JSON.stringify(json)}`);
}
