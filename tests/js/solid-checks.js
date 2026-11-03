import { weld } from '../../web/js/exporters.js';

// Every edge of a closed surface belongs to two triangles that run it in opposite directions.
export function openEdges(solid) {
  const { vertices, faces } = weld([solid]);
  const count = new Map();
  for (let k = 0; k < faces.length; k += 3) {
    for (const [a, b] of [[faces[k], faces[k + 1]], [faces[k + 1], faces[k + 2]], [faces[k + 2], faces[k]]]) {
      const key = `${a}>${b}`;
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  }
  const bad = [];
  for (const [key, n] of count) {
    const [a, b] = key.split('>');
    if (n !== 1 || count.get(`${b}>${a}`) !== 1) bad.push(key);
  }
  return { bad, vertices };
}

// Volume by the divergence theorem: positive when the triangles face out.
export function volume({ positions, indices }) {
  let v = 0;
  for (let k = 0; k < indices.length; k += 3) {
    const [a, b, c] = [indices[k], indices[k + 1], indices[k + 2]].map((i) => positions.subarray(i * 3, i * 3 + 3));
    v += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  return v;
}
