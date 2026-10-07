import { test } from 'node:test';
import assert from 'node:assert/strict';

import { differenceParts, markHeights, markNumber, markSteps, rulerReading, signedMetres, whyLines } from '../../web/js/height-ruler.js';
import { language, setLanguage } from '../../web/js/i18n.js';
import { RU } from '../../web/js/i18n-ru.js';

function withLanguage(id, fn) {
  const before = language();
  setLanguage(id);
  try { return fn(); } finally { setLanguage(before); }
}

test('marks: numbers at least 30 px apart, on a step of 1, 2 or 5; small marks between where they fit', () => {
  assert.deepEqual(markSteps(0.1), { major: 500, minor: 100 });      // 300 m for 30 px: 500 m
  assert.deepEqual(markSteps(0.3), { major: 100, minor: 50 });       // 20 m would be 6 px: too close
  assert.deepEqual(markSteps(1.5), { major: 20, minor: 5 });
  assert.deepEqual(markSteps(0.05), { major: 1000, minor: 200 });    // 600 m: the next 1 of ten
  assert.deepEqual(markSteps(0.0012), { major: 50000, minor: 10000 });
  assert.deepEqual(markSteps(1000), { major: 0.1, minor: 0.02 }, 'a tenth of a metre at least');
  for (const none of [0, -1, NaN, Infinity]) assert.deepEqual(markSteps(none), { major: 0, minor: 0 });
});

test('marks: from 0 towards the top, up or down, the last one not past it', () => {
  assert.deepEqual(markHeights(1234, 500), [0, 500, 1000]);
  assert.deepEqual(markHeights(-1234, 500), [0, -500, -1000]);
  assert.deepEqual(markHeights(1000, 500), [0, 500, 1000]);
  assert.deepEqual(markHeights(1, 0.5), [0, 0.5, 1]);
  assert.deepEqual(markHeights(0, 100), [0]);
  assert.ok(Object.is(markHeights(-5, 1)[0], 0), 'no "−0"');
  assert.equal(markNumber(1000, 500), '1,000');
  assert.equal(markNumber(-1500, 500), '−1,500');
  assert.equal(markNumber(0.1 * 3, 0.1), '0.3');
  assert.equal(markNumber(0, 0.5), '0.0');
  withLanguage('ru', () => assert.equal(markNumber(-2500, 500), '−2 500'));
});

test('the reading: millimetres of the model, metres by its heights scale, the data, and the distance across', () => {
  const zero = { x: 0, y: 0, z: 10 }, top = { x: 3, y: 4, z: 15 };
  const r = rulerReading({ zero, top, zeroData: 115, topData: 612, zMmPerM: 0.01, mmPerM: 0.001 });
  assert.equal(r.mm, 5);
  assert.equal(r.metres, 500);
  assert.equal(r.data, 497);
  assert.equal(r.acrossM, 5000);
  assert.ok(Number.isNaN(rulerReading({ zero, top, zeroData: NaN, topData: 612, zMmPerM: 0.01, mmPerM: 0.001 }).data));
  const down = rulerReading({ zero: top, top: zero, zeroData: 612, topData: 115, zMmPerM: 0.01, mmPerM: 0.001 });
  assert.equal(down.metres, -500);
  assert.equal(down.data, -497);
});

test('a height over the zero: its sign, tenths under 10 m, "0 m" for nothing', () => {
  assert.equal(signedMetres(2735.4), '+2,735 m');
  assert.equal(signedMetres(-12), '−12 m');
  assert.equal(signedMetres(3.44), '+3.4 m');
  assert.equal(signedMetres(9.96), '+10 m');
  assert.equal(signedMetres(0.04), '0 m');
  assert.equal(signedMetres(-0.04), '0 m');
  withLanguage('ru', () => {
    const metres = (n) => RU['{n} m'].replace('{n}', n);
    assert.equal(signedMetres(2735.4), metres('+2\u00a0735'));
    assert.equal(signedMetres(-3.44), metres('−3,4'), 'a decimal comma');
  });
});

// Olympus Mons reads +21,255 m on the model and +20,762 m by the data: the ruler says why, in parts that
// add up to the difference.
const end = (data, place = null, { offset = 0, raise = 0, held = 0 } = {}) => ({ data, place, offset, raise, held });
const words = (parts, zero, top, least = 0.5) => whyLines({
  parts, zero, top, names: ['Georgia', 'Olympus Mons'], stepM: 1240, least, distance: (m) => `${m} m`,
});

test('why the numbers differ: the place stood higher, and the rest the grid of the model', () => {
  const zero = end(17, 0, { offset: 0.03 }), top = end(20779, 1, { offset: 496.98 });
  const metres = 20779 - 17 + 496.95 - 4;
  const parts = differenceParts({ metres, zero, top });
  assert.ok(Math.abs(parts.lift - 496.95) < 1e-9);
  assert.equal(parts.water, 0);
  assert.ok(Math.abs(parts.grid + 4) < 1e-9);
  assert.deepEqual(words(parts, zero, top), [
    'Olympus Mons stands 497 m higher on the model (“Lowest points level”)',
    'grid of the model: −4.0 m, points 1240 m apart',
  ], 'the 0.03 m of Georgia is too little to say');
});

test('why the numbers differ: on one place its lift cancels out; raised, lowered, both causes; water', () => {
  const lifted = { offset: 497 };
  const same = differenceParts({ metres: 100, zero: end(1000, 1, lifted), top: end(1100, 1, lifted) });
  assert.deepEqual(same, { lift: 0, water: 0, grid: 0 });
  assert.deepEqual(words(same, end(1000, 1, lifted), end(1100, 1, lifted)), []);

  const zero = end(0, 0, { raise: -250 }), top = end(500, 1, { offset: 300, raise: 200 });
  const parts = differenceParts({ metres: 500 + 500 + 250, zero, top });
  assert.deepEqual(parts, { lift: 750, water: 0, grid: 0 });
  assert.deepEqual(words(parts, zero, top), [
    'Olympus Mons stands 500 m higher on the model (“Lowest points level” and “Raise”)',
    'Georgia stands 250 m lower on the model (“Raise”)',
  ]);

  const wet = differenceParts({ metres: 212, zero: end(0), top: end(200, null, { held: 12 }) });
  assert.deepEqual(wet, { lift: 0, water: 12, grid: 0 });
  assert.deepEqual(words(wet, end(0), end(200, null, { held: 12 })), ['calm water: +12 m']);
});

test('why the numbers differ: the parts add up to the difference, and small ones show by the numbers shown', () => {
  const zero = end(3.1, 0, { raise: 0.3 }), top = end(6.2, 1, { held: 0.2 });
  const metres = 2.9;
  const parts = differenceParts({ metres, zero, top });
  assert.ok(Math.abs(parts.lift + parts.water + parts.grid - (metres - (6.2 - 3.1))) < 1e-12);
  assert.deepEqual(words(parts, zero, top, 0.5), [], 'whole metres shown: tenths are not said');
  assert.equal(words(parts, zero, top, 0.05).length, 3, 'tenths shown: they are');
});
