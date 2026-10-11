// Source choices after a place has been framed: picture first, heights next. A custom URL is
// validated here, but no custom tiles are requested until the model is captured.
import { CustomLayer, CustomLayerStore } from './custom-layer.js';
import { t } from './i18n.js';
import { LayerHistoryPicker } from './layer-history-picker.js';

const $ = (id) => document.getElementById(id);

export class CaptureSources {
  constructor() {
    this._store = new CustomLayerStore();
    this.refresh();
    this._history = new LayerHistoryPicker({ input: $('guide-custom-url'), results: $('guide-custom-history'), store: this._store,
      onPick: (layer) => this.restore(layer) });
    $('picture-source').addEventListener('change', () => this._customVisible());
    $('guide-custom-url').addEventListener('input', () => this._placeholders());
  }

  show(stage) {
    if (stage !== 'picture') this._history.close();
    $('sources').hidden = !stage;
    $('guide-picture-choice').hidden = stage !== 'picture';
    $('guide-height-choice').hidden = stage !== 'heights';
    this._customVisible();
  }

  _customVisible() {
    const hidden = $('picture-source').value !== 'custom';
    $('guide-custom-source').hidden = hidden;
    $('guide-custom-settings').hidden = hidden;
    if (hidden) this._history?.close();
  }

  _placeholders() {
    let layer = null;
    try { layer = new CustomLayer({ url: $('guide-custom-url').value }); } catch { /* The validation message comes on Next. */ }
    $('guide-custom-name').placeholder = layer?.label ?? t('Automatic');
    $('guide-custom-credit').placeholder = layer?.credit ?? t('Automatic');
  }

  async picture() {
    const pictureId = $('picture-source').value;
    if (pictureId !== 'custom') return { pictureId, pictureSource: null };
    try {
      const pictureSource = new CustomLayer({ url: $('guide-custom-url').value, maxZoom: $('guide-custom-zoom').value,
        name: $('guide-custom-name').value, credit: $('guide-custom-credit').value });
      await this._store.keep(pictureSource);
      $('guide-source-error').textContent = '';
      return { pictureId, pictureSource };
    } catch (e) {
      $('guide-source-error').textContent = t(e.message);
      return null;
    }
  }

  get heightsId() { return $('heights-source').value; }

  refresh() {
    $('guide-custom-url').value = '';
    $('guide-custom-zoom').value = '';
    $('guide-custom-name').value = '';
    $('guide-custom-credit').value = '';
    this._history?.close();
    this._placeholders();
    $('guide-source-error').textContent = '';
  }

  restore(layer) {
    if (!layer) return;
    $('guide-custom-url').value = layer.url;
    $('guide-custom-zoom').value = layer.zoomLimit ?? '';
    $('guide-custom-name').value = layer.name;
    $('guide-custom-credit').value = layer.userCredit;
    this._placeholders();
  }
}
