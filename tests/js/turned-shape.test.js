import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Box3, BoxGeometry, Group, Mesh, Vector3 } from '../../web/vendor/three/three.module.js';
import { ANGLES, TurnedShape } from '../../web/js/turned-shape.js';

// A shape as fetchShape gives it: metres, y up, its lowest point at 0, its middle over the origin.
function standing(x, y, z) {
  const shape = new Group();
  const box = new Mesh(new BoxGeometry(x, y, z));
  box.position.y = y / 2;
  shape.add(box);
  return shape;
}
const sizeOf = (turned) => {
  turned.object.updateMatrixWorld(true);
  const box = new Box3().setFromObject(turned.object, true);
  return { size: box.getSize(new Vector3()), low: box.min.y };
};
const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-6, `${what}: ${a} is not ${b}`);

test('a rocket tilted lies on its side, and turned it lies the other way, resting on the ground', () => {
  const turned = new TurnedShape(standing(2, 10, 2));
  near(turned.heightM, 10, 'as it came');
  near(sizeOf(turned).low, 0, 'on the ground');
  turned.turn({ tiltDeg: 90 });
  near(turned.heightM, 2, 'lying');
  near(sizeOf(turned).low, 0, 'still on the ground');
  near(sizeOf(turned).size.z, 10, 'along the view\'s z');
  turned.turn({ turnDeg: 90, tiltDeg: 90 });
  near(sizeOf(turned).size.x, 10, 'the turn after the tilt: along x');
  near(sizeOf(turned).low, 0, 'and on the ground');
  turned.turn({ turnDeg: 45 });
  near(turned.heightM, 10, 'turned round the vertical, as tall');
});

test('a cube tilted half way stands on its edge: as high as its diagonal, its lowest point on the ground', () => {
  const turned = new TurnedShape(standing(2, 2, 2));
  turned.turn({ tiltDeg: 45 });
  near(turned.heightM, 2 * Math.SQRT2, 'the diagonal');
  near(sizeOf(turned).low, 0, 'on its edge, not over it');
});

test('the lean tips a standing rocket round the other horizontal axis, and rolls a lying one round its length', () => {
  const rocket = new TurnedShape(standing(2, 10, 2));
  rocket.turn({ leanDeg: 90 });
  near(rocket.heightM, 2, 'leaned over: lying');
  near(sizeOf(rocket).size.x, 10, 'along x, where the tilt laid it along z');
  near(sizeOf(rocket).low, 0, 'on the ground');
  // flat on one side: 4 wide one way, 2 the other
  const flat = new TurnedShape(standing(2, 10, 4));
  flat.turn({ tiltDeg: 90 });
  near(flat.heightM, 4, 'laid along z by the tilt, on its narrow side');
  flat.turn({ tiltDeg: 90, leanDeg: 90 });
  near(flat.heightM, 2, 'rolled round its length onto its wide side');
  near(sizeOf(flat).size.z, 10, 'still along z');
  near(sizeOf(flat).size.x, 4, 'its width across');
  near(sizeOf(flat).low, 0, 'on the ground');
  assert.deepEqual(flat.angles, { turnDeg: 0, tiltDeg: 90, leanDeg: 90 });
});

test('the angles of a record: those it has, 0 for those it was saved without', () => {
  assert.deepEqual(TurnedShape.anglesOf(), { turnDeg: 0, tiltDeg: 0, leanDeg: 0 });
  const before = { asteroid: { id: 'sls', source: 'vehicle' }, at: { u: 0.5, v: 0.5 }, altitudeM: 0, turnDeg: 30, tiltDeg: -45 };
  assert.deepEqual(TurnedShape.anglesOf(before), { turnDeg: 30, tiltDeg: -45, leanDeg: 0 });
  assert.deepEqual(TurnedShape.anglesOf({ turnDeg: '30', leanDeg: NaN }), { turnDeg: 0, tiltDeg: 0, leanDeg: 0 });
});

test('the page has a slider, its row and its words for each angle', () => {
  const page = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
  for (const name of ANGLES) {
    const id = `asteroid-${name.replace(/Deg$/, '')}`;
    for (const one of [id, `${id}-row`, `${id}-val`]) assert.ok(page.includes(`id="${one}"`), `${one} for ${name}`);
  }
});
