import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Box3, Vector3 } from '../../web/vendor/three/three.module.js';
import { VehicleShapes, placesOf } from '../../web/js/vehicle-shapes.js';
import { RU } from '../../web/js/i18n-ru.js';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const VEHICLES = read('../../web/data/vehicles.json');

test('every spacecraft of the list: its name and group in Russian, a model of NASA\'s or parts to draw', () => {
  assert.equal(new Set(VEHICLES.map((v) => v.id)).size, VEHICLES.length, 'ids are one each');
  for (const v of VEHICLES) {
    assert.ok(v.name in RU && v.group in RU, `${v.name} in Russian`);
    if (v.kind === 'glb') {
      assert.ok(v.url.startsWith('https://raw.githubusercontent.com/nasa/NASA-3D-Resources/'), v.id);
      assert.ok(v.fit === 'height' ? v.heightM > 0 : v.fit === 'longest' && v.lengthM > 0, `${v.id} has the size it is scaled to`);
    } else {
      assert.equal(v.kind, 'built');
      assert.ok(v.parts.length && v.heightM > 0 && v.widthM > 0, v.id);
    }
  }
});

// The widest a shape is, seen from any side: the published width of a rocket with boosters is across
// two of them, whichever way they stand.
function widest(group) {
  let most = 0;
  for (let a = 0; a < 180; a += 5) {
    group.rotation.y = a * Math.PI / 180;
    group.updateMatrixWorld(true);
    most = Math.max(most, new Box3().setFromObject(group, true).getSize(new Vector3()).x);
  }
  return most;
}

test('a rocket drawn from its dimensions is as tall and as wide as published', () => {
  const shapes = new VehicleShapes();
  for (const v of VEHICLES.filter((one) => one.kind === 'built')) {
    const group = shapes.build(v);
    const size = new Box3().setFromObject(group, true).getSize(new Vector3());
    assert.ok(Math.abs(size.y - v.heightM) / v.heightM < 0.005, `${v.id}: ${size.y.toFixed(1)} m tall, published ${v.heightM}`);
    const wide = widest(group);
    assert.ok(Math.abs(wide - v.widthM) / v.widthM < 0.03, `${v.id}: ${wide.toFixed(2)} m wide, published ${v.widthM}`);
  }
});

test('boosters stand round the core, evenly or at the angles given', () => {
  const even = placesOf({ around: { count: 4, radius: 2, turnDeg: 0 } });
  assert.equal(even.length, 4);
  assert.ok(Math.abs(even[1][0]) < 1e-12 && Math.abs(even[1][1] - 2) < 1e-12, 'the second a quarter round');
  const given = placesOf({ around: { radius: 1, anglesDeg: [90, 270] } });
  assert.deepEqual(given.map(([x, z]) => [Math.round(x) || 0, Math.round(z) || 0]), [[0, 1], [0, -1]]);
  assert.deepEqual(placesOf({ at: [7.6, 0] }), [[7.6, 0]]);
  assert.deepEqual(placesOf({}), [[0, 0]]);
});
