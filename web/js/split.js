// A model of two places side by side: one outline (the first place's circle or contour) cut in two
// by a line (divider.js), the first place on one side and the second on the other, both at the
// same scale. Both places are captured whole, in square frames that hold the outline however it is
// turned (capture.js), so the line can be moved, and each place turned and raised, afterwards
// without fetching again.
//
// Frame coordinates: u from the west edge of the frame (0) to the east edge (1), v from the north
// (0) to the south (1), with the outline's centre in the middle. Metres, as divider.js and
// outline.js have them: x east, y north from the middle.

import { HeightGrid } from './height-grid.js';
import { CircleOutline } from './outline.js';

// How the two halves stand against each other in height.
//   sea-level   the heights as measured, so a high place stands higher.
//   own-lowest  each half from its own lowest point, so only the relief compares.
export const VERTICAL_MODES = ['sea-level', 'own-lowest'];

// A point of the frame in metres, and back. frame: { widthM, heightM }.
export const toMetres = (u, v, frame) => [(u - 0.5) * frame.widthM, (0.5 - v) * frame.heightM];
export const toFrame = (x, y, frame) => [0.5 + x / frame.widthM, 0.5 - y / frame.heightM];

// A place turned about the centre of its frame, clockwise as seen from above (at 90 its north
// faces east). Given a frame position on the model, where on the place's own capture it falls.
export function turnedSource(turnDeg) {
  const a = turnDeg * Math.PI / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  return (u, v) => {
    const du = u - 0.5, dv = v - 0.5;
    return [0.5 + du * cos + dv * sin, 0.5 - du * sin + dv * cos];
  };
}

// A turn kept between 0 and 360.
export function normalTurn(deg) {
  if (!Number.isFinite(deg)) throw new RangeError(`a turn must be a number, got ${deg}`);
  return ((deg % 360) + 360) % 360;
}

// The turn a place takes on the model when its shape (the mask) was turned by maskDeg, clockwise,
// over its map while it was found: what lay in the mask's clear part comes into its part of the model,
// whose line stays as drawn. The place turns the other way: a mask turned 90° gives 270°.
export const turnForMask = (maskDeg) => normalTurn(-maskDeg);

// The lowest and the highest height a place shows inside the outline, the place turned by turnDeg:
// the heights of the model's nodes inside, read from the place as the model reads them. A circle is
// widened by one cell's diagonal: the model's edge runs through cells whose outer corners lie just
// outside it. Over the whole outline, not the half on show: moving the line must not move a half up
// or down.
export function rangeInside(grid, outline, frame, turnDeg = 0) {
  const n = Math.max(grid.cols, grid.rows);
  const source = turnedSource(turnDeg);
  const cell = Math.hypot(frame.widthM, frame.heightM) / (n - 1);
  const area = outline.kind === 'circle' ? new CircleOutline(outline.radiusM + cell) : outline;
  const xs = Array.from({ length: n }, (_, i) => toMetres(i / (n - 1), 0, frame)[0]);
  const row = new Uint8Array(n);
  let lowest = Infinity, highest = -Infinity;
  for (let j = 0; j < n; j++) {
    const v = j / (n - 1);
    area.insideRow(toMetres(0, v, frame)[1], xs, row);
    for (let i = 0; i < n; i++) {
      if (!row[i]) continue;
      const h = grid.sample(...source(i / (n - 1), v));
      if (h < lowest) lowest = h;
      if (h > highest) highest = h;
    }
  }
  return lowest <= highest ? { lowest, highest } : { lowest: NaN, highest: NaN };
}

// The heights each place is raised by: none for sea-level, each one's own lowest point brought to
// zero for own-lowest.
export function verticalOffsets(first, second, vertical, { outline, frame, turns = [0, 0] }) {
  if (!VERTICAL_MODES.includes(vertical)) throw new RangeError(`vertical must be one of ${VERTICAL_MODES.join(', ')}, got ${vertical}`);
  if (vertical === 'sea-level') return [0, 0];
  const low = (grid, turn) => rangeInside(grid, outline, frame, turn).lowest;
  return [-(low(first, turns[0]) || 0), -(low(second, turns[1]) || 0)];
}

// The vertical mode a pair of worlds starts with: heights from sea level when both are on Earth;
// otherwise each from its lowest point (the Moon, Mars and Venus have no sea, and their zero is a
// sphere someone chose).
export function defaultVertical(worlds) {
  return worlds.every((w) => w === 'earth') ? 'sea-level' : 'own-lowest';
}

// One grid of heights for the split model: each node takes the place on its side of the line,
// that place turned by its own turn and raised by its offset plus the user's own raise (metres).
// As fine as the finer of the two, up to maxCells a side.
export function composeHeights(first, second, { divider, outline, frame, vertical, turns = [0, 0], raises = [0, 0], maxCells = 1024 }) {
  const n = Math.min(maxCells, Math.max(first.cols, first.rows, second.cols, second.rows));
  const offsets = verticalOffsets(first, second, vertical, { outline, frame, turns });
  const sources = turns.map(turnedSource);
  const lift = [offsets[0] + raises[0], offsets[1] + raises[1]];
  const grids = [first, second];
  // Which place each node takes, a row at a time.
  const sides = divider.sides(outline.reachM);
  const side = new Uint8Array(n * n);
  const xs = Array.from({ length: n }, (_, i) => toMetres(i / (n - 1), 0, frame)[0]);
  const row = new Uint8Array(n);
  for (let j = 0; j < n; j++) {
    sides.sideRow(toMetres(0, j / (n - 1), frame)[1], xs, row);
    side.set(row, j * n);
  }
  const grid = HeightGrid.fill(n, n, (u, v) => {
    const s = side[Math.round(v * (n - 1)) * n + Math.round(u * (n - 1))];
    const [su, sv] = sources[s](u, v);
    return grids[s].sample(su, sv) + lift[s];
  });
  grid.offsets = offsets;
  return grid;
}

// The middle of each place's part of the outline, in metres; null for a place the line leaves no
// ground.
export function partMiddles(divider, outline, samples = 48) {
  const reach = outline.reachM;
  const sides = divider.sides(reach);
  const sums = [[0, 0, 0], [0, 0, 0]];
  const xs = Array.from({ length: samples }, (_, i) => -reach + 2 * reach * (i + 0.5) / samples);
  const inside = new Uint8Array(samples), side = new Uint8Array(samples);
  for (let j = 0; j < samples; j++) {
    const y = reach - 2 * reach * (j + 0.5) / samples;
    outline.insideRow(y, xs, inside);
    sides.sideRow(y, xs, side);
    for (let i = 0; i < samples; i++) {
      if (!inside[i]) continue;
      const sum = sums[side[i]];
      sum[0] += xs[i];
      sum[1] += y;
      sum[2] += 1;
    }
  }
  return sums.map(([sx, sy, count]) => (count ? [sx / count, sy / count] : null));
}

// Where each place's turn dial stands: on the outline's rim, out from the centre towards the middle
// of the place's part, in frame coordinates. null for a place the line leaves no ground.
export function sideAnchors(divider, outline, frame) {
  return partMiddles(divider, outline).map((middle) => {
    if (!middle) return null;
    const length = Math.hypot(...middle) || 1;
    const [x, y] = rimAlong(outline, middle[0] / length, middle[1] / length, outline.reachM);
    return toFrame(x, y, frame);
  });
}

// The outermost point of the outline along a ray from the centre (dx, dy: a unit vector).
function rimAlong(outline, dx, dy, reach) {
  const steps = 200;
  let inner = 0;
  for (let k = steps; k > 0; k--) {
    const t = reach * k / steps;
    if (outline.contains(dx * t, dy * t)) {
      inner = t;
      break;
    }
  }
  let outer = Math.min(reach * 1.001, inner + reach / steps);
  for (let k = 0; k < 30; k++) {
    const mid = (inner + outer) / 2;
    if (outline.contains(dx * mid, dy * mid)) inner = mid;
    else outer = mid;
  }
  return [dx * inner, dy * inner];
}

// The two places in one picture of `size` (browser only): the first everywhere, the second clipped
// to its side of the line, each turned as its heights are, and a thin light line between them
// inside the outline.
export function composeCanvas(firstCanvas, secondCanvas, size, { divider, outline, frame, turns = [0, 0], line = true, canvas = null }) {
  const out = canvas ?? document.createElement('canvas');
  out.width = size.w;
  out.height = size.h;
  const ctx = out.getContext('2d');
  const px = ([x, y]) => {
    const [u, v] = toFrame(x, y, frame);
    return [u * size.w, v * size.h];
  };
  const drawTurned = (picture, deg) => {
    ctx.save();
    ctx.translate(size.w / 2, size.h / 2);
    ctx.rotate(deg * Math.PI / 180);
    ctx.drawImage(picture, -size.w / 2, -size.h / 2, size.w, size.h);
    ctx.restore();
  };
  const sides = divider.sides(outline.reachM);
  drawTurned(firstCanvas, turns[0]);
  ctx.save();
  trace(ctx, sides.second.map(px), true);
  ctx.clip();
  drawTurned(secondCanvas, turns[1]);
  ctx.restore();
  if (line) {
    ctx.save();
    if (outline.kind === 'circle') {
      ctx.beginPath();
      ctx.ellipse(size.w / 2, size.h / 2, outline.radiusM / frame.widthM * size.w, outline.radiusM / frame.heightM * size.h, 0, 0, 2 * Math.PI);
    } else {
      trace(ctx, outline.points.map(px), true);
    }
    ctx.clip();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = Math.max(2, Math.round(Math.max(size.w, size.h) / 600));
    ctx.lineJoin = 'round';
    trace(ctx, sides.line.map(px), false);
    ctx.stroke();
    ctx.restore();
  }
  return out;
}

function trace(ctx, points, closed) {
  ctx.beginPath();
  points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  if (closed) ctx.closePath();
}
