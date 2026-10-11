import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DetailTileLoader, MissingDetailTile } from '../../web/js/detail-tile-loader.js';

const source = { key: 'a'.repeat(64), tileUrl: (z, x, y) => `https://tiles.example.org/${z}/${x}/${y}.png` };
const signal = new AbortController().signal;

test('a persisted tile is decoded without accessing its original source or writing it again', async () => {
  const requests = [], image = {};
  const loader = new DetailTileLoader({
    fetchFn: async (path) => { requests.push(path); return new Response('saved image'); },
    capture: { _tile: () => assert.fail('must not fetch upstream'), _tilePicture: async (blob) => {
      assert.equal(await blob.text(), 'saved image'); return image;
    } },
  });
  assert.equal(await loader.tile(source, 19, 12, 14, signal), image);
  assert.deepEqual(requests, [`/api/picture-sources/${source.key}/tiles/19/12/14`]);
});

test('only upstream 404 reports missing detail, other source failures remain errors', async () => {
  for (const status of [404, 401, 500]) {
    let writes = 0;
    const loader = new DetailTileLoader({
      fetchFn: async (_path, options) => { if (options.method === 'PUT') writes++; return new Response('', { status: 404 }); },
      capture: { _tile: async () => new Response('', { status }), _tilePicture: () => assert.fail('no image to decode') },
    });
    await assert.rejects(loader.tile(source, 19, 12, 14, signal), (error) => {
      assert.equal(error instanceof MissingDetailTile, status === 404);
      if (status === 404) assert.equal(error.z, 19);
      return true;
    });
    assert.equal(writes, 0);
  }
});

test('failed server persistence closes the decoded image and reports the failure', async () => {
  let closed = 0;
  const loader = new DetailTileLoader({
    fetchFn: async (_path, options) => new Response('', { status: options.method === 'PUT' ? 503 : 404 }),
    capture: { _tile: async () => new Response('image'), _tilePicture: async () => ({ close: () => closed++ }) },
  });
  await assert.rejects(loader.tile(source, 19, 12, 14, signal), /could not be saved/);
  assert.equal(closed, 1);
});
