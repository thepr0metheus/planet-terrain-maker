// The search of the craft on the surface of the world on the map (worlds.js landers): a field and a
// list under it, as the place search has: found by name, in a list that falls down.
// An empty field lists them all, by the year they landed; words typed keep those whose name, in the
// language in use or in English, or year has each of them. ↑ ↓ go along the list, Enter picks, Esc
// closes it.

import { t } from './i18n.js';

// Craft whose name (as shown, or in English) or year has every word of the query, in the list's order.
// A pure rule of text: a function.
export function findCraft(list, query, nameOf = (craft) => craft.label) {
  const words = normal(query).split(' ').filter(Boolean);
  if (!words.length) return list;
  return list.filter((craft) => {
    const text = normal(`${nameOf(craft)} ${craft.label} ${craft.year}`);
    return words.every((word) => text.includes(word));
  });
}

// Cyrillic yo (U+0451) is searched as ye (U+0435): most people type the one for the other.
const normal = (text) => String(text).toLowerCase().replace(/\u0451/g, '\u0435').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export class CraftSearch {
  // input, results: the field and the list under it. onPick(craft): a craft was chosen.
  constructor({ input, results, onPick }) {
    this._input = input;
    this._results = results;
    this._onPick = onPick;
    this._list = [];
    this._found = [];
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

  // The craft of another world (none for Earth): the field starts empty.
  setList(list) {
    this._list = list ?? [];
    this._input.value = '';
    this.close();
  }

  close() {
    this._results.hidden = true;
    this._found = [];
    this._active = -1;
  }

  _show() {
    this._found = findCraft(this._list, this._input.value, (craft) => t(craft.label));
    this._active = -1;
    this._results.replaceChildren();
    if (!this._found.length) this._results.append(Dom.el('p', { class: 'state' }, t('Nothing found.')));
    this._found.forEach((craft, i) => {
      const button = Dom.el('button', { type: 'button', id: `craft-${i}` }, Dom.el('span', { class: 'name' }, t(craft.label)),
        Dom.el('span', { class: 'detail' }, String(craft.year)));
      button.addEventListener('click', () => this._pick(craft));
      this._results.append(button);
    });
    this._results.hidden = false;
  }

  _key(e) {
    if (e.key === 'Escape') {
      this.close();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (this._results.hidden) this._show();
      if (!this._found.length) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      this._active = (this._active + step + this._found.length) % this._found.length;
      this._results.querySelectorAll('button').forEach((b, i) => b.classList.toggle('active', i === this._active));
      this._results.querySelector(`#craft-${this._active}`)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (this._results.hidden) this._show();
      const craft = this._found[Math.max(0, this._active)];
      if (craft) this._pick(craft);
    }
  }

  _pick(craft) {
    this.close();
    this._input.value = t(craft.label);
    this._onPick(craft);
  }
}
