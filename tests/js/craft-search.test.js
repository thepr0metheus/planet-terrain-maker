import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findCraft } from '../../web/js/craft-search.js';
import { WORLDS } from '../../web/js/worlds.js';
import { RU } from '../../web/js/i18n-ru.js';

const ru = (craft) => RU[craft.label] ?? craft.label;
const names = (found) => found.map((craft) => craft.label);

test('a craft is found by its name in Russian or in English, by part of it, or by its year', () => {
  const moon = WORLDS.moon.landers.list, mars = WORLDS.mars.landers.list;
  assert.equal(findCraft(moon, '', ru).length, moon.length, 'an empty field: all of them');
  // the Russian names as the page shows them (its dictionary), typed in other ways
  const typed = (label) => RU[label].toLowerCase();
  assert.deepEqual(names(findCraft(moon, typed('Apollo 11').replace('-', ' '), ru)), ['Apollo 11']);
  assert.deepEqual(names(findCraft(moon, RU['Apollo 17'], ru)), ['Apollo 17'], 'the dash as typed or not');
  const rover = typed('Luna 17 and Lunokhod 1').split(RU[' and '])[1].replace(/-\d+$/, '');     // the rover's name without its number
  assert.deepEqual(names(findCraft(moon, rover, ru)), ['Luna 17 and Lunokhod 1', 'Luna 21 and Lunokhod 2']);
  assert.deepEqual(names(findCraft(mars, typed('Curiosity').slice(0, 5), ru)), ['Curiosity'], 'the start of a name');
  assert.deepEqual(names(findCraft(mars, 'Curiosity', ru)), ['Curiosity'], 'the English name too');
  assert.deepEqual(names(findCraft(mars, '2021', ru)), ['Perseverance and Ingenuity', 'Zhurong'], 'by the year');
  assert.deepEqual(names(findCraft(WORLDS.venus.landers.list, typed('Vega 1').split('-')[0], ru)), ['Vega 1', 'Vega 2']);
  assert.deepEqual(findCraft(mars, typed('Venera 7').split('-')[0], ru), [], 'nothing of another world');
});
