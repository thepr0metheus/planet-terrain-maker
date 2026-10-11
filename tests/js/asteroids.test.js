import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { equivalentDiameter, longestExtent, metresPerUnit, readObj, readRadiusGrid, readWrl, volumeOf } from '../../web/js/asteroid-shapes.js';
import { asteroidWords, catalogueEntry, cometEntry, entryOf, findAsteroids, keyOf, topEntry, vehicleEntry } from '../../web/js/asteroid-search.js';
import { RU } from '../../web/js/i18n-ru.js';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

// A cube of side 2 as an OBJ: 8 corners, 6 square facets in two forms of index.
const CUBE = `# a cube
v -1 -1 -1
v 1 -1 -1
v 1 1 -1
v -1 1 -1
v -1 -1 1
v 1 -1 1
v 1 1 1
v -1 1 1
f 1 4 3 2
f 5 6 7 8
f 1/1 2/2 6/6 5/5
f 2//2 3//3 7//7 6//6
f 3 4 8 7
f -1 -5 -8 -4
`;

test('a shape of vertices and facets: squares cut into triangles, and the forms of an index OBJ has', () => {
  const cube = readObj(CUBE);
  assert.equal(cube.positions.length, 24);
  assert.equal(cube.indices.length, 6 * 2 * 3);
  assert.deepEqual([...cube.indices.slice(-6)], [7, 3, 0, 7, 0, 4], 'negative indices count back from the last vertex');
  assert.ok(Math.abs(volumeOf(cube) - 8) < 1e-9, 'a cube of side 2 holds 8');
  assert.equal(longestExtent(cube.positions), 2);
  assert.throws(() => readObj('v 0 0 0\n'), /no facets/);
  assert.throws(() => readObj('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 9\n'), /could not be read/);
});

test('a shape without a size is sized by the diameter of a ball of its volume', () => {
  const cube = readObj(CUBE);
  const own = equivalentDiameter(volumeOf(cube));
  assert.ok(Math.abs(own - Math.cbrt(48 / Math.PI)) < 1e-12);
  const metres = metresPerUnit(cube, 2.5);
  assert.ok(Math.abs(own * metres - 2500) < 1e-6, 'the cube becomes a 2.5 km asteroid');
});

const TOP = [
  topEntry({ id: 'bennu', name: 'Bennu', number: 101955, lengthM: 565 }),
  topEntry({ id: 'eros', name: 'Eros', number: 433, lengthM: 32601 }),
];
const CATALOGUE = [[2, 'Pallas', 539, 101], [16, 'Psyche', 222, 109], [116, 'Sirona', 70, 201], [1600, 'Vyssotsky', 5, 300], [17433, '', 4.4, 5100]]
  .map(catalogueEntry);

test('the search: the top while nothing is typed; by name, the name in the language in use, or number', () => {
  const lists = { top: TOP, catalogue: CATALOGUE };
  assert.deepEqual(findAsteroids(lists, '  '), { top: TOP, found: [] });
  assert.deepEqual(findAsteroids(lists, 'psy').found.map((a) => a.number), [16]);
  assert.deepEqual(findAsteroids(lists, 'PALLAS').found.map((a) => a.name), ['Pallas'], 'any case');
  assert.deepEqual(findAsteroids(lists, '16').found.map((a) => a.number), [16, 116, 1600], 'the number typed itself first');
  assert.deepEqual(findAsteroids(lists, '17433').found.map((a) => a.number), [17433], 'an asteroid with no name');
  const russian = findAsteroids(lists, RU.Eros.slice(0, 3), { nameOf: (a) => RU[a.name] ?? a.name });
  assert.deepEqual(russian.top.map((a) => a.id), ['eros'], 'the top by its name in Russian');
  assert.equal(findAsteroids(lists, '1', { most: 2 }).found.length, 2, 'at most so many of the catalogue');
});

test('an asteroid in words: the top by its length, the catalogue by its diameter', () => {
  const distance = (m) => `${m} m`;
  assert.deepEqual(asteroidWords(TOP[0], distance), { name: 'Bennu', size: '565 m long' });
  assert.deepEqual(asteroidWords(CATALOGUE[1], distance), { name: '(16) Psyche', size: '222000 m in diameter' });
  assert.deepEqual(asteroidWords(CATALOGUE[4], distance), { name: '(17433)', size: '4400 m in diameter' });
});

test('a saved asteroid: its key finds it again in the lists, and one the lists have no more is none', () => {
  const lists = { top: TOP, catalogue: CATALOGUE };
  for (const a of [TOP[0], CATALOGUE[1], CATALOGUE[4]]) {
    const key = JSON.parse(JSON.stringify(keyOf(a)));         // as the model's settings keep it
    assert.deepEqual(entryOf(key, lists), a);
  }
  assert.deepEqual(keyOf(TOP[1]), { source: 'top', id: 'eros' }, 'the top by its id: the list has the rest');
  assert.equal(entryOf({ source: 'top', id: 'gone' }, lists), null);
  assert.equal(entryOf({ source: 'damit', number: 5, name: 'Astraea', diameterKm: 0, model: 7 }, lists), null, 'no size to scale it by');
  assert.equal(entryOf({ source: 'elsewhere', id: 'bennu' }, lists), null);
  assert.equal(entryOf(undefined, lists), null);
});

test('the lists the tool made: the top smallest first, the catalogue by number and without the top', () => {
  const top = read('../../web/data/asteroids-top.json');
  const damit = read('../../web/data/asteroids-damit.json');
  assert.equal(top.length, 10);
  assert.ok(top.every((a, i) => a.lengthM > 0 && (i === 0 || a.lengthM >= top[i - 1].lengthM)), 'the top from the smallest');
  assert.ok(top.every((a) => ['glb', 'obj'].includes(a.kind) && a.url.startsWith('https://') && a.metresPerUnit > 0 && a.credit));
  assert.ok(top.every((a) => a.name in RU), 'each name of the top has its Russian');
  assert.ok(damit.length > 8000);
  const numbers = new Set(top.map((a) => a.number));
  assert.ok(damit.every(([number, name, km, model], i) => Number.isInteger(number) && typeof name === 'string' && km > 0
    && Number.isInteger(model) && !numbers.has(number) && (i === 0 || number > damit[i - 1][0])));
});

test('a comet\'s shape in VRML (Rosetta\'s 67P) and as a table of radii (Halley\'s)', () => {
  const wrl = `#VRML V2.0 utf8
# a tetrahedron
Shape { geometry IndexedFaceSet { coord Coordinate { point [
  0 0 0, 1 0 0,
  0 1 0, 0 0 1 ] }
  coordIndex [ 0 2 1 -1 0 1 3 -1 0 3 2 -1 1 2 3 -1 ] } }`;
  const tetra = readWrl(wrl);
  assert.equal(tetra.positions.length, 12);
  assert.equal(tetra.indices.length, 12);
  assert.ok(Math.abs(volumeOf(tetra) - 1 / 6) < 1e-12);
  assert.throws(() => readWrl('#VRML V2.0 utf8\nShape { }'), /no facets/);
  // a ball of radius 2 as a grid: longitudes 0 to 360 every 90 degrees, latitudes -90 to 90 every 45
  const rows = [];
  for (const lon of [360, 270, 180, 90, 0]) for (const lat of [-90, -45, 0, 45, 90]) rows.push(`${lon} ${lat} 2.0`);
  const ball = readRadiusGrid(rows.join('\n'));
  assert.equal(ball.positions.length / 3, 25);
  assert.equal(ball.indices.length / 3, 4 * 4 * 2);
  assert.ok(Math.abs(longestExtent(ball.positions) - 4) < 1e-6, '4 across');
  assert.throws(() => readRadiusGrid('0 0 1\n90 0 1\n'), /could not be read/);
});

test('the comets of the list: smallest first, each read by its kind, its name in Russian', () => {
  const comets = read('../../web/data/comets.json');
  assert.equal(comets.length, 5);
  assert.ok(comets.every((c, i) => c.lengthM > 0 && (i === 0 || c.lengthM >= comets[i - 1].lengthM)));
  assert.ok(comets.every((c) => ['obj', 'wrl', 'grid'].includes(c.kind) && c.url.startsWith('https://') && c.metresPerUnit > 0 && c.credit));
  assert.ok(comets.every((c) => c.name in RU), 'each name in Russian');
});

test('a comet and a spacecraft are saved by their id and said by their size', () => {
  const comet = cometEntry({ id: '67p', name: '67P/Churyumov–Gerasimenko', lengthM: 5015 });
  const rocket = vehicleEntry({ id: 'falcon-9', name: 'Falcon 9', kind: 'built', heightM: 70 });
  const station = vehicleEntry({ id: 'iss', name: 'International Space Station', kind: 'glb', lengthM: 108.5 });
  const lists = { top: TOP, catalogue: CATALOGUE, comets: [comet], vehicles: [rocket, station] };
  for (const one of [comet, rocket, station]) {
    const key = JSON.parse(JSON.stringify(keyOf(one)));
    assert.deepEqual(Object.keys(key), ['source', 'id'], 'the id only: the list has the rest');
    assert.equal(entryOf(key, lists), one);
  }
  assert.equal(entryOf({ source: 'vehicle', id: 'gone' }, lists), null);
  assert.equal(entryOf({ source: 'comet', id: '67p' }, { top: TOP }), null, 'no comets loaded: none found');
  const distance = (m) => `${m} m`;
  assert.deepEqual(asteroidWords(rocket, distance), { name: 'Falcon 9', size: '70 m tall' });
  assert.deepEqual(asteroidWords(station, distance), { name: 'International Space Station', size: '108.5 m long' });
  assert.deepEqual(asteroidWords(comet, distance), { name: '67P/Churyumov–Gerasimenko', size: '5015 m long' });
});

test('the labels: medium unless one chose, as chosen on this device, and hidden on asking', async () => {
  const { LabelLook } = await import('../../web/js/asteroid-on-model.js');
  const { StoredChoice } = await import('../../web/js/stored-choice.js');
  const kept = new Map();
  const storage = () => ({ getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, String(v)) });
  const container = () => ({ dataset: {}, hidden: false, toggleAttribute(name, on) { this.hidden = on; } });
  const look = (into) => new LabelLook(into, {
    size: new StoredChoice('ptm.objectLabels', { allowed: LabelLook.SIZES, storage }),
    shown: new StoredChoice('ptm.objectLabelsShown', { allowed: ['yes', 'no'], storage }),
  });
  const first = container(), labels = look(first);
  assert.equal(first.dataset.objectLabels, 'medium');
  assert.equal(first.hidden, false);
  labels.setSize('small');
  labels.setSize('huge');
  labels.setShown(false);
  assert.deepEqual([first.dataset.objectLabels, first.hidden], ['small', true], 'an unknown size changes nothing');
  const again = container();
  look(again);
  assert.deepEqual([again.dataset.objectLabels, again.hidden], ['small', true], 'kept for the next visit');
});

