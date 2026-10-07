import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PER_EDGE, smoothPath } from '../../web/js/smooth.js';
import { PolygonOutline } from '../../web/js/outline.js';

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
