// A point of the model's top carried by hand: an element over the view (an end of the height ruler,
// an asteroid's label) grabbed with the mouse or a finger and dropped on another point, or moved by
// the arrow keys while it has the focus. The point under the pointer is found at most once a frame
// (step), and where the element was grabbed: the offset of the grab is kept, so a finger does not
// cover the point it carries. A click on the model is the page's still: only the element carries.

const KEY_PX = 8;              // an arrow key carries a focused element this far on the screen (1 px with Shift)

export class CarriedPoint {
  // el: the element. view: the 3D view (ModelView). shownAt() -> where the point carried shows now, in
  // page pixels, or null. onPoint({ u, v }): a new point of the model's top. active() -> whether it may
  // be carried now.
  constructor(el, { view, shownAt, onPoint, active = () => true }) {
    this._el = el;
    this._view = view;
    this._shownAt = shownAt;
    this._onPoint = onPoint;
    this._active = active;
    this._drag = null;            // { id, dx, dy, want } while the element is carried
    el.addEventListener('pointerdown', (e) => this._pressed(e));
    el.addEventListener('pointermove', (e) => this._moved(e));
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) el.addEventListener(type, (e) => this._letGo(e));
    el.addEventListener('keydown', (e) => this._keyed(e));
  }

  get carried() { return this._drag !== null; }

  // The point under the pointer, once a frame while the element is carried.
  step() {
    const drag = this._drag;
    if (!drag?.want) return;
    this._carry(drag.want);
    drag.want = null;
  }

  cancel() {
    this._drag = null;
    this._el.classList.remove('held');
  }

  _pressed(e) {
    if (e.button !== 0 || !this._active()) return;
    e.preventDefault();
    e.stopPropagation();
    this._el.focus({ preventScroll: true });
    this._el.setPointerCapture(e.pointerId);
    const at = this._shownAt() ?? { x: e.clientX, y: e.clientY };
    this._drag = { id: e.pointerId, dx: at.x - e.clientX, dy: at.y - e.clientY, want: null };
    this._el.classList.add('held');
  }

  _moved(e) {
    const drag = this._drag;
    if (drag?.id === e.pointerId) drag.want = { x: e.clientX + drag.dx, y: e.clientY + drag.dy };
  }

  _letGo(e) {
    const drag = this._drag;
    if (drag?.id !== e.pointerId) return;
    if (drag.want && this._active()) this._carry(drag.want);
    this.cancel();
  }

  _keyed(e) {
    const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    const at = this._shownAt();
    if (!step || !at || !this._active()) return;
    // the keys are the carried element's now, not free flight's
    e.preventDefault();
    e.stopPropagation();
    const px = e.shiftKey ? 1 : KEY_PX;
    this._carry({ x: at.x + step[0] * px, y: at.y + step[1] * px });
  }

  // The model's top under a point of the page; nothing off the top.
  _carry({ x, y }) {
    const pick = this._view.pickAt(x, y);
    if (pick && pick.u !== null) this._onPoint({ u: pick.u, v: pick.v });
  }
}
