// The first screen: the saved models as cards. A card opens its model; its small buttons copy,
// rename and remove it. A copy is how a model is kept as it is while one of its places changes.

import { renaming } from './names.js';
import { WORLD_ORDER, worldOf } from './worlds.js';
import { atlasLink, dotted } from './atlas-links.js';
import { countOf, language, t } from './i18n.js';

const $ = (id) => document.getElementById(id);

export class LibraryScreen {
  // library: Library. say(text, kind, action). onOpen(id). askName(current, title) -> Promise<name | null>.
  constructor({ library, say, onOpen, askName, confirmRemove }) {
    this._library = library;
    this._say = say;
    this._onOpen = onOpen;
    this._askName = askName;
    this._confirmRemove = confirmRemove;
    this._models = null;
  }

  async refresh() {
    const cards = $('library-cards');
    try {
      this._models = await this._library.list();
    } catch (e) {
      cards.replaceChildren(Dom.el('p', { class: 'state error' }, Dom.el('strong', {}, t('The list did not come')), t(e.message)));
      $('library-count').textContent = '';
      return;
    }
    this.render();
  }

  // Draw the cards again (the language changed, or the list).
  // Maps of each world on other sites, on the main page only: every world's links in a row.
  _atlases() {
    $('atlas-rows').replaceChildren(...WORLD_ORDER.map(worldOf).filter((w) => w.atlases).map((w) =>
      Dom.el('li', {}, Dom.el('b', {}, `${t(w.label)}:`), ' ', ...dotted(w.atlases.map(atlasLink)))));
  }

  render() {
    if (!this._models) return;
    const cards = $('library-cards');
    $('library-count').textContent = this._models.length ? countOf(this._models.length, 'model', 'models') : '';
    $('start-tips').hidden = this._models.length > 3;
    this._atlases();
    if (!this._models.length) {
      cards.replaceChildren(Dom.el('p', { class: 'state' }, Dom.el('strong', {}, t('No models yet')),
        t('Press New model: one place, or two side by side.')));
      return;
    }
    cards.replaceChildren(...this._models.map((m, i) => this._card(m, i)));
  }

  _card(m, i) {
    const picture = Dom.el('div', { class: 'card-picture' });
    if (m.files.includes('thumb.jpg')) {
      picture.append(Dom.el('img', { src: `${this._library.fileUrl(m.id, 'thumb.jpg')}?v=${encodeURIComponent(m.updated ?? '')}`, alt: '', loading: 'lazy' }));
    }
    const places = m.places.map((p) => `${p.name} · ${t(worldOf(p.world).label)}`).join(' | ');
    const when = m.updated ? new Date(m.updated).toLocaleDateString(language() === 'ru' ? 'ru-RU' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    const copy = Dom.el('button', { type: 'button', class: 'mini', title: t('Copy'), 'aria-label': t('Copy') }, Icon.make('layers', 16));
    const rename = Dom.el('button', { type: 'button', class: 'mini', title: t('Rename'), 'aria-label': t('Rename') }, Icon.make('pencil', 16));
    const remove = Dom.el('button', { type: 'button', class: 'mini danger', title: t('Remove'), 'aria-label': t('Remove') }, Icon.make('trash', 16));
    const card = Dom.el('article', { class: 'card glass glow enter', tabindex: 0, 'aria-label': m.name },
      picture,
      Dom.el('div', { class: 'card-body' }, Dom.el('div', { class: 'card-name' }, m.name), Dom.el('div', { class: 'card-meta' }, places),
        when ? Dom.el('div', { class: 'card-meta' }, when) : null),
      Dom.el('div', { class: 'card-actions' }, copy, rename, remove));
    card.style.setProperty('--i', String(Math.min(i, 12)));
    card.addEventListener('click', (e) => {
      if (!e.target.closest('.card-actions')) this._onOpen(m.id);
    });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target === card) this._onOpen(m.id);
    });
    copy.addEventListener('click', async () => {
      const name = await this._askName(t('{name} (copy)', { name: m.name }), t('Copy the model'));
      if (name === null) return;
      try {
        const copied = await this._library.copy(m.id, name);
        await this.refresh();
        this._say(t('Copied: {name}', { name: copied.name }), 'info', { label: t('Open'), run: () => this._onOpen(copied.id) });
      } catch (e) {
        this._say(t(e.message), 'error');
      }
    });
    rename.addEventListener('click', async () => {
      const name = await this._askName(m.name, t('Rename the model'));
      if (name === null) return;
      // the places take their parts of the name too (names.js): one name on the card, not two
      const change = renaming({ name: m.name, places: m.places.map((p) => p.name) }, name, t(' and '));
      if (!change) return;
      try {
        await this._library.rename(m.id, change.name, change.places);
        await this.refresh();
      } catch (e) {
        this._say(t(e.message), 'error');
      }
    });
    remove.addEventListener('click', async () => {
      if (!(await this._confirmRemove(m.name))) return;
      try {
        await this._library.remove(m.id);
        this._say(t('Removed: {name}', { name: m.name }));
        await this.refresh();
      } catch (e) {
        this._say(t(e.message), 'error');
      }
    });
    return card;
  }
}
