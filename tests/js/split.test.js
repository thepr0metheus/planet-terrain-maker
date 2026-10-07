import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HeightGrid } from '../../web/js/height-grid.js';
import {
  composeHeights, rangeInside, verticalOffsets, turnedSource, normalTurn, defaultVertical, sideAnchors, toMetres, toFrame, turnForMask,
} from '../../web/js/split.js';
import { Divider } from '../../web/js/divider.js';
import { TerrainModel } from '../../web/js/model.js';
import { Place } from '../../web/js/capture.js';
import { CircleOutline, PolygonOutline } from '../../web/js/outline.js';

const frame = { widthM: 2240, heightM: 2240 };
const circle = new CircleOutline(1000);
const centreLine = (deg = 0) => new Divider({ angleDeg: deg });
const flat = (h, n = 21) => HeightGrid.fill(n, n, () => h);
const rampEast = (n = 21) => HeightGrid.fill(n, n, (u) => u * 100);    // 0 at the west edge, 100 at the east
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test('frame coordinates and metres: u east, v south; x east, y north', () => {
  assert.deepEqual(toMetres(0.5, 0.5, frame), [0, 0]);
  assert.deepEqual(toMetres(1, 0, frame), [1120, 1120]);
  const [u, v] = toFrame(...toMetres(0.3, 0.8, frame), frame);
  assert.ok(near(u, 0.3) && near(v, 0.8));
});

test('the range counts only the outline (a circle widened by a cell); a contour holds what its turn brings in', () => {
  // 10 m within 600 m of the centre, 1000 m beyond, no height at the very centre
  const grid = HeightGrid.fill(21, 21, (u, v) => {
    const [x, y] = toMetres(u, v, frame);
    if (u === 0.5 && v === 0.5) return NaN;
    return Math.hypot(x, y) > 600 ? 1000 : 10;
  });
  assert.deepEqual(rangeInside(grid, new CircleOutline(400), frame), { lowest: 10, highest: 10 }, '400 m + a cell (158 m) stays inside 600');
  assert.equal(rangeInside(grid, new CircleOutline(500), frame).highest, 1000, '500 m + a cell passes 600');
  // a long thin contour east-west: low ground only near the centre line north-south
  const strip = HeightGrid.fill(41, 41, (u) => (Math.abs(u - 0.5) < 0.05 ? 0 : 500));
  const wide = new PolygonOutline([[-900, -100], [900, -100], [900, 100], [-900, 100]]);
  assert.equal(rangeInside(strip, wide, frame).highest, 500, 'the contour runs across the strip');
  assert.equal(rangeInside(strip, wide, frame, 90).highest, 0, 'turned a quarter, the strip lies along the contour');
});

test('sea-level keeps the heights; own-lowest brings each place\'s lowest point to zero', () => {
  const how = { outline: circle, frame };
  assert.deepEqual(verticalOffsets(flat(100), flat(-2000), 'sea-level', how), [0, 0]);
  assert.deepEqual(verticalOffsets(flat(100), flat(-2000), 'own-lowest', how), [-100, 2000]);
  assert.throws(() => verticalOffsets(flat(0), flat(0), 'nonsense', how), RangeError);
});

test('two Earth places start from sea level; any other world from the lowest points', () => {
  assert.equal(defaultVertical(['earth', 'earth']), 'sea-level');
  assert.equal(defaultVertical(['earth', 'moon']), 'own-lowest');
  assert.equal(defaultVertical(['mars', 'venus']), 'own-lowest');
});

test('the composed grid takes each node from its side, raised by its offset and the user\'s raise', () => {
  const grid = composeHeights(flat(100), flat(-2000), { divider: centreLine(), outline: circle, frame, vertical: 'own-lowest', raises: [5, -7] });
  assert.equal(grid.sample(0.2, 0.5), 0 + 5);
  assert.equal(grid.sample(0.8, 0.5), 0 - 7);
  const sea = composeHeights(flat(100), flat(-2000), { divider: centreLine(), outline: circle, frame, vertical: 'sea-level' });
  assert.equal(sea.sample(0.2, 0.5), 100);
  assert.equal(sea.sample(0.8, 0.5), -2000);
});

test('a drawn line need not pass the centre: the heights follow it', () => {
  // west to east 300 m north of the centre: the first place north of it, the second south
  const divider = new Divider({ points: [[-800, 300], [800, 300]] });
  const grid = composeHeights(flat(100), flat(-50), { divider, outline: circle, frame, vertical: 'sea-level' });
  const [, northV] = toFrame(0, 600, frame);
  assert.equal(grid.sample(0.5, northV), 100);
  assert.equal(grid.sample(0.5, 0.5), -50, 'the centre is the second place\'s');
});

test('a turn moves a place about its centre, clockwise: at 90 its north faces east', () => {
  const source = turnedSource(90);
  const [u, v] = source(0.9, 0.5);       // east of the centre on the model
  assert.ok(near(u, 0.5, 1e-12) && near(v, 0.1, 1e-12), 'comes from the north of the capture');
  assert.equal(normalTurn(-30), 330);
  assert.throws(() => normalTurn(Infinity), RangeError);
  // a ramp rising eastwards, turned by 180, rises westwards
  const turned = composeHeights(rampEast(), rampEast(), { divider: centreLine(90), outline: circle, frame, vertical: 'sea-level', turns: [180, 0] });
  assert.ok(turned.sample(0.3, 0.3) > turned.sample(0.7, 0.3), 'the first place, turned, falls to the east');
  assert.ok(turned.sample(0.3, 0.7) < turned.sample(0.7, 0.7), 'the second, unturned, rises to the east');
});

test('each dial stands on the rim of its own part', () => {
  const [west, east] = sideAnchors(centreLine(), circle, frame);
  assert.ok(near(west[0], 0.5 - 1000 / 2240, 1e-3) && near(west[1], 0.5, 1e-2), `west ${west}`);
  assert.ok(near(east[0], 0.5 + 1000 / 2240, 1e-3) && near(east[1], 0.5, 1e-2), `east ${east}`);
  // a line far north leaves the first place a small cap: its dial stands at the north of the rim
  const [cap, rest] = sideAnchors(new Divider({ points: [[-900, 700], [900, 700]] }), circle, frame);
  assert.ok(near(cap[0], 0.5, 1e-2) && near(cap[1], 0.5 - 1000 / 2240, 1e-3), `cap ${cap}`);
  assert.ok(rest[1] > 0.5, 'the rest is mostly south');
  assert.deepEqual(sideAnchors(new Divider({ points: [[-900, 1500], [900, 1500]] }), circle, frame)[0], null, 'a line past the outline leaves the first place nothing');
});

function place(world, h, outline = circle) {
  return new Place({ world, center: { lat: 0, lon: 0 }, frame, outline,
    heights: flat(h), picture: { width: 4, height: 4 }, name: `${world} ${h}` });
}

test('a model of two places: the ground under a point is the place\'s own height, not lifted', () => {
  const model = new TerrainModel({ places: [place('earth', 300), place('moon', -1500)] });
  assert.equal(model.compare.vertical, 'own-lowest');
  model.arrange({ raises: [50, 0] });
  assert.deepEqual(model.groundAt(0.2, 0.5), { height: 300, place: 0 });
  assert.deepEqual(model.groundAt(0.8, 0.5), { height: -1500, place: 1 });
  assert.equal(model.heights().sample(0.2, 0.5), 50, 'the composed heights carry the mode and the raise');
});

test('two places share the first one\'s contour, and a drawn line keeps to the library', async () => {
  const zone = new PolygonOutline([[-900, -500], [900, -500], [600, 700], [-600, 700]]);
  const model = new TerrainModel({
    places: [place('earth', 300, zone), place('mars', -10, zone)],
    compare: { points: [[-800, 300], [800, 300]], smooth: false },
  });
  assert.equal(model.outline, zone);
  assert.equal(model.groundAt(0.5, 0.5).place, 1);
  const { meta } = await model.toLibrary(null, async () => new Uint8Array(1));
  assert.deepEqual(meta.compare.points, [[-800, 300], [800, 300]]);
  assert.equal(meta.compare.smooth, false);
  const old = TerrainModel.compareOf([place('earth', 1), place('earth', 2)], { angleDeg: 30 });
  assert.equal(old.points, null, 'a model saved before drawn lines keeps the line through the centre');
});

test('another place for a half: turned and raised by nothing, the mode picked again when the worlds change', () => {
  const model = new TerrainModel({ places: [place('earth', 300), place('earth', 100)], compare: { turns: [10, 20], raises: [1, 2] } });
  assert.equal(model.compare.vertical, 'sea-level');
  model.id = 'abc';
  model.replacePlace(1, place('mars', -4000));
  assert.deepEqual(model.compare.turns, [10, 0]);
  assert.deepEqual(model.compare.raises, [1, 0]);
  assert.equal(model.compare.vertical, 'own-lowest', 'Earth with Mars starts from the lowest points');
  assert.equal(model.id, 'abc', 'the same model, saved again: a copy in the library keeps the old one');
  model.arrange({ vertical: 'sea-level' });
  model.replacePlace(1, place('moon', -1000));
  assert.equal(model.compare.vertical, 'sea-level', 'the same mix of kinds keeps the user\'s choice');
});

test('a shape turned over the map gives its place the turn that brings the clear part home', () => {
  // the mask turned 90° clockwise on the map: its clear part, east at no turn, lies south there
  assert.equal(turnForMask(90), 270);
  assert.equal(turnForMask(0), 0);
  assert.equal(turnForMask(-45), 45);
  // so the model's east (the clear part, the line as drawn) shows what lay south of the capture's centre
  const [u, v] = turnedSource(turnForMask(90))(0.9, 0.5);
  assert.ok(near(u, 0.5, 1e-12) && near(v, 0.9, 1e-12), `east comes from the south: ${u}, ${v}`);
});

