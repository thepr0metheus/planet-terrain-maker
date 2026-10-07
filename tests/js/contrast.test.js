import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stretchLevels, levelHistogram, levelsOf, widenLevels, levelTable, applyLevelTable, levelsClose } from '../../web/js/contrast.js';

// A grey picture of the given levels, one pixel each.
const grey = (levels, alpha = 255) => new Uint8ClampedArray(levels.flatMap((v) => [v, v, v, alpha]));

test('a dull grey picture is spread over the whole range', () => {
  const levels = Array.from({ length: 101 }, (_, i) => 60 + i);   // 60..160
  const px = grey(levels);
  assert.deepEqual(stretchLevels(px, { low: 0, high: 1 }), { lo: 60, hi: 160 });
  assert.equal(px[0], 0, 'the darkest becomes black');
  assert.equal(px[100 * 4], 255, 'the brightest becomes white');
  assert.equal(px[40 * 4], 102, 'level 100 lies 40% of the way: 0.4 x 255');
});

test('the darkest and brightest few per cent are cut, so one odd pixel does not decide', () => {
  const levels = [0, ...Array.from({ length: 100 }, (_, i) => 50 + i), 255];   // 102 pixels
  const { lo, hi } = stretchLevels(grey(levels), { low: 0.02, high: 0.98 });
  assert.equal(lo, 51, 'the third darkest: 2% of 102 is 2.04 pixels');
  assert.equal(hi, 148, 'the hundredth');
});

test('transparent pixels do not count, and a flat picture is left as it is', () => {
  const px = grey([10, 20, 30, 200], 255);
  px[3 * 4 + 3] = 0;                                // the 200 is transparent
  assert.deepEqual(stretchLevels(px, { low: 0, high: 1 }), { lo: 10, hi: 30 });
  const flat = grey([90, 90, 90]);
  assert.equal(stretchLevels(flat), null);
  assert.deepEqual([...flat], [...grey([90, 90, 90])]);
  assert.equal(stretchLevels(grey([5], 0)), null, 'nothing visible');
});

test('every channel gets the same stretch, so a colour keeps its hue', () => {
  const px = new Uint8ClampedArray([100, 50, 50, 255, 150, 100, 100, 255, 200, 150, 150, 255]);
  stretchLevels(px, { low: 0, high: 1 });
  // red stays ahead of green and blue by the same factor in each pixel
  assert.ok(px[0] >= px[1] && px[4] > px[5] && px[8] > px[9]);
  assert.equal(px[1], px[2]);
});

test('tiles counted together get the levels of one picture made of them all', () => {
  // the map's tiles share one stretch: their counts add up
  const a = grey(Array.from({ length: 50 }, (_, i) => 30 + i));    // a dark tile, 30..79
  const b = grey(Array.from({ length: 50 }, (_, i) => 120 + i));   // a bright one, 120..169
  const sum = levelHistogram(a).map((n, v) => n + levelHistogram(b)[v]);
  const both = new Uint8ClampedArray([...a, ...b]);
  assert.deepEqual(levelsOf(sum, { low: 0.02, high: 0.98 }), levelsOf(levelHistogram(both), { low: 0.02, high: 0.98 }));
  assert.deepEqual(levelsOf(sum, { low: 0.02, high: 0.98 }), { lo: 31, hi: 167 }, 'the 2nd and the 98th of 100');
  assert.equal(levelsOf(new Uint32Array(256)), null, 'no pixels');
});

test('a narrow span is widened about its middle, and stays in 0..255', () => {
  assert.deepEqual(widenLevels({ lo: 30, hi: 90 }, 24), { lo: 30, hi: 90 }, 'wide enough: kept');
  assert.deepEqual(widenLevels({ lo: 34, hi: 45 }, 24), { lo: 28, hi: 52 }, 'the mare by Apollo 11: 11 greys become 24');
  assert.deepEqual(widenLevels({ lo: 2, hi: 6 }, 24), { lo: 0, hi: 24 });
  assert.deepEqual(widenLevels({ lo: 250, hi: 255 }, 24), { lo: 231, hi: 255 });
  assert.deepEqual(widenLevels({ lo: 90, hi: 90 }, 300), { lo: 0, hi: 255 });
});

test('the table sends lo and below to black, hi and above to white, a line between', () => {
  const table = levelTable({ lo: 28, hi: 52 });
  assert.equal(table[0], 0);
  assert.equal(table[28], 0);
  assert.equal(table[40], 128, '12 of 24 greys: halfway, 127.5 rounds to 128');
  assert.equal(table[51], 244, '23 of 24 greys: 244.4');
  assert.equal(table[52], 255);
  assert.equal(table[200], 255);
  const same = levelTable({ lo: 0, hi: 255 });
  assert.ok(same.every((v, i) => v === i), 'from 0 to 255 nothing changes');
});

test('the table can write into another array, leaving the picture as it came', () => {
  const from = new Uint8ClampedArray([40, 30, 52, 77]);
  const to = new Uint8ClampedArray(4);
  applyLevelTable(from, levelTable({ lo: 28, hi: 52 }), to);
  assert.deepEqual([...to], [128, 21, 255, 77], 'alpha copied as it is');
  assert.deepEqual([...from], [40, 30, 52, 77]);
});

test('a stretch a grey or two away is close enough not to redraw for', () => {
  assert.equal(levelsClose({ lo: 29, hi: 53 }, { lo: 28, hi: 52 }), true);
  assert.equal(levelsClose({ lo: 31, hi: 54 }, { lo: 28, hi: 52 }), false);
  assert.equal(levelsClose({ lo: 59, hi: 207 }, { lo: 56, hi: 205 }), true, 'a wide span allows more: 5 is within 4% of 149');
  assert.equal(levelsClose({ lo: 60, hi: 207 }, { lo: 56, hi: 205 }), false, '6 is not');
  assert.equal(levelsClose({ lo: 28, hi: 52 }, null), false, 'nothing drawn yet');
  assert.equal(levelsClose(null, null), true);
});
