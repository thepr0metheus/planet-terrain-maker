// What one can put on a model (asteroid-on-model.js), and how one picks it. Asteroids: the top of the
// list, the most exact shapes from spacecraft and radar (web/data/asteroids-top.json), and under it the
// DAMIT catalogue, shapes found from how an asteroid's light changes as it turns, each sized by its
// diameter (asteroids-damit.json, about 8,800 of them); a field and a list under it, as the craft
// search has, an empty field showing the top. Comets seen up close (comets.json) and spacecraft
// (vehicles.json) are short lists, each under a button of its own: a plain list, no search. The
// asteroid and comet lists are made by tools/asteroids.py, vehicles.json is written by hand.

import { number, t } from './i18n.js';

const MOST_FOUND = 40;         // the catalogue's matches listed at most

// Text as the search compares it: small letters, no accents, words split by anything else.
const normal = (text) => String(text).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// An entry of the top list, of the catalogue (its rows are [number, name, diameterKm, modelId]), of the
// comets and of the spacecraft.
export const topEntry = (a) => ({ source: 'top', ...a });
export const catalogueEntry = ([number, name, diameterKm, model]) => ({ source: 'damit', number, name, diameterKm, model });
export const cometEntry = (c) => ({ source: 'comet', ...c });
export const vehicleEntry = (v) => ({ source: 'vehicle', ...v });

// What a saved model keeps of what stands on it, to find it again: an id in its list, or the
// catalogue's row (the catalogue is too long to look the number up in).
const KEYS = {
  top: (a) => ({ source: 'top', id: a.id }),
  comet: (a) => ({ source: 'comet', id: a.id }),
  vehicle: (a) => ({ source: 'vehicle', id: a.id }),
  damit: (a) => ({ source: 'damit', number: a.number, name: a.name, diameterKm: a.diameterKm, model: a.model }),
};
export function keyOf(a) {
  return KEYS[a.source](a);
}

// What a saved key names, from the lists (AsteroidLists.lists), or null when the lists have it no more.
export function entryOf(key, { top, comets = [], vehicles = [] }) {
  const listed = { top, comet: comets, vehicle: vehicles }[key?.source];
  if (listed) return listed.find((a) => a.id === key.id) ?? null;
  if (key?.source === 'damit' && key.model > 0 && key.diameterKm > 0) return catalogueEntry([key.number, key.name ?? '', key.diameterKm, key.model]);
  return null;
}

// The asteroids whose name (also as nameOf gives it: the language in use), designation or number has
// every word typed: { top: of the top list, found: of the catalogue, at most `most`, the number typed
// itself first }. Nothing typed: the whole top, and nothing of the catalogue.
export function findAsteroids({ top, catalogue }, text, { nameOf = (a) => a.name, most = MOST_FOUND } = {}) {
  const words = normal(text).split(' ').filter(Boolean);
  if (!words.length) return { top, found: [] };
  const has = (a) => {
    const said = normal(`${a.number} ${a.name} ${nameOf(a)}`);
    return words.every((word) => said.includes(word));
  };
  const itself = (a) => words.length === 1 && String(a.number) === words[0];
  const found = catalogue.filter(has).sort((a, b) => itself(b) - itself(a) || a.number - b.number).slice(0, most);
  return { top: top.filter(has), found };
}

// What stands on the model in words: its name, and its size as its list knows it (an asteroid of the
// top and a comet: its length; one of the catalogue: the diameter of a ball of its volume; a rocket: its
// height; the station: its length). distance(m): a distance in words.
export function asteroidWords(a, distance) {
  if (a.source === 'vehicle' && a.heightM) return { name: t(a.name), size: t('{d} tall', { d: distance(a.heightM) }) };
  if (a.source !== 'damit') return { name: t(a.name), size: t('{d} long', { d: distance(a.lengthM) }) };
  const name = a.name ? `(${a.number}) ${a.name}` : `(${a.number})`;
  return { name, size: t('{d} in diameter', { d: distance(a.diameterKm * 1000) }) };
}

// The four lists, loaded once.
export class AsteroidLists {
  constructor(load = (url) => fetch(url).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  })) {
    this._load = load;
    this._lists = null;
  }

  async lists() {
    this._lists ??= Promise.all(['asteroids-top', 'asteroids-damit', 'comets', 'vehicles'].map((name) => this._load(`data/${name}.json`)))
      .then(([top, damit, comets, vehicles]) => ({
        top: top.map(topEntry), catalogue: damit.map(catalogueEntry), comets: comets.map(cometEntry), vehicles: vehicles.map(vehicleEntry),
      }))
      .catch((e) => {
        this._lists = null;            // asked again next time
        throw e;
      });
    return this._lists;
  }
}

export class AsteroidSearch {
  // input, results: the field and the list under it. lists: AsteroidLists. onPick(asteroid).
  // distance(m): a distance in words. say(text, kind): a message.
  constructor({ input, results, lists, onPick, distance, say }) {
    this._input = input;
    this._results = results;
    this._lists = lists;
    this._onPick = onPick;
    this._distance = distance;
    this._say = say;
    this._found = [];             // the entries listed, in their order
    this._active = -1;
    const open = () => this._show();
    input.addEventListener('focus', open);
    input.addEventListener('click', open);
    input.addEventListener('input', open);
    input.addEventListener('keydown', (e) => this._key(e));
    document.addEventListener('pointerdown', (e) => {
      if (!results.contains(e.target) && e.target !== input) this.close();
    });
  }

  // The list as it is for the field now: the top, while nothing is typed.
  open() {
    this._show();
  }

  close() {
    this._results.hidden = true;
    this._found = [];
    this._active = -1;
  }

  clear() {
    this._input.value = '';
    this.close();
  }

  async _show() {
    const text = this._input.value;
    let lists;
    try {
      lists = await this._lists.lists();
    } catch (e) {
      this._say(t('The list of asteroids did not come: {why}', { why: e.message }), 'error');
      return;
    }
    if (text !== this._input.value) return;          // typed on meanwhile: the newer one shows
    const { top, found } = findAsteroids(lists, text, { nameOf: (a) => t(a.name) });
    this._found = [...top, ...found];
    this._active = -1;
    const rows = [];
    let k = 0;
    const row = (a) => {
      const words = asteroidWords(a, this._distance);
      const button = Dom.el('button', { type: 'button', id: `asteroid-${k++}` },
        Dom.el('span', { class: 'name' }, words.name), Dom.el('span', { class: 'detail' }, words.size));
      button.addEventListener('click', () => this._pick(a));
      return button;
    };
    if (top.length) rows.push(Dom.el('p', { class: 'group' }, t('Top: the most exact shapes')), ...top.map(row));
    if (found.length) rows.push(Dom.el('p', { class: 'group' }, t('The DAMIT catalogue')), ...found.map(row));
    if (!text.trim()) rows.push(Dom.el('p', { class: 'state' }, t('Type a name or a number: {n} more asteroids in the DAMIT catalogue.', { n: number(lists.catalogue.length) })));
    else if (!this._found.length) rows.push(Dom.el('p', { class: 'state' }, t('Nothing found.')));
    this._results.replaceChildren(...rows);
    this._results.hidden = false;
  }

  _key(e) {
    if (e.key === 'Escape') {
      this.close();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (this._results.hidden || !this._found.length) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      this._active = (this._active + step + this._found.length) % this._found.length;
      this._results.querySelectorAll('button').forEach((b, i) => b.classList.toggle('active', i === this._active));
      this._results.querySelector(`#asteroid-${this._active}`)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const asteroid = this._found[Math.max(0, this._active)];
      if (asteroid) this._pick(asteroid);
    }
  }

  _pick(asteroid) {
    this.close();
    this._input.value = asteroidWords(asteroid, this._distance).name;
    this._onPick(asteroid);
  }
}

// A short list to pick from: the comets, or the spacecraft by their group. A button for each, its name
// and its size, as the asteroid search lists them.
export class ObjectChoices {
  // list: the element the buttons go in. distance(m): a distance in words. onPick(entry).
  constructor({ list, distance, onPick }) {
    this._list = list;
    this._distance = distance;
    this._onPick = onPick;
  }

  // entries in their order; a heading before each new group (the spacecraft's), none without groups.
  show(entries) {
    const rows = [];
    let group = null;
    entries.forEach((entry, k) => {
      if (entry.group && entry.group !== group) {
        group = entry.group;
        rows.push(Dom.el('p', { class: 'group' }, t(group)));
      }
      const words = asteroidWords(entry, this._distance);
      const size = entry.kind === 'built' ? t('{d} tall, a simple shape', { d: this._distance(entry.heightM) }) : words.size;
      const button = Dom.el('button', { type: 'button', id: `object-${k}` },
        Dom.el('span', { class: 'name' }, words.name), Dom.el('span', { class: 'detail' }, size));
      button.addEventListener('click', () => this._onPick(entry));
      rows.push(button);
    });
    this._list.replaceChildren(...rows);
    this._list.hidden = false;
  }

  hide() {
    this._list.hidden = true;
  }
}

