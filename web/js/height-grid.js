// A grid of heights over a place: `cols` x `rows` heights in metres, row by row from the top
// (north) left (west) corner, NaN where the source has no height. The first and last rows and
// columns lie on the edges of the place: (u, v) = (0, 0) is the top left corner, (1, 1) the
// bottom right.
//
// The model, the heights on click and the two places all read heights through sample(u, v).

export class HeightGrid {
  constructor(cols, rows, data) {
    if (!(cols >= 2 && rows >= 2)) throw new RangeError(`a grid needs 2 x 2 heights at least, not ${cols} x ${rows}`);
    if (data.length !== cols * rows) throw new RangeError(`${cols} x ${rows} heights, but ${data.length} given`);
    this.cols = cols;
    this.rows = rows;
    this.data = data instanceof Float32Array ? data : Float32Array.from(data, (h) => (h === null ? NaN : h));
  }

  // A grid of `cols` x `rows` whose heights `at(u, v)` gives (NaN for none).
  static fill(cols, rows, at) {
    const data = new Float32Array(cols * rows);
    for (let j = 0; j < rows; j++) {
      const v = j / (rows - 1);
      for (let i = 0; i < cols; i++) data[j * cols + i] = at(i / (cols - 1), v);
    }
    return new HeightGrid(cols, rows, data);
  }

  get(i, j) {
    return this.data[j * this.cols + i];
  }

  // The height at (u, v), between the four nearest heights; those without a height are left
  // out, and NaN comes back only when all four are without. Outside 0..1 the edge is used.
  sample(u, v) {
    const fx = Math.min(this.cols - 1, Math.max(0, u * (this.cols - 1)));
    const fy = Math.min(this.rows - 1, Math.max(0, v * (this.rows - 1)));
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(this.cols - 1, x0 + 1), y1 = Math.min(this.rows - 1, y0 + 1);
    const tx = fx - x0, ty = fy - y0;
    const d = this.data, c = this.cols;
    let total = 0, weight = 0;
    const add = (h, w) => {
      if (w > 0 && h === h) { total += h * w; weight += w; }
    };
    add(d[y0 * c + x0], (1 - tx) * (1 - ty));
    add(d[y0 * c + x1], tx * (1 - ty));
    add(d[y1 * c + x0], (1 - tx) * ty);
    add(d[y1 * c + x1], tx * ty);
    return weight > 0 ? total / weight : NaN;
  }

  // How many heights are known.
  get known() {
    let n = 0;
    for (const h of this.data) if (h === h) n += 1;
    return n;
  }

  // The lowest and highest height where `inside(u, v)` holds (everywhere without it);
  // { lowest: NaN, highest: NaN } when there is none.
  range(inside = null) {
    let lowest = Infinity, highest = -Infinity;
    for (let j = 0; j < this.rows; j++) {
      const v = j / (this.rows - 1);
      for (let i = 0; i < this.cols; i++) {
        const h = this.data[j * this.cols + i];
        if (h !== h || (inside && !inside(i / (this.cols - 1), v))) continue;
        if (h < lowest) lowest = h;
        if (h > highest) highest = h;
      }
    }
    return lowest <= highest ? { lowest, highest } : { lowest: NaN, highest: NaN };
  }

  // A copy whose holes (NaN) take the height of the nearest known heights, spreading in from
  // the edges of each hole. A model needs a height everywhere; a hole is mostly a few cells
  // (a radar shadow, a void at the coast). A grid with no height at all comes back as zeros.
  filled() {
    const { cols, rows } = this;
    const out = Float32Array.from(this.data);
    let todo = [];
    for (let k = 0; k < out.length; k++) if (out[k] !== out[k]) todo.push(k);
    if (todo.length === out.length) return new HeightGrid(cols, rows, new Float32Array(out.length));
    while (todo.length) {
      const next = [];
      const found = [];
      for (const k of todo) {
        const i = k % cols, j = (k - i) / cols;
        let total = 0, count = 0;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ni = i + di, nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
          const h = out[nj * cols + ni];
          if (h === h) { total += h; count += 1; }
        }
        if (count) found.push([k, total / count]);
        else next.push(k);
      }
      for (const [k, h] of found) out[k] = h;
      todo = next;
    }
    return new HeightGrid(cols, rows, out);
  }

  // The grid as bytes for the library (float32, little-endian, NaN kept).
  toBytes() {
    const bytes = new Uint8Array(this.data.length * 4);
    const view = new DataView(bytes.buffer);
    this.data.forEach((h, k) => view.setFloat32(k * 4, h, true));
    return bytes;
  }

  static fromBytes(cols, rows, buffer) {
    const view = new DataView(buffer instanceof ArrayBuffer ? buffer : buffer.buffer, buffer.byteOffset ?? 0);
    if (view.byteLength < cols * rows * 4) throw new RangeError(`${cols} x ${rows} heights need ${cols * rows * 4} bytes, not ${view.byteLength}`);
    const data = new Float32Array(cols * rows);
    for (let k = 0; k < data.length; k++) data[k] = view.getFloat32(k * 4, true);
    return new HeightGrid(cols, rows, data);
  }
}
