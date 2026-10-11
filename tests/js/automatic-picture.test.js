import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CustomLayer } from '../../web/js/custom-layer.js';
import { LayerDescription } from '../../web/js/layer-description.js';
import { PictureDetail } from '../../web/js/picture-detail.js';
import { PlaceCapture, CaptureError } from '../../web/js/capture.js';
import { LocalFrame } from '../../web/js/geo.js';
import { WORLDS, mPerDegOf } from '../../web/js/worlds.js';

test('automatic custom settings use the actual host; overrides survive browser serialization', () => {
  const auto = new CustomLayer({ url: 'https://tiles.example.org/{z}/{x}/{y}.png', maxZoom: '' });
  assert.equal(auto.label, 'tiles.example.org');
  assert.equal(auto.credit, 'tiles.example.org');
  assert.equal(auto.zoomLimit, null);
  assert.equal(auto.probeZoom, true);
  const manual = new CustomLayer({ url: auto.url, name: 'My layer', credit: 'Mapping agency', maxZoom: 16 });
  const restored = new CustomLayer(JSON.parse(JSON.stringify(manual)));
  assert.equal(restored.label, 'My layer');
  assert.equal(restored.credit, 'Mapping agency');
  assert.equal(restored.maxZoom, 16);
  assert.equal(restored.probeZoom, false);
});

test('a blocked service description falls back to the host without inventing a zoom limit', async () => {
  const source = new CustomLayer({ url: 'https://tiles.example.org/wmts/map/grid/{z}/{x}/{y}.png' });
  await source.describe(async () => { throw new TypeError('CORS blocked'); });
  assert.equal(source.label, 'tiles.example.org');
  assert.equal(source.probeZoom, true);
  const stopped = new AbortController(); stopped.abort();
  await assert.rejects(LayerDescription.read(source.url, async () => { throw new DOMException('Stopped', 'AbortError'); }, stopped.signal), { name: 'AbortError' });
});

test('automatic detail follows source pixels and the device limit instead of always making 8192', () => {
  assert.equal(PictureDetail.pixels(2000, 10, 8192), 512);
  assert.equal(PictureDetail.pixels(40000, 10, 8192), 4096);
  assert.equal(PictureDetail.pixels(100000, 1, 8192), 8192);
  assert.equal(PictureDetail.pixels(100000, 1, 4096), 4096);
  assert.equal(PictureDetail.pixels(100000, 1, 2048), 2048);
});

test('a WMTS layer with sparse levels uses its own available levels and honours a manual ceiling', () => {
  const source = new CustomLayer({ url: 'https://tiles.example.org/wmts/map/grid/{z}/{x}/{y}.png' });
  source._description = { name: 'Map', maxZoom: 16, zooms: [12, 14, 16] };
  assert.equal(source.availableZoom(15), 14);
  assert.equal(source.availableZoom(19), 16);
  assert.equal(source.availableZoom(8), 12);
  source.zoomLimit = 13;
  assert.equal(source.availableZoom(15), 12);
  source.zoomLimit = 10;
  assert.equal(source.availableZoom(15), null);
});

test('automatic region images never upscale past the region API\'s 4096-pixel limit', async () => {
  const world = WORLDS.earth, local = new LocalFrame(0, 0, mPerDegOf(world));
  const frame = { widthM: 1000000, heightM: 500000 }, box = local.boxOf(frame.widthM / 2, frame.heightM / 2);
  const capture = new PlaceCapture({
    canvas: (width, height) => ({ width, height, getContext: () => ({ drawImage() {}, fillRect() {} }) }),
    decode: async () => ({ width: 4096, height: 2048 }),
    fetchFn: async () => new Response('picture'),
  });
  const picture = await capture._picture(world, { server: '/picture', nativeM: 100 }, local, frame, box, 1000000, 'auto', null, 8192);
  assert.equal(picture.width, 4096);
  assert.equal(picture.height, 2048);
});

test('an undescribed XYZ source lowers zoom only for missing levels, then fetches the selected region', async () => {
  const source = new CustomLayer({ url: 'https://tiles.example.org/{z}/{x}/{y}.png' });
  const asked = [];
  const capture = new PlaceCapture({
    canvas: (width, height) => ({ width, height, getContext: () => ({ drawImage() {}, fillRect() {} }) }),
    decode: async () => ({ width: 256, height: 256 }),
    fetchFn: async (url) => { asked.push(url); const z = Number(new URL(url).pathname.split('/')[1]); return new Response('image', { status: z > 16 ? 404 : 200 }); },
  });
  const place = { world: 'earth', center: { lat: 41.7151, lon: 44.8271 }, frame: { widthM: 2240, heightM: 1120 }, picture: { width: 8192, height: 4096 } };
  const picture = await capture.pictureFor(place, source);
  assert.ok(asked.some((url) => Number(new URL(url).pathname.split('/')[1]) > 16));
  assert.ok(asked.some((url) => Number(new URL(url).pathname.split('/')[1]) === 16));
  assert.equal(picture.width, 8192, 'an existing model retains its selected picture size');
  assert.equal(picture.height, 4096);
});

test('automatic zoom does not disguise CORS or server failures as coarser available imagery', async () => {
  const source = new CustomLayer({ url: 'https://tiles.example.org/{z}/{x}/{y}.png' });
  for (const fetchFn of [async () => { throw new TypeError('CORS blocked'); }, async () => new Response('', { status: 503 })]) {
    const capture = new PlaceCapture({ fetchFn, wait: async () => {} });
    await assert.rejects(capture._availableZoom(source, { south: 41.7, north: 41.8, west: 44.8, east: 44.9 }, 19, null), CaptureError);
  }
});
