// The saved models, through the server (app/library.py): the list, one model with its files,
// saving, renaming and removing.

import { TerrainModel } from './model.js';
import { t } from './i18n.js';

export class LibraryError extends Error {}

async function answered(response, what) {
  if (response.ok) return response;
  const said = await response.json().catch(() => ({}));
  throw new LibraryError(said.error ? `${t(what)}: ${t(said.error)}` : `${t(what)} (${response.status})`);
}

export class Library {
  constructor(fetchFn = (...a) => fetch(...a)) {
    this._fetch = fetchFn;
  }

  async list() {
    return (await answered(await this._fetch('/api/models'), 'The list did not come')).json();
  }

  fileUrl(id, name) {
    return `/api/models/${encodeURIComponent(id)}/files/${encodeURIComponent(name)}`;
  }

  // The model with this id, ready to show. picture(url) -> Promise<canvas>.
  async open(id, picture) {
    const meta = await (await answered(await this._fetch(`/api/models/${encodeURIComponent(id)}`), 'The model did not come')).json();
    return TerrainModel.fromLibrary(meta, (name) => this._file(id, name), (name) => picture(this.fileUrl(id, name)));
  }

  async _file(id, name) {
    return (await answered(await this._fetch(this.fileUrl(id, name)), `${name} did not come`)).arrayBuffer();
  }

  // Save a model: a new one, or again under its id. Returns the saved meta.
  async save(model, thumb, toJpeg) {
    const { meta, files } = await model.toLibrary(thumb, toJpeg);
    const form = new FormData();
    form.append('meta', JSON.stringify(meta));
    for (const [name, body] of Object.entries(files)) form.append(name, body instanceof Blob ? body : new Blob([body]), name);
    const url = model.id ? `/api/models/${encodeURIComponent(model.id)}` : '/api/models';
    const response = await this._fetch(url, { method: model.id ? 'PUT' : 'POST', body: form });
    const saved = await (await answered(response, 'Not saved')).json();
    model.id = saved.id;
    // the pictures live in the saved model's files now: the next save sends them from there
    for (const [i, place] of model.places.entries()) {
      const { file, width, height } = meta.places[i].picture;
      place.stored = { width, height, bytes: () => this._file(saved.id, file) };
    }
    return saved;
  }

  // A copy of a saved model under a new id and `name`: its meta.
  async copy(id, name) {
    const response = await this._fetch(`/api/models/${encodeURIComponent(id)}/copy`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
    });
    return (await answered(response, 'Not copied')).json();
  }

  // A new name for a saved model; places: a new name for each of its places, or null to leave them.
  async rename(id, name, places = null) {
    const response = await this._fetch(`/api/models/${encodeURIComponent(id)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(places ? { name, places } : { name }),
    });
    return (await answered(response, 'Not renamed')).json();
  }

  async remove(id) {
    await answered(await this._fetch(`/api/models/${encodeURIComponent(id)}`, { method: 'DELETE' }), 'Not removed');
  }
}
