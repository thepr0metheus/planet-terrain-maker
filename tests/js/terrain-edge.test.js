import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HeightGrid } from '../../web/js/height-grid.js';
import { TerrainEdge } from '../../web/js/terrain-edge.js';
import { PolygonOutline } from '../../web/js/outline.js';
import { toMetres } from '../../web/js/split.js';

const frame = { widthM: 2700, heightM: 2700 };
const ground = (f, n = 181) => HeightGrid.fill(n, n, (u, v) => f(...toMetres(u, v, frame)));
const ring = (radiusAt, height = 300, widthM = 60) => ground((x, y) => {
  const r = Math.hypot(x, y), a = Math.atan2(y, x);
  return height * Math.exp(-(((r - radiusAt(a)) / widthM) ** 2));
});
const radii = (points) => points.map(([x, y]) => Math.hypot(x, y));

test('round a ring of hills the edge keeps to their crest, closed and smooth', () => {
  const edge = new TerrainEdge({ heights: ring(() => 1100), frame, radiusM: 1000 }).trace();
  assert.equal(edge.reason, null);
  assert.ok(edge.strength > 0.9, `strength ${edge.strength}`);
  const r = radii(edge.points);
  assert.ok(r.every((x) => x > 1060 && x < 1140), `radii from ${Math.min(...r)} to ${Math.max(...r)}`);
  assert.doesNotThrow(() => new PolygonOutline(edge.points), 'an outline the mesh can take');
});

test('a valley is followed the same way, the ground turned over', () => {
  const trench = ring(() => 880, -200);
  const edge = new TerrainEdge({ heights: trench, frame, radiusM: 1000, follow: 'valley' }).trace();
  assert.equal(edge.reason, null);
  const r = radii(edge.points);
  assert.ok(r.every((x) => x > 840 && x < 920), `radii from ${Math.min(...r)} to ${Math.max(...r)}`);
  assert.equal(new TerrainEdge({ heights: trench, frame, radiusM: 1000, follow: 'ridge' }).trace().reason, 'flat', 'no ridge in a ring of trenches');
});

test('a ridge that wanders in and out within the band is followed as it goes', () => {
  const wander = (a) => 1000 * (1 + 0.1 * Math.cos(2 * a));
  const edge = new TerrainEdge({ heights: ring(wander), frame, radiusM: 1000 }).trace();
  assert.equal(edge.reason, null);
  const off = edge.points.map(([x, y]) => Math.abs(Math.hypot(x, y) - wander(Math.atan2(y, x))));
  assert.ok(Math.max(...off) < 50, `off the crest by ${Math.max(...off)} m at most`);
});

test('flat ground has no edge to follow, and a band past the heights is refused', () => {
  const flat = new TerrainEdge({ heights: ground(() => 120), frame, radiusM: 1000 }).trace();
  assert.deepEqual([flat.points, flat.reason], [null, 'flat']);
  const tooBig = new TerrainEdge({ heights: ring(() => 1100), frame, radiusM: 1300 }).trace();
  assert.equal(tooBig.reason, 'off-frame');
  assert.throws(() => new TerrainEdge({ heights: ground(() => 0), frame, radiusM: 1000, follow: 'peaks' }), RangeError);
});
