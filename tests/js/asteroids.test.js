import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { equivalentDiameter, longestExtent, metresPerUnit, readObj, volumeOf } from '../../web/js/asteroid-shapes.js';
import { asteroidWords, catalogueEntry, entryOf, findAsteroids, keyOf, topEntry } from '../../web/js/asteroid-search.js';
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
