import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LineTool } from '../../web/js/line-tool.js';
import { Divider } from '../../web/js/divider.js';

const near = (a, b) => a.every((p, i) => Math.abs(p[0] - b[i][0]) < 1e-9 && Math.abs(p[1] - b[i][1]) < 1e-9);

test('through the centre: turned 5° a step, set to an angle, the parts swapped', () => {
  let told = 0;
  const tool = new LineTool(() => { told += 1; });
  tool.start();
  assert.equal(tool.active, true);
  assert.equal(tool.divider().angleDeg, 0);
  tool.turn(-5);
  assert.equal(tool.angleDeg, 355);
  tool.setAngle(372);
  assert.equal(tool.angleDeg, 12);
  tool.swap();
  assert.equal(tool.divider().angleDeg, 192, 'the other part: the line turned half round');
  assert.equal(told, 4);
});

test('an own line: points clicked one by one, taken back and given back, a smooth curve through them', () => {
  const tool = new LineTool();
  tool.start();
  tool.setKind('drawn');
  assert.equal(tool.divider(), null, 'no line before two points');
  tool.add([-800, 0]);
  assert.equal(tool.divider(), null);
  tool.add([0, 300]);
  tool.add([800, 0]);
  const line = tool.divider();
  assert.ok(line instanceof Divider && line.drawn && line.smooth);
  assert.deepEqual(line.points, [[-800, 0], [0, 300], [800, 0]]);
  tool.undo();
  tool.undo();
  assert.deepEqual(tool.points, [[-800, 0]]);
  tool.redo();
  assert.deepEqual(tool.points, [[-800, 0], [0, 300]]);
  tool.add([500, -500]);
  tool.redo();
  assert.deepEqual(tool.points, [[-800, 0], [0, 300], [500, -500]], 'a new point forgets what was taken back');
  tool.swap();
  assert.deepEqual(tool.points, [[500, -500], [0, 300], [-800, 0]], 'swapped: the same points the other way');
  tool.turn(90);
  assert.ok(near(tool.points, [[-500, -500], [300, 0], [0, 800]]), 'turned 90° clockwise about the centre');
  tool.clear();
  assert.deepEqual(tool.points, []);
  assert.throws(() => tool.setKind('wavy'), RangeError);
});

test('drawn anew from a model\'s line: an own line comes back with its turn in its points', () => {
  const tool = new LineTool();
  tool.start(new Divider({ points: [[0, -500], [0, 500]], angleDeg: 90 }));
  assert.equal(tool.kind, 'drawn');
  assert.equal(tool.angleDeg, 0);
  assert.ok(near(tool.points, [[-500, 0], [500, 0]]), 'the line runs west to east, as the model shows it');
  tool.start(new Divider({ angleDeg: 30 }));
  assert.equal(tool.kind, 'centre');
  assert.equal(tool.angleDeg, 30);
  assert.deepEqual(tool.points, []);
  tool.stop();
  assert.equal(tool.active, false);
});

test('by points: any point, the middle ones too, is taken away; undo puts it back where it was', () => {
  const tool = new LineTool();
  tool.start();
  tool.setKind('drawn');
  for (const p of [[-900, 0], [-300, 200], [300, -200], [900, 0]]) tool.add(p);
  tool.removeAt(1);
  assert.deepEqual(tool.points, [[-900, 0], [300, -200], [900, 0]], 'point 2 taken away from the middle');
  tool.removeAt(7);
  assert.equal(tool.points.length, 3, 'no such point: nothing happens');
  tool.clear();
  assert.deepEqual(tool.points, []);
  tool.undo();
  assert.deepEqual(tool.points, [[-900, 0], [300, -200], [900, 0]], 'the clearing undone: all of them back');
  tool.undo();
  assert.deepEqual(tool.points, [[-900, 0], [-300, 200], [300, -200], [900, 0]], 'point 2 back in its place');
  tool.redo();
  tool.redo();
  assert.deepEqual(tool.points, [], 'and done again');
  tool.undo();
  tool.turn(90);
  tool.undo();
  assert.equal(tool.points.length, 3, 'a turn starts the undoing anew');
});

