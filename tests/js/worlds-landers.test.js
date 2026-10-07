import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WORLDS } from '../../web/js/worlds.js';

test('every world but Earth lists its craft on the surface, by year, on the map', () => {
  assert.equal(WORLDS.earth.landers, undefined);
  for (const id of ['moon', 'mars', 'venus']) {
    const { viewKm, list } = WORLDS[id].landers;
    assert.ok(viewKm > 0 && list.length >= 10, `${id}: ${list.length} craft`);
    for (const craft of list) {
      assert.ok(Math.abs(craft.lat) <= 90 && Math.abs(craft.lon) <= 180, `${craft.label} on the map`);
      assert.ok(craft.year >= 1966 && craft.year <= 2026, `${craft.label}: ${craft.year}`);
    }
    assert.deepEqual(list.map((c) => c.year), [...list.map((c) => c.year)].sort((a, b) => a - b), `${id}: by year`);
  }
  // the IAU's stations and the landers' points agree (web/data/moon-names.json)
  const at = (label) => WORLDS.moon.landers.list.find((c) => c.label === label);
  assert.deepEqual([at('Apollo 11').lat, at('Apollo 11').lon], [0.6741, 23.4732]);
  assert.deepEqual([at("Chang'e 4 and Yutu-2").lat, at("Chang'e 4 and Yutu-2").lon], [-45.45, 177.6]);
});
