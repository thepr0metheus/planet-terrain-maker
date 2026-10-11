import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CustomLayer, CustomLayerStore } from '../../web/js/custom-layer.js';

const source = (id, extra = {}) => new CustomLayer({ url: `https://tiles.example.org/${id}/{z}/{x}/{y}.png`, ...extra });

function server() {
  let entries = [];
  const fetchFn = async (path, { method = 'GET', body } = {}) => {
    assert.equal(path, '/api/picture-sources');
    const data = body ? JSON.parse(body) : null;
    if (method === 'POST') entries = [data, ...entries.filter((e) => e.url !== data.url)];
    if (method === 'DELETE') entries = entries.filter((e) => e.url !== data.url);
    return Response.json(entries);
  };
  return { fetchFn };
}

test('client and server source validation use the same cases', () => {
  const cases = JSON.parse(readFileSync(new URL('../fixtures/picture-sources.json', import.meta.url)));
  for (const entry of cases) {
    if (entry.valid) assert.doesNotThrow(() => new CustomLayer(entry.source));
    else assert.throws(() => new CustomLayer(entry.source));
  }
});

test('two browser clients share server history, newest first and with one entry per URL', async () => {
  const data = server();
  const first = new CustomLayerStore({ ...data, legacyStorage: () => null });
  const a = source('photo'), b = source('topo');
  await first.keep(a); await first.keep(b); await first.keep(source('photo', { name: 'Updated name', maxZoom: 16 }));
  const second = new CustomLayerStore({ ...data, legacyStorage: () => null });
  const history = await second.history();
  assert.deepEqual(history.layers.map((s) => s.url), [a.url, b.url]);
  assert.equal(history.layers[0].name, 'Updated name');
  assert.equal(history.layers[0].zoomLimit, 16);
});

test('legacy browser URLs migrate to the server and are removed only after successful writes', async () => {
  const data = server(), a = source('legacy');
  const values = new Map([['ptm.customLayer', JSON.stringify(a)]]);
  const legacyStorage = () => ({ getItem: (key) => values.get(key) ?? null, removeItem: (key) => values.delete(key) });
  const store = new CustomLayerStore({ ...data, legacyStorage });
  assert.equal((await store.history()).layers[0].url, a.url);
  assert.equal(values.size, 0);
  const other = new CustomLayerStore({ ...data, legacyStorage: () => null });
  assert.equal((await other.history()).layers[0].url, a.url);
});

test('a failed migration keeps the legacy link rather than claiming it was saved', async () => {
  const a = source('legacy'), raw = JSON.stringify(a);
  const legacyStorage = () => ({ getItem: (key) => key === 'ptm.customLayer' ? raw : null, removeItem() { throw new Error('must not erase'); } });
  const store = new CustomLayerStore({ fetchFn: async () => new Response('', { status: 503 }), legacyStorage });
  await assert.rejects(store.history());
  assert.equal(legacyStorage().getItem('ptm.customLayer'), raw);
});

test('forgetting one server URL retains all other sources', async () => {
  const store = new CustomLayerStore({ ...server(), legacyStorage: () => null });
  const a = source('photo'), b = source('topo');
  await store.keep(a); await store.keep(b); await store.forget(a.url);
  assert.deepEqual((await store.history()).layers.map((s) => s.url), [b.url]);
});

test('a server read failure is an error, not an empty source history', async () => {
  const store = new CustomLayerStore({ fetchFn: async () => new Response('', { status: 503 }), legacyStorage: () => null });
  await assert.rejects(store.history(), /could not be read/);
});
