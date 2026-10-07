// The shape of a model of two places on the map: the first place's outline (its circle or contour,
// at its size on the ground), the line that divides it (divider.js), the part that goes to the
// other place dimmed, and the parts' names. It stands on the first place while the line is drawn,
// and in the middle of the free part of the map, following the map, while another place is looked
// for there.
//
// SVG over the map, taking no clicks: the map under it pans and zooms as usual.

import { LocalFrame } from './geo.js';
import { mPerDegOf } from './worlds.js';
import { partMiddles } from './split.js';

const SVG = 'http://www.w3.org/2000/svg';
const CIRCLE_POINTS = 120;

export class ShapeOverlay {
  // svg: the <svg> element over the map.
  constructor(svg) {
    this._svg = svg;
    this._spec = null;
    this._middles = null;          // the parts' middles of the spec on show, in metres
    const el = (name, attrs = {}) => {
      const e = document.createElementNS(SVG, name);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
      return e;
    };
    this._clip = el('path');
    const defs = el('defs');
    defs.append(el('clipPath', { id: 'shape-clip' }));
    defs.firstChild.append(this._clip);
    this._outside = el('path', { class: 'shape-outside', 'fill-rule': 'evenodd' });
    this._shade = el('path', { class: 'shape-shade', 'clip-path': 'url(#shape-clip)', 'fill-rule': 'evenodd' });
    this._outline = el('path', { class: 'shape-outline' });
    this._line = el('path', { class: 'shape-line', 'clip-path': 'url(#shape-clip)' });
    this._names = [0, 1].map(() => el('text', { class: 'shape-name', 'text-anchor': 'middle' }));
    this._size = el('text', { class: 'shape-size', 'text-anchor': 'middle' });
    this._dots = el('g', { class: 'shape-points' });
    this._el = el;
    svg.append(defs, this._outside, this._shade, this._outline, this._line, ...this._names, this._size, this._dots);
    svg.toggleAttribute('hidden', true);      // an attribute: SVG elements have no `hidden` property
  }

  get spec() { return this._spec; }

  // spec: { outline (metres about the centre), centre: { lat, lon } or null (the free part's middle),
  // divider: Divider or null, keep: 0 or 1 (the part not dimmed) or null, names: [first, second]
  // (each part's name, '' for none), size: the text under the shape, points: the line's points
  // being drawn ([{ lat, lon }], drawn over all; the map's own markers under them take the drags),
  // turnDeg: the whole shape turned clockwise about its centre (the mask turned while a place is
  // found for a part: split.js turnForMask) }. null takes it away.
  set(spec) {
    this._spec = spec;
    this._middles = spec?.divider ? partMiddles(spec.divider, spec.outline) : null;
  }

  // Draw on `map` (Leaflet) for `world`; middle: the free part's middle { lat, lon }, where a spec
  // without a centre stands.
  draw(map, world, middle) {
    const spec = this._spec;
    this._svg.toggleAttribute('hidden', !spec || !map);
    if (!spec || !map) return;
    const centre = spec.centre ?? middle;
    const frame = new LocalFrame(centre.lat, centre.lon, mPerDegOf(world));
    const a = (spec.turnDeg ?? 0) * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
    const px = ([mx, my]) => {
      const { lat, lon } = frame.toLatLon(mx * cos + my * sin, -mx * sin + my * cos);
      const p = map.latLngToContainerPoint([lat, lon]);
      return [p.x, p.y];
    };
    const { outline, divider, keep } = spec;
    const rim = (outline.kind === 'circle' ? circlePoints(outline.radiusM) : outline.points).map(px);
    const shape = pathOf(rim, true);
    this._outline.setAttribute('d', shape);
    this._clip.setAttribute('d', shape);
    const size = map.getSize();
    this._outside.setAttribute('d', `M-10 -10H${size.x + 10}V${size.y + 10}H-10Z ${shape}`);
    let line = '', shade = '';
    if (divider) {
      const sides = divider.sides(outline.reachM);
      line = pathOf(sides.line.map(px), false);
      const second = pathOf(sides.second.map(px), true);
      // the second place's part, or (even-odd, inside the outline) the shape without it
      if (keep === 0) shade = second;
      else if (keep === 1) shade = `${shape} ${second}`;
    }
    this._line.setAttribute('d', line);
    this._shade.setAttribute('d', shade);
    this._names.forEach((text, i) => {
      const at = this._middles?.[i];
      const name = spec.names?.[i] ?? '';
      text.toggleAttribute('hidden', !at || !name);
      if (!at || !name) return;
      const [x, y] = px(at);
      text.setAttribute('x', x.toFixed(1));
      text.setAttribute('y', y.toFixed(1));
      text.textContent = name;
    });
    const bottom = Math.max(...rim.map(([, y]) => y));
    const left = Math.min(...rim.map(([x]) => x)), right = Math.max(...rim.map(([x]) => x));
    this._size.setAttribute('x', ((left + right) / 2).toFixed(1));
    this._size.setAttribute('y', (bottom + 20).toFixed(1));
    this._size.textContent = spec.size ?? '';
    this._dots.replaceChildren(...(spec.points ?? []).map((p, i) => {
      const at = map.latLngToContainerPoint([p.lat, p.lon]);
      return this._el('circle', { cx: at.x.toFixed(1), cy: at.y.toFixed(1), r: i === 0 ? 7 : 5.5, class: i === 0 ? 'first' : '' });
    }));
  }
}

function circlePoints(radiusM) {
  return Array.from({ length: CIRCLE_POINTS }, (_, k) => {
    const a = 2 * Math.PI * k / CIRCLE_POINTS;
    return [radiusM * Math.cos(a), radiusM * Math.sin(a)];
  });
}

function pathOf(points, closed) {
  return points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('') + (closed ? 'Z' : '');
}
