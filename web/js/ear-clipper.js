// Cuts a simple polygon into triangles by taking off one corner at a time (an "ear"), and keeps
// every corner of the polygon as a corner of some triangle. A corner on a straight stretch of the
// outline stays one: the wall that stands on that stretch has it too, and a triangle that skipped
// it would leave a crack between the wall and the bottom. Libraries that triangulate for drawing
// (earcut) may drop such a corner, and give slivers along a straight stretch whose own turn is
// rounding, so that turning each triangle by it tears the surface.
//
// The result is a disc by construction, whatever the numbers say: n - 2 triangles, each edge of
// the polygon in one of them, each cut between two of them run both ways. Only the shape of the
// triangles depends on the numbers.

// Within this part of the polygon's size, a corner is on a line, and touches a triangle. The
// points where an outline crosses a grid lie on its sides to within rounding, a million times
// closer than this.
const NEAR = 1e-9;

export class EarClipper {
  // x, y: the corners in order, anticlockwise (three at least).
  constructor(x, y) {
    if (x.length < 3 || x.length !== y.length) throw new RangeError(`a polygon needs 3 corners at least, got ${x.length} x and ${y.length} y`);
    this.n = x.length;
    this.x = Float64Array.from(x);
    this.y = Float64Array.from(y);
    let loX = Infinity, hiX = -Infinity, loY = Infinity, hiY = -Infinity;
    for (let v = 0; v < this.n; v++) {
      loX = Math.min(loX, this.x[v]); hiX = Math.max(hiX, this.x[v]);
      loY = Math.min(loY, this.y[v]); hiY = Math.max(hiY, this.y[v]);
    }
    this.near = NEAR * Math.max(hiX - loX, hiY - loY);
    // How many corners had to be cut although they were not clean ears: 0 for any simple polygon
    // that has no corner sharper than NEAR. Set by triangles().
    this.forced = 0;
  }

  // Twice the area of the triangle a, b, c: positive when it runs anticlockwise.
  _turn(a, b, c) {
    const { x, y } = this;
    return (x[b] - x[a]) * (y[c] - y[a]) - (y[b] - y[a]) * (x[c] - x[a]);
  }

  // 1 where the polygon turns left at b, between a and c (a corner that sticks out), -1 where it
  // turns right (a dent), 0 where b lies on the straight line from a to c.
  _bend(a, b, c) {
    const turn = this._turn(a, b, c);
    const slack = this.near * Math.hypot(this.x[c] - this.x[a], this.y[c] - this.y[a]);
    return turn > slack ? 1 : turn < -slack ? -1 : 0;
  }

  // Notes how corner v bends. The ones that do not stick out are the only ones that can stand in
  // an ear's way, so they are kept in a list of their own, with their places beside them: the test
  // of an ear runs over that list, and it is most of the work.
  _rate(v) {
    this._bends[v] = this._bend(this._prev[v], v, this._next[v]);
    if (this._bends[v] > 0) this._unlist(v);
    else if (this._slot[v] < 0) {
      const slot = this._listed++;
      this._slot[v] = slot;
      this._list[slot] = v;
      this._listX[slot] = this.x[v];
      this._listY[slot] = this.y[v];
    }
  }

  _unlist(v) {
    const slot = this._slot[v];
    if (slot < 0) return;
    const last = --this._listed;
    const moved = this._list[last];
    this._list[slot] = moved;
    this._listX[slot] = this._listX[last];
    this._listY[slot] = this._listY[last];
    this._slot[moved] = slot;
    this._slot[v] = -1;
  }

  // Whether a corner that does not stick out lies in the triangle a, b, c, or on its edges.
  _blocked(a, b, c) {
    const { x, y, near } = this;
    const loX = Math.min(x[a], x[b], x[c]) - near, hiX = Math.max(x[a], x[b], x[c]) + near;
    const loY = Math.min(y[a], y[b], y[c]) - near, hiY = Math.max(y[a], y[b], y[c]) + near;
    const slackAB = near * Math.hypot(x[b] - x[a], y[b] - y[a]);
    const slackBC = near * Math.hypot(x[c] - x[b], y[c] - y[b]);
    const slackCA = near * Math.hypot(x[a] - x[c], y[a] - y[c]);
    const { _listX: listX, _listY: listY } = this;
    for (let k = 0; k < this._listed; k++) {
      const wx = listX[k], wy = listY[k];
      if (wx < loX || wx > hiX || wy < loY || wy > hiY) continue;
      const w = this._list[k];
      if (w === a || w === b || w === c) continue;
      if (this._turn(a, b, w) >= -slackAB && this._turn(b, c, w) >= -slackBC && this._turn(c, a, w) >= -slackCA) return true;
    }
    return false;
  }

  // The corner to take off next, looking round from `from`: one that sticks out and has nothing
  // in its triangle. A polygon that is simple has two at least; one that is not quite (a corner
  // sharper than NEAR, two sides that touch) may have none, and then the thinnest triangle goes,
  // a flat one at best, which costs nothing.
  _ear(from, remaining) {
    for (let tried = 0, v = from; tried < remaining; tried++, v = this._next[v]) {
      if (this._bends[v] > 0 && !this._blocked(this._prev[v], v, this._next[v])) return v;
    }
    let thinnest = from, least = Infinity;
    for (let tried = 0, v = from; tried < remaining; tried++, v = this._next[v]) {
      const area = Math.abs(this._turn(this._prev[v], v, this._next[v]));
      if (area < least) { least = area; thinnest = v; }
    }
    if (this._bends[thinnest] !== 0) this.forced++;
    return thinnest;
  }

  // The triangles: corner numbers, three to a triangle, anticlockwise like the polygon.
  triangles() {
    const n = this.n;
    this.forced = 0;
    this._prev = Int32Array.from({ length: n }, (_, v) => (v + n - 1) % n);
    this._next = Int32Array.from({ length: n }, (_, v) => (v + 1) % n);
    this._bends = new Int8Array(n);
    this._list = new Int32Array(n);
    this._listX = new Float64Array(n);
    this._listY = new Float64Array(n);
    this._slot = new Int32Array(n).fill(-1);
    this._listed = 0;
    for (let v = 0; v < n; v++) this._rate(v);

    const out = new Uint32Array(3 * (n - 2));
    let at = 0;
    for (let remaining = n, k = 0; remaining > 3; remaining--, k += 3) {
      const tip = this._ear(at, remaining);
      const before = this._prev[tip], after = this._next[tip];
      out[k] = before; out[k + 1] = tip; out[k + 2] = after;
      this._next[before] = after;
      this._prev[after] = before;
      this._unlist(tip);
      this._rate(before);
      this._rate(after);
      at = before;
    }
    if (this._bends[at] < 0) this.forced++;
    out.set([this._prev[at], at, this._next[at]], out.length - 3);
    return out;
  }
}
