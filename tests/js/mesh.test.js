import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from '../../web/vendor/three/addons/fflate.module.js';

import { HeightGrid } from '../../web/js/height-grid.js';
import { CircleOutline, PolygonOutline, outlineFromJSON } from '../../web/js/outline.js';
import { buildTerrainMesh, GROUP, OutlineTooSmall, topMm } from '../../web/js/terrain-mesh.js';
import { stlOf, threeMfOf, objZipOf, weld } from '../../web/js/exporters.js';

const flat = (h = 100, n = 40) => HeightGrid.fill(n, n, () => h);

// Every edge of a closed surface belongs to two triangles that run it in opposite directions.
function openEdges(solid) {
  const { vertices, faces } = weld([solid]);
  const count = new Map();
  for (let k = 0; k < faces.length; k += 3) {
    for (const [a, b] of [[faces[k], faces[k + 1]], [faces[k + 1], faces[k + 2]], [faces[k + 2], faces[k]]]) {
      const key = `${a}>${b}`;
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  }
  const bad = [];
  for (const [key, n] of count) {
    const [a, b] = key.split('>');
    if (n !== 1 || count.get(`${b}>${a}`) !== 1) bad.push(key);
  }
  return { bad, vertices };
}

// Volume by the divergence theorem: positive when the triangles face out.
function volume({ positions, indices }) {
  let v = 0;
  for (let k = 0; k < indices.length; k += 3) {
    const [a, b, c] = [indices[k], indices[k + 1], indices[k + 2]].map((i) => positions.subarray(i * 3, i * 3 + 3));
    v += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  return v;
}

test('a round model is closed, faces out, and holds a disc of the base', () => {
  const mesh = buildTerrainMesh({
    heights: flat(), frame: { widthM: 1100, heightM: 1100 }, outline: new CircleOutline(500),
    sizeMm: 100, baseMm: 2, nodes: 80,
  });
  assert.deepEqual(openEdges(mesh).bad, []);
  const disc = Math.PI * 50 * 50 * 2;
  assert.ok(Math.abs(volume(mesh) - disc) / disc < 0.01, `volume ${volume(mesh)} vs ${disc}`);
  assert.equal(mesh.mmPerM, 0.1);
  assert.deepEqual(mesh.groups.map((g) => g.materialIndex), [GROUP.top, GROUP.side, GROUP.bottom]);
  for (let k = 2; k < mesh.positions.length; k += 3) assert.ok(mesh.positions[k] === 0 || Math.abs(mesh.positions[k] - 2) < 1e-6);
});

test('a drawn contour, hollow on one side, is closed too and holds its own area', () => {
  // An L: 600 x 600 with a 300 x 300 corner cut out.
  const points = [[-300, -300], [300, -300], [300, 0], [0, 0], [0, 300], [-300, 300]];
  const outline = new PolygonOutline(points);
  const mesh = buildTerrainMesh({ heights: flat(0), frame: { widthM: 700, heightM: 700 }, outline, sizeMm: 60, baseMm: 3, nodes: 120 });
  assert.deepEqual(openEdges(mesh).bad, []);
  const expected = outline.area * mesh.mmPerM ** 2 * 3;
  assert.ok(Math.abs(volume(mesh) - expected) / expected < 0.02, `volume ${volume(mesh)} vs ${expected}`);
  assert.equal(outline.area, 270000);
});

test('heights stand on the base: the lowest point at baseMm, the rest by the scale', () => {
  const heights = HeightGrid.fill(51, 51, (u, v) => 1000 + 500 * Math.exp(-((u - 0.5) ** 2 + (v - 0.5) ** 2) * 40));
  const mesh = buildTerrainMesh({ heights, frame: { widthM: 2000, heightM: 2000 }, outline: new CircleOutline(900), sizeMm: 90, zScale: 2, baseMm: 1.5, nodes: 101 });
  assert.equal(mesh.zMmPerM, 0.05 * 2);
  assert.ok(Math.abs(mesh.highestM - 1500) < 1);
  assert.ok(Math.abs(mesh.size.z - (1.5 + (mesh.highestM - mesh.lowestM) * 0.1)) < 1e-6);
  assert.deepEqual(openEdges(mesh).bad, []);
});

test('calm water: heights under the floor are raised to it', () => {
  const heights = HeightGrid.fill(30, 30, (u) => (u < 0.5 ? -40 : 10));
  const mesh = buildTerrainMesh({ heights, frame: { widthM: 1000, heightM: 1000 }, outline: new CircleOutline(450), floorM: 0, nodes: 60 });
  assert.equal(mesh.lowestM, 0);
});

// The ruler of heights measures the solid's top by topMm: it must stand where the solid's own
// points and triangles are, not where the data's heights would be.
test('topMm: the top at the points of the solid, and between them as its triangles stand', () => {
  const W = 1200, H = 1000;
  const heights = HeightGrid.fill(60, 50, (u, v) => 300 * Math.sin(u * 7) + 200 * Math.cos(v * 5) + 50 * u * v);
  const mesh = buildTerrainMesh({ heights, frame: { widthM: W, heightM: H }, outline: new CircleOutline(450), sizeMm: 120, zScale: 2.5, baseMm: 3, nodes: 70 });
  const top = mesh.groups.find((g) => g.materialIndex === GROUP.top);
  const P = mesh.positions;
  for (let k = top.start; k < top.start + top.count; k++) {
    const p = mesh.indices[k];
    const z = topMm(mesh, mesh.uvs[p * 2], 1 - mesh.uvs[p * 2 + 1]);
    assert.ok(Math.abs(z - P[p * 3 + 2]) < 1e-3, `point ${p}: ${z} vs ${P[p * 3 + 2]}`);
  }
  // points between the solid's points, well inside the outline: the triangle under each, by its corners
  const triangles = [];
  for (let k = top.start; k < top.start + top.count; k += 3) triangles.push([0, 1, 2].map((c) => mesh.indices[k + c]));
  for (let n = 0; n < 150; n++) {
    const r = 380 * Math.sqrt((n + 0.5) / 150), a = n * 2.39996;
    const u = r * Math.cos(a) / W + 0.5, v = 0.5 - r * Math.sin(a) / H;
    const x = (u - 0.5) * W * mesh.mmPerM, y = (0.5 - v) * H * mesh.mmPerM;
    let found = null;
    for (const [a1, b1, c1] of triangles) {
      const [ax, ay, bx, by, cx, cy] = [P[a1 * 3], P[a1 * 3 + 1], P[b1 * 3], P[b1 * 3 + 1], P[c1 * 3], P[c1 * 3 + 1]];
      const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
      const wb = ((x - ax) * (cy - ay) - (cx - ax) * (y - ay)) / area, wc = ((bx - ax) * (y - ay) - (x - ax) * (by - ay)) / area;
      if (wb < -1e-9 || wc < -1e-9 || wb + wc > 1 + 1e-9) continue;
      found = (1 - wb - wc) * P[a1 * 3 + 2] + wb * P[b1 * 3 + 2] + wc * P[c1 * 3 + 2];
      break;
    }
    assert.notEqual(found, null, `no triangle under ${u}, ${v}`);
    assert.ok(Math.abs(topMm(mesh, u, v) - found) < 1e-3, `at ${u}, ${v}: ${topMm(mesh, u, v)} vs ${found}`);
  }
});

test('an outline smaller than a cell holds nothing, and says so', () => {
  assert.throws(() => buildTerrainMesh({ heights: flat(), frame: { widthM: 1000, heightM: 1000 }, outline: new CircleOutline(5), nodes: 20 }), OutlineTooSmall);
});

test('outlines: a contour that crosses itself is refused; JSON round trip', () => {
  assert.throws(() => new PolygonOutline([[0, 0], [10, 10], [10, 0], [0, 10]]), /crosses itself/);
  assert.throws(() => new PolygonOutline([[0, 0], [1, 1]]), /3 points/);
  const circle = outlineFromJSON(new CircleOutline(12.5).toJSON());
  assert.equal(circle.radiusM, 12.5);
  const polygon = outlineFromJSON(new PolygonOutline([[0, 0], [10.123, 0], [0, 10]]).toJSON());
  assert.deepEqual(polygon.points, [[0, 0], [10.12, 0], [0, 10]]);
  const row = new Uint8Array(5);
  new PolygonOutline([[-1, -1], [1, -1], [1, 1], [-1, 1]]).insideRow(0, [-2, -0.5, 0, 0.5, 2], row);
  assert.deepEqual([...row], [0, 1, 1, 1, 0]);
});

test('STL: header, count and 50 bytes a triangle, normals out', () => {
  const mesh = buildTerrainMesh({ heights: flat(), frame: { widthM: 1100, heightM: 1100 }, outline: new CircleOutline(500), nodes: 30 });
  const bytes = stlOf([mesh], 'Elbrus');
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(80, true), mesh.triangles);
  assert.equal(bytes.length, 84 + 50 * mesh.triangles);
  assert.match(new TextDecoder().decode(bytes.subarray(0, 80)), /Planet Terrain Maker: Elbrus/);
  // The first triangle is on top: its normal points up.
  assert.ok(view.getFloat32(84 + 8, true) > 0.99);
});

test('3MF: a package with one closed, welded mesh in millimetres', () => {
  const mesh = buildTerrainMesh({ heights: flat(), frame: { widthM: 1100, heightM: 1100 }, outline: new CircleOutline(500), nodes: 30 });
  const files = unzipSync(threeMfOf([mesh], 'Kazbek & <Elbrus>'));
  assert.deepEqual(Object.keys(files).sort(), ['3D/3dmodel.model', '[Content_Types].xml', '_rels/.rels']);
  const model = strFromU8(files['3D/3dmodel.model']);
  assert.match(model, /unit="millimeter"/);
  assert.match(model, /Kazbek &amp; &lt;Elbrus&gt;/);
  const { vertices, faces } = weld([mesh]);
  assert.equal((model.match(/<vertex /g) || []).length, vertices.length / 3);
  assert.equal((model.match(/<triangle /g) || []).length, faces.length / 3);
  assert.ok(vertices.length / 3 < mesh.positions.length / 3, 'shared corners are one vertex');
});

test('OBJ: a zip of the mesh, its materials and the picture, y up', () => {
  const mesh = buildTerrainMesh({ heights: flat(), frame: { widthM: 1100, heightM: 1100 }, outline: new CircleOutline(500), nodes: 20 });
  const files = unzipSync(objZipOf(mesh, new Uint8Array([0xff, 0xd8, 0xff]), [], 'test'));
  assert.deepEqual(Object.keys(files).sort(), ['model.mtl', 'model.obj', 'picture.jpg']);
  const obj = strFromU8(files['model.obj']);
  assert.match(obj, /usemtl top/);
  assert.match(strFromU8(files['model.mtl']), /map_Kd picture.jpg/);
  const firstTop = obj.split('\n').find((l) => l.startsWith('v '));
  assert.equal(Number(firstTop.split(' ')[2]), 2, 'height goes to y');
});
