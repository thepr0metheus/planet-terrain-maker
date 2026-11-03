import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PER_EDGE, smoothPath } from '../../web/js/smooth.js';
import { PolygonOutline, firstCrossing } from '../../web/js/outline.js';

const square = [[0, 0], [100, 0], [100, 100], [0, 100]];

test('a smooth contour passes through every corner and rounds the corners between them', () => {
  const line = smoothPath(square);
  assert.equal(line.length, square.length * PER_EDGE);
  for (let i = 0; i < square.length; i++) assert.deepEqual(line[i * PER_EDGE], square[i], 'the corner is where it was put');
  // halfway along an edge the line bulges out a little, not much
  const [, y] = line[PER_EDGE / 2];
  assert.ok(y < 0 && y > -15, `the bottom edge bulges ${y} m`);
  // no sharp turn is left: the direction changes by less than 30 degrees from point to point
  for (let i = 0; i < line.length; i++) {
    const a = line[(i + line.length - 1) % line.length], b = line[i], c = line[(i + 1) % line.length];
    const turn = Math.abs(Math.atan2(c[1] - b[1], c[0] - b[0]) - Math.atan2(b[1] - a[1], b[0] - a[0]));
    assert.ok(Math.min(turn, 2 * Math.PI - turn) < Math.PI / 6, `turn at ${i}`);
  }
  assert.doesNotThrow(() => new PolygonOutline(line), 'still a contour that does not cross itself');
});

test('corners in a row stay a straight line; corners on one spot give no holes in the numbers', () => {
  const straight = smoothPath([[0, 0], [10, 0], [20, 0], [30, 0]], { closed: false });
  assert.ok(straight.every(([, y]) => Math.abs(y) < 1e-9));
  assert.deepEqual(straight.at(-1), [30, 0]);
  const twice = smoothPath([[0, 0], [50, 0], [50, 0], [0, 60]]);
  assert.ok(twice.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)));
  assert.deepEqual(smoothPath([[1, 2], [3, 4]]), [[1, 2], [3, 4]], 'two corners: nothing to round');
});

// Whether two sides of a line cross, worked out here on its own, so that the test does not lean on
// the code it tests.
function crosses(line, closed = true) {
  const n = line.length, sides = closed ? n : n - 1;
  const turn = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (let i = 0; i < sides; i++) {
    for (let j = i + 2; j < sides; j++) {
      if (closed && i === 0 && j === n - 1) continue;
      const [a, b, c, d] = [line[i], line[(i + 1) % n], line[j], line[(j + 1) % n]];
      if (turn(a, b, c) * turn(a, b, d) < 0 && turn(c, d, a) * turn(c, d, b) < 0) return true;
    }
  }
  return false;
}

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

// Corners a person might click, put in an order whose straight lines do not cross: wherever two
// cross, the corners between them go the other way round.
function contour(random, n) {
  const corners = Array.from({ length: n }, () => [Math.round(random() * 1000), Math.round(random() * 1000)]);
  for (let found = firstCrossing(corners); found; found = firstCrossing(corners)) {
    const [i, j] = found;
    corners.splice(i + 1, j - i, ...corners.slice(i + 1, j + 1).reverse());
  }
  return corners;
}

const at = (line, i) => line[i * PER_EDGE];

// A deep bay narrower than the bulge its sides would make: the clicked corners do not cross, and
// the smooth line through them must not either, or the page refuses the contour it shows.
const BAY = [[0, 0], [1000, 0], [1000, 600], [520, 600], [509, 299], [480, 600], [0, 600]];

test('a bay narrower than the bulge of its sides: the smooth line keeps out of itself', () => {
  const line = smoothPath(BAY);
  assert.equal(crosses(line), false);
  assert.doesNotThrow(() => new PolygonOutline(line));
  assert.equal(line.length, BAY.length * PER_EDGE);
  for (let i = 0; i < BAY.length; i++) assert.deepEqual(at(line, i), BAY[i], 'the corner is where it was put');
  // what is far from the bay stays round: halfway up the right side the line bulges out
  const [x] = line[PER_EDGE + PER_EDGE / 2];
  assert.ok(x > 1000, `the right side, x ${x}`);
});

test('contours whose corners do not cross: the smooth line through them does not either', () => {
  const random = seeded(7);
  for (let round = 0; round < 300; round++) {
    const corners = contour(random, 4 + Math.floor(random() * 11));
    const line = smoothPath(corners);
    assert.equal(crosses(line), false, JSON.stringify(corners));
    for (let i = 0; i < corners.length; i++) assert.deepEqual(at(line, i), corners[i]);
  }
  for (let round = 0; round < 200; round++) {
    // bays of all widths and depths, the tip anywhere across the mouth
    const half = 2 + 60 * random(), depth = 50 + 550 * random(), tip = 500 + half * (2 * random() - 1);
    const corners = [[0, 0], [1000, 0], [1000, 600], [500 + half, 600], [tip, 600 - depth], [500 - half, 600], [0, 600]];
    assert.equal(crosses(smoothPath(corners)), false, JSON.stringify(corners));
  }
});

test('an open line keeps out of itself too, with its ends where they were put', () => {
  const random = seeded(11);
  for (let round = 0; round < 300; round++) {
    const corners = contour(random, 3 + Math.floor(random() * 8));
    // an open line: its corners' straight lines must not cross, the closing one aside
    if (crosses(corners, false)) continue;
    const line = smoothPath(corners, { closed: false });
    assert.equal(crosses(line, false), false, JSON.stringify(corners));
    assert.deepEqual(line[0], corners[0]);
    assert.deepEqual(line.at(-1), corners.at(-1));
  }
});

test('an open line is not closed for the test: an S whose chord from end to start crosses it stays round', () => {
  const S = [[0, 0], [100, 0], [100, 50], [0, 60], [0, 100], [100, 100]];
  assert.equal(firstCrossing(S, false), null, 'no side of the S crosses another');
  const line = smoothPath(S, { closed: false });
  // the stretch across the middle, from (100, 50) to (0, 60), still bows: it is not drawn straight
  const off = ([x, y]) => Math.abs(y - (50 + (100 - x) / 10));
  assert.ok(line.slice(2 * PER_EDGE + 1, 3 * PER_EDGE).some((p) => off(p) > 1), 'the middle stretch is round');
});

test('corners whose own lines cross: the smooth line crosses too, and the contour is refused', () => {
  const bow = [[0, 0], [100, 90], [100, 0], [0, 100]];
  const line = smoothPath(bow);
  assert.equal(crosses(line), true);
  assert.throws(() => new PolygonOutline(line), /crosses itself/);
});

test('firstCrossing names the first two sides that cross, closed or open', () => {
  assert.equal(firstCrossing(square), null);
  assert.deepEqual(firstCrossing([[0, 0], [100, 100], [100, 0], [0, 100]]), [0, 2]);
  assert.deepEqual(firstCrossing([[0, 0], [10, 0], [5, 5], [5, -5]], false), [0, 2]);
  assert.equal(firstCrossing([[0, 0], [10, 0], [5, 5], [5, -5]].slice(0, 3), false), null);
  // sides that only touch do not cross: a corner on another side
  assert.equal(firstCrossing([[0, 0], [10, 0], [10, 10], [5, 0], [0, 10]]), null);
});
