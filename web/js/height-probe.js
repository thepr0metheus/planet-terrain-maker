// Heights on the model under a click: a label at the point that says how high the ground is there
// (and, on a model of two places, which place it is). The label stays over its point as the camera
// moves and goes after LABEL_MS. Several labels may stand at once.
//
// The view tells a click with its point, found once (ModelView.onPick): the page puts the label
// there at once, before the view turns about the point. The page says what a point is (describe);
// the view says where a point shows on the screen (pointOnScreen).

export const LABEL_MS = 10000;
const FADE_MS = 600;          // the last part of LABEL_MS: the label fades out
const MOST_LABELS = 6;        // past this, the oldest label goes first

export class HeightProbe {
  // container: the element the labels lie in. view: the 3D view (ModelView).
  // describe(u, v) -> { value, name } for the label (name may be null), or null for none.
  constructor({ container, view, describe }) {
    this._container = container;
    this._view = view;
    this._describe = describe;
    this._labels = [];          // { el, u, v, timers }
  }

  // A label for the point (u, v) of the model's top, if the page has something to say there.
  labelAt(u, v) {
    const said = this._describe(u, v);
    if (!said) return null;
    while (this._labels.length >= MOST_LABELS) this._remove(this._labels[0]);
    const tag = Dom.el('div', { class: 'height-tag' }, Dom.el('div', { class: 'height-value' }, said.value));
    if (said.name) tag.append(Dom.el('div', { class: 'height-place' }, said.name));
    const el = Dom.el('div', { class: 'height-label' }, tag, Dom.el('div', { class: 'height-pin' }));
    this._container.appendChild(el);
    const label = { el, u, v, timers: [] };
    label.timers.push(setTimeout(() => el.classList.add('fading'), LABEL_MS - FADE_MS));
    label.timers.push(setTimeout(() => this._remove(label), LABEL_MS));
    this._labels.push(label);
    this.place();
    return label;
  }

  // Keep each label over its point, where the camera shows it now. Every frame.
  place() {
    if (!this._labels.length) return;
    const view = this._view.canvas.getBoundingClientRect();
    const box = this._container.getBoundingClientRect();
    for (const { el, u, v } of this._labels) {
      const p = this._view.pointOnScreen(u, v);
      el.classList.toggle('off-screen', !p);
      if (!p) continue;
      el.style.setProperty('--x', `${Math.round(p.x + view.left - box.left)}px`);
      el.style.setProperty('--y', `${Math.round(p.y + view.top - box.top)}px`);
    }
  }

  // Another model: the labels of this one go.
  clear() {
    for (const label of [...this._labels]) this._remove(label);
  }

  get count() { return this._labels.length; }

  _remove(label) {
    for (const timer of label.timers) clearTimeout(timer);
    label.el.remove();
    this._labels = this._labels.filter((l) => l !== label);
  }
}
