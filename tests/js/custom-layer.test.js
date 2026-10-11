import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CustomLayer, CustomLayerStore } from '../../web/js/custom-layer.js';
import { PlaceCapture, CaptureError } from '../../web/js/capture.js';

const url = 'https://tiles.example.org/{z}/{x}/{y}.png';

test('a custom XYZ layer expands all coordinates and keeps its credit as plain text', () => {
  const layer = new CustomLayer({ url, credit: '<img src=x onerror=alert(1)>&', maxZoom: 16 });
  assert.equal(layer.tileUrl(14, 10232, 6099), 'https://tiles.example.org/14/10232/6099.png');
  assert.equal(layer.maxZoom, 16);
  assert.equal(layer.credit, '<img src=x onerror=alert(1)>&');
});

test('a custom layer refuses unusable templates, credentials and invalid zoom limits', () => {
  for (const bad of [url.replace('{x}', 'x'), url.replace('{z}', '{s}'), 'http://tiles.example.org/{z}/{x}/{y}',
    'https://user:password@tiles.example.org/{z}/{x}/{y}', `${url}#fragment`, 'https://{x}.example.org/{z}/{x}/{y}']) {
    assert.throws(() => new CustomLayer({ url: bad }), Error, bad);
  }
  for (const maxZoom of [-1, 23, 2.5, 'not a number']) assert.throws(() => new CustomLayer({ url, maxZoom }));
});

test('a custom picture uses the captured frame and URL, without cookies or new heights', async () => {
  const layer = new CustomLayer({ url, name: 'My map', credit: 'Example mapping agency', maxZoom: 16 });
  const asked = [], drawn = [];
  const capture = new PlaceCapture({
    canvas: (width, height) => ({ width, height, getContext: () => ({ fillRect() {}, drawImage: (...args) => drawn.push(args) }) }),
    decode: async () => ({ width: 256, height: 256 }),
    fetchFn: async (url, options) => { asked.push({ url, options }); return new Response(new Blob(['picture'], { type: 'image/jpeg' })); },
  });
  const place = { world: 'earth', center: { lat: 41.7151, lon: 44.8271 }, frame: { widthM: 2240, heightM: 1120 },
    picture: { width: 32, height: 16 } };
  const picture = await capture.pictureFor(place, layer);
  assert.ok(asked.length > 0);
  assert.ok(asked.every((r) => r.url.startsWith('https://tiles.example.org/') && r.options.mode === 'cors' && r.options.credentials === 'omit'));
  assert.ok(drawn.length > 0);
  assert.equal(picture.width, 32);
  assert.equal(picture.height, 16);
  assert.deepEqual(place.picture, { width: 32, height: 16 }, 'acquisition does not change a place before all tiles arrive');
});

test('a custom service blocked by CORS or returning no tiles stops capture with an explicit error', async () => {
  const layer = new CustomLayer({ url });
  const canvas = () => ({ getContext: () => ({ drawImage() {} }) });
  const box = { south: 43.30, north: 43.31, west: 42.40, east: 42.41 };
  for (const fetchFn of [async () => { throw new TypeError('Failed to fetch'); }, async () => new Response('', { status: 404 })]) {
    const capture = new PlaceCapture({ canvas, fetchFn, wait: async () => {} });
    await assert.rejects(capture._stitch('mercator', 'custom', box, 10, null, 256, layer.tileUrl.bind(layer)),
      (e) => e instanceof CaptureError && e.message.includes('CORS'));
  }
});

test('a custom capture with one missing tile cannot silently save a partly grey picture', async () => {
  const layer = new CustomLayer({ url });
  let asked = 0;
  const capture = new PlaceCapture({
    canvas: () => ({ getContext: () => ({ drawImage() {} }) }), decode: async () => ({}),
    fetchFn: async () => new Response('', { status: asked++ === 0 ? 404 : 200 }),
  });
  const box = { south: 43.30, north: 43.40, west: 42.40, east: 42.80 };
  await assert.rejects(capture._stitch('mercator', 'custom', box, 10, null, 256, layer.tileUrl.bind(layer)),
    (e) => e instanceof CaptureError && e.message.includes('CORS'));
});
