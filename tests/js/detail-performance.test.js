import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../../web/vendor/three/three.module.js';
import { TopSurfacePicker } from '../../web/js/top-surface-picker.js';
import { DetailPatchCache } from '../../web/js/detail-patch-cache.js';
import { geometryOf } from '../../web/js/model-view.js';
import { buildTerrainMesh, GROUP } from '../../web/js/terrain-mesh.js';
import { HeightGrid } from '../../web/js/height-grid.js';
import { CircleOutline } from '../../web/js/outline.js';

test('visibility probes match actual top triangles for steep relief, edges, misses and rays from below', () => {
  const solid = buildTerrainMesh({ heights: HeightGrid.fill(32, 32, (u, v) => 800 * Math.sin(u * 9) * Math.cos(v * 7)),
    frame: { widthM: 10000, heightM: 10000 }, outline: new CircleOutline(4000), sizeMm: 100, zScale: 2, baseMm: 2, nodes: 40 });
  const geometry = geometryOf(solid), picker = new TopSurfacePicker(geometry, solid.groups.find((g) => g.materialIndex === GROUP.top));
  const mesh = new THREE.Mesh(geometry, [new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial()]);
  mesh.updateMatrixWorld(true);
  let found = 0, missed = 0;
  const origins = [new THREE.Vector3(0, 90, 0), new THREE.Vector3(120, 10, 60), new THREE.Vector3(0, -90, 0)];
  for (const origin of origins) for (let x = -60; x <= 60; x += 15) for (let z = -60; z <= 60; z += 15) {
    const ray = new THREE.Ray(origin, new THREE.Vector3(x, 5, z).sub(origin).normalize());
    const reference = new THREE.Raycaster(origin, ray.direction).intersectObject(mesh).find((hit) => hit.face.materialIndex === GROUP.top) ?? null;
    const hit = picker.hit(ray);
    assert.equal(Boolean(hit), Boolean(reference));
    if (hit) {
      found++;
      assert.ok(hit.point.distanceTo(reference.point) < 1e-8);
      assert.ok(Math.abs(hit.u - reference.uv.x) < 1e-8);
      assert.ok(Math.abs(hit.v - (1 - reference.uv.y)) < 1e-8);
    } else missed++;
  }
  assert.ok(found > 20 && missed > 20);
});

test('ready detail is reused with the same geometry and texture, while memory eviction releases oldest resources', () => {
  const released = [], patch = () => ({ material: { map: { image: { width: 256, height: 256 } } },
    geometry: { attributes: { position: { array: new Float32Array(9) } } } });
  const a = patch(), b = patch(), c = patch(), size = DetailPatchCache.bytesOf(a);
  const cache = new DetailPatchCache({ mostBytes: size * 2, dispose: (p) => released.push(p) });
  cache.keep('a', a); cache.keep('b', b);
  assert.equal(cache.take('a'), a, 'same ready mesh, no decode, reconstruction or GPU upload');
  cache.keep('a', a); cache.keep('c', c);
  assert.deepEqual(released, [b], 'least recently used mesh is freed');
  assert.equal(cache.take('b'), null);
  assert.ok(cache.bytes <= cache.mostBytes);
  cache.clear();
  assert.equal(cache.bytes, 0);
  assert.equal(cache.take('a'), null, 'another model cannot reuse old geometry or picture options');
  assert.deepEqual(released, [b, a, c]);
});
