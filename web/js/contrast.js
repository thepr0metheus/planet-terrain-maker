// Stretching the levels of a picture: the Moon's and Mars's mosaics are grey and
// low in contrast (Kaguya's especially: a 2.6 km crater is a faint ring in it).
// The darkest and brightest few per cent are cut and the rest is spread over
// the full range, the same for every channel, so colours keep their hue.
//
// Plain functions on pixel arrays and counts: no state, and the tests run them
// on numbers. A captured picture is stretched on its own (stretchLevels); the
// map's tiles share one stretch made from all of them in view (stretched-tiles.js).

// How many pixels of each grey (0..255) a picture has. rgba: the pixels as a
// Uint8ClampedArray (r, g, b, a, ...). Transparent pixels do not count.
export function levelHistogram(rgba) {
  const histogram = new Uint32Array(256);
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) continue;
    histogram[Math.round(0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2])] += 1;
  }
  return histogram;
}

// The greys to become black and white: the one below which `low` of the pixels
// lie (at least the darkest one) and the one below which `high` do. Null when
// there are no pixels.
export function levelsOf(histogram, { low = 0.01, high = 0.99 } = {}) {
  let count = 0;
  for (const n of histogram) count += n;
  if (count === 0) return null;
  const level = (share) => {
    const target = Math.max(1, Math.ceil(share * count));
    let seen = 0;
    for (let v = 0; v < 256; v++) {
      seen += histogram[v];
      if (seen >= target) return v;
    }
    return 255;
  };
  return { lo: level(low), hi: level(high) };
}

// Levels at least `minSpan` greys apart, widened about their middle and kept in
// 0..255. Spreading a few greys over the full range makes steps between them and
// blows up the noise; a floor on the span caps the gain at 255 / minSpan.
export function widenLevels({ lo, hi }, minSpan) {
  if (hi - lo >= minSpan) return { lo, hi };
  const span = Math.min(255, minSpan);
  const from = Math.min(255 - span, Math.max(0, Math.round((lo + hi - span) / 2)));
  return { lo: from, hi: from + span };
}

// What each grey becomes: lo and below black, hi and above white, a straight
// line between.
export function levelTable({ lo, hi }) {
  const table = new Uint8ClampedArray(256);   // clamps to 0..255 and rounds
  const scale = 255 / (hi - lo);
  for (let v = 0; v < 256; v++) table[v] = (v - lo) * scale;
  return table;
}

// Every channel of `from` through the table, into `to` (the same array by
// default); alpha is copied.
export function applyLevelTable(from, table, to = from) {
  for (let i = 0; i < from.length; i += 4) {
    to[i] = table[from[i]];
    to[i + 1] = table[from[i + 1]];
    to[i + 2] = table[from[i + 2]];
    to[i + 3] = from[i + 3];
  }
}

// Whether a stretch is worth redrawing for: the new levels lie within a few per
// cent of the span from the ones drawn. Panning a little moves the levels by a
// grey or two, and the tiles on screen should not flicker for that.
export function levelsClose(a, b, share = 0.04) {
  if (!a || !b) return a === b;
  const tolerance = Math.max(2, share * (b.hi - b.lo));
  return Math.abs(a.lo - b.lo) + Math.abs(a.hi - b.hi) <= tolerance;
}

// Stretch one picture by its own levels, in place. Returns { lo, hi }, the
// levels that became 0 and 255, or null when the picture is flat (nothing to
// stretch) or has no visible pixels.
export function stretchLevels(rgba, { low = 0.01, high = 0.99 } = {}) {
  const levels = levelsOf(levelHistogram(rgba), { low, high });
  if (!levels || levels.hi - levels.lo < 2) return null;
  applyLevelTable(rgba, levelTable(levels));
  return levels;
}
