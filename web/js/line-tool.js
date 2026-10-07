// The line between two places while it is drawn on the model (the first place is shown in 3D at
// once, and the line is chosen on it, not on the map). Through the centre at a turn, or by
// points: points 1, 2, 3… clicked on the model, a smooth curve through them (divider.js); any point,
// the middle ones too, can be taken away. Points are metres about the model's middle, x east, y north.
// Each adding, taking away and clearing can be undone and redone; a turn or a swap of the whole line
// starts the undoing anew. Only the state is kept here: the model screen draws it, compare-flow.js
// wires the buttons, the keys and the clicks.

import { Divider } from './divider.js';

const KINDS = ['centre', 'drawn'];

export class LineTool {
  // onChange(): after every change, and when the drawing starts or stops.
  constructor(onChange = () => {}) {
    this.onChange = onChange;
    this.active = false;
    this.kind = 'centre';
    this.angleDeg = 0;
    this.points = [];
    this._done = [];               // what was done to the points, last last: { add | remove | clear }
    this._undone = [];
  }

  // Draw again from a line: through the centre at its turn, or its points with the turn in them (the
  // line drawn anew starts unturned). No line: through the centre, unturned.
  start(divider = null) {
    this.active = true;
    this._forget();
    if (divider?.drawn) {
      const a = divider.angleDeg * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
      this.kind = 'drawn';
      this.angleDeg = 0;
      this.points = divider.points.map(([x, y]) => [x * cos + y * sin, -x * sin + y * cos]);
    } else {
      this.kind = 'centre';
      this.angleDeg = divider?.angleDeg ?? 0;
      this.points = [];
    }
    this.onChange();
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.onChange();
  }

  setKind(kind) {
    if (!KINDS.includes(kind)) throw new RangeError(`no such line: ${kind}`);
    this.kind = kind;
    this.onChange();
  }

  // Turn the line by deg, clockwise about the centre: an own line turns its points.
  turn(deg) {
    if (this.kind === 'drawn') {
      const a = deg * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
      this.points = this.points.map(([x, y]) => [x * cos + y * sin, -x * sin + y * cos]);
      this._forget();
    } else {
      this.angleDeg = normal(this.angleDeg + deg);
    }
    this.onChange();
  }

  // The centre line at a turn, in degrees clockwise from north.
  setAngle(deg) {
    if (this.kind !== 'centre' || !Number.isFinite(deg)) return;
    this.angleDeg = normal(deg);
    this.onChange();
  }

  // Each place takes the other part.
  swap() {
    if (this.kind === 'drawn') {
      this.points = [...this.points].reverse();
      this._forget();
    } else {
      this.angleDeg = normal(this.angleDeg + 180);
    }
    this.onChange();
  }

  // The next point, at the end of the line.
  add([x, y]) {
    this._do({ add: true, index: this.points.length, point: [x, y] });
  }

  // Take point `index` away (0 is point 1), wherever it is on the line.
  removeAt(index) {
    if (!(index >= 0 && index < this.points.length)) return;
    this._do({ add: false, index, point: this.points[index] });
  }

  clear() {
    if (!this.points.length) return;
    this._do({ clear: this.points });
  }

  undo() {
    const step = this._done.pop();
    if (!step) return;
    this.points = unapply(this.points, step);
    this._undone.push(step);
    this.onChange();
  }

  redo() {
    const step = this._undone.pop();
    if (!step) return;
    this.points = apply(this.points, step);
    this._done.push(step);
    this.onChange();
  }

  _do(step) {
    this.points = apply(this.points, step);
    this._done.push(step);
    this._undone = [];
    this.onChange();
  }

  _forget() {
    this._done = [];
    this._undone = [];
  }

  // The line as it is: a Divider, or null while an own line has fewer than two points.
  divider() {
    if (this.kind === 'centre') return new Divider({ angleDeg: this.angleDeg });
    return this.points.length >= 2 ? new Divider({ points: this.points }) : null;
  }
}

const normal = (deg) => ((Math.round(deg) % 360) + 360) % 360;

// The points after a step, and before it.
function apply(points, step) {
  if (step.clear) return [];
  const out = [...points];
  if (step.add) out.splice(step.index, 0, step.point);
  else out.splice(step.index, 1);
  return out;
}

function unapply(points, step) {
  if (step.clear) return [...step.clear];
  const out = [...points];
  if (step.add) out.splice(step.index, 1);
  else out.splice(step.index, 0, step.point);
  return out;
}
