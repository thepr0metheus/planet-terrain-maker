import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from '../../web/vendor/three/addons/fflate.module.js';

import { HeightGrid } from '../../web/js/height-grid.js';
import { CircleOutline, PolygonOutline, outlineFromJSON } from '../../web/js/outline.js';
import { buildTerrainMesh, GROUP, OutlineTooSmall, topMm } from '../../web/js/terrain-mesh.js';
import { stlOf, threeMfOf, objZipOf, weld } from '../../web/js/exporters.js';
import { openEdges, volume } from './solid-checks.js';

const flat = (h = 100, n = 40) => HeightGrid.fill(n, n, () => h);

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

// A side that runs slantwise across the grid is cut by it at points that lie on one straight line,
// dozens of them in a row. The bottom has to take every one of those points, and turn every
// triangle the way its neighbours turn, or the walls and the bottom part along that side.
const regular = (sides, radius, turn = 0) => Array.from({ length: sides }, (_, i) => {
  const a = turn + (2 * Math.PI * i) / sides;
  return [radius * Math.cos(a), radius * Math.sin(a)];
});

const SLANTED = {
  triangle: [[-300, -300], [300, -300], [0, 300]],
  'square on its corner': regular(4, 300, Math.PI / 4),
  'square turned a little': regular(4, 300, 0.3),
  pentagon: regular(5, 300, 0.1),
  hexagon: regular(6, 300),
  'long thin bar, turned': [[-300, -20], [300, -20], [300, 20], [-300, 20]].map(([x, y]) => [x * Math.cos(0.5) - y * Math.sin(0.5), x * Math.sin(0.5) + y * Math.cos(0.5)]),
  star: Array.from({ length: 10 }, (_, i) => [(i % 2 ? 130 : 320) * Math.cos((Math.PI * i) / 5 + 0.2), (i % 2 ? 130 : 320) * Math.sin((Math.PI * i) / 5 + 0.2)]),
};

// The footprint, seen from above, of the triangles of one group: [positive, negative] areas.
function areasOf(mesh, materialIndex) {
  const { start, count } = mesh.groups.find((g) => g.materialIndex === materialIndex);
  const P = mesh.positions;
  let up = 0, down = 0;
  for (let k = start; k < start + count; k += 3) {
    const [a, b, c] = [0, 1, 2].map((s) => mesh.indices[k + s] * 3);
    const twice = (P[b] - P[a]) * (P[c + 1] - P[a + 1]) - (P[b + 1] - P[a + 1]) * (P[c] - P[a]);
    if (twice > 0) up += twice / 2; else down -= twice / 2;
  }
  return [up, down];
}

for (const [name, points] of Object.entries(SLANTED)) {
  test(`a contour with slanted sides, ${name}: one closed solid that holds its own area`, () => {
    const outline = new PolygonOutline(points);
    for (const nodes of [60, 97, 150]) {
      const mesh = buildTerrainMesh({ heights: flat(0), frame: { widthM: 800, heightM: 800 }, outline, sizeMm: 80, baseMm: 3, nodes });
      assert.deepEqual(openEdges(mesh).bad, [], `${nodes} nodes`);
      const expected = outline.area * mesh.mmPerM ** 2 * 3;
      assert.ok(Math.abs(volume(mesh) - expected) / expected < 0.03, `${nodes} nodes: volume ${volume(mesh)} vs ${expected}`);
      // the bottom faces down, all of it, and covers what the top covers. The positions are
      // float32: a sliver along a straight side is a triangle of rounding, up or down at random,
      // a millionth of the whole at the most.
      const [bottomUp, bottomDown] = areasOf(mesh, GROUP.bottom);
      const [topUp, topDown] = areasOf(mesh, GROUP.top);
      assert.ok(bottomUp < 1e-6 * bottomDown, `${nodes} nodes: ${bottomUp} mm2 of the bottom faces up`);
      assert.ok(topDown < 1e-6 * topUp, `${nodes} nodes: ${topDown} mm2 of the top faces down`);
      assert.ok(Math.abs((bottomDown - bottomUp) - (topUp - topDown)) < 1e-9 * topUp, `${nodes} nodes: bottom ${bottomDown - bottomUp} mm2, top ${topUp - topDown} mm2`);
    }
  });
}

// A notch of the outline that is narrower than a cell, and ends in a widening round a node of the
// grid, leaves that node outside with the ground all round it: a pit with no way out in the grid's
// own terms, though the outline's notch leads out. The pit is filled, as the notch is: a detail
// smaller than a cell is not kept, and a hole through the middle of a model is not a detail.
test('a notch narrower than a cell does not leave a hole through the model', () => {
  const outline = new PolygonOutline([[-300, -300], [300, -300], [300, 300], [15.5, 300], [15.5, 104.5], [20, 100], [0, 80], [-20, 100], [0, 120], [9.5, 110.5], [9.5, 300], [-300, 300]]);
  const mesh = buildTerrainMesh({ heights: flat(0), frame: { widthM: 1000, heightM: 1000 }, outline, sizeMm: 100, baseMm: 3, nodes: 41 });
  assert.deepEqual(openEdges(mesh).bad, []);
  const [bottomUp, bottomDown] = areasOf(mesh, GROUP.bottom);
  const [topUp, topDown] = areasOf(mesh, GROUP.top);
  assert.equal(bottomUp, 0, 'no part of the bottom faces up');
  assert.equal(topDown, 0);
  assert.ok(Math.abs(topUp - bottomDown) < 1e-6 * topUp, `the top covers ${topUp} mm2, the bottom ${bottomDown} mm2`);
});

// What is filled is a pit with no way out, and nothing else: an outside node that the outside
// reaches from the corner of a cell is not a pit. A channel narrower than a cell that runs slantwise
// across the grid has outside nodes in a row, each one a corner away from the next.
test('a channel narrower than a cell, slantwise across the grid, is kept open', () => {
  const grain = 10.6;                                  // the channel is 7.5 m either side of y = x + 50
  const outline = new PolygonOutline([[-290, -290], [290, -290], [290, 290], [-290, 290], [-290, -240 + grain], [-10, 40 + grain], [-10, 40 - grain], [-290, -240 - grain]]);
  const mesh = buildTerrainMesh({ heights: flat(0), frame: { widthM: 1000, heightM: 1000 }, outline, sizeMm: 100, baseMm: 3, nodes: 41 });
  assert.deepEqual(openEdges(mesh).bad, []);
  const footprint = areasOf(mesh, GROUP.top)[0] / mesh.mmPerM ** 2;
  assert.ok(Math.abs(footprint - outline.area) < 0.005 * outline.area, `${footprint} m2 of ground, the outline holds ${outline.area} m2`);
});

// Contours with inlets narrower than a cell, as drawn by hand: the pits at their ends are filled
// (nothing of the bottom faces up), and a contour whose inlets lead out keeps them.
const WITH_INLETS = {
  'ten corners': [1498, 91, [[-68.1, 404.7], [389.7, 19.2], [588.4, -594.2], [-57.1, -549.0], [-21.5, -470.3], [-605.7, -181.3], [-444.2, 558.8], [-57.7, 378.8], [57.7, -363.2], [245.2, -228.1]]],
  'eight corners, a frame wider than tall': [3775, 58, [[599.9, 566.3], [760.4, 1072.5], [-427.8, 963.9], [-1008.0, 1099.3], [-1052.4, -121.6], [-44.4, 690.0], [-1062.2, -216.9], [510.0, 980.7]], 2759],
};

for (const [name, [width, nodes, points, height = width]] of Object.entries(WITH_INLETS)) {
  test(`a contour with inlets, ${name}: no pit is left as a hole`, () => {
    const mesh = buildTerrainMesh({ heights: flat(0), frame: { widthM: width, heightM: height }, outline: new PolygonOutline(points), sizeMm: 100, baseMm: 3, nodes });
    assert.deepEqual(openEdges(mesh).bad, []);
    assert.equal(areasOf(mesh, GROUP.bottom)[0], 0, 'no part of the bottom faces up');
  });
}

test('a contour with inlets keeps those that lead out', () => {
  const outline = new PolygonOutline([[-48.7, 163.7], [-111.8, 15.3], [243.5, -77.2], [87.7, 0.8], [59.5, 40.5], [-168.1, 380.9], [358.1, -155.0], [343.4, -221.8], [-89.4, -338.2], [-403.3, -178.5], [-218.4, 310.9], [-77.7, 230.7]]);
  const mesh = buildTerrainMesh({ heights: flat(0), frame: { widthM: 971, heightM: 3659 }, outline, sizeMm: 100, baseMm: 3, nodes: 86 });
  assert.deepEqual(openEdges(mesh).bad, []);
  const footprint = areasOf(mesh, GROUP.top)[0] / mesh.mmPerM ** 2;
  assert.ok(Math.abs(footprint - outline.area) < 0.01 * outline.area, `${footprint} m2 of ground, the outline holds ${outline.area} m2`);
});

// A contour whose corners and sides run through the grid's nodes (corners typed in, or snapped to
// a grid) cuts the grid's edges at the nodes themselves. The points it makes there must stay
// apart, or a file takes them for one and the wall touches itself along a line. Corners are
// given as the grid's own numbers, column and row.
const onNodes = (nodes, corners) => corners.map(([i, j]) => [(i / (nodes - 1) - 0.5) * 1000, (0.5 - j / (nodes - 1)) * 1000]);

const THROUGH_NODES = {
  'a rectangle along the grid lines': [41, [[10, 10], [30, 10], [30, 25], [10, 25]]],
  'a diamond, its sides on the nodes of the diagonals': [41, [[20, 8], [32, 20], [20, 32], [8, 20]]],
  'a right triangle, its slanted side on nodes': [41, [[8, 8], [32, 8], [8, 32]]],
  'a pentagon with a dent': [35, [[19, 25], [14, 12], [20, 19], [25, 7], [22, 16]]],
  'a hexagon with sides on a column and a row': [50, [[16, 38], [8, 38], [8, 23], [17, 38], [26, 32], [24, 40]]],
  'a kite whose long side runs along a row': [41, [[34, 30], [7, 30], [12, 23], [10, 8]]],
  'a trapezoid with sides on a row, a column and a row': [41, [[8, 26], [34, 26], [34, 16], [19, 16]]],
  'a quadrilateral with a short side on a row': [41, [[5, 23], [12, 23], [33, 30], [30, 11]]],
  'a quadrilateral with a long point': [41, [[34, 5], [8, 26], [24, 26], [33, 27]]],
  'a hexagon whose corners touch the nodes of others': [43, [[7, 11], [15, 22], [19, 17], [18, 20], [16, 22], [22, 35]]],
  'a hexagon on a finer grid': [122, [[53, 82], [19, 86], [23, 26], [63, 56], [25, 65], [20, 81]]],
};

for (const [name, [nodes, corners]] of Object.entries(THROUGH_NODES)) {
  test(`a contour through the nodes of the grid, ${name}: one closed solid`, () => {
    const outline = new PolygonOutline(onNodes(nodes, corners));
    for (const sizeMm of [40, 100, 300]) {
      const mesh = buildTerrainMesh({ heights: flat(0), frame: { widthM: 1000, heightM: 1000 }, outline, sizeMm, baseMm: 3, nodes });
      assert.deepEqual(openEdges(mesh).bad, [], `${sizeMm} mm`);
      assert.ok(volume(mesh) > 0, `${sizeMm} mm: volume ${volume(mesh)}`);
    }
  });
}

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
