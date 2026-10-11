// A viewer's own XYZ picture source for the 3D model. History is runtime data on the server;
// a place keeps the picture and its credit. Tiles are read directly, so the service must allow CORS.
import { LayerDescription } from './layer-description.js';

export class CustomLayer {
  constructor({ name = '', url = '', credit = '', maxZoom = null, key = null } = {}) {
    url = String(url).trim();
    if (url.length > 4096 || !['{z}', '{x}', '{y}'].every((key) => url.includes(key)) ||
      /[{}]/.test(url.replace(/\{[zxy]\}/g, ''))) {
      throw new Error('Use an XYZ tile URL with {z}, {x} and {y}.');
    }
    let parsed;
    try { parsed = new URL(url.replace(/\{[zxy]\}/g, '0')); } catch {
      throw new Error('The tile URL must be a valid HTTPS address.');
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash ||
      /\{/.test(url.split('/').slice(0, 3).join('/'))) {
      throw new Error('Use HTTPS without a login, password or fragment in the tile URL.');
    }
    const automatic = maxZoom === null || maxZoom === '' || maxZoom === 'auto';
    if (!automatic && (typeof maxZoom === 'boolean' || !Number.isInteger(Number(maxZoom)) || Number(maxZoom) < 0 || Number(maxZoom) > 22)) {
      throw new Error('The last tile zoom must be a whole number from 0 to 22.');
    }
    this.id = 'custom';
    this.key = key;
    this.name = String(name).trim().slice(0, 120);
    this.userCredit = String(credit).trim().slice(0, 600);
    this._host = parsed.hostname;
    this.url = url;
    this.zoomLimit = automatic ? null : Number(maxZoom);
    this._description = null;
    this.tiles = 'custom';
  }

  tileUrl(z, x, y) {
    return this.url.replace(/\{([zxy])\}/g, (_, key) => ({ z, x, y })[key]);
  }

  get label() { return this.name || this._description?.name || this._host; }
  get credit() { return this.userCredit || this._description?.credit || this._host; }
  get maxZoom() { return Math.min(this.zoomLimit ?? 22, this._description?.maxZoom ?? 22); }
  get probeZoom() { return this.zoomLimit === null && this._description?.maxZoom == null; }

  async describe(fetchFn, signal) {
    this._description = await LayerDescription.read(this.url, fetchFn, signal);
  }

  availableZoom(wanted) {
    const described = this._description?.zooms;
    if (!described?.length) return wanted;
    const levels = described.filter((z) => z <= this.maxZoom);
    return levels.filter((z) => z <= wanted).at(-1) ?? levels[0] ?? null;
  }

  get metadata() {
    return { pictureCredit: this.credit, customPicture: true, ...(this.key ? { pictureSourceKey: this.key, pictureMaxZoom: this.maxZoom } : {}) };
  }

  toJSON() {
    return { name: this.name, url: this.url, credit: this.userCredit, maxZoom: this.zoomLimit };
  }
}

export class CustomLayerStore {
  constructor({ fetchFn = (...args) => fetch(...args), legacyStorage = () => globalThis.localStorage } = {}) {
    this._fetch = fetchFn;
    this._legacyStorage = legacyStorage;
    this._migration = null;
  }

  async history() {
    this._migration ??= this._importLegacy().catch((error) => { this._migration = null; throw error; });
    await this._migration;
    const entries = await this._request('GET');
    if (!Array.isArray(entries)) throw new Error('The saved picture sources could not be read.');
    return { layers: entries.map((entry) => new CustomLayer(entry)), invalid: false };
  }

  async _importLegacy() {
    let storage, entries;
    try {
      storage = this._legacyStorage();
      if (!storage) return;
      const history = storage.getItem('ptm.customLayers'), one = storage.getItem('ptm.customLayer');
      entries = history ? JSON.parse(history) : one ? [JSON.parse(one)] : [];
      if (!Array.isArray(entries)) return;
      entries = entries.map((entry) => new CustomLayer(entry));
    } catch { return; } // Unreadable legacy data is left in place, never silently erased.
    for (const layer of entries.reverse()) await this._request('POST', layer);
    if (entries.length) {
      storage.removeItem('ptm.customLayers');
      storage.removeItem('ptm.customLayer');
    }
  }

  async keep(layer) {
    const entries = await this._request('POST', layer);
    layer.key = entries.find((entry) => entry.url === layer.url)?.key ?? null;
    return entries;
  }
  forget(url) { return this._request('DELETE', { url }); }

  async _request(method, data = null) {
    const response = await this._fetch('/api/picture-sources', { method, cache: 'no-store',
      ...(data ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {}) });
    if (!response.ok) throw new Error(method === 'GET' ? 'The saved picture sources could not be read.' : 'The picture sources could not be saved.');
    return response.json();
  }
}
