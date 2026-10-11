// A server-backed source history shared by the picture step and the 3D editor. The field never picks
// a saved URL by itself. Its floating list is outside scrolling panels and does not move the map.
import { t } from './i18n.js';

export class LayerHistoryPicker {
  constructor({ input, results, store, onPick }) {
    this._input = input;
    this._results = results;
    this._store = store;
    this._onPick = onPick;
    this._found = [];
    this._index = -1;
    this._request = 0;
    document.body.append(results);
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', results.id);
    this.close();
    for (const type of ['focus', 'click']) input.addEventListener(type, () => this.open());
    input.addEventListener('input', () => this.open(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { this.close(); e.preventDefault(); e.stopPropagation(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (results.hidden) { this.open(); return; }
        if (!this._found.length) return;
        this._index = this._index < 0 ? (e.key === 'ArrowDown' ? 0 : this._found.length - 1)
          : (this._index + (e.key === 'ArrowDown' ? 1 : -1) + this._found.length) % this._found.length;
        this._highlight();
      } else if (e.key === 'Enter' && !results.hidden && this._index >= 0) {
        e.preventDefault(); this._pick(this._found[this._index]);
      }
    });
    input.addEventListener('blur', () => {
      if (!results.contains(document.activeElement)) this.close();
    });
    // Keep input focus until the row's click chooses a URL; blur must not swallow that click.
    results.addEventListener('pointerdown', (e) => e.preventDefault());
    document.addEventListener('pointerdown', (e) => {
      if (e.target !== input && !results.contains(e.target)) this.close();
    });
    document.addEventListener('scroll', (e) => { if (!results.contains(e.target)) this.close(); }, true);
    window.addEventListener('resize', () => this.close());
  }

  async open(query = '') {
    if (this._input.disabled) return;
    const request = ++this._request;
    this._results.replaceChildren(Dom.el('p', { class: 'group' }, t('Loading saved sources…')));
    this._results.hidden = false;
    this._input.setAttribute('aria-expanded', 'true');
    this._position();
    let history;
    try { history = await this._store.history(); } catch {
      if (request !== this._request) return;
      this._results.replaceChildren(Dom.el('p', { class: 'group' }, t('The saved picture sources could not be read.')));
      this._position();
      return;
    }
    if (request !== this._request || this._input.disabled) return;
    const needle = query.trim().toLowerCase();
    this._found = history.layers.filter((layer) => `${layer.url} ${layer.label}`.toLowerCase().includes(needle));
    this._index = -1;
    const rows = this._found.map((layer, i) => {
      const row = Dom.el('button', { type: 'button', role: 'option', tabindex: '-1', 'aria-selected': 'false', id: `${this._results.id}-${i}` },
        Dom.el('span', { class: 'name' }, layer.label), Dom.el('span', { class: 'detail' }, layer.url));
      row.addEventListener('click', () => this._pick(layer));
      return row;
    });
    const note = rows.length ? t('Previously used sources') : t('No matching saved links.');
    this._results.replaceChildren(Dom.el('p', { class: 'group' }, note), ...rows);
    this._results.hidden = false;
    this._input.setAttribute('aria-expanded', 'true');
    this._position();
  }

  _position() {
    const box = this._input.getBoundingClientRect();
    this._results.style.setProperty('--history-left', `${Math.max(8, box.left)}px`);
    this._results.style.setProperty('--history-width', `${Math.min(box.width, innerWidth - 16)}px`);
    const height = this._results.getBoundingClientRect().height;
    const top = box.bottom + height + 6 <= innerHeight ? box.bottom + 6 : Math.max(8, box.top - height - 6);
    this._results.style.setProperty('--history-top', `${top}px`);
  }

  close() {
    this._request += 1;
    this._results.hidden = true;
    this._index = -1;
    this._input.setAttribute('aria-expanded', 'false');
    this._input.removeAttribute('aria-activedescendant');
  }

  _highlight() {
    const rows = [...this._results.querySelectorAll('button')];
    rows.forEach((row, i) => row.setAttribute('aria-selected', String(i === this._index)));
    const row = rows[this._index];
    this._input.setAttribute('aria-activedescendant', row.id);
    row.scrollIntoView({ block: 'nearest' });
  }

  _pick(layer) {
    this._input.value = layer.url;
    this.close();
    this._onPick(layer);
  }
}
