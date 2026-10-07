import { test } from 'node:test';
import assert from 'node:assert/strict';

import { canvasMost, canvasSide } from '../../web/js/device.js';

// A browser that draws nothing on a canvas past `area` points, as Safari past its limit.
const browser = (area) => (w, h) => {
  const canvas = { width: w, height: h };
  let drawn = null;
  canvas.getContext = () => ({
    fillRect: (x, y) => { if (canvas.width * canvas.height <= area) drawn = `${x},${y}`; },
    getImageData: (x, y) => ({ data: [255, 255, 255, drawn === `${x},${y}` ? 255 : 0] }),
  });
  return canvas;
};

test('the canvas a browser holds is tried on it', () => {
  assert.equal(canvasSide(browser(4096 * 4096), [8192, 4096, 2048]), 4096);
  assert.equal(canvasSide(browser(2048 * 2048), [8192, 4096, 2048]), 2048);
  assert.equal(canvasSide(() => { throw new Error('no canvas'); }, [8192, 4096, 2048]), 1024, 'none works: the least');
  const made = [];
  canvasSide((w, h) => {
    const canvas = browser(4096 * 4096)(w, h);
    made.push(canvas);
    return canvas;
  }, [8192, 4096, 2048]);
  assert.equal(made.length, 2, '8192 and then 4096 tried');
  assert.ok(made.every((c) => c.width === 0 && c.height === 0), 'each canvas tried is given back');
});

test('a computer that holds 8192 gets all; a touch device 4096 at most, as an iPad needs', () => {
  assert.equal(canvasMost(browser(16384 * 16384)), 16384, 'a computer: as much as the page makes');
  assert.equal(canvasMost(browser(4096 * 4096)), 4096, 'a computer that holds less');
  // an iPad made one canvas of 8192, then a model of two such pictures came out blank
  assert.equal(canvasMost(browser(16384 * 16384), { touch: true }), 4096);
  assert.equal(canvasMost(browser(2048 * 2048), { touch: true }), 2048, 'and less where it holds less');
  const tried = [];
  canvasMost((w, h) => {
    tried.push(w);
    return browser(16384 * 16384)(w, h);
  }, { touch: true });
  assert.deepEqual(tried, [4096], 'a touch device is not made to hold 8192 even for a moment');
});
