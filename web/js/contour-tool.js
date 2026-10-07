// Drawing a contour on the map: a click adds a corner, a click on the first corner (or a double
// click, or Enter) closes it, a corner can be dragged; undo (Cmd+Z, Ctrl+Z or Backspace) opens the
// contour again or takes the last corner back, redo does it again; Esc clears. The model is the ground inside the contour. With smooth corners (the usual) the contour
// is a smooth line through the corners (smooth.js); with sharp ones, straight lines between them.

import * as L from '../vendor/leaflet/leaflet-src.esm.js';
import { smoothPath } from './smooth.js';

const LINE = { color: '#8e90ff', weight: 3, opacity: 0.95 };
const NEAR_PX = 6;            // a double click's own two clicks land within this of each other

export class ContourTool {
  // onChange({ points, closed }): after every change.
  constructor({ onChange = () => {}, smooth = true } = {}) {
    this._onChange = onChange;
    this._smooth = smooth;
    this._map = null;
    this._points = [];          // L.LatLng
    this._undone = [];          // what undo took back, the last on top: a corner, or 'close'
    this._closed = false;
    this._shape = null;
    this._markers = [];
    this._onClick = (e) => this._add(e.latlng);
    this._onDoubleClick = () => this.close();
  }

  get points() { return this._points.map((p) => ({ lat: p.lat, lon: p.lng })); }
  get closed() { return this._closed; }
  get smooth() { return this._smooth; }

  // The contour as the model takes it: the corners, or the smooth line through them.
  get shapePoints() { return this._line().map((p) => ({ lat: p.lat, lon: p.lng })); }

  setSmooth(on) {
    this._smooth = Boolean(on);
    this._redraw();
  }

  attach(map) {
    this.detach();
    this._map = map;
    map.doubleClickZoom.disable();
    map.on('click', this._onClick);
    map.on('dblclick', this._onDoubleClick);
    this._map.getContainer().classList.add('drawing');
    this._redraw();
  }

  detach() {
    if (!this._map) return;
    this._map.off('click', this._onClick);
    this._map.off('dblclick', this._onDoubleClick);
    this._map.doubleClickZoom.enable();
    this._map.getContainer().classList.remove('drawing');
    this._shape?.remove();
    for (const m of this._markers) m.remove();
    this._shape = null;
    this._markers = [];
    this._map = null;
  }

  undo() {
    if (this._closed) {
      this._closed = false;
      this._undone.push('close');
    } else if (this._points.length) {
      this._undone.push(this._points.pop());
    } else {
      return;
    }
    this._redraw();
  }

  redo() {
    const step = this._undone.pop();
    if (step === undefined) return;
    if (step === 'close') this._closed = this._points.length >= 3;
    else this._points.push(step);
    this._redraw();
  }

  clear() {
    this._points = [];
    this._undone = [];
    this._closed = false;
    this._redraw();
  }

  close() {
    if (!this._map) return;
    // The two clicks of a double click put two corners on one spot: one of them goes.
    while (this._points.length > 1) {
      const [a, b] = this._points.slice(-2).map((p) => this._map.latLngToContainerPoint(p));
      if (a.distanceTo(b) > NEAR_PX) break;
      this._points.pop();
    }
    if (this._points.length < 3) return;
    this._closed = true;
    this._redraw();
  }

  // Corners given from outside (a contour from the library, or the one drawn before).
  set(points, closed = true) {
    this._points = points.map((p) => L.latLng(p.lat, p.lon));
    this._undone = [];
    this._closed = closed && this._points.length >= 3;
    this._redraw();
  }

  _add(latlng) {
    if (this._closed) return;
    this._points.push(latlng);
    this._undone = [];
    this._redraw();
  }

  _redraw() {
    if (this._map) {
      this._shape?.remove();
      for (const m of this._markers) m.remove();
      this._shape = this._closed
        ? L.polygon(this._line(), { ...LINE, fillColor: '#8e90ff', fillOpacity: 0.12 })
        : L.polyline(this._line(), { ...LINE, dashArray: '6 6' });
      this._shape.addTo(this._map);
      this._markers = this._points.map((p, i) => {
        const marker = L.marker(p, {
          draggable: true, keyboard: false,
          icon: L.divIcon({ className: `contour-corner${i === 0 ? ' first' : ''}`, iconSize: i === 0 ? [16, 16] : [12, 12] }),
        });
        marker.on('drag', (e) => {
          this._points[i] = e.target.getLatLng();
          this._shape.setLatLngs(this._line());
        });
        marker.on('dragend', () => this._onChange(this._state()));
        marker.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          if (i === 0 && !this._closed) this.close();
        });
        return marker.addTo(this._map);
      });
    }
    this._onChange(this._state());
  }

  _state() {
    return { points: this.points, closed: this._closed };
  }

  // The line drawn and captured, as L.LatLng. The smooth line is made in metres-like units about the
  // corners' middle (a degree of longitude shortened by the cosine of the latitude), so a round
  // corner is round on the ground.
  _line() {
    const n = this._points.length;
    if (!this._smooth || n < 3) return this._points;
    const lat0 = this._points.reduce((sum, p) => sum + p.lat, 0) / n;
    const lon0 = this._points.reduce((sum, p) => sum + p.lng, 0) / n;
    const k = Math.cos(lat0 * Math.PI / 180);
    const flat = this._points.map((p) => [(p.lng - lon0) * k, p.lat - lat0]);
    return smoothPath(flat, { closed: this._closed }).map(([x, y]) => L.latLng(lat0 + y, lon0 + x / k));
  }
}
