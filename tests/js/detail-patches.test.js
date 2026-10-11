import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TileFrame } from '../../web/js/tile-frame.js';
import { PatchSurface } from '../../web/js/patch-surface.js';
import { Mercator } from '../../web/js/geo.js';

test('source pixels map back onto the same model frame, including a rotated comparison part', () => {
  const place = { center: { lat: 41.6872, lon: 41.72 }, frame: { widthM: 44318, heightM: 44318 } };
  for (const turn of [0, 90, 235]) {
    const frame = new TileFrame(place, turn);
    for (const uv of [[.5, .5], [.23, .81], [.95, .12]]) {
      const pixel = frame.pixel(...uv, 19), back = frame.modelUv(pixel.x, pixel.y, 19);
      assert.ok(Math.abs(back[0] - uv[0]) < 1e-10 && Math.abs(back[1] - uv[1]) < 1e-10);
    }
  }
});

test('Mercator inverse preserves high-detail tile coordinates near the selected location', () => {
  const p = Mercator.px(41.6872, 41.72, 19), back = Mercator.latLon(p.x, p.y, 19);
  assert.ok(Math.abs(back.lat - 41.6872) < 1e-10 && Math.abs(back.lon - 41.72) < 1e-10);
});

test('a detail patch is cut from terrain triangles even when none of their vertices lie inside it', () => {
  const geometry = { index: { array: new Uint32Array([0, 1, 2, 0, 2, 3]) }, attributes: {
    position: { array: new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1]) },
    normal: { array: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]) },
    uv: { array: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]) },
  } };
  const surface = new PatchSurface(geometry, { start: 0, count: 6 });
  const frame = { pixel: (u, v) => ({ x: u * 100, y: v * 100 }), bounds: () => ({ left: .25, right: .75, top: .25, bottom: .75 }) };
  const patch = surface.patch(frame, 25, 25, 19, 50);
  assert.ok(patch.positions.length > 0);
  for (let i = 0; i < patch.positions.length; i += 3) {
    assert.ok(patch.positions[i] >= .25 && patch.positions[i] <= .75);
    assert.ok(patch.positions[i + 2] >= .25 && patch.positions[i + 2] <= .75);
    assert.ok(Math.abs(patch.positions[i + 1] - .001) < 1e-7, 'same ground plane, with only the anti-z-fighting offset');
  }
  for (const uv of patch.uvs) assert.ok(uv >= 1 / 52 - 1e-7 && uv <= 51 / 52 + 1e-7);
});
