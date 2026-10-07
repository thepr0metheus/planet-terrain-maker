import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MOST, RecentPlaces } from '../../web/js/recent-places.js';
import { StoredChoice } from '../../web/js/stored-choice.js';
import { PlaceNames } from '../../web/js/place-names.js';

function memory() {
  const data = new Map();
  return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, v), data };
}

test('the places found last, for each world, newest first and each once, at most five', () => {
  const store = memory();
  const recent = new RecentPlaces(new StoredChoice('ptm.recentPlaces', { storage: () => store }));
  assert.deepEqual(recent.list('moon'), []);
  const at = (name, lat) => ({ name, detail: 'crater', lat, lon: 10, widthM: 5000 });
  recent.add('moon', at('Tycho', -43));
  recent.add('moon', at('Copernicus', 9));
  recent.add('mars', at('Gale', -5));
  recent.add('moon', at('Tycho', -43));
  assert.deepEqual(recent.list('moon').map((p) => p.name), ['Tycho', 'Copernicus'], 'Tycho again: first, and once');
  assert.deepEqual(recent.list('mars').map((p) => p.name), ['Gale']);
  for (let k = 0; k < 7; k++) recent.add('moon', at(`Crater ${k}`, k));
  assert.equal(recent.list('moon').length, MOST);
  assert.equal(recent.list('moon')[0].name, 'Crater 6');
  assert.deepEqual(new RecentPlaces(new StoredChoice('ptm.recentPlaces', { storage: () => store })).list('mars').map((p) => p.name), ['Gale'], 'kept for the next visit');
});

test('a storage that refuses or holds nonsense reads as nothing kept', () => {
  const refusing = new RecentPlaces(new StoredChoice('k', { storage: () => { throw new Error('blocked'); } }));
  refusing.add('moon', { name: 'Tycho', lat: 1, lon: 2 });
  assert.deepEqual(refusing.list('moon'), []);
  const store = memory();
  store.setItem('k', '[1, 2');
  assert.deepEqual(new RecentPlaces(new StoredChoice('k', { storage: () => store })).list('moon'), []);
});

test('the largest named places of a world, the biggest first', async () => {
  const names = new PlaceNames(async () => [
    ['Small', 0, 0, 5, 'AA'], ['Huge', 1, 1, 2500, 'OC'], ['Albedo', 2, 2, 0, 'AL'], ['Big', 3, 3, 900, 'ME'],
  ], 1737400);
  assert.deepEqual((await names.largest(2)).map((p) => p.name), ['Huge', 'Big']);
  assert.ok((await names.largest(10)).every((p) => p.diameterKm > 0), 'a name with no size is not among the largest');
});
