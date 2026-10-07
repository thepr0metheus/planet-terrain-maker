import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Divider } from '../../web/js/divider.js';

const R = 1000;

test('the line through the centre: the first place west at 0, north at 90; 180 swaps', () => {
  const at = (deg) => new Divider({ angleDeg: deg }).sides(R);
  assert.equal(at(0).sideOf(-300, 0), 0);
  assert.equal(at(0).sideOf(300, 0), 1);
  assert.equal(at(90).sideOf(0, 300), 0);
  assert.equal(at(90).sideOf(0, -300), 1);
  assert.equal(at(180).sideOf(300, 0), 0);
  assert.equal(new Divider({ angleDeg: -90 }).angleDeg, 270);
  assert.throws(() => new Divider({ angleDeg: NaN }), RangeError);
});

test('a drawn line need not pass the centre, and may bend', () => {
  // west to east, 300 m north of the centre: the second place is south of it, the centre too
  const off = new Divider({ points: [[-500, 300], [500, 300]] }).sides(R);
  assert.equal(off.sideOf(0, 0), 1);
  assert.equal(off.sideOf(0, 400), 0);
  assert.equal(off.sideOf(-900, 350), 0, 'past the drawn end the line runs on straight');
  // an arch over the centre: under it is the second place's, above it the first's
  const arch = new Divider({ points: [[-600, -200], [0, 500], [600, -200]] }).sides(R);
  assert.equal(arch.sideOf(0, 0), 1);
  assert.equal(arch.sideOf(0, 700), 0);
  assert.equal(arch.sideOf(-900, 0), 0);
});

test('swapping gives each place the other side; a turn turns the drawn line about the centre', () => {
  const line = new Divider({ points: [[-500, 300], [500, 300]] });
  assert.equal(line.swapped().sides(R).sideOf(0, 0), 0);
  assert.equal(new Divider({ angleDeg: 30 }).swapped().angleDeg, 210);
  // turned a quarter clockwise, the line runs south 300 m east of the centre
  const turned = line.turnedTo(90).sides(R);
  assert.equal(turned.sideOf(0, 0), 1);
  assert.equal(turned.sideOf(400, 0), 0);
});

test('a row of points gets the sides one by one would', () => {
  const sides = new Divider({ points: [[-700, -100], [-100, 200], [300, -300], [700, 100]] }).sides(R);
  const xs = Array.from({ length: 41 }, (_, i) => -1000 + 50 * i);
  for (const y of [-600, -150, 0, 120, 450]) {
    const row = new Uint8Array(xs.length);
    sides.sideRow(y, xs, row);
    assert.deepEqual([...row], xs.map((x) => sides.sideOf(x, y)), `row ${y}`);
  }
});

test('a line needs two points apart; it keeps to JSON', () => {
  assert.throws(() => new Divider({ points: [[0, 0]] }), RangeError);
  assert.throws(() => new Divider({ points: [[5, 5], [5, 5]] }).sides(R), RangeError);
  const line = new Divider({ points: [[-500.123, 1], [500, 2]], angleDeg: 45 });
  const back = new Divider(line.toJSON());
  assert.deepEqual(back.points, [[-500.12, 1], [500, 2]]);
  assert.equal(back.angleDeg, 45);
});
