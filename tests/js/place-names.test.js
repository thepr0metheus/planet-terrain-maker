import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PlaceNames } from '../../web/js/place-names.js';

const MOON_R = 1737400;
// Entries shaped like the Moon's list (tools/planet_names.py output). Mare
// Tranquillitatis, Sabine, Ritter and Aldrin are real; the others are set up
// for the search order and the "smallest feature that holds it" cases.
const LIST = [
  ['Mare Tranquillitatis', 8.35, 30.83, 875.73, 'ME'],
  ['Sabine', 1.3769, 20.066, 29.75, 'AA'],
  ['Ritter', 1.958, 19.1713, 29.52, 'AA'],
  ['Sabine D', 1.1, 20.2, 4.0, 'SF'],
  ['Sabine B', 1.6, 19.9, 8.0, 'SF'],          // after Sabine D in the list, but bigger
  ['Rimae Sabine', 1.0, 22.0, 100.0, 'RI'],     // holds the name inside, and is the biggest
  ['Aldrin', 1.4059, 22.0899, 2.8, 'AA'],
  ['Ritter B', 2.32, 18.89, 14.2, 'SF'],
];

const names = (list = LIST) => new PlaceNames(() => Promise.resolve(list), MOON_R);

test('a search finds names that hold the query, the exact one first, then those that start with it', async () => {
  const found = await names().search('ritter');
  assert.deepEqual(found.map((p) => p.name), ['Ritter', 'Ritter B']);
  assert.deepEqual(found[0], { name: 'Ritter', lat: 1.958, lon: 19.1713, diameterKm: 29.52, kind: 'crater' });
  // The exact name, then the names that start with it (bigger first), then the rest.
  assert.deepEqual((await names().search('sabine')).map((p) => p.name), ['Sabine', 'Sabine B', 'Sabine D', 'Rimae Sabine']);
  // Inside a name, and the biggest first among equals.
  assert.deepEqual((await names().search('ra')).map((p) => p.name), ['Mare Tranquillitatis']);
  assert.deepEqual(await names().search('x'), [], 'one letter is not searched');
  assert.equal((await names().search('i', 2)).length, 0);
  assert.equal((await names().search('in', 1)).length, 1, 'limit');
});

test('a point is named after the smallest feature that holds it', async () => {
  assert.equal((await names().nameAt(1.38, 20.07)).name, 'Sabine');            // the centre of Sabine
  assert.equal((await names().nameAt(1.1, 20.2)).name, 'Sabine D', 'inside Sabine D and inside Sabine: the smaller');
  assert.equal((await names().nameAt(8.0, 30.0)).name, 'Mare Tranquillitatis');
  assert.equal(await names().nameAt(-60, -100), null, 'nothing named there');
});

test('distances are measured on the body\'s sphere: one degree on the Moon is 30.3 km', () => {
  const d = names().distanceKm(0, 0, 1, 0);
  assert.ok(Math.abs(d - 30.3234) < 1e-3, `${d}`);
});

test('the list is loaded once, and loaded again after a failure', async () => {
  let loads = 0;
  const ok = new PlaceNames(() => { loads += 1; return Promise.resolve(LIST); }, MOON_R);
  await ok.search('sabine');
  await ok.nameAt(1, 20);
  assert.equal(loads, 1);
  let tries = 0;
  const flaky = new PlaceNames(() => { tries += 1; return tries === 1 ? Promise.reject(new Error('offline')) : Promise.resolve(LIST); }, MOON_R);
  await assert.rejects(() => flaky.search('sabine'), /offline/);
  assert.equal((await flaky.search('sabine'))[0].name, 'Sabine');
});

test('a feature type the list does not explain gets no word', () => {
  assert.equal(PlaceNames.place(['X', 0, 0, 1, 'ZZ']).kind, '');
});

test('the words follow the IAU descriptor terms, on Mars and on Venus', () => {
  // Mars said "chasm" for a chaos and "mountains" for mesas before 2026-10-05
  const kind = (code) => PlaceNames.place(['X', 0, 0, 1, code]).kind;
  assert.deepEqual(
    ['CH', 'CM', 'MN', 'LA', 'LB', 'TH'].map(kind),
    ['chaos', 'chasm', 'mesa', 'landslide', 'labyrinth', 'dome'],
    'Aurorae Chaos, Coprates Chasma, Nepenthes Mensae, Candor Labes, Noctis Labyrinthus, Cerberus Tholi');
  assert.deepEqual(['CR', 'TE', 'FR', 'FL', 'RE'].map(kind), ['corona', 'tessera', 'pancake dome', 'lava flow', 'region'],
    'Artemis Corona, Fortuna Tessera, Seoritsu Farra, Mylitta Fluctus, Ovda Regio');
});
