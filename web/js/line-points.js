// The points of a line drawn by points (line-tool.js) as numbered marks over the model: 1, 2, 3… in
// the order the line goes through them. Each stays over its place on the relief as the camera moves,
// as the heights' labels do (height-probe.js), and a click on it takes that point away (any point,
// the middle ones too). The marks are buttons over the view: a click on one reaches no
// model below it, so it adds no point and turns no view.

import { toFrame } from './split.js';
import { t } from './i18n.js';

export class LinePoints {
  // container: the element the marks lie in. view: the 3D view (ModelView). onRemove(index).
  constructor({ container, view, onRemove }) {
    this._container = container;
    this._view = view;
    this._onRemove = onRemove;
    this._marks = [];             // { el, u, v }
  }

  // The marks of these points, in metres about the middle of a model in `frame`; none for [].
  show(points, frame) {
    for (const mark of this._marks) mark.el.remove();
    this._marks = points.map(([x, y], i) => {
      const [u, v] = toFrame(x, y, frame);
      const words = t('Take point {n} away', { n: i + 1 });
      const el = Dom.el('button', { type: 'button', class: 'line-point', title: words, 'aria-label': words }, String(i + 1));
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        this._onRemove(i);
      });
      this._container.appendChild(el);
      return { el, u, v };
    });
    this.place();
  }

  // Keep each mark over its point, where the camera shows it now. Every frame.
  place() {
    if (!this._marks.length) return;
    const view = this._view.canvas.getBoundingClientRect();
    const box = this._container.getBoundingClientRect();
    for (const { el, u, v } of this._marks) {
      const p = this._view.pointOnScreen(u, v);
      el.hidden = !p;
      if (!p) continue;
      el.style.setProperty('--x', `${Math.round(p.x + view.left - box.left)}px`);
      el.style.setProperty('--y', `${Math.round(p.y + view.top - box.top)}px`);
    }
  }
}
