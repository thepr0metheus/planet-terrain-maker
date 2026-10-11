import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Box3, BoxGeometry, Group, Mesh, Vector3 } from '../../web/vendor/three/three.module.js';
import { TurnedShape } from '../../web/js/turned-shape.js';

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
  turned.turn(0, 90);
  near(turned.heightM, 2, 'lying');
  near(sizeOf(turned).low, 0, 'still on the ground');
  near(sizeOf(turned).size.z, 10, 'along the view\'s z');
  turned.turn(90, 90);
  near(sizeOf(turned).size.x, 10, 'the turn after the tilt: along x');
  near(sizeOf(turned).low, 0, 'and on the ground');
  turned.turn(45, 0);
  near(turned.heightM, 10, 'turned round the vertical, as tall');
});

test('a cube tilted half way stands on its edge: as high as its diagonal, its lowest point on the ground', () => {
  const turned = new TurnedShape(standing(2, 2, 2));
  turned.turn(0, 45);
  near(turned.heightM, 2 * Math.SQRT2, 'the diagonal');
  near(sizeOf(turned).low, 0, 'on its edge, not over it');
});
