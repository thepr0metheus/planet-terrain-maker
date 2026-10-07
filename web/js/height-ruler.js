// A ruler of heights over the model, to see that the heights are shown and counted right.
// It stands upright where its top was carried to, the top on the model's top; its foot stays at the
// level of its zero, another point of the top. Its marks count metres up (or down) from that level
// as the model stands them, "Heights ×" included, so the top reads how high the model stands there
// over the zero. Beside the top: that reading; the same between the two points as the data has it;
// the model's own millimetres; how far apart the two points are across.
//
// Both ends are carried by hand, grabbed and dropped: the ring at the top to another point, the "0"
// to another level; arrow keys move a focused end a little. A click on the
// model stays the page's: the height there, and the view turning about it.
//
// The ruler is drawn over the view, not into it: no picture, video or file of the model has it.

import { number, t } from './i18n.js';

const SVG = 'http://www.w3.org/2000/svg';
const NICE = [1, 2, 5, 10];
const LABEL_PX = 30;           // the numbered marks stand at least this far apart on the screen
const TICK_PX = 7;             // and the small marks between them
const TICK = { major: 9, minor: 5 };     // how long the marks are, px
const MOST_MARKS = 200;        // more marks than this on the ruler: the small ones are left out
const KEY_PX = 8;              // an arrow key carries a focused end this far on the screen (1 px with Shift)
const READING_GAP = 18;        // the reading stands this far right of the top (or left, near the panel)

// The steps between the ruler's marks, in metres: `major` between the numbered marks, at least
// labelPx apart on the screen, and `minor` between the small marks (0 for none), at least tickPx
// apart. pxPerM: the pixels a metre of height takes on the ruler now.
export function markSteps(pxPerM, { labelPx = LABEL_PX, tickPx = TICK_PX } = {}) {
  if (!(pxPerM > 0) || !Number.isFinite(pxPerM)) return { major: 0, minor: 0 };
  const least = Math.max(0.1, labelPx / pxPerM);
  const decade = 10 ** Math.floor(Math.log10(least));
  const n = NICE.find((k) => k * decade >= least * (1 - 1e-9));
  const major = n * decade;
  const parts = { 1: [5, 2], 2: [4, 2], 5: [5], 10: [5, 2] }[n];
  const minor = parts.map((p) => major / p).find((step) => step * pxPerM >= tickPx) ?? 0;
  return { major, minor };
}

// The heights of the marks from 0 towards `drop`, `step` apart, in metres; the 0 always.
export function markHeights(drop, step) {
  if (!(step > 0) || !Number.isFinite(drop)) return [0];
  const sign = drop < 0 ? -1 : 1;
  const count = Math.floor(Math.abs(drop) / step + 1e-9);
  return Array.from({ length: count + 1 }, (_, k) => sign * k * step || 0);
}

// The number of a mark: as many decimals as its step needs, a minus sign for those under the zero.
export function markNumber(height, step) {
  const digits = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  const value = Number(height.toFixed(digits));
  return value < 0 ? `−${number(-value, digits)}` : number(value, digits);
}

// What the ruler reads between its two ends, each { x, y, z } in the model's millimetres (z up):
// mm, the top over the zero on the model; metres, the same in the metres of the model's heights;
// data, the same as the data has it (from the heights at both ends; NaN when one has none); acrossM,
// how far apart the two ends are, across.
export function rulerReading({ zero, top, zeroData, topData, zMmPerM, mmPerM }) {
  const mm = top.z - zero.z;
  return { mm, metres: mm / zMmPerM, data: topData - zeroData, acrossM: Math.hypot(top.x - zero.x, top.y - zero.y) / mmPerM };
}

// Metres as the ruler shows them: tenths under 10 m, whole metres from 10 m.
function shown(m) {
  const digits = Math.abs(m) < 9.95 ? 1 : 0;
  return { digits, value: Number(m.toFixed(digits)) };
}

// A height over the zero: "+2,735 m", "−12 m"; tenths under 10 m ("+3.4 m"); "0 m".
export function signedMetres(m) {
  const { digits, value } = shown(m);
  if (value === 0) return t('{n} m', { n: 0 });
  return t('{n} m', { n: `${value > 0 ? '+' : '−'}${number(Math.abs(value), digits)}` });
}

// A height without its sign: "497 m", "3.4 m".
function plainMetres(m) {
  const { digits, value } = shown(Math.abs(m));
  return t('{n} m', { n: number(value, digits) });
}

// Why the ruler's two numbers differ, in parts that add up to the difference (the model's metres
// less the data's): `lift`, what the two ends' places stand higher by on the model than their data
// (the heights mode of two places and "Raise"; on one place it cancels out); `water`, calm water
// holding the ground up to its level; `grid`, the rest: the model is built on points further apart
// than the data's, and its two places meet in one cell of them. metres: the model's metres between the
// ends. zero, top: each end's { data, place, offset, raise, held } (ModelScreen._measured).
export function differenceParts({ metres, zero, top }) {
  const lift = zero.place === top.place ? 0 : (top.offset + top.raise) - (zero.offset + zero.raise);
  const water = top.held - zero.held;
  return { lift, water, grid: metres - (top.data - zero.data) - lift - water };
}

// The parts in words, those of `least` metres or more (the numbers' own rounding): the place each end
// is on, stood higher or lower on the model and by what; the water; the grid, its points `stepM`
// apart. names: the places' names. distance(m): a distance in words.
export function whyLines({ parts, zero, top, names, stepM, least, distance }) {
  const lines = [];
  if (zero.place !== top.place) {
    for (const end of [top, zero]) {
      const lift = end.offset + end.raise;
      if (end.place === null || Math.abs(lift) < least) continue;
      const causes = [];
      // the names of the page's own controls, in the quotation marks of the language in use
      const named = (control) => t('“{name}”', { name: t(control) });
      if (Math.abs(end.offset) >= least) causes.push(named('Lowest points level'));
      if (Math.abs(end.raise) >= least) causes.push(named('Raise'));
      if (!causes.length) causes.push(named(Math.abs(end.offset) >= Math.abs(end.raise) ? 'Lowest points level' : 'Raise'));
      const words = { name: names[end.place], n: plainMetres(lift), why: causes.join(t(' and ')) };
      lines.push(lift > 0 ? t('{name} stands {n} higher on the model ({why})', words) : t('{name} stands {n} lower on the model ({why})', words));
    }
  }
  if (Math.abs(parts.water) >= least) lines.push(t('calm water: {n}', { n: signedMetres(parts.water) }));
  if (Math.abs(parts.grid) >= least) lines.push(t('grid of the model: {n}, points {d} apart', { n: signedMetres(parts.grid), d: distance(stepM) }));
  return lines;
}

function signedMm(mm) {
  const value = Number(mm.toFixed(1));
  return value === 0 ? '0' : `${value > 0 ? '+' : '−'}${number(Math.abs(value), 1)}`;
}

function svgEl(tag, attributes = {}) {
  const el = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, value);
  return el;
}

export class HeightRuler {
  // container: the element the ruler lies in, over the view. view: the 3D view (ModelView).
  // distance(m): a distance in words (map-view.js formatDistance).
  constructor({ container, view, distance }) {
    this._container = container;
    this._view = view;
    this._distance = distance;
    this._model = null;         // what the ruler measures: measure()
    this._ends = null;          // { zero: { u, v }, top: { u, v } } while the ruler is out
    this._drag = null;          // { end, id, dx, dy, want } while an end is carried
    this._shown = { zero: null, top: null };    // where the ends show now, page pixels
    this._said = null;
    this._build();
  }

  get on() { return this._ends !== null; }

  // The ruler out, both ends at the point (u, v) of the model's top. model: as measure() takes it.
  start({ u, v }, model) {
    this._ends = { zero: { u, v }, top: { u, v } };
    this._root.hidden = false;
    this.measure(model);
  }

  stop() {
    this._ends = null;
    this._drag = null;
    this._root.hidden = true;
  }

  // What the ruler measures, again after the model is built anew (the ends keep their points):
  // top(u, v) -> the model's top at (u, v), { x, y, z } in its millimetres, z up; ground(u, v) ->
  // { data, place, offset, raise, held } there (differenceParts); zMmPerM, mmPerM: the model's
  // scales; names: its places' names; stepM: how far apart its points stand.
  measure(model) {
    this._model = model;
    this._said = null;
    if (this.on) this._draw();
  }

  // Keep the ruler on its points, where the camera shows them now; an end being carried goes to the
  // point under the pointer first. Every frame.
  place() {
    if (!this.on || !this._model) return;
    const drag = this._drag;
    if (drag?.want) {
      this._carry(drag.end, drag.want);
      drag.want = null;
    }
    this._draw();
  }

  // ---------- inside ----------

  _build() {
    this._lines = svgEl('svg', { class: 'ruler-lines', 'aria-hidden': 'true' });
    // each line twice: a dark one under a light one, seen over a light ground and a dark one
    this._level = [svgEl('line', { class: 'ruler-shade' }), svgEl('line', { class: 'ruler-level' })];
    this._bar = [svgEl('line', { class: 'ruler-shade wide' }), svgEl('line', { class: 'ruler-bar' })];
    this._ticks = [svgEl('path', { class: 'ruler-shade' }), svgEl('path', { class: 'ruler-ticks' })];
    this._numbers = svgEl('g', { class: 'ruler-numbers' });
    this._lines.append(...this._level, ...this._bar, ...this._ticks, this._numbers);
    const words = (text) => ({ title: t(text), 'aria-label': t(text) });
    this._zeroEl = Dom.el('button', { type: 'button', class: 'ruler-zero', ...words('Carry the zero to another level') }, '0');
    this._topEl = Dom.el('button', { type: 'button', class: 'ruler-top', ...words('Carry the ruler to another point') });
    this._reading = Dom.el('div', { class: 'ruler-reading' });
    this._readingWidth = null;  // px, measured once after the reading changes
    this._root = Dom.el('div', { class: 'height-ruler', hidden: true }, this._lines, this._reading, this._zeroEl, this._topEl);
    this._container.append(this._root);
    this._carried(this._zeroEl, 'zero');
    this._carried(this._topEl, 'top');
  }

  // An end carried by the pointer: the point under it, kept where it was grabbed, at most once a frame
  // (place); or by the arrow keys while it has the focus.
  _carried(el, end) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.on) return;
      e.preventDefault();
      e.stopPropagation();
      el.focus({ preventScroll: true });
      el.setPointerCapture(e.pointerId);
      const at = this._shown[end] ?? { x: e.clientX, y: e.clientY };
      this._drag = { end, id: e.pointerId, dx: at.x - e.clientX, dy: at.y - e.clientY, want: null };
      el.classList.add('held');
    });
    el.addEventListener('pointermove', (e) => {
      const drag = this._drag;
      if (drag?.id === e.pointerId) drag.want = { x: e.clientX + drag.dx, y: e.clientY + drag.dy };
    });
    const letGo = (e) => {
      const drag = this._drag;
      if (drag?.id !== e.pointerId) return;
      if (drag.want && this.on) this._carry(drag.end, drag.want);
      this._drag = null;
      el.classList.remove('held');
    };
    el.addEventListener('pointerup', letGo);
    el.addEventListener('pointercancel', letGo);
    el.addEventListener('lostpointercapture', letGo);
    el.addEventListener('keydown', (e) => {
      const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      const at = this._shown[end];
      if (!step || !at || !this.on) return;
      // the keys are the ruler's now, not free flight's
      e.preventDefault();
      e.stopPropagation();
      const px = e.shiftKey ? 1 : KEY_PX;
      this._carry(end, { x: at.x + step[0] * px, y: at.y + step[1] * px });
    });
  }

  // An end to the model's top under a point of the page; it stays where it was off the top.
  _carry(end, { x, y }) {
    const pick = this._view.pickAt(x, y);
    if (!pick || pick.u === null) return;
    this._ends[end] = { u: pick.u, v: pick.v };
  }

  _draw() {
    const m = this._model, ends = this._ends;
    const zero = m.top(ends.zero.u, ends.zero.v), top = m.top(ends.top.u, ends.top.v);
    const foot = { x: top.x, y: top.y, z: zero.z };
    // what is read of the page comes first, before anything on it moves (no layout forced each frame)
    const view = this._view.canvas.getBoundingClientRect(), box = this._container.getBoundingClientRect();
    const freeRight = this._view.freeRect().right;
    // container pixels of a point of the model, null behind the camera
    const at = (p) => {
      const s = this._view.onScreen(p);
      return s && { x: s.x + view.left - box.left, y: s.y + view.top - box.top };
    };
    const sZero = at(zero), sTop = at(top), sFoot = at(foot);
    const page = (s) => s && { x: s.x + box.left, y: s.y + box.top };
    this._shown = { zero: page(sZero), top: page(sTop) };
    const ground = { zero: m.ground(ends.zero.u, ends.zero.v), top: m.ground(ends.top.u, ends.top.v) };
    const reading = rulerReading({ zero, top, zeroData: ground.zero.data, topData: ground.top.data, zMmPerM: m.zMmPerM, mmPerM: m.mmPerM });
    const same = ends.zero.u === ends.top.u && ends.zero.v === ends.top.v;
    HeightRuler._put(this._zeroEl, sZero);
    HeightRuler._put(this._topEl, sTop);
    HeightRuler._put(this._reading, sTop);
    HeightRuler._line(this._level, sZero, sFoot);
    HeightRuler._line(this._bar, sFoot, sTop);
    this._marks({ foot, sFoot, sTop, metres: reading.metres, zMmPerM: m.zMmPerM, at, width: box.width, height: box.height });
    this._say(reading, same, ground);
    // the reading to the left of the top where the panel would cover it on the right
    if (sTop) {
      this._readingWidth ||= this._reading.offsetWidth;
      this._reading.classList.toggle('left', sTop.x + box.left + READING_GAP + this._readingWidth > freeRight);
    }
  }

  static _put(el, s) {
    el.hidden = !s;
    if (!s) return;
    el.style.setProperty('--x', `${Math.round(s.x)}px`);
    el.style.setProperty('--y', `${Math.round(s.y)}px`);
  }

  static _line(pair, a, b) {
    for (const line of pair) {
      line.removeAttribute('visibility');
      if (!a || !b) {
        line.setAttribute('visibility', 'hidden');
        continue;
      }
      line.setAttribute('x1', a.x.toFixed(1));
      line.setAttribute('y1', a.y.toFixed(1));
      line.setAttribute('x2', b.x.toFixed(1));
      line.setAttribute('y2', b.y.toFixed(1));
    }
  }

  // The marks along the ruler and their numbers, on its left on the screen (the reading is right).
  _marks({ foot, sFoot, sTop, metres, zMmPerM, at, width, height }) {
    let d = '';
    let used = 0;
    const length = sFoot && sTop ? Math.hypot(sTop.x - sFoot.x, sTop.y - sFoot.y) : 0;
    if (length >= 2 && Math.abs(metres) > 1e-6) {
      const { major, minor } = markSteps(length / Math.abs(metres));
      const across = { x: -(sTop.y - sFoot.y) / length, y: (sTop.x - sFoot.x) / length };
      const side = across.x > 0 ? { x: -across.x, y: -across.y } : across;
      const majors = markHeights(metres, major);
      const minors = minor && majors.length * (major / minor) <= MOST_MARKS ? markHeights(metres, minor) : [];
      const onView = (s) => s && s.x > -20 && s.y > -20 && s.x < width + 20 && s.y < height + 20;
      const mark = (h, long) => {
        const s = at({ x: foot.x, y: foot.y, z: foot.z + h * zMmPerM });
        if (!onView(s)) return null;
        d += `M${s.x.toFixed(1)} ${s.y.toFixed(1)}l${(side.x * long).toFixed(1)} ${(side.y * long).toFixed(1)}`;
        return s;
      };
      for (const h of minors) {
        const k = h / major;
        if (Math.abs(k - Math.round(k)) > 1e-6) mark(h, TICK.minor);
      }
      for (const h of majors) {
        const s = mark(h, TICK.major);
        // no number right at the top: the reading says it
        if (!s || Math.hypot(s.x - sTop.x, s.y - sTop.y) < LABEL_PX * 0.6) continue;
        const text = this._number(used++);
        const x = (s.x + side.x * (TICK.major + 4)).toFixed(1), y = (s.y + side.y * (TICK.major + 4)).toFixed(1);
        if (text.getAttribute('x') !== x) text.setAttribute('x', x);
        if (text.getAttribute('y') !== y) text.setAttribute('y', y);
        const anchor = side.x < -0.3 ? 'end' : 'middle';
        if (text.getAttribute('text-anchor') !== anchor) text.setAttribute('text-anchor', anchor);
        const words = markNumber(h, major);
        if (text.textContent !== words) text.textContent = words;
      }
    }
    for (const path of this._ticks) path.setAttribute('d', d || 'M0 0');
    while (this._numbers.childElementCount > used) this._numbers.lastChild.remove();
  }

  _number(k) {
    while (this._numbers.childElementCount <= k) this._numbers.append(svgEl('text', { 'dominant-baseline': 'middle' }));
    return this._numbers.children[k];
  }

  // The reading beside the top, written anew only when it changes.
  _say(reading, same, ground) {
    const m = this._model;
    const known = Number.isFinite(reading.data);
    const least = Math.abs(reading.metres) < 9.95 || Math.abs(reading.data) < 9.95 ? 0.05 : 0.5;
    const why = known ? whyLines({ parts: differenceParts({ metres: reading.metres, ...ground }), ...ground,
      names: m.names, stepM: m.stepM, least, distance: this._distance }) : [];
    // [class, words] a line: the reading, then the data's, why they differ, the millimetres, across
    const lines = same ? [['ruler-value', signedMetres(0)], ['ruler-more', t('Carry the ring to another point')]] : [
      ['ruler-value', signedMetres(reading.metres)],
      ['ruler-more', known ? t('by the data {n}', { n: signedMetres(reading.data) }) : t('by the data: no heights')],
      ...why.map((line) => ['ruler-why', line]),
      ['ruler-more', t('{n} mm on the model', { n: signedMm(reading.mm) })],
      ['ruler-more', t('{d} across', { d: this._distance(reading.acrossM) })],
    ];
    const key = lines.map(([, words]) => words).join('\n');
    if (key === this._said) return;
    this._said = key;
    this._readingWidth = null;
    this._reading.replaceChildren(...lines.map(([kind, words]) => Dom.el('div', { class: kind }, words)));
  }
}
