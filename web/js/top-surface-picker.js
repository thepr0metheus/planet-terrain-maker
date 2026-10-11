// Repeated visibility probes need only the terrain's top. Index its triangles once in frame cells,
// then test rays against occupied cell boxes before touching triangles. Full scene picking still
// belongs to ModelView, where buildings, sides and asteroids matter for user clicks.
import * as THREE from '../vendor/three/three.module.js';

export class TopSurfacePicker {
  constructor(geometry, topGroup, cells = 32) {
    this.geometry = geometry;
    this._buckets = new Map();
    this._box = new THREE.Box3();
    this._a = new THREE.Vector3(); this._b = new THREE.Vector3(); this._c = new THREE.Vector3();
    this._point = new THREE.Vector3(); this._weights = new THREE.Vector3();
    const { position, uv } = geometry.attributes, index = geometry.index.array;
    const cell = (v) => Math.max(0, Math.min(cells - 1, Math.floor(v * cells)));
    const triangleBox = new THREE.Box3();
    for (let i = topGroup.start; i < topGroup.start + topGroup.count; i += 3) {
      const ia = index[i], ib = index[i + 1], ic = index[i + 2];
      this._a.fromBufferAttribute(position, ia); this._b.fromBufferAttribute(position, ib); this._c.fromBufferAttribute(position, ic);
      triangleBox.makeEmpty().expandByPoint(this._a).expandByPoint(this._b).expandByPoint(this._c);
      this._box.union(triangleBox);
      const left = cell(Math.min(uv.getX(ia), uv.getX(ib), uv.getX(ic)));
      const right = cell(Math.max(uv.getX(ia), uv.getX(ib), uv.getX(ic)));
      const bottom = cell(Math.min(uv.getY(ia), uv.getY(ib), uv.getY(ic)));
      const top = cell(Math.max(uv.getY(ia), uv.getY(ib), uv.getY(ic)));
      for (let y = bottom; y <= top; y++) for (let x = left; x <= right; x++) {
        const key = y * cells + x;
        if (!this._buckets.has(key)) this._buckets.set(key, { box: new THREE.Box3(), triangles: [] });
        const bucket = this._buckets.get(key);
        bucket.box.union(triangleBox); bucket.triangles.push(i);
      }
    }
  }

  hit(ray) {
    if (!ray.intersectsBox(this._box)) return null;
    const candidates = [];
    for (const bucket of this._buckets.values()) {
      if (!ray.intersectBox(bucket.box, this._point)) continue;
      const distance = bucket.box.containsPoint(ray.origin) ? 0 : ray.origin.distanceToSquared(this._point);
      candidates.push({ bucket, distance });
    }
    candidates.sort((a, b) => a.distance - b.distance);
    let nearest = Infinity, hit = null;
    const checked = new Set(), { position, uv } = this.geometry.attributes, index = this.geometry.index.array;
    for (const { bucket, distance } of candidates) {
      if (distance > nearest) break;
      for (const i of bucket.triangles) {
        if (checked.has(i)) continue;
        checked.add(i);
        const ia = index[i], ib = index[i + 1], ic = index[i + 2];
        this._a.fromBufferAttribute(position, ia); this._b.fromBufferAttribute(position, ib); this._c.fromBufferAttribute(position, ic);
        if (!ray.intersectTriangle(this._a, this._b, this._c, true, this._point)) continue;
        const d = ray.origin.distanceToSquared(this._point);
        if (d >= nearest) continue;
        nearest = d;
        THREE.Triangle.getBarycoord(this._point, this._a, this._b, this._c, this._weights);
        const w = this._weights;
        hit = { point: this._point.clone(), u: w.x * uv.getX(ia) + w.y * uv.getX(ib) + w.z * uv.getX(ic),
          v: 1 - (w.x * uv.getY(ia) + w.y * uv.getY(ib) + w.z * uv.getY(ic)) };
      }
    }
    return hit;
  }
}
