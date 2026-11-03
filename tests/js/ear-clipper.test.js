import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EarClipper } from '../../web/js/ear-clipper.js';

const cut = (points) => {
  const clipper = new EarClipper(points.map((p) => p[0]), points.map((p) => p[1]));
  return { clipper, triangles: clipper.triangles() };
};

const twiceArea = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

const sizeOf = (points) => {
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
};

// The triangles are a triangulated disc that has the polygon for its rim: n - 2 of them, every
// corner in one, each side of the polygon in one triangle running the polygon's way, every other
// edge in two that run it both ways. With every triangle turning the way the polygon does (to
// within the clipper's own tolerance), such a disc cannot fold over itself.
//   forced: how many corners the clipper says it had to cut though they were not clean (null: not asked)
//   upright: every triangle turns the way the polygon does
//   slivers: triangles with no height at all are allowed (a polygon that has no area in places)
function assertDisc(points, what, { forced = 0, upright = true, slivers = false } = {}) {
  const { clipper, triangles } = cut(points);
  const n = points.length, size = sizeOf(points);
  assert.equal(triangles.length, 3 * (n - 2), `${what}: ${n - 2} triangles`);
  const runs = new Map();
  const used = new Set();
  let area = 0;
  for (let k = 0; k < triangles.length; k += 3) {
    const corners = [triangles[k], triangles[k + 1], triangles[k + 2]];
    for (const v of corners) {
      assert.ok(v >= 0 && v < n, `${what}: corner ${v} is not one of the polygon's`);
      used.add(v);
    }
    for (let s = 0; s < 3; s++) {
      const key = `${corners[s]}>${corners[(s + 1) % 3]}`;
      runs.set(key, (runs.get(key) ?? 0) + 1);
    }
    const [a, b, c] = corners.map((v) => points[v]);
    const twice = twiceArea(a, b, c);
    if (upright) assert.ok(twice >= -2e-9 * size * size, `${what}: triangle ${corners} turns the wrong way (${twice})`);
    // the smallest height of the triangle is over its longest side
    const longest = Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]), Math.hypot(c[0] - b[0], c[1] - b[1]), Math.hypot(a[0] - c[0], a[1] - c[1]));
    if (!slivers) assert.ok(twice / longest > 1e-9 * size, `${what}: triangle ${corners} is a sliver (height ${twice / longest})`);
    area += twice / 2;
  }
  assert.equal(used.size, n, `${what}: every corner is used`);
  for (let v = 0; v < n; v++) {
    const w = (v + 1) % n;
    assert.equal(runs.get(`${v}>${w}`), 1, `${what}: side ${v}-${w} is in one triangle`);
    assert.equal(runs.get(`${w}>${v}`) ?? 0, 0, `${what}: side ${v}-${w} is not run backwards`);
  }
  for (const [key, count] of runs) {
    const [v, w] = key.split('>').map(Number);
    if (w === (v + 1) % n) continue;
    assert.equal(count, 1, `${what}: ${key} is run once`);
    assert.equal(runs.get(`${w}>${v}`), 1, `${what}: ${key} has its other way`);
  }
  const whole = points.reduce((sum, p, v) => sum + twiceArea(points[0], p, points[(v + 1) % n]), 0) / 2;
  assert.ok(Math.abs(area - whole) <= 1e-9 * (Math.abs(whole) + size * size), `${what}: the triangles hold ${area}, the polygon ${whole}`);
  if (forced !== null) assert.equal(clipper.forced, forced, `${what}: corners cut that were not clean`);
  return { triangles, clipper };
}

const regular = (sides, radius = 1, turn = 0) => Array.from({ length: sides }, (_, i) => [radius * Math.cos(turn + (2 * Math.PI * i) / sides), radius * Math.sin(turn + (2 * Math.PI * i) / sides)]);

// The corners of a polygon with `stops` extra corners spread along each side.
const withStops = (corners, stops, wobble = 0, random = () => 0.5) => corners.flatMap((a, i) => {
  const b = corners[(i + 1) % corners.length];
  const out = [a];
  for (let s = 1; s <= stops; s++) {
    const t = s / (stops + 1);
    out.push([a[0] + t * (b[0] - a[0]) + wobble * (random() - 0.5), a[1] + t * (b[1] - a[1]) + wobble * (random() - 0.5)]);
  }
  return out;
});

// A small deterministic random source.
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('a triangle is one triangle, a polygon of n corners is n - 2', () => {
  const triangle = [...cut([[0, 0], [1, 0], [0, 1]]).triangles];
  const from = triangle.indexOf(0);
  assert.deepEqual([...triangle.slice(from), ...triangle.slice(0, from)], [0, 1, 2], 'the polygon itself, the way round it runs');
  for (const n of [4, 5, 6, 7, 12, 100, 1000]) assertDisc(regular(n, 50, 0.3), `a regular ${n}-gon`);
});

test('a polygon with dents is cut without crossing them', () => {
  const shapes = {
    'an L': [[0, 0], [6, 0], [6, 3], [3, 3], [3, 6], [0, 6]],
    'a dart': [[0, 0], [5, 2], [10, 0], [5, 10]],
    'a C': [[0, 0], [9, 0], [9, 3], [3, 3], [3, 6], [9, 6], [9, 9], [0, 9]],
    'a comb': [[0, 0], [12, 0], [12, 5], [11, 5], [11, 1], [9, 1], [9, 5], [8, 5], [8, 1], [6, 1], [6, 5], [5, 5], [5, 1], [3, 1], [3, 5], [2, 5], [2, 1], [1, 1], [1, 5], [0, 5]],
    'a spiky star': Array.from({ length: 24 }, (_, i) => [(i % 2 ? 1 : 10) * Math.cos((Math.PI * i) / 12), (i % 2 ? 1 : 10) * Math.sin((Math.PI * i) / 12)]),
    'a slit that almost closes': [[0, 0], [10, 0], [10, 10], [5.0001, 10], [5.0001, 1], [4.9999, 1], [4.9999, 10], [0, 10]],
    // ears of these lie close to dents of the polygon that are not in them: a test that took the
    // region beyond a side of the ear for the ear, would find no ear to cut
    'a jagged polygon, eleven corners': [[45, 87], [14, 79], [40, 89], [46, 89], [28, 6], [43, 72], [56, 59], [55, 45], [75, 92], [9, 89], [31, 35]],
    'a jagged polygon, twelve corners': [[39, 52], [4, 64], [26, 5], [100, 32], [19, 55], [49, 48], [35, 60], [89, 51], [96, 55], [93, 61], [10, 75], [3, 66]],
  };
  for (const [name, points] of Object.entries(shapes)) assertDisc(points, name);
});

test('a corner on a straight stretch stays a corner of the triangles', () => {
  // exactly on the line, on every side, evenly and not
  assertDisc(withStops([[0, 0], [8, 0], [8, 8], [0, 8]], 1), 'a square with a point in the middle of each side');
  assertDisc(withStops([[0, 0], [8, 0], [8, 8], [0, 8]], 7), 'a square with seven points on each side');
  assertDisc([[0, 0], [1, 0], [2, 0], [5, 0], [6, 0], [6, 1], [6, 4], [6, 6], [0, 6], [0, 3], [0, 2]], 'a rectangle with points here and there');
  assertDisc(withStops([[0, 0], [10, 0], [10, 1], [0, 1]], 40), 'a bar, forty points to a side');
  assertDisc(withStops([[0, 0], [20, 0], [20, 1], [0, 1]], 30).slice().reverse().map(([x, y]) => [x, -y]), 'the same bar, the other way round');
});

test('sides that are straight to within rounding are cut the same way', () => {
  const corners = [[-300, -300], [300, -300], [0, 300]];
  assertDisc(withStops(corners, 60), 'a triangle, sixty points to a side, as rounding leaves them');
  assertDisc(withStops(corners, 60, 1e-12, seeded(5)), 'the same with a trillionth of wobble');
  assertDisc(withStops(regular(7, 931.7, 0.77), 25, 1e-11, seeded(6)), 'a heptagon');
  assertDisc(withStops([[0, 0], [1e6, 0], [1e6, 1], [0, 1]], 50, 1e-9, seeded(7)), 'a bar a million times as long as it is wide');
  // far from the origin, where the numbers are large and the differences small
  assertDisc(withStops(regular(5, 400, 0.2).map(([x, y]) => [x + 9e5, y - 7e5]), 40, 1e-9, seeded(8)), 'a pentagon far from the origin');
});

// Polygons that are not simple, or have no area: the clipper is not asked for these, but a disc
// comes out of whatever it is given, and a cut that costs nothing (a corner on a line) is not
// counted among the ones that do.
test('polygons that are not simple, or flat, are still cut into a disc', () => {
  assertDisc([[0, 0], [4, 0], [4, 4], [2, 4], [2, 9], [2, 4], [0, 4]], 'a spike as thin as a line', { slivers: true });
  assertDisc([[0, 0], [10, 0], [10, 10], [5, 10], [5, 1], [5, 10], [0, 10]], 'a slit with no width', { slivers: true });
  assertDisc([[0, 0], [5, 0], [5, 5], [5, 5], [0, 5]], 'a corner twice', { slivers: true });
  assertDisc([[1, 2], [0, 2], [0, 0], [4, 4], [1, 2]], 'a ring closed by its first corner again', { slivers: true });
  assertDisc([[0, 0], [1, 0], [2, 0], [3, 0], [5, 0]], 'all on one line', { slivers: true });
  assertDisc([[3, 3], [3, 3], [3, 3], [3, 3], [3, 3]], 'all in one place', { slivers: true });
  // two squares that touch at a corner: a corner has to be cut that another corner of the same place stands in
  assertDisc([[0, 0], [1, 1], [2, 0], [2, 2], [1, 1], [0, 2]], 'two triangles that touch at a corner', { forced: null, slivers: true });
});

test('a polygon that runs the wrong way is cut, and every cut is counted as not clean', () => {
  const square = [[0, 0], [0, 4], [4, 4], [4, 0]];
  assertDisc(square, 'a square run clockwise', { forced: 2, upright: false, slivers: true });
  const clipper = new EarClipper(square.map((p) => p[0]), square.map((p) => p[1]));
  clipper.triangles();
  clipper.triangles();
  assert.equal(clipper.forced, 2, 'counted afresh each time');
});

test('random simple polygons: a disc each, and not one corner cut that was not clean', () => {
  const random = seeded(2024);
  for (let round = 0; round < 300; round++) {
    // star-shaped about the origin: simple whatever the radii
    const n = 3 + Math.floor(random() * 60);
    const star = Array.from({ length: n }, (_, i) => {
      const a = (2 * Math.PI * (i + 0.9 * random())) / n, r = 1 + 99 * random() ** 2;
      return [r * Math.cos(a), r * Math.sin(a)];
    });
    assertDisc(star, `star ${round}`);
    // and with points on its sides
    assertDisc(withStops(star, Math.floor(random() * 6)), `star ${round} with points on its sides`);
  }
});

test('the corners come out anticlockwise, like the polygon, and twice gives the same', () => {
  const points = withStops(regular(6, 10), 3);
  const clipper = new EarClipper(points.map((p) => p[0]), points.map((p) => p[1]));
  const first = [...clipper.triangles()];
  assert.deepEqual([...clipper.triangles()], first);
  for (let k = 0; k < first.length; k += 3) assert.ok(twiceArea(...[0, 1, 2].map((s) => points[first[k + s]])) > 0);
});

test('fewer than three corners, or an x without a y, is refused', () => {
  assert.throws(() => new EarClipper([0, 1], [0, 1]), RangeError);
  assert.throws(() => new EarClipper([0, 1, 2], [0, 1]), RangeError);
});

// A big outline cut by the grid at fine detail has thousands of corners, most of them on
// straight stretches. The time is a generous bound: cutting it takes a fraction of it.
test('ten thousand corners, most of them on straight sides, are cut in seconds', () => {
  const points = withStops(regular(5, 5000, 0.4), 2000, 1e-10, seeded(9));
  const started = performance.now();
  const { triangles, clipper } = cut(points);
  const seconds = (performance.now() - started) / 1000;
  assert.equal(triangles.length, 3 * (points.length - 2));
  assert.equal(clipper.forced, 0);
  assert.ok(seconds < 5, `${seconds} s`);
});
