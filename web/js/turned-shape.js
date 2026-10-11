// A shape put on the model (asteroid-on-model.js), turned round the vertical and tilted and leaned
// round the two horizontal axes, all about its middle, and lifted so that it still rests on its
// lowest point: the page hangs it by that point over the ground. The tilt comes first (round x), the
// lean next (round z) and the turn last (round y): a rocket laid along z by the tilt is then rolled
// round its own length by the lean, and turned round, lying, by the turn. Each of the three moves it
// another way wherever it stands, but one: leaned by 90°, the tilt does what the turn does.
//
// The lowest point is found from the shape's own vertices, all of them, at every turn: the box of a
// turned box is bigger than the shape, and a rock would hang over the ground by up to a fifth of
// its size. Only the vertical of each vertex is reckoned, three products each: fast enough for a
// slider even for the largest shape of the lists.

import * as THREE from '../vendor/three/three.module.js';

const DEG = Math.PI / 180;

// The three angles, in degrees, under the names a saved model keeps them by: round the vertical
// (0 to 360), round one horizontal axis and round the other (-180 to 180 each).
export const ANGLES = ['turnDeg', 'tiltDeg', 'leanDeg'];

export class TurnedShape {
  // shape: in metres, y up, its lowest point at 0 and its middle over the origin (fetchShape's).
  constructor(shape) {
    shape.updateMatrixWorld(true);
    const points = [], v = new THREE.Vector3();
    shape.traverse((part) => {
      const position = part.isMesh && part.geometry.getAttribute('position');
      if (!position) return;
      for (let k = 0; k < position.count; k++) {
        v.fromBufferAttribute(position, k).applyMatrix4(part.matrixWorld);
        points.push(v.x, v.y, v.z);
      }
    });
    const box = new THREE.Box3().setFromArray(points);
    const middle = box.getCenter(new THREE.Vector3());
    for (let k = 0; k < points.length; k += 3) {
      points[k] -= middle.x;
      points[k + 1] -= middle.y;
      points[k + 2] -= middle.z;
    }
    this._points = Float32Array.from(points);
    shape.position.sub(middle);                 // its middle at the turner's origin, the pivot
    this._turner = new THREE.Group();
    this._turner.rotation.order = 'YZX';        // tilted round x first, leaned round z, turned round y
    this._turner.add(shape);
    this.object = new THREE.Group();            // what the page hangs over the point
    this.object.add(this._turner);
    this.angles = TurnedShape.anglesOf();
    this.heightM = 0;                           // from its lowest point to its highest, as turned
    this.turn(this.angles);
  }

  // The three angles of a record (the sliders', or a saved model's, which keeps them by their names
  // among its other fields), each 0 where the record has none: a model saved before an angle came
  // was not turned that way.
  static anglesOf(record = {}) {
    return Object.fromEntries(ANGLES.map((name) => [name, Number.isFinite(record[name]) ? record[name] : 0]));
  }

  // Turned as `angles` says ({ turnDeg, tiltDeg, leanDeg }; one left out is 0).
  turn(angles) {
    this.angles = TurnedShape.anglesOf(angles);
    const { turnDeg, tiltDeg, leanDeg } = this.angles;
    this._turner.rotation.set(tiltDeg * DEG, turnDeg * DEG, leanDeg * DEG);
    this._turner.position.set(0, 0, 0);
    this._turner.updateMatrix();
    const e = this._turner.matrix.elements, p = this._points;      // column by column: y = e1 x + e5 y + e9 z
    let low = Infinity, high = -Infinity;
    for (let k = 0; k < p.length; k += 3) {
      const y = e[1] * p[k] + e[5] * p[k + 1] + e[9] * p[k + 2];
      if (y < low) low = y;
      if (y > high) high = y;
    }
    this._turner.position.y = -low;
    this.heightM = high - low;
  }
}
