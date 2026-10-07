import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nameOfPlaces, placesOfName, renaming } from '../../web/js/names.js';
import { RU } from '../../web/js/i18n-ru.js';

const AND = ' and ';

test('a model\'s name made of its places\' names gives each place its part', () => {
  assert.deepEqual(placesOfName('Batumi and Everest', 2, AND), ['Batumi', 'Everest']);
  assert.deepEqual(placesOfName('Georgia (Batumi, Poti, Zugdidi) and Olympus Mons', 2, AND), ['Georgia (Batumi, Poti, Zugdidi)', 'Olympus Mons']);
  assert.deepEqual(placesOfName('  Elbrus, 28 km ', 1, AND), ['Elbrus, 28 km'], 'one place takes the whole name');
  assert.deepEqual(placesOfName(`Batumi${RU[' and ']}Everest`, 2, RU[' and ']), ['Batumi', 'Everest'], 'the joining word of the language in use');
});

test('a name that does not split into the places leaves them as they are', () => {
  assert.equal(placesOfName('Caucasus', 2, AND), null, 'no joining word');
  assert.equal(placesOfName('Batumi and Poti and Mars', 2, AND), null, 'more parts than places');
  assert.equal(placesOfName('Batumi and ', 2, AND), null, 'an empty part');
  assert.equal(placesOfName('   ', 1, AND), null);
  assert.equal(nameOfPlaces(['Batumi ', 'Sabine'], AND), 'Batumi and Sabine');
});

test('a rename by hand renames the places too, and a name typed again sets old models right', () => {
  const card = { name: 'Batumi and Everest', places: ['Khelvachauri Municipality', 'Jiashizong'] };
  assert.deepEqual(renaming(card, 'Batumi and Everest', AND), { name: 'Batumi and Everest', places: ['Batumi', 'Everest'] },
    'the same name again gives the places their names');
  assert.deepEqual(renaming(card, 'Adjara and Himalayas', AND), { name: 'Adjara and Himalayas', places: ['Adjara', 'Himalayas'] });
  assert.deepEqual(renaming(card, 'Caucasus', AND), { name: 'Caucasus', places: null }, 'a name of its own: the places stay');
  assert.equal(renaming({ name: 'Batumi and Everest', places: ['Batumi', 'Everest'] }, 'Batumi and Everest', AND), null, 'nothing to change');
  assert.equal(renaming(card, '  ', AND), null);
});
