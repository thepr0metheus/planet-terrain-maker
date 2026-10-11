// The shapes of asteroids and comets as the page reads them (asteroid-on-model.js draws them): a text
// of vertices and facets (OBJ, and the radar models' "v" and "f" lines; VRML's IndexedFaceSet, as
// Rosetta's comet 67P comes; a table of radii by longitude and latitude, as Halley's shape comes)
// read into arrays, and the sizes a shape is put at. Pure rules of numbers and text, without state:
// functions.

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

// The same arrays from a VRML text: the numbers of "point [ ... ]" three by three, and the polygons of
// "coordIndex [ ... ]", each ended by -1 and cut into a fan of triangles.
export function readWrl(text) {
  const plain = String(text).replace(/#[^\n]*/g, ' ');
  const inside = (word) => {
    const start = plain.indexOf('[', plain.indexOf(word));
    const end = plain.indexOf(']', start);
    if (plain.indexOf(word) < 0 || start < 0 || end < 0) throw new Error('The shape holds no facets.');
    return plain.slice(start + 1, end).split(/[\s,]+/).filter(Boolean).map(Number);
  };
  const positions = inside('point');
  const count = positions.length / 3, indices = [];
  let polygon = [];
  for (const k of inside('coordIndex')) {
    if (k >= 0) {
      polygon.push(k);
      continue;
    }
    for (let n = 1; n < polygon.length - 1; n++) indices.push(polygon[0], polygon[n], polygon[n + 1]);
    polygon = [];
  }
  if (!count || !indices.length || positions.length % 3) throw new Error('The shape holds no facets.');
  if (positions.some((n) => !Number.isFinite(n)) || indices.some((k) => !(k < count))) throw new Error('The shape could not be read.');
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

// The same arrays from a table of "longitude latitude radius" lines (degrees, longitude positive west,
// radius in km), a radius for every point of a grid: a vertex at each, z to the north, and two
// triangles between each four neighbours.
export function readRadiusGrid(text) {
  const radius = new Map(), longitudes = new Set(), latitudes = new Set();
  for (const line of String(text).split('\n')) {
    const parts = line.trim().split(/\s+/).map(Number);
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) continue;
    const [lon, lat, r] = parts;
    radius.set(`${lon} ${lat}`, r);
    longitudes.add(lon);
    latitudes.add(lat);
  }
  const lons = [...longitudes].sort((a, b) => a - b), lats = [...latitudes].sort((a, b) => a - b);
  if (lons.length < 3 || lats.length < 3 || radius.size !== lons.length * lats.length) throw new Error('The shape could not be read.');
  const positions = [], indices = [], DEG = Math.PI / 180;
  for (const lat of lats) {
    for (const lon of lons) {
      const r = radius.get(`${lon} ${lat}`), east = -lon * DEG;
      positions.push(r * Math.cos(lat * DEG) * Math.cos(east), r * Math.cos(lat * DEG) * Math.sin(east), r * Math.sin(lat * DEG));
    }
  }
  const at = (i, j) => i * lons.length + j;
  for (let i = 0; i < lats.length - 1; i++) {
    for (let j = 0; j < lons.length - 1; j++) {
      indices.push(at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j), at(i + 1, j + 1), at(i, j + 1));
    }
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
