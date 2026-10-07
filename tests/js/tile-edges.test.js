import { test } from 'node:test';
import assert from 'node:assert/strict';

import { borderedPicture } from '../../web/js/tile-edges.js';

// A 2 x 2 grey tile whose pixels are first, first + 1 (the top row), first + 2,
// first + 3 (the bottom row).
function tile(first, size = 2) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) data.set([first + i, first + i, first + i, 255], i * 4);
  return { width: size, height: size, data };
}
const greys = (picture) => Array.from({ length: picture.width * picture.height }, (_, i) => picture.data[i * 4]);

test('the border comes from the neighbours: each edge from the pixels that touch it', () => {
  const out = borderedPicture(tile(100), {
    n: tile(10), s: tile(20), w: tile(30), e: tile(40),
    nw: tile(50), ne: tile(60), sw: tile(70), se: tile(80),
  });
  assert.equal(out.width, 4);
  assert.equal(out.height, 4);
  assert.deepEqual(greys(out), [
    53, 12, 13, 62,     // the bottom rows of the tiles above
    31, 100, 101, 40,   // the right column of the west tile, the tile, the left column of the east one
    33, 102, 103, 42,
    71, 20, 21, 80,     // the top rows of the tiles below
  ]);
  assert.ok([...out.data].every((v, i) => i % 4 !== 3 || v === 255), 'alpha is copied');
});

test('without neighbours the tile\'s own edge is repeated, as the browser would draw it', () => {
  assert.deepEqual(greys(borderedPicture(tile(100), {})), [
    100, 100, 101, 101,
    100, 100, 101, 101,
    102, 102, 103, 103,
    102, 102, 103, 103,
  ]);
  // with only the north tile: the north corners repeat its row, the rest the tile's own edge
  assert.deepEqual(greys(borderedPicture(tile(100), { n: tile(10) })).slice(0, 4), [12, 12, 13, 13]);
});

test('a neighbour of another size counts as missing', () => {
  const out = borderedPicture(tile(100), { w: tile(30, 3), nw: tile(50, 3) });
  assert.deepEqual(greys(out).slice(0, 8), [100, 100, 101, 101, 100, 100, 101, 101]);
});
