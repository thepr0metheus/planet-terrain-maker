import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CircleOutline } from '../../web/js/outline.js';
import { buildingsSolid } from '../../web/js/buildings.js';
import { openEdges, volume } from './solid-checks.js';

const SCALE = { mmPerM: 0.1, zMmPerM: 0.1 };
const GROUND_MM = 2;
const HEIGHT_M = 10;
const SINK_MM = 0.2;       // buildings.js: into the ground

const area = (ring) => ring.reduce((sum, [x, y], i) => sum + (x * ring[(i + 1) % ring.length][1] - ring[(i + 1) % ring.length][0] * y), 0) / 2;

// Corners spread along every side of a ring, evenly.
const withStops = (ring, stops) => ring.flatMap((a, i) => {
  const b = ring[(i + 1) % ring.length];
  return [a, ...Array.from({ length: stops }, (_, s) => [a[0] + ((s + 1) / (stops + 1)) * (b[0] - a[0]), a[1] + ((s + 1) / (stops + 1)) * (b[1] - a[1])])];
});

const turned = (ring, angle, [dx, dy]) => ring.map(([x, y]) => [dx + x * Math.cos(angle) - y * Math.sin(angle), dy + x * Math.sin(angle) + y * Math.cos(angle)]);

// A building that steps up a slope, as the plans of such blocks are drawn: its corners sit on two
// parallel slanted lines.
const stairs = (steps, across, up) => {
  const ring = [[0, 0]];
  for (let i = 0; i < steps; i++) ring.push([(i + 1) * across, i * up], [(i + 1) * across, (i + 1) * up]);
  ring.push([0, steps * up]);
  return ring;
};

const FOOTPRINTS = {
  'a box': [[0, 0], [20, 0], [20, 10], [0, 10]],
  'a box with a corner in the middle of each side': withStops([[0, 0], [20, 0], [20, 10], [0, 10]], 1),
  'a box turned a little, corners along its sides': turned(withStops([[0, 0], [30, 0], [30, 12], [0, 12]], 3), 0.35, [-60, -30]),
  'a box turned by half a radian, corners along its sides': turned(withStops([[0, 0], [30, 0], [30, 12], [0, 12]], 3), 0.5, [40, 40]),
  'a box turned by a radian, corners along its sides': turned(withStops([[0, 0], [30, 0], [30, 12], [0, 12]], 3), 1, [-60, -30]),
  'a block that steps up': stairs(5, 5, 4),
  'a block that steps up, far from the middle': stairs(5, 5, 4).map(([x, y]) => [x - 70.219, y - 35.185]),
  'a block that steps up, turned': turned(stairs(4, 6, 3), 1.1, [-200, 150]),
  'a star with corners along its sides': withStops(Array.from({ length: 10 }, (_, i) => [(i % 2 ? 6 : 16) * Math.cos((Math.PI * i) / 5), (i % 2 ? 6 : 16) * Math.sin((Math.PI * i) / 5)]), 2),
  'an L': [[0, 0], [20, 0], [20, 10], [10, 10], [10, 20], [0, 20]],
  'a ring that comes round clockwise': [[0, 0], [0, 10], [20, 10], [20, 0]],
};

for (const [name, ring] of Object.entries(FOOTPRINTS)) {
  test(`buildings: ${name} stands as one closed solid that holds its footprint`, () => {
    const solid = buildingsSolid([{ ring, height: HEIGHT_M }], new CircleOutline(1000), SCALE, () => GROUND_MM);
    assert.deepEqual(openEdges(solid).bad, []);
    const thickness = (GROUND_MM + HEIGHT_M * SCALE.zMmPerM) - (GROUND_MM - SINK_MM);
    const expected = Math.abs(area(ring)) * SCALE.mmPerM ** 2 * thickness;
    assert.ok(Math.abs(volume(solid) - expected) <= 1e-4 * expected, `volume ${volume(solid)} vs ${expected}`);
    // The volume does not tell a roof cut into triangles that fold over each other from one that
    // does not (the folds cancel), so every triangle of the roof and the floor is looked at: up for
    // the roof, down for the floor. The positions are float32, hence the little room.
    const P = solid.positions, middle = GROUND_MM + (HEIGHT_M * SCALE.zMmPerM - SINK_MM) / 2;
    let flat = 0;
    for (let k = 0; k < solid.indices.length; k += 3) {
      const [a, b, c] = [0, 1, 2].map((s) => solid.indices[k + s] * 3);
      if (Math.abs(P[a + 2] - P[b + 2]) > 1e-6 || Math.abs(P[a + 2] - P[c + 2]) > 1e-6) continue;
      flat++;
      const twice = (P[b] - P[a]) * (P[c + 1] - P[a + 1]) - (P[b + 1] - P[a + 1]) * (P[c] - P[a]);
      if (P[a + 2] > middle) assert.ok(twice > -1e-4, `a roof triangle faces down (${twice})`);
      else assert.ok(twice < 1e-4, `a floor triangle faces up (${twice})`);
    }
    assert.equal(flat, 2 * (ring.length - 2), 'a roof and a floor, a triangle less than the corners, each');
  });
}

test('buildings: several in one solid, each closed', () => {
  const buildings = [
    { ring: stairs(5, 5, 4), height: 12 },
    { ring: turned(withStops([[0, 0], [30, 0], [30, 12], [0, 12]], 3), 0.6, [120, -80]), height: 7 },
    { ring: [[-300, -300], [-280, -300], [-280, -290], [-300, -290]], height: 9 },
  ];
  const solid = buildingsSolid(buildings, new CircleOutline(1000), SCALE, () => GROUND_MM);
  assert.deepEqual(openEdges(solid).bad, []);
  assert.ok(volume(solid) > 0);
});
