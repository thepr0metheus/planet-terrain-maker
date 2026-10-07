// The turn dials of a model of two places: by each place's part, an arrow each way and the place's
// turn in degrees between them. An arrow turns that place by TURN_STEP_DEG, clockwise or back; the
// number takes any turn. Each dial stays just outside the rim of its part (the model says where,
// split.js sideAnchors) as the camera moves, so the two never cover each other or the ground.
//
// The page owns the turns (the sliders in the panel): a dial reports the turn the user asks for
// through onTurn, and shows what show() gives it. Under the dial stands the place's name; the pencil
// beside it, and only the pencil, asks for another place there (onReplace).

import { normalTurn } from './split.js';
import { t } from './i18n.js';

export const TURN_STEP_DEG = 5;           // 5° a step wherever an angle is turned by hand

export class TurnDials {
  // container: the element the dials lie in. view: the 3D view (ModelView).
  // onTurn(place, deg): place 0 or 1 asked to stand at deg. onReplace(place): another place there.
  constructor({ container, view, onTurn, onReplace = () => {} }) {
    this._container = container;
    this._view = view;
    this._onTurn = onTurn;
    this._onReplace = onReplace;
    this._anchors = null;           // [[u, v] or null] x 2; null: no model of two places, the dials are hidden
    this._turns = [0, 0];
    this._dials = [0, 1].map((place) => this._makeDial(place));
  }

  // anchors: where each dial stands on the rim, in frame coordinates (null: that place has no
  // ground and no dial); turns: the places' turns; names: theirs.
  show(anchors, turns, names = ['', '']) {
    this._anchors = anchors;
    this._turns = [0, 1].map((i) => normalTurn(turns?.[i] ?? 0));
    this._dials.forEach((dial, i) => {
      dial.el.hidden = !anchors[i];
      if (document.activeElement !== dial.input) dial.input.value = this._turns[i];
      dial.name.textContent = names[i] ?? '';
    });
    this.place();
  }

  hide() {
    this._anchors = null;
    for (const dial of this._dials) dial.el.hidden = true;
  }

  // Put each dial just outside the rim of its part, where the camera shows it now, kept inside the
  // view. Every frame while a model of two places is on screen.
  place() {
    if (!this._anchors) return;
    const canvas = this._view.canvas.getBoundingClientRect();
    const free = this._view.freeRect();
    const box = this._container.getBoundingClientRect();
    const centre = this._view.pointOnScreen(0.5, 0.5);
    this._anchors.forEach((anchor, i) => {
      if (!anchor) return;
      const [u, v] = anchor;
      const { el } = this._dials[i];
      const rim = centre && this._view.pointOnScreen(u, v);
      el.classList.toggle('off-screen', !rim);
      if (!rim) return;
      // Out from the model's centre through the rim, by half the dial and a gap.
      const dx = rim.x - centre.x, dy = rim.y - centre.y;
      const length = Math.hypot(dx, dy) || 1;
      const w = el.offsetWidth, h = el.offsetHeight;
      const out = Math.hypot(w * dx / length, h * dy / length) / 2 + 6;
      const cx = rim.x + dx / length * out, cy = rim.y + dy / length * out;
      // rim is in the canvas's pixels; the dial stays inside the part the panel leaves free
      const left = Math.min(free.right - w, Math.max(free.left, canvas.left + cx - w / 2));
      const top = Math.min(free.bottom - h, Math.max(free.top, canvas.top + cy - h / 2));
      const x = Math.round(left - box.left);
      const y = Math.round(top - box.top);
      el.style.setProperty('--x', `${x}px`);
      el.style.setProperty('--y', `${y}px`);
    });
  }

  _makeDial(place) {
    const back = Dom.el('button', { type: 'button', class: 'turn-step', title: t('Turn this place {n}° back (anticlockwise)', { n: TURN_STEP_DEG }) }, '↺');
    const input = Dom.el('input', { type: 'number', min: 0, max: 359, step: 1, 'aria-label': t('Turn of this place, degrees') });
    const on = Dom.el('button', { type: 'button', class: 'turn-step', title: t('Turn this place {n}° on (clockwise)', { n: TURN_STEP_DEG }) }, '↻');
    const name = Dom.el('span', { class: 'turn-name' });
    const another = t('Pick another place for this half; the other half stays');
    const edit = Dom.el('button', { type: 'button', class: 'turn-edit', title: another, 'aria-label': another }, Icon.make('pencil', 14));
    const el = Dom.el('div', { class: 'turn-dial glass', 'data-place': place, hidden: true }, back, Dom.el('label', { class: 'turn-value' }, input, '°'), on,
      Dom.el('div', { class: 'turn-name-row' }, name, edit));
    const turnBy = (step) => {
      this._turns[place] = normalTurn(this._turns[place] + step);
      input.value = this._turns[place];
      this._onTurn(place, this._turns[place]);
    };
    back.addEventListener('click', () => turnBy(-TURN_STEP_DEG));
    on.addEventListener('click', () => turnBy(TURN_STEP_DEG));
    input.addEventListener('change', () => {
      const deg = Number.parseFloat(input.value);
      if (!Number.isFinite(deg)) {
        input.value = this._turns[place];
        return;
      }
      this._turns[place] = normalTurn(Math.round(deg));
      input.value = this._turns[place];
      this._onTurn(place, this._turns[place]);
    });
    edit.addEventListener('click', () => this._onReplace(place));
    this._container.appendChild(el);
    return { el, input, name };
  }
}
