import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CustomPicture } from '../../web/js/custom-picture.js';
import { TerrainModel } from '../../web/js/model.js';
import { Place } from '../../web/js/capture.js';
import { HeightGrid } from '../../web/js/height-grid.js';
import { CircleOutline } from '../../web/js/outline.js';

const url = 'https://tiles.example.org/{z}/{x}/{y}.png';

// Only the form's DOM boundary is faked; these tests exercise ownership of asynchronous results.
class Form {
  constructor() { this.elements = new Map(); this.body = { append() {} }; }
  addEventListener() {}
  getElementById(id) {
    if (!this.elements.has(id)) this.elements.set(id, { id, value: '', hidden: false, disabled: false, textContent: '',
      addEventListener() {}, setAttribute() {}, removeAttribute() {}, replaceChildren(...children) { this.value = String(children[0]?.value ?? ''); } });
    return this.elements.get(id);
  }
}

function setup(capture) {
  const form = new Form();
  globalThis.document = form;
  globalThis.window = { addEventListener() {} };
  globalThis.Dom = { el: (_, attrs) => attrs };
  let changes = 0;
  const control = new CustomPicture({ capture, onChanged: () => { changes += 1; },
    store: { read: () => ({ layer: null, invalid: false }), keep() {} } });
  const show = control.show.bind(control);
  control.show = (model) => { show(model); form.getElementById('custom-layer-url').value = url; };
  return { form, control, changes: () => changes };
}

function place(name, world = 'earth') {
  return new Place({ name, world, center: { lat: 41.7, lon: 44.8 }, frame: { widthM: 2240, heightM: 2240 },
    outline: new CircleOutline(1000), heights: HeightGrid.fill(3, 3, () => 100), picture: { width: 2048, height: 2048 },
    sources: { heights: 'Height source', picture: 'Original' } });
}

test('a custom picture changes only the chosen Earth place, keeping both places and their arrangement', async () => {
  const picture = { width: 2048, height: 2048 }, asked = [];
  const at = setup({ pictureFor: async (place) => { asked.push(place); return picture; } });
  const a = place('First'), b = place('Second');
  const model = new TerrainModel({ places: [a, b], compare: { turns: [90, 180], raises: [100, 200] } });
  const compare = structuredClone(model.compare), aPicture = a.picture;
  at.control.show(model);
  at.form.getElementById('custom-layer-place').value = '1';
  await at.control.apply();
  assert.deepEqual(asked, [b]);
  assert.equal(a.picture, aPicture);
  assert.equal(b.picture, picture);
  assert.deepEqual(model.compare, compare);
  assert.equal(at.changes(), 1);
});

test('a picture that finishes after another model opens cannot change either model', async () => {
  let finish, signal;
  const at = setup({ pictureFor: (_, __, options) => { signal = options.signal; return new Promise((resolve) => { finish = resolve; }); } });
  const first = new TerrainModel({ places: [place('First')] }), second = new TerrainModel({ places: [place('Second')] });
  const original = first.places[0].picture;
  at.control.show(first);
  const loading = at.control.apply();
  await Promise.resolve();
  at.control.show(second);
  assert.equal(signal.aborted, true);
  finish({ width: 2048, height: 2048 });
  await loading;
  assert.equal(first.places[0].picture, original);
  assert.equal(at.changes(), 0);
  assert.equal(at.form.getElementById('custom-layer-apply').disabled, false);
});

test('a failed custom picture retains its original stored file and reports the failure', async () => {
  const at = setup({ pictureFor: async () => { throw new Error('The service failed'); } });
  const p = place('First'); p.stored = { width: 8192, height: 8192, bytes: async () => new Uint8Array([1]) };
  const original = p.picture, stored = p.stored;
  at.control.show(new TerrainModel({ places: [p] }));
  await at.control.apply();
  assert.equal(p.picture, original);
  assert.equal(p.stored, stored);
  assert.equal(at.changes(), 0);
  assert.equal(at.form.getElementById('custom-layer-state').textContent, 'The service failed');
  assert.equal(at.form.getElementById('custom-layer-apply').disabled, false);
});

test('a mixed-world model offers only its Earth place as the custom picture target', () => {
  const at = setup({ pictureFor: async () => { throw new Error('Not requested'); } });
  at.control.show(new TerrainModel({ places: [place('Moon', 'moon'), place('Earth')] }));
  assert.equal(at.form.getElementById('custom-layer-place').value, '1');
  assert.equal(at.form.getElementById('custom-layer-place-label').hidden, true);
  assert.equal(at.form.getElementById('custom-layer').hidden, false);
  at.control.show(new TerrainModel({ places: [place('Moon', 'moon')] }));
  assert.equal(at.form.getElementById('custom-layer').hidden, true);
});
