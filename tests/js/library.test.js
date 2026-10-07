import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Library } from '../../web/js/library.js';
import { TerrainModel } from '../../web/js/model.js';
import { Place } from '../../web/js/capture.js';
import { HeightGrid } from '../../web/js/height-grid.js';
import { CircleOutline } from '../../web/js/outline.js';

const canvas = (side) => ({ width: side, height: side });

// The library's server in memory: a model and its files to GET, a model to PUT or POST as the form
// the page sends.
function server() {
  const models = {};
  let next = 1;
  const fetchFn = async (url, { method = 'GET', body } = {}) => {
    const file = url.match(/^\/api\/models\/([^/]+)\/files\/(.+)$/);
    const one = url.match(/^\/api\/models\/([^/]+)$/);
    if (method === 'GET' && file) {
      const bytes = models[file[1]]?.files[decodeURIComponent(file[2])];
      return bytes ? new Response(bytes) : Response.json({}, { status: 404 });
    }
    if (method === 'GET' && one) return Response.json({ ...models[one[1]].meta, id: one[1] });
    const id = method === 'PUT' ? one[1] : `m${next++}`;
    const files = {};
    for (const [name, value] of body.entries()) if (name !== 'meta') files[name] = new Uint8Array(await value.arrayBuffer());
    models[id] = { meta: JSON.parse(body.get('meta')), files };
    return Response.json({ id });
  };
  return { models, library: new Library(fetchFn) };
}

// A model saved with a picture of 8192 points, its JPEG the bytes 1 2 3.
async function saved({ models, library }) {
  const place = new Place({ world: 'earth', center: { lat: 43.35, lon: 42.44 }, frame: { widthM: 2240, heightM: 2240 },
    outline: new CircleOutline(1000), heights: HeightGrid.fill(5, 5, () => 1), picture: canvas(8192), name: 'Elbrus' });
  const model = new TerrainModel({ places: [place], name: 'Elbrus' });
  await library.save(model, null, async () => new Uint8Array([1, 2, 3]));
  assert.deepEqual([...models[model.id].files['place-0.jpg']], [1, 2, 3]);
  return model.id;
}

const madeAgain = (bytes, made = []) => async (picture) => {
  made.push(picture.width);
  return new Uint8Array(bytes);
};

test('a tablet saves a picture back as its file, never as the smaller copy it shows', async () => {
  const at = server();
  const id = await saved(at);
  const onTablet = await at.library.open(id, async () => canvas(4096));    // the device holds 4096
  assert.ok(onTablet.places[0].reduced);
  const made = [];
  await at.library.save(onTablet, null, madeAgain([9], made));
  assert.deepEqual(made, [], 'no picture made again from the smaller canvas');
  assert.deepEqual([...at.models[id].files['place-0.jpg']], [1, 2, 3], 'the file is the full one still');
  assert.deepEqual(at.models[id].meta.places[0].picture, { file: 'place-0.jpg', width: 8192, height: 8192 });
});

test('a copy takes the picture\'s file too, and its next save reads the file from the copy', async () => {
  const at = server();
  const id = await saved(at);
  const model = await at.library.open(id, async () => canvas(4096));
  model.id = null;                                     // "Copy" on the model screen
  await at.library.save(model, null, madeAgain([9]));
  const copy = model.id;
  assert.notEqual(copy, id);
  assert.deepEqual([...at.models[copy].files['place-0.jpg']], [1, 2, 3]);
  delete at.models[id];                                // the model copied, removed
  await at.library.save(model, null, madeAgain([9]));
  assert.deepEqual([...at.models[copy].files['place-0.jpg']], [1, 2, 3]);
});

test('with the file gone, a full picture is made again, and a smaller one is not saved', async () => {
  const at = server();
  const id = await saved(at);
  const small = await at.library.open(id, async () => canvas(4096));
  const full = await at.library.open(id, async () => canvas(8192));
  delete at.models[id].files['place-0.jpg'];
  await assert.rejects(at.library.save(small, null, madeAgain([9])), /place-0\.jpg did not come/);
  assert.equal(at.models[id].files['place-0.jpg'], undefined, 'nothing written over it');
  const made = [];
  await at.library.save(full, null, madeAgain([7], made));
  assert.deepEqual(made, [8192]);
  assert.deepEqual([...at.models[id].files['place-0.jpg']], [7]);
});
