import { test } from 'node:test';
import assert from 'node:assert/strict';

import { linePreview } from '../../web/js/line-preview.js';
import { Divider } from '../../web/js/divider.js';
import { CircleOutline } from '../../web/js/outline.js';

// A canvas that writes down what is drawn on it.
function recorder(w, h) {
  const calls = [];
  const path = [];
  const ctx = new Proxy({}, {
    get: (_, name) => {
      if (name === 'calls') return calls;
      if (name === 'moveTo' || name === 'lineTo') return (x, y) => path.push([x, y]);
      if (name === 'beginPath') return () => { path.length = 0; };
      return (...args) => calls.push([name, ...(name === 'fill' || name === 'stroke' ? [path.map(([x, y]) => [Math.round(x), Math.round(y)])] : args)]);
    },
    set: () => true,
  });
  return { width: w, height: h, getContext: () => ctx, calls };
}

const outline = new CircleOutline(1000);
const frame = { widthM: 2240, heightM: 2240 };

test('the second part dimmed and the line drawn over the picture, at most 4096 points a side', () => {
  const made = [];
  const canvas = (w, h) => { const c = recorder(w, h); made.push(c); return c; };
  const picture = { width: 8192, height: 8192 };
  const out = linePreview(picture, { divider: new Divider({ angleDeg: 0 }), outline, frame }, { canvas });
  assert.equal(out.width, 4096);
  const calls = out.calls.map(([name]) => name);
  assert.deepEqual(calls.filter((n) => ['drawImage', 'fill', 'stroke'].includes(n)), ['drawImage', 'fill', 'stroke', 'stroke'],
    'the picture, the part dimmed, the line twice (its dark edge, then white)');
  const dimmed = out.calls.find(([n]) => n === 'fill')[1];
  assert.ok(dimmed.some(([x]) => x > 2048 + 1000), 'at 0° the line runs north: the second place is east, on the right');
  assert.ok(dimmed.every(([x]) => x >= 2047), 'and nothing west of the centre is dimmed');
});

test('a line by points of one point: no line yet, the picture as it is', () => {
  const out = linePreview({ width: 2000, height: 2000 }, { divider: null, outline, frame }, { canvas: recorder });
  assert.equal(out.width, 2000, 'a small picture keeps its size');
  assert.deepEqual(out.calls.map(([n]) => n).filter((n) => ['drawImage', 'fill', 'stroke'].includes(n)), ['drawImage']);
});
