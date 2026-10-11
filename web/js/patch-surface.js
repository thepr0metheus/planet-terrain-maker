// Clip the existing terrain's actual top triangles to one picture patch. New vertices interpolate
// the same positions and smooth normals, so detailed pictures do not create another terrain.
export class PatchSurface {
  constructor(geometry, topGroup, cells = 32) {
    this.geometry = geometry;
    this.cells = cells;
    this._buckets = new Map();
    const index = geometry.index.array, uv = geometry.attributes.uv.array;
    for (let i = topGroup.start; i < topGroup.start + topGroup.count; i += 3) {
      const ids = [index[i], index[i + 1], index[i + 2]];
      const us = ids.map((id) => uv[id * 2]), vs = ids.map((id) => 1 - uv[id * 2 + 1]);
      this._visit({ left: Math.min(...us), right: Math.max(...us), top: Math.min(...vs), bottom: Math.max(...vs) }, (key) => {
        if (!this._buckets.has(key)) this._buckets.set(key, []);
        this._buckets.get(key).push(i);
      });
    }
  }

  _visit(box, each) {
    const cell = (v) => Math.max(0, Math.min(this.cells - 1, Math.floor(v * this.cells)));
    for (let y = cell(box.top); y <= cell(box.bottom); y++) for (let x = cell(box.left); x <= cell(box.right); x++) each(y * this.cells + x);
  }

  patch(frame, x, y, z, size) {
    const candidates = new Set(), box = frame.bounds(x, y, z, size);
    if (box.left >= box.right || box.top >= box.bottom) return null;
    this._visit(box, (key) => { for (const i of this._buckets.get(key) ?? []) candidates.add(i); });
    const positions = [], normals = [], uvs = [], { attributes, index } = this.geometry;
    const vertex = (id) => {
      const p = frame.pixel(attributes.uv.array[id * 2], 1 - attributes.uv.array[id * 2 + 1], z);
      return [p.x, p.y, ...attributes.position.array.slice(id * 3, id * 3 + 3), ...attributes.normal.array.slice(id * 3, id * 3 + 3)];
    };
    const clip = (points, axis, edge, greater) => {
      const result = [];
      for (let i = 0; i < points.length; i++) {
        const a = points[i], b = points[(i + 1) % points.length];
        const insideA = greater ? a[axis] >= edge : a[axis] <= edge;
        const insideB = greater ? b[axis] >= edge : b[axis] <= edge;
        if (insideA) result.push(a);
        if (insideA !== insideB) {
          const t = (edge - a[axis]) / (b[axis] - a[axis]);
          result.push(a.map((value, k) => value + (b[k] - value) * t));
        }
      }
      return result;
    };
    for (const i of candidates) {
      let polygon = [vertex(index.array[i]), vertex(index.array[i + 1]), vertex(index.array[i + 2])];
      for (const [axis, edge, greater] of [[0, x, true], [0, x + size, false], [1, y, true], [1, y + size, false]]) {
        polygon = clip(polygon, axis, edge, greater);
        if (polygon.length < 3) break;
      }
      for (let k = 1; k + 1 < polygon.length; k++) for (const p of [polygon[0], polygon[k], polygon[k + 1]]) {
        // A tiny normal offset also prevents z-fighting in exported files.
        positions.push(p[2] + p[5] * .001, p[3] + p[6] * .001, p[4] + p[7] * .001);
        normals.push(...p.slice(5, 8));
        uvs.push((p[0] - x + 1) / (size + 2), 1 - (p[1] - y + 1) / (size + 2));
      }
    }
    return positions.length ? { positions: new Float32Array(positions), normals: new Float32Array(normals), uvs: new Float32Array(uvs) } : null;
  }
}
