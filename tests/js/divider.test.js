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

// A line drawn by points runs on straight past its ends. Where that runs into the line itself, the
// line has no two sides: the test of a side hands pieces of one place to the other. Such a line is
// refused, and the page says where it crosses.
test('a line that runs into itself, between its points or past an end, says where', () => {
  // across, then a hook back: past the last point the line runs on into its own first stretch
  const hook = [[-800, 0], [400, 0], [450, 300], [300, 150]];
  assert.equal(new Divider({ points: hook, smooth: false }).crossing(R), 'last');
  assert.equal(new Divider({ points: hook }).crossing(R), 'last', 'smooth too');
  assert.equal(new Divider({ points: [...hook].reverse(), smooth: false }).crossing(R), 'first');
  // its own stretches cross between its points
  assert.equal(new Divider({ points: [[-500, 0], [500, 0], [0, 300], [0, -300]], smooth: false }).crossing(R), 'drawn');
  // turned, the same
  assert.equal(new Divider({ points: hook, angleDeg: 130, smooth: false }).crossing(R), 'last');
  // a line that does not cross itself even carried on, but what runs on past its first point crosses
  // the far side that closes the second place's half from its last end: refused too, both ends told
  const round = new Divider({ points: [[-632, 698], [348, 126], [624, -552], [-188, 86]], smooth: false });
  assert.equal(round.crossing(R), 'ends');
  // a hook whose run-on meets what runs on past the first point: both ends are told
  assert.equal(new Divider({ points: [[-500, 0], [400, 0], [480, 120], [250, 100]], smooth: false }).crossing(R), 'ends');
});

test('lines that divide cleanly have no crossing: the centre line, a bend, an arch, an S', () => {
  for (const divider of [
    new Divider({ angleDeg: 0 }), new Divider({ angleDeg: 77 }),
    new Divider({ points: [[-500, 300], [500, 300]] }),
    new Divider({ points: [[-600, -200], [0, 500], [600, -200]] }),
    new Divider({ points: [[-700, -100], [-200, 300], [200, -300], [700, 100]] }),
  ]) {
    assert.equal(divider.crossing(R), null, JSON.stringify(divider.toJSON()));
  }
});
