// The 3D screen's own picture source. The 2D map only selects a place; this control reads its
// coordinates and frame, downloads a new picture, then changes that picture atomically.
import { CustomLayer, CustomLayerStore } from './custom-layer.js';
import { PlaceCapture } from './capture.js';
import { t } from './i18n.js';
import { LayerHistoryPicker } from './layer-history-picker.js';

const $ = (id) => document.getElementById(id);

export class CustomPicture {
  constructor({ onChanged, store = new CustomLayerStore(), capture = null }) {
    this._onChanged = onChanged;
    this._store = store;
    this._model = null;
    this._loading = null;
    this._capture = capture ?? new PlaceCapture({ onProgress: (_, share) => {
      if (this._loading && Number.isFinite(share)) this._state(t('Loading the picture: {n}%.', { n: Math.round(share * 100) }));
    } });
    this._layer = null;
    this._fill();
    this._history = new LayerHistoryPicker({ input: $('custom-layer-url'), results: $('custom-layer-history'), store,
      onPick: (layer) => { this._layer = layer; this._fill(); } });
    $('custom-layer-form').addEventListener('submit', (e) => { e.preventDefault(); this.apply(); });
    $('custom-layer-remove').addEventListener('click', async () => {
      try {
        await this._store.forget($('custom-layer-url').value.trim());
        this._layer = null;
        this._fill();
        this._state(t('The URL was forgotten. The model picture stays as it is.'));
      } catch (error) { this._state(t(error.message)); }
    });
  }

  show(model) {
    this._history.close();
    if (model !== this._model) {
      this._layer = null;
      this._fill();
    }
    if (this._loading) this._state(this._layer ? t('Layer set: {name}.', { name: this._layer.label }) : t('No custom layer is set.'));
    this._loading?.abort();
    this._loading = null;
    this._model = model;
    const places = model.places.map((place, index) => ({ place, index })).filter(({ place }) => place.world === 'earth');
    $('custom-layer').hidden = !places.length;
    $('custom-layer-place-label').hidden = places.length < 2;
    $('custom-layer-place').replaceChildren(...places.map(({ place, index }) => Dom.el('option', { value: index }, place.name || t('Earth'))));
    this._enabled(true);
  }

  _fill() {
    const layer = this._layer;
    $('custom-layer-name').value = layer?.name ?? '';
    $('custom-layer-url').value = layer?.url ?? '';
    $('custom-layer-credit').value = layer?.userCredit ?? '';
    $('custom-layer-zoom').value = layer?.zoomLimit ?? '';
    $('custom-layer-remove').disabled = !layer;
    this._state(layer ? t('Layer set: {name}.', { name: layer.label }) : t('No custom layer is set.'));
  }

  _state(text) { $('custom-layer-state').textContent = text; }

  _enabled(on) {
    $('custom-layer-apply').disabled = !on;
    $('custom-layer-remove').disabled = !on || !this._layer;
    $('custom-layer-place').disabled = !on;
  }

  async apply() {
    if (this._loading || !this._model) return;
    let source;
    try {
      source = new CustomLayer({ name: $('custom-layer-name').value, url: $('custom-layer-url').value,
        credit: $('custom-layer-credit').value, maxZoom: $('custom-layer-zoom').value });
    } catch (e) {
      this._state(t(e.message));
      return;
    }
    const model = this._model;
    const index = Number($('custom-layer-place').value);
    const place = model.places[index];
    if (place?.world !== 'earth') return;
    this._layer = source;
    const loading = new AbortController();
    this._loading = loading;
    this._enabled(false);
    this._state(t('Loading the picture…'));
    try {
      await this._store.keep(source);
      if (this._model !== model || model.places[index] !== place || loading.signal.aborted) return;
      const picture = await this._capture.pictureFor(place, source, { signal: loading.signal });
      // Another model or another place may have opened while the tiles were coming.
      if (this._model !== model || model.places[index] !== place || loading.signal.aborted) return;
      model.setPicture(index, { picture, source });
      await this._onChanged();
      this._state(t('The picture was applied. Save the model to keep it.'));
    } catch (e) {
      if (!loading.signal.aborted) this._state(t(e.message));
    } finally {
      if (this._loading === loading) {
        this._loading = null;
        this._enabled(true);
      }
    }
  }
}
