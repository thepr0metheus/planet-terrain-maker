// The search on the map screen: names of places on Earth from the server (Nominatim), and on the
// Moon, Mars and Venus from the IAU's lists the page carries (place-names.js). While its field is
// empty it lists the places last found on this device (recent-places.js) and, on the other worlds,
// the ten largest named ones: something to pick from before typing.

import { PlaceNames } from './place-names.js';
import { RecentPlaces } from './recent-places.js';
import { WORLDS } from './worlds.js';
import { language, t } from './i18n.js';

const WAIT_MS = 350;

export class SearchBox {
  // input, results: the field and the list under it. world(): the world on the map now.
  // onPick({ name, lat, lon, widthM }): a place was chosen.
  constructor({ input, results, world, onPick, fetchFn = (...a) => fetch(...a), recent = new RecentPlaces() }) {
    this._input = input;
    this._results = results;
    this._world = world;
    this._onPick = onPick;
    this._fetch = fetchFn;
    this._timer = null;
    this._asked = 0;
    this._found = [];
    this._recent = recent;
    this._names = {};
    for (const id of Object.keys(WORLDS)) {
      const w = WORLDS[id];
      if (w.names !== 'nominatim') {
        this._names[id] = new PlaceNames(() => this._fetch(w.names).then((r) => r.json()), w.radiusM);
      }
    }
    input.addEventListener('input', () => {
      clearTimeout(this._timer);
      if (input.value.trim().length < 2) this.suggest();
      else this._timer = setTimeout(() => this.search(), WAIT_MS);
    });
    for (const type of ['focus', 'click']) {
      input.addEventListener(type, () => {
        if (input.value.trim().length < 2) this.suggest();
      });
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        clearTimeout(this._timer);
        if (this._found.length && this._shownFor === input.value.trim()) this._pick(this._found[0]);
        else this.search().then(() => this._found.length && this._pick(this._found[0]));
      } else if (e.key === 'Escape') {
        this.close();
      }
    });
    document.addEventListener('pointerdown', (e) => {
      if (!results.contains(e.target) && e.target !== input) this.close();
    });
  }

  // The world changed: what was found is for another world.
  reset() {
    this._input.value = '';
    this.close();
  }

  close() {
    this._results.hidden = true;
    this._found = [];
  }

  // While the field is empty: the places last found here, and the world's largest named ones.
  async suggest() {
    const asked = ++this._asked;
    const world = this._world();
    const recent = this._recent.list(world);
    let largest = [];
    try {
      largest = this._names[world] ? (await this._names[world].largest(10)).map((p) => this._ofName(p)) : [];
    } catch {
      // the list did not come: the recent places alone
    }
    if (asked !== this._asked || this._input.value.trim().length >= 2) return;
    this._found = [];
    this._results.replaceChildren();
    const group = (title, places) => {
      if (!places.length) return;
      this._results.append(Dom.el('p', { class: 'group' }, title));
      for (const place of places) this._results.append(this._button(place));
    };
    group(t('Found lately'), recent);
    group(t('The largest'), largest);
    this._results.hidden = !recent.length && !largest.length;
  }

  async search() {
    const query = this._input.value.trim();
    const asked = ++this._asked;
    if (query.length < 2) {
      this.close();
      return;
    }
    const world = this._world();
    let found;
    try {
      if (world === 'earth') {
        const response = await this._fetch(`/api/search?${new URLSearchParams({ q: query, lang: language() })}`);
        if (!response.ok) throw new Error(`${response.status}`);
        found = (await response.json()).map((p) => ({
          name: p.name, detail: p.detail, lat: p.lat, lon: p.lon,
          widthM: p.box ? boxWidthM(p.box) : null,
        }));
      } else {
        found = (await this._names[world].search(query)).map((p) => this._ofName(p));
      }
    } catch (e) {
      if (asked !== this._asked) return;
      this._show([], t('The search did not answer. Try again in a minute.'));
      return;
    }
    if (asked !== this._asked) return;      // a newer search is under way
    this._shownFor = query;
    this._show(found, found.length ? null : t('Nothing found.'));
  }

  // A named place of another world as the list shows it.
  _ofName(p) {
    return {
      name: p.name, detail: [t(p.kind), p.diameterKm ? t('{n} km', { n: roundKm(p.diameterKm) }) : ''].filter(Boolean).join(' · '),
      lat: p.lat, lon: p.lon, widthM: p.diameterKm ? p.diameterKm * 1000 : null,
    };
  }

  _button(place) {
    const button = Dom.el('button', { type: 'button' }, Dom.el('span', { class: 'name' }, place.name),
      place.detail ? Dom.el('span', { class: 'detail' }, place.detail) : null);
    button.addEventListener('click', () => this._pick(place));
    return button;
  }

  _show(found, note) {
    this._found = found;
    this._results.replaceChildren();
    if (note) this._results.append(Dom.el('p', { class: 'state' }, note));
    for (const place of found) this._results.append(this._button(place));
    this._results.hidden = false;
  }

  _pick(place) {
    this.close();
    this._input.value = place.name;
    this._recent.add(this._world(), place);
    this._onPick(place);
  }
}

// The east-west width of Nominatim's box [south, north, west, east], metres, on Earth.
function boxWidthM([south, north, west, east]) {
  const lat = (south + north) / 2;
  const w = (east - west) * 111320 * Math.cos(lat * Math.PI / 180);
  const h = (north - south) * 111320;
  return Math.max(w, h);
}

function roundKm(km) {
  return km < 10 ? Math.round(km * 10) / 10 : Math.round(km);
}
