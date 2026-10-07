// Planet Terrain Maker: the page. Three screens — the saved models, the map, the model — and the
// header's buttons, the language, the theme, the OpenTopography key and the small dialogs.

import './client-errors.js';
import { LANGUAGES, PageTranslator, language, setLanguage, t } from './i18n.js';
import { StoredChoice } from './stored-choice.js';
import { Library } from './library.js';
import { LibraryScreen } from './library-screen.js';
import { MapScreen } from './map-screen.js';
import { ModelScreen } from './model-screen.js';
import { CompareFlow } from './compare-flow.js';
import { TerrainModel } from './model.js';
import { DEVICE, fitCanvas } from './device.js';
import { FullScreen } from './full-screen.js';
import { HeaderFit } from './header-fit.js';
import { nameOfPlaces, placesOfName } from './names.js';

const $ = (id) => document.getElementById(id);
const CACHE_CLEARED = 'ptm.cacheCleared';     // in sessionStorage: the reload after "Clear the cache" says so

// Which header buttons each screen has.
const TOOLS = {
  library: ['cache-btn', 'new-btn', 'key-btn'],
  map: ['back-btn', 'key-btn'],
  model: ['model-back-btn', 'library-btn', 'export-wrap', 'copy-btn', 'save-btn'],
};

class App {
  constructor() {
    this._languageChoice = new StoredChoice('ptm.language', { allowed: LANGUAGES });
    setLanguage(this._languageChoice.get('en'));
    document.documentElement.lang = language();
    this._translator = new PageTranslator(document.body, { skip: '.leaflet-container, .view, script, style' });
    this._translator.start();
    for (const slot of document.querySelectorAll('.icon-slot[data-icon]')) slot.replaceChildren(Icon.make(slot.dataset.icon, 16));
    this._toast = new Toast($('toast'));
    this._screen = null;
    this._modelFrom = 'library';     // where the model on screen came from: Back goes there

    this.library = new Library();
    this.libraryScreen = new LibraryScreen({
      library: this.library, say: (text, kind, action) => this.say(text, kind, action), onOpen: (id) => this.open(id),
      askName: (name, title) => this.askName(name, title), confirmRemove: (name) => this.confirm(t('Remove “{name}”?', { name })),
    });
    this.mapScreen = new MapScreen({
      say: (text, kind) => this.say(text, kind),
      onCaptured: (place) => this.showModel(new TerrainModel({ places: [place] })),
      keyNeeded: (why) => this.keyDialog(why),
    });
    this.modelScreen = new ModelScreen({
      say: (text, kind) => this.say(text, kind), library: this.library,
      onReplace: (index) => this.compare.replace(index), onRedrawLine: () => this.compare.redrawLine(),
      askName: (name, title) => this.askName(name, title), askNames: (names) => this.askNames(names),
    });
    this.compare = new CompareFlow({ app: this, map: this.mapScreen, models: this.modelScreen });

    $('home-link').addEventListener('click', () => this.show('library'));
    $('back-btn').addEventListener('click', () => this.show('library'));
    $('model-back-btn').addEventListener('click', () => this.back());
    $('library-btn').addEventListener('click', () => this.show('library'));
    $('new-btn').addEventListener('click', () => this.newModel());
    $('save-btn').addEventListener('click', () => this.modelScreen.save().then((saved) => saved && this.libraryScreen.refresh()));
    $('copy-btn').addEventListener('click', () => this.modelScreen.copy().then((saved) => saved && this.libraryScreen.refresh()));
    $('key-btn').addEventListener('click', () => this.keyDialog());
    $('cache-btn').addEventListener('click', () => this.clearCache());
    $('lang-btn').addEventListener('click', () => this.switchLanguage(language() === 'ru' ? 'en' : 'ru'));
    $('theme-btn').addEventListener('click', () => { Theme.toggle(); this._themeIcon(); });
    // the whole page on the whole screen (an iPad, a computer): one button, in and out
    this._fullScreen = new FullScreen();
    this._fullScreen.onChange = () => this._fullScreenButton();
    $('fullscreen-btn').hidden = !this._fullScreen.can;
    $('fullscreen-btn').addEventListener('click', () => this._fullScreen.toggle()
      .catch((e) => this.say(t('Full screen did not open: {why}', { why: t(e.message ?? String(e)) }), 'error')));
    $('export-btn').addEventListener('click', () => {
      const menu = $('export-menu');
      menu.hidden = !menu.hidden;
      $('export-btn').setAttribute('aria-expanded', String(!menu.hidden));
    });
    document.addEventListener('pointerdown', (e) => {
      if (!$('export-menu').hidden && !e.target.closest('#export-wrap')) {
        $('export-menu').hidden = true;
        $('export-btn').setAttribute('aria-expanded', 'false');
      }
    });
    this._langButton();
    this._themeIcon();
    this._fullScreenButton();
    this._headerFit = new HeaderFit($('tools'));
    this.show('library');          // which asks the server for the list
    this.mapScreen.loadStarts();
    this._cacheClearedNote();
  }

  // ---------- screens ----------

  show(name) {
    this._screen = name;
    $('app').dataset.screen = name;
    for (const screen of ['library', 'map', 'model']) $(`${screen}-screen`).hidden = screen !== name;
    const wanted = new Set(TOOLS[name]);
    // a model from the library goes Back there: no second button to the library
    if (name === 'model' && this._modelFrom === 'library') wanted.delete('library-btn');
    for (const id of new Set(Object.values(TOOLS).flat())) $(id).hidden = !wanted.has(id);
    this._headerFit?.fit();
    this.modelScreen.view.run(name === 'model');
    this.modelScreen.syncCameraButtons();
    if (name === 'map') this.mapScreen.view.refresh();
    if (name === 'library') this.libraryScreen.refresh();
    this.compare.wizard.viewChanged(name);
  }

  // A new model, the one way in: the map, on the world it showed last (Earth at first). One place
  // or two side by side is chosen on the map.
  newModel() {
    this.compare.wizard.close();
    this.show('map');
    this.mapScreen.setKind('one');
    if (!this.mapScreen.view.world) {
      this.mapScreen.setShape('circle');
      this.mapScreen.showWorld('earth');
    }
  }

  // The screen first: the view measures itself when the model is laid in it. from: where Back goes.
  showModel(model, from = 'map') {
    this.compare.wizard.close();
    this.modelFrom(from);
    this.show('model');
    this.modelScreen.show(model);
  }

  // Where the model on screen came from: the map (it was captured there) or the library.
  modelFrom(screen) {
    this._modelFrom = screen;
  }

  // The model screen's Back: a step back in the two-places guide while it arranges the places,
  // else to where the model came from (the map as it was left, or the library).
  back() {
    const wizard = this.compare.wizard;
    if (wizard.active && wizard.view.back) {
      wizard.back();
      return;
    }
    this.show(this._modelFrom);
  }

  async open(id) {
    this.say(t('Opening the model…'));
    try {
      const model = await this.library.open(id, (url) => loadCanvas(url));
      this.showModel(model, 'library');
      const reduced = model.places.find((p) => p.reduced);
      if (reduced) {
        this.say(t('The picture is shown at {shown} points of {stored}: this device has no memory for a bigger one. The file on the server stays as it is.', {
          shown: Math.max(reduced.picture.width, reduced.picture.height), stored: Math.max(reduced.stored.width, reduced.stored.height),
        }));
      } else {
        this._toast.hide();
      }
    } catch (e) {
      this.say(t('The model did not open: {why}', { why: t(e.message) }), 'error');
    }
  }

  // ---------- this device's cache ----------

  // Clear this site's cache in this browser, to free the room: the server answers with
  // Clear-Site-Data: "cache", and the browser drops the map tiles, pictures and page files it keeps.
  // The reload after it brings the newest page. The models on the server, the other devices and the
  // choices kept here (localStorage: they are not cache) stay as they are.
  async clearCache() {
    this.say(t('Clearing the cache…'));
    try {
      const response = await fetch('/api/clear-cache', { method: 'POST' });
      if (!response.ok) throw new Error(`${response.status}`);
    } catch (e) {
      this.say(t('The cache was not cleared: {why}', { why: t(e.message) }), 'error');
      return;
    }
    try {
      sessionStorage.setItem(CACHE_CLEARED, '1');
    } catch {
      // no note after the reload then
    }
    location.reload();
  }

  _cacheClearedNote() {
    try {
      if (!sessionStorage.getItem(CACHE_CLEARED)) return;
      sessionStorage.removeItem(CACHE_CLEARED);
    } catch {
      return;
    }
    this.say(t('The cache of this device is cleared.'));
  }

  // ---------- small things ----------

  say(text, kind = 'info', action = null) {
    this._toast.show({ text, kind, action });
  }

  switchLanguage(id) {
    setLanguage(id);
    this._languageChoice.set(id);
    document.documentElement.lang = id;
    this._translator.refresh();
    this._langButton();
    this._fullScreenButton();
    this._headerFit.fit();
    this.libraryScreen.render();
    if (this.mapScreen.view.world) this.mapScreen.showWorld(this.mapScreen.world, this.mapScreen.view.where());
    if (this.modelScreen.model) this.modelScreen.show(this.modelScreen.model);
  }

  _langButton() {
    $('lang-btn').textContent = language() === 'ru' ? 'EN' : 'RU';
  }

  _fullScreenButton() {
    const on = this._fullScreen.on;
    const button = $('fullscreen-btn');
    const words = on ? t('Leave full screen') : t('Full screen');
    button.title = words;
    button.setAttribute('aria-label', words);
    button.querySelector('.fs-enter').toggleAttribute('hidden', on);
    button.querySelector('.fs-exit').toggleAttribute('hidden', !on);
  }

  _themeIcon() {
    const slot = $('theme-btn').querySelector('.icon-slot');
    slot.replaceChildren(Icon.make(Theme.current() === 'dark' ? 'sun' : 'moon', 16));
  }

  // The OpenTopography key: kept on the server, never shown again. why: what asked for it.
  async keyDialog(why = null) {
    const dialog = $('key-dialog');
    const state = $('key-state'), error = $('key-error'), input = $('key-input');
    input.value = '';
    error.hidden = true;
    const refresh = async () => {
      const where = (await fetch('/api/settings').then((r) => r.json()).catch(() => ({}))).opentopo_key;
      state.textContent = where === 'page' ? t('The server has a key from this page.')
        : where === 'environment' ? t('The server has a key from its settings.') : t('The server has no key yet.');
      $('key-remove').hidden = where !== 'page';
    };
    if (why) {
      error.textContent = t(why);
      error.hidden = false;
    }
    await refresh();
    const close = () => dialog.close();
    $('key-cancel').onclick = close;
    $('key-remove').onclick = async () => {
      await fetch('/api/settings/opentopo-key', { method: 'DELETE' });
      await refresh();
    };
    $('key-save').onclick = async () => {
      const response = await fetch('/api/settings/opentopo-key', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: input.value.trim() }),
      });
      if (response.ok) {
        close();
        this.say(t('The key is kept on the server.'));
      } else {
        error.textContent = t('That does not look like a key.');
        error.hidden = false;
      }
    };
    dialog.showModal();
    input.focus();
  }

  // A name from the user: the current one to start from. Resolves with the name, or null (cancel).
  askName(current, title) {
    const dialog = $('name-dialog'), input = $('name-input'), error = $('name-error');
    $('name-title').textContent = title;
    input.value = current ?? '';
    error.hidden = true;
    return new Promise((resolve) => {
      const done = (value) => {
        dialog.close();
        resolve(value);
      };
      $('name-cancel').onclick = () => done(null);
      dialog.oncancel = (e) => { e.preventDefault(); done(null); };
      $('name-ok').onclick = () => {
        const name = input.value.trim();
        if (!name) {
          error.textContent = t('A model needs a name.');
          error.hidden = false;
          return;
        }
        done(name);
      };
      input.onkeydown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); $('name-ok').click(); }
      };
      dialog.showModal();
      input.select();
    });
  }

  // The names of a model and of its places: { model, places: [...] } in, the same back, or null.
  askNames({ model, places }) {
    const dialog = $('names-dialog'), error = $('names-error');
    const inputs = [$('names-place-0'), $('names-place-1')];
    $('names-model').value = model ?? '';
    $('names-place-0-word').textContent = t(places.length > 1 ? 'First place' : 'Place');
    // one place takes the model's name itself (names.js): its own field would only repeat it
    $('names-place-0-label').hidden = places.length < 2;
    $('names-place-1-label').hidden = places.length < 2;
    inputs.forEach((input, i) => { input.value = places[i] ?? ''; });
    error.hidden = true;
    // One name: the places' fields follow the model's name while it is made of theirs, and the
    // model's name follows them; at the start the fields show what the model's name gives.
    const joiner = t(' and ');
    const follow = () => {
      const given = placesOfName($('names-model').value, places.length, joiner);
      if (given) given.forEach((name, i) => { inputs[i].value = name; });
    };
    $('names-model').oninput = follow;
    inputs.forEach((input) => {
      input.oninput = () => {
        if (placesOfName($('names-model').value, places.length, joiner)) {
          $('names-model').value = nameOfPlaces(places.map((_, i) => inputs[i].value), joiner);
        }
      };
    });
    follow();
    return new Promise((resolve) => {
      const done = (value) => {
        dialog.close();
        resolve(value);
      };
      $('names-cancel').onclick = () => done(null);
      dialog.oncancel = (e) => { e.preventDefault(); done(null); };
      $('names-ok').onclick = () => {
        const names = { model: $('names-model').value.trim(), places: places.map((_, i) => inputs[i].value.trim()) };
        if (!names.model || names.places.some((name) => !name)) {
          error.textContent = t('Each name is needed.');
          error.hidden = false;
          return;
        }
        done(names);
      };
      for (const input of [$('names-model'), ...inputs]) {
        input.onkeydown = (e) => {
          if (e.key === 'Enter') { e.preventDefault(); $('names-ok').click(); }
        };
      }
      dialog.showModal();
      $('names-model').select();
    });
  }

  confirm(text) {
    return Promise.resolve(window.confirm(text));
  }
}

// A saved picture as a canvas, made smaller where the device holds no canvas that big (device.js):
// a model saved with a picture of 8192 points opens on an iPad at 4096. Such a device asks the server
// for the smaller copy itself: decoding the big JPEG there already fails (a blank picture).
async function loadCanvas(url) {
  const sized = DEVICE.smaller ? `${url}${url.includes('?') ? '&' : '?'}most=${DEVICE.canvasMostPx}` : url;
  const response = await fetch(sized);
  if (!response.ok) throw new Error(`${response.status}`);
  const image = await createImageBitmap(await response.blob());
  const { width, height } = fitCanvas(image.width, image.height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(image, 0, 0, width, height);
  image.close?.();
  return canvas;
}

window.app = new App();
