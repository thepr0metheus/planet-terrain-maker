import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HeightGrid } from '../../web/js/height-grid.js';
import { LocalFrame, LonLat, Mercator, distanceM, metresPerDegree } from '../../web/js/geo.js';
import { FRAME_MARGIN, CaptureError, PlaceCapture, bilinearArray, frameFor, gridFromResponse, pictureMetres, pictureSourceFor, terrariumHeights, tileBudget, zoomFor } from '../../web/js/capture.js';
import { CircleOutline, PolygonOutline } from '../../web/js/outline.js';
import { buildingsSolid } from '../../web/js/buildings.js';
import { weld } from '../../web/js/exporters.js';
import { niceStep, needsPainting } from '../../web/js/styles.js';
import { WORLDS, WORLD_ORDER, mPerDegOf, worldOf } from '../../web/js/worlds.js';

test('a place\'s own frame: metres east and north of its centre, and back', () => {
  const frame = new LocalFrame(43.35, 42.45, metresPerDegree(6378137));
  const { lat, lon } = frame.toLatLon(5000, -3000);
  const back = frame.toXY(lat, lon);
  assert.ok(Math.abs(back.x - 5000) < 1e-6 && Math.abs(back.y + 3000) < 1e-6);
  // a metre east is a metre on the ground (haversine), here and 5 km north
  const east = frame.toLatLon(1000, 5000), west = frame.toLatLon(-1000, 5000);
  assert.ok(Math.abs(distanceM(east.lat, east.lon, west.lat, west.lon, 6378137) - 2000) < 1);
  const box = frame.boxOf(5000, 5000);
  for (const [x, y] of [[-5000, -5000], [5000, 5000], [-5000, 5000]]) {
    const p = frame.toLatLon(x, y);
    assert.ok(p.lat >= box.south - 1e-9 && p.lat <= box.north + 1e-9 && p.lon >= box.west - 1e-9 && p.lon <= box.east + 1e-9);
  }
  assert.throws(() => new LocalFrame(95, 0, 1), RangeError);
});

test('map pixels: Web Mercator and Trek\'s plain degrees', () => {
  assert.deepEqual(Mercator.px(0, 0, 0), { x: 128, y: 128 });
  assert.ok(Math.abs(Mercator.metresPerPx(0, 0) - 156543.03) < 0.01);
  assert.deepEqual(LonLat.px(90, -180, 0), { x: 0, y: 0 });
  assert.deepEqual(LonLat.px(-90, 180, 0), { x: 512, y: 256 }, 'two tiles side by side at zoom 0');
});

test('the frame reaches the margin beyond the outline; a contour\'s frame is centred on its middle', () => {
  const square = frameFor(new CircleOutline(1000));
  assert.equal(square.widthM, square.heightM);
  assert.ok(Math.abs(square.widthM - 2000 * (1 + 2 * FRAME_MARGIN)) < 1e-9);
  const tall = frameFor(new PolygonOutline([[-100, -400], [300, -400], [0, 500]]));
  assert.ok(tall.heightM > tall.widthM);
  assert.ok(tall.widthM >= 600 && tall.heightM >= 1000);
});

test('terrarium pixels are metres; no data reads NaN', () => {
  const rgba = new Uint8ClampedArray([128, 0, 0, 255, 128, 100, 128, 255, 0, 0, 0, 255, 128, 0, 0, 0]);
  const h = terrariumHeights(rgba);
  assert.equal(h[0], 0);
  assert.equal(h[1], 100.5);
  assert.ok(Number.isNaN(h[2]), 'black is no data');
  assert.ok(Number.isNaN(h[3]), 'see-through is no data');
  assert.equal(bilinearArray(Float32Array.from([0, 10, NaN, 30]), 2, 2, 0.5, 0.5), (0 + 10 + 30) / 3);
});

test('the zoom is as fine as wanted, and coarser when the tiles would be too many', () => {
  const few = () => 4;
  assert.equal(zoomFor('mercator', 0, 10, 15, few), 14, '9.6 m a pixel at zoom 14 on the equator');
  assert.equal(zoomFor('mercator', 0, 1, 15, few), 15, 'never past maxZoom');
  const many = (z) => 2 ** z;
  assert.ok(zoomFor('mercator', 0, 10, 15, many) <= 4, 'at most 18 x 18 tiles');
  const moon = mPerDegOf(worldOf('moon'));
  assert.equal(zoomFor('lonlat', 0, 50, 10, few, moon), 9, 'the Moon\'s own degree: 41.6 m a pixel at zoom 9');
});

test('the server\'s grid: its size and box from the headers', () => {
  const bytes = HeightGrid.fill(2, 2, () => 7).toBytes();
  const headers = new Map([['X-Grid-Cols', '2'], ['X-Grid-Rows', '2'], ['X-Grid-Box', '1,2,3,4']]);
  const { heights, box } = gridFromResponse({ get: (k) => headers.get(k) ?? null }, bytes.buffer);
  assert.deepEqual(box, [1, 2, 3, 4]);
  assert.equal(heights.get(1, 1), 7);
  assert.throws(() => gridFromResponse({ get: () => null }, bytes.buffer), CaptureError);
});

test('holes in a grid take the nearest heights; bytes go and come back', () => {
  const grid = new HeightGrid(3, 3, Float32Array.from([1, 1, 1, 1, NaN, NaN, 1, NaN, 5]));
  const filled = grid.filled();
  assert.ok(filled.data.every((h) => Number.isFinite(h)));
  assert.equal(filled.get(1, 1), 1);
  const back = HeightGrid.fromBytes(3, 3, grid.toBytes().buffer);
  assert.ok(Number.isNaN(back.get(1, 1)) && back.get(2, 2) === 5);
  assert.deepEqual(new HeightGrid(2, 2, new Float32Array(4).fill(NaN)).filled().data, new Float32Array(4));
});

test('buildings: a closed box on the ground, only those inside the outline', () => {
  const buildings = [
    { ring: [[0, 0], [20, 0], [20, 10], [0, 10]], height: 12 },
    { ring: [[900, 900], [920, 900], [920, 920]], height: 6 },          // outside the circle
  ];
  const solid = buildingsSolid(buildings, new CircleOutline(500), { mmPerM: 0.1, zMmPerM: 0.1 }, () => 3);
  const { faces } = weld([solid]);
  assert.equal(faces.length / 3, 12, 'one box: 4 walls, roof and floor');
  const tops = [];
  for (let k = 2; k < solid.positions.length; k += 3) tops.push(solid.positions[k]);
  assert.ok(Math.abs(Math.max(...tops) - (3 + 12 * 0.1)) < 1e-6);
  assert.equal(buildingsSolid([buildings[1]], new CircleOutline(500), { mmPerM: 0.1, zMmPerM: 0.1 }, () => 0), null);
});

test('contour steps are 1, 2 or 5 times a power of ten', () => {
  assert.equal(niceStep(3000), 200);
  assert.equal(niceStep(70), 5);
  assert.equal(niceStep(2), 0.1);
});

test('every world has its sources, its map and a start', () => {
  for (const id of WORLD_ORDER) {
    const w = WORLDS[id];
    assert.ok(w.heights.length && w.pictures.length && w.map.layer && w.start, id);
    for (const s of [...w.heights, ...w.pictures]) assert.ok(s.tiles || s.server, `${id}: ${s.id}`);
  }
  assert.throws(() => worldOf('pluto'), RangeError);
  assert.equal(worldOf(undefined).id, 'earth');
});

test('a bigger picture may take more tiles, and the zoom follows', () => {
  assert.deepEqual([2048, 4096, 8192].map(tileBudget), [324, 900, 1600]);
  assert.deepEqual([2048, 8192].map((px) => tileBudget(px, { mostPx: 4096 })), [256, 256], 'a touch device holds a canvas of 16 x 16 tiles');
  const across = (z) => 2 ** (z - 7);                     // 13 km wide region: 64 tiles across at zoom 13
  assert.equal(zoomFor('mercator', 41.6, 46000 / 2048, 17, across, 0, tileBudget(2048)), 11);
  assert.equal(zoomFor('mercator', 41.6, 46000 / 8192, 17, across, 0, tileBudget(8192)), 12);
});

test('the hint says the coarser of the picture\'s share and the source\'s finest', () => {
  const earth = worldOf('earth'), moon = worldOf('moon');
  const esri = pictureSourceFor(earth, 'photo', 46000), s2 = pictureSourceFor(earth, 's2', 46000);
  assert.ok(Math.abs(pictureMetres(earth, esri, 41.6, 46000, 2048) - 46000 / 2048) < 1e-9, 'the picture is the limit');
  assert.ok(pictureMetres(earth, s2, 41.6, 4000, 8192) > 7, 'Sentinel-2 cannot be finer than its zoom 14');
  assert.equal(pictureSourceFor(moon, null, 40000).id, 'kaguya');
  assert.equal(pictureSourceFor(moon, null, 400000).id, 'wac');
  assert.equal(pictureMetres(moon, pictureSourceFor(moon, null, 400000), 0, 400000, 8192), 100, 'WAC is 100 m');
});

test('the photo as it is needs no graphics card', () => {
  assert.equal(needsPainting('photo', {}, null), false);
  assert.equal(needsPainting('photo', { brightness: 0, contrast: 1, saturation: 1 }, { on: false }), false);
  assert.equal(needsPainting('photo', { contrast: 1.2 }, null), true);
  assert.equal(needsPainting('photo', {}, { on: true, levelM: 0 }), true);
  assert.equal(needsPainting('pencil', {}, null), true);
});

test('a tile the server could not get is asked again; one that never comes stops the capture with what to do', async () => {
  const canvas = () => ({ getContext: () => ({ drawImage() {}, getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) }) });
  const box = { south: 43.30, north: 43.31, west: 42.40, east: 42.41 };      // one tile at zoom 10
  const pauses = [];
  const run = (answers) => {
    const asked = [];
    const capture = new PlaceCapture({
      canvas, decode: async () => ({}), wait: async (ms) => { pauses.push(ms); },
      fetchFn: async (url) => {
        asked.push(url);
        const a = answers.shift();
        if (a === 'reset') throw new TypeError('Failed to fetch');
        return { ok: a === 200, status: a, blob: async () => new Blob([]) };
      },
    });
    return { asked, done: capture._stitch('mercator', 'earth-s2-2025', box, 10, null) };
  };
  const first = run([502, 'reset', 200]);
  const stitched = await first.done;
  assert.equal(stitched.width, 256);
  assert.equal(first.asked.length, 3, 'asked again after a 502 and after no answer');
  assert.deepEqual(pauses, [1000, 3000]);
  const never = run([502, 503, 502]);
  await assert.rejects(never.done, (e) => e instanceof CaptureError && /3 times \(502\)/.test(e.message));
  const refused = run([403]);
  await assert.rejects(refused.done, CaptureError);
  assert.equal(refused.asked.length, 1, 'a refusal is not asked again');
});

test('a layer of 512-point tiles (CTX) is asked for the level one below, and its tiles are put in place', async () => {
  const canvas = () => ({ getContext: () => ({ drawImage() {}, getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) }) });
  const asked = [];
  const capture = new PlaceCapture({
    canvas, decode: async () => ({}), wait: async () => {},
    fetchFn: async (url) => { asked.push(url); return { ok: true, status: 200, blob: async () => new Blob([]) }; },
  });
  const box = { south: 18.0, north: 18.3, west: -134.2, east: -133.8 };
  const z = 9;
  const stitched = await capture._stitch('lonlat', 'mars-ctx', box, z, null, 512);
  const nw = LonLat.px(box.north, box.west, z), se = LonLat.px(box.south, box.east, z);
  const across = Math.floor(se.x / 512) - Math.floor(nw.x / 512) + 1, down = Math.floor(se.y / 512) - Math.floor(nw.y / 512) + 1;
  assert.equal(asked.length, across * down);
  assert.ok(asked.every((url) => url.startsWith('/api/tile/mars-ctx/8/')), 'level 8: as fine as zoom 9 of 256-point tiles');
  assert.ok(asked.includes(`/api/tile/mars-ctx/8/${Math.floor(nw.x / 512)}/${Math.floor(nw.y / 512)}`));
  assert.equal(stitched.width, across * 512);
  const corner = stitched.at(box.north, box.west);
  assert.ok(Math.abs(corner.x - (nw.x - Math.floor(nw.x / 512) * 512)) < 1e-9);
});

test('a tile the strict decoder refuses is read as an <img>; one nothing reads leaves its place grey', async () => {
  const canvas = () => ({ getContext: () => ({ drawImage() {}, getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) }) });
  const box = { south: 43.30, north: 43.31, west: 42.40, east: 42.41 };      // one tile at zoom 10
  const run = (asImage) => new PlaceCapture({
    canvas, wait: async () => {},
    fetchFn: async () => ({ ok: true, status: 200, blob: async () => new Blob([]) }),
    decode: async () => { throw new DOMException('The source image could not be decoded.', 'InvalidStateError'); },
    decodeImage: asImage,
  })._stitch('mercator', 'mars-ctx', box, 10, null);
  const read = [];
  await run(async () => { read.push('img'); return {}; });
  assert.deepEqual(read, ['img']);
  await assert.rejects(run(async () => { throw new Error('not a picture'); }), (e) => e instanceof CaptureError && /no tiles/.test(e.message),
    'the only tile unread: the map has nothing here, said as for a missing tile');
});

test('a canvas made to fit the device keeps its shape', async () => {
  const { fitCanvas } = await import('../../web/js/device.js');
  assert.deepEqual(fitCanvas(8192, 6000, 4096), { width: 4096, height: 3000 });
  assert.deepEqual(fitCanvas(2048, 2048, 4096), { width: 2048, height: 2048 }, 'a small one stays');
});
