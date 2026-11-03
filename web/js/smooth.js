// A smooth line through the corners the user clicks: a centripetal Catmull-Rom spline. It passes
// through every corner, so a corner still is where it was put, and the centripetal kind does not
// loop or overshoot where corners are close together.
//
// It does not cross itself where the corners' straight lines do not. The bulge of a stretch between
// two corners can reach across a narrow bay to the bulge of the other side, and the page would then
// refuse a contour whose corners are fine: such a stretch is drawn straight, as with sharp corners,
// and the rest of the line stays round.
//
// smoothPath is a plain function: one call is a stateless rule of geometry (the same corners give
// the same line, nothing is kept between calls).

import { firstCrossing } from './outline.js';

const ALPHA = 0.5;               // centripetal
export const PER_EDGE = 10;      // points a stretch between two corners gets

// points: [[x, y], ...]. closed: the last corner joins the first. Gives the corners and PER_EDGE - 1
// points between each two of them; a closed path does not repeat its first point at the end.
export function smoothPath(points, { closed = true, perEdge = PER_EDGE } = {}) {
  if (points.length < 3) return points.map(([x, y]) => [x, y]);
  const straight = new Set();    // the stretches drawn straight, by their first corner
  for (;;) {
    const line = trace(points, closed, perEdge, straight);
    const crossing = firstCrossing(line, closed);
    // a side of the line belongs to the stretch it was traced in
    const round = (crossing ?? []).map((side) => Math.floor(side / perEdge)).filter((s) => !straight.has(s));
    // no crossing, or one of the corners' own straight lines: nothing smoothing can do
    if (!round.length) return line;
    for (const s of round) straight.add(s);
  }
}

function trace(points, closed, perEdge, straight) {
  const n = points.length;
  const at = (i) => {
    if (closed) return points[((i % n) + n) % n];
    // an open path's ends: a corner mirrored past the end, so the line leaves the end straight
    if (i < 0) return mirror(points[0], points[1]);
    if (i >= n) return mirror(points[n - 1], points[n - 2]);
    return points[i];
  };
  const out = [];
  const stretches = closed ? n : n - 1;
  for (let i = 0; i < stretches; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    for (let k = 0; k < perEdge; k++) out.push(straight.has(i) ? along(p1, p2, k / perEdge) : between(p0, p1, p2, p3, k / perEdge));
  }
  if (!closed) out.push([...points[n - 1]]);
  return out;
}

const mirror = ([x, y], [ox, oy]) => [2 * x - ox, 2 * y - oy];

const along = (a, b, s) => (s === 0 ? [a[0], a[1]] : [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s]);

// The point a share s (0..1) of the way from p1 to p2 (Barry and Goldman's form).
function between(p0, p1, p2, p3, s) {
  const gap = (a, b) => Math.max(1e-9, Math.hypot(b[0] - a[0], b[1] - a[1]) ** ALPHA);
  const t0 = 0, t1 = t0 + gap(p0, p1), t2 = t1 + gap(p1, p2), t3 = t2 + gap(p2, p3);
  const t = t1 + (t2 - t1) * s;
  const mix = (a, b, ta, tb) => {
    const w = (t - ta) / (tb - ta);
    return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w];
  };
  const a1 = mix(p0, p1, t0, t1), a2 = mix(p1, p2, t1, t2), a3 = mix(p2, p3, t2, t3);
  const b1 = mix(a1, a2, t0, t2), b2 = mix(a2, a3, t1, t3);
  return mix(b1, b2, t1, t2);
}
