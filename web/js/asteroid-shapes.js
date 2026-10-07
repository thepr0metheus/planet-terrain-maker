// The shapes of asteroids as the page reads them (asteroid-on-model.js draws them): a text of vertices
// and facets (OBJ, and the radar models' "v" and "f" lines) read into arrays, and the sizes a shape is
// put at. Pure rules of numbers and text, without state: functions.

// { positions: Float32Array of x, y, z, indices: Uint32Array of triangles } from an OBJ text: "v x y z"
// lines, and "f a b c ..." lines with indices from 1 (or negative, back from the last vertex) in the
// forms "a", "a/t" and "a/t/n"; a facet of more corners is cut into a fan of triangles.
export function readObj(text) {
  const positions = [], indices = [];
  for (const line of String(text).split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'v' && parts.length >= 4) {
      positions.push(Number(parts[1]), Number(parts[2]), Number(parts[3]));
    } else if (parts[0] === 'f' && parts.length >= 4) {
      const count = positions.length / 3;
      const corners = parts.slice(1).map((p) => {
        const k = parseInt(p.split('/')[0], 10);
        return k < 0 ? count + k : k - 1;
      });
      for (let k = 1; k < corners.length - 1; k++) indices.push(corners[0], corners[k], corners[k + 1]);
    }
  }
  const count = positions.length / 3;
  if (!count || !indices.length) throw new Error('The shape holds no facets.');
  if (positions.some((n) => !Number.isFinite(n)) || indices.some((k) => !(k >= 0 && k < count))) {
    throw new Error('The shape could not be read.');
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

// The volume a closed shape holds, whichever way its triangles face (the sign is dropped).
export function volumeOf({ positions: p, indices }) {
  let six = 0;
  for (let k = 0; k < indices.length; k += 3) {
    const a = indices[k] * 3, b = indices[k + 1] * 3, c = indices[k + 2] * 3;
    six += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
      - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
      + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return Math.abs(six) / 6;
}

// The diameter of the sphere of the same volume: what a catalogue's "diameter" of an asteroid means.
export function equivalentDiameter(volume) {
  return Math.cbrt(6 * volume / Math.PI);
}

// How many metres one unit of a shape is, for a catalogue's diameter in km: that diameter over the
// diameter the shape has in its own units.
export function metresPerUnit(shape, diameterKm) {
  const own = equivalentDiameter(volumeOf(shape));
  if (!(own > 0)) throw new Error('The shape holds no volume.');
  return diameterKm * 1000 / own;
}

// The longest extent of a shape along x, y and z, in its own units.
export function longestExtent(positions) {
  let longest = 0;
  for (let axis = 0; axis < 3; axis++) {
    let low = Infinity, high = -Infinity;
    for (let k = axis; k < positions.length; k += 3) {
      if (positions[k] < low) low = positions[k];
      if (positions[k] > high) high = positions[k];
    }
    longest = Math.max(longest, high - low);
  }
  return longest;
}
