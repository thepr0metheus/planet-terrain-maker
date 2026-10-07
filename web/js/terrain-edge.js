// An outline that follows the relief: the closed line round a centre that keeps to the nearest
// ridge (or valley) within a band about a circle's radius, like the rim of a basin. The idea is the
// "Terrain edge" of Minimap Maker (Mike Jenkin, MIT); this code is our own.
//
// How it is found:
// - The heights are smoothed a little first, so one noisy cell is not taken for a ridge.
// - Along each of SECTORS rays from the centre, each radius in the band gets a score: how much the
//   ground there stands above the ground a window inwards and outwards (below, for a valley),
//   compressed (a ridge twice as high scores a little more, not twice), less a pull towards the
//   radius asked for.
// - One radius per ray is chosen for all rays at once (a route round the circle, best in sum, with a
//   cost for each jump between neighbours), so the line is one smooth closed curve and not a
//   zigzag from feature to feature.
// - When less than MIN_STRENGTH of the line lies on a real ridge (or valley), there is none to
//   follow: the answer says so, and gives no line.
//
// Metres: x east, y north from the centre, as outline.js has them.

import { HeightGrid } from './height-grid.js';
import { toFrame } from './split.js';

export const BAND = 0.2;            // the band looked in: this share of the radius either way
const SECTORS = 120;
const MIN_STRENGTH = 0.4;
const PULL = 0.3;                   // the pull towards the radius, at the edge of the band
const UNKNOWN = -0.2;               // the score of a spot without heights: a little worse than plain ground
const JUMP = 1;                     // the cost of the largest jump allowed between neighbours
const MAX_SLOPE = 0.5;              // radius change per metre along the arc, at most

export class TerrainEdge {
  // heights: a HeightGrid over `frame` ({ widthM, heightM }, the centre in its middle).
  // radiusM: the circle asked for. follow: 'ridge' or 'valley'.
  constructor({ heights, frame, radiusM, follow = 'ridge', band = BAND, sectors = SECTORS }) {
    if (follow !== 'ridge' && follow !== 'valley') throw new RangeError(`follow must be ridge or valley, not ${follow}`);
    if (!(radiusM > 0)) throw new RangeError(`the radius must be above 0, not ${radiusM}`);
    this.heights = heights;
    this.frame = frame;
    this.radiusM = radiusM;
    this.follow = follow;
    this.band = band;
    this.sectors = sectors;
    this.cellM = Math.max(frame.widthM / (heights.cols - 1), frame.heightM / (heights.rows - 1));
  }

  // { points: [[x, y], ...] in metres, or null; strength: the share of the line on a real ridge or
  // valley; reason: null, 'off-frame' (the band does not fit the heights) or 'flat' }.
  trace() {
    const R = this.radiusM, S = this.sectors;
    const inner = R * (1 - this.band), outer = R * (1 + this.band);
    const step = Math.min(this.cellM, 0.005 * R) || 0.005 * R;
    const candidates = Math.ceil((outer - inner) / step) + 1;
    const windowM = Math.min(Math.max(2 * this.cellM, 0.03 * R), inner / 2);
    const ws = Math.max(1, Math.round(windowM / step));
    const half = Math.min(this.frame.widthM, this.frame.heightM) / 2;
    if (outer + ws * step > half) return { points: null, strength: 0, reason: 'off-frame' };
    const thresholdM = Math.max(2, 0.002 * R);
    const field = smoothed(this.heights, Math.max(1.5 * this.cellM, 0.005 * R) / this.cellM);
    const sign = this.follow === 'ridge' ? 1 : -1;
    const at = (k, r) => {
      const a = 2 * Math.PI * (k + 0.5) / S;
      const [u, v] = toFrame(r * Math.cos(a), r * Math.sin(a), this.frame);
      return sign * field.sample(u, v);
    };

    // The score of each radius on each ray, and whether it is on a crest.
    const score = new Float64Array(S * candidates);
    const crest = new Float32Array(S * candidates);
    const profile = new Float64Array(candidates + 2 * ws);
    for (let k = 0; k < S; k++) {
      for (let e = 0; e < profile.length; e++) profile[e] = at(k, inner + (e - ws) * step);
      for (let j = 0; j < candidates; j++) {
        const inward = profile[j], here = profile[j + ws], outward = profile[j + 2 * ws];
        const p = here - (inward + outward) / 2;
        const evidence = Number.isFinite(p) ? Math.sign(p) * Math.log1p(Math.abs(p) / thresholdM) : UNKNOWN;
        const off = (inner + j * step - R) / (this.band * R);
        score[k * candidates + j] = evidence - PULL * off * off;
        crest[k * candidates + j] = here - Math.max(inward, outward);
      }
    }

    // The best closed route: one radius a ray.
    const arcM = 2 * Math.PI * R / S;
    const jump = Math.min(candidates - 1, Math.max(1, Math.floor(MAX_SLOPE * arcM / step)));
    const route = closedRoute(score, S, candidates, jump);

    const reach = Math.max(1, ws >> 1);
    let genuine = 0;
    for (let k = 0; k < S; k++) {
      for (let j = Math.max(0, route[k] - reach); j <= Math.min(candidates - 1, route[k] + reach); j++) {
        if (crest[k * candidates + j] >= thresholdM) {
          genuine += 1;
          break;
        }
      }
    }
    const strength = genuine / S;
    if (strength < MIN_STRENGTH) return { points: null, strength, reason: 'flat' };
    // The radii smoothed once round (1 : 2 : 1), so the step of the search does not show.
    const radii = Array.from(route, (j) => inner + j * step);
    const points = radii.map((r, k) => {
      const rr = 0.5 * r + 0.25 * (radii[(k + S - 1) % S] + radii[(k + 1) % S]);
      const a = 2 * Math.PI * (k + 0.5) / S;
      return [rr * Math.cos(a), rr * Math.sin(a)];
    });
    return { points, strength, reason: null };
  }
}

// The best route round S rays, one candidate a ray, closed: the summed scores less JUMP * (d/jump)²
// for a change of d between neighbours (d at most `jump`). A loop has no start: two free laps let
// the route settle, and the candidate it holds at the start of the second pins a last lap that
// ends within one jump of it.
function closedRoute(score, S, candidates, jump) {
  const cost = Float64Array.from({ length: jump + 1 }, (_, d) => JUMP * (d / jump) ** 2);
  const lap = (steps, pinned) => {
    let behind = new Float64Array(candidates), ahead = new Float64Array(candidates);
    const from = new Int32Array(steps * candidates);
    for (let j = 0; j < candidates; j++) behind[j] = pinned < 0 || j === pinned ? score[j] : -Infinity;
    for (let t = 1; t < steps; t++) {
      const row = (t % S) * candidates;
      for (let j = 0; j < candidates; j++) {
        let best = -Infinity, source = j;
        for (let p = Math.max(0, j - jump); p <= Math.min(candidates - 1, j + jump); p++) {
          const value = behind[p] - cost[Math.abs(p - j)];
          if (value > best) { best = value; source = p; }
        }
        ahead[j] = best + score[row + j];
        from[t * candidates + j] = source;
      }
      [behind, ahead] = [ahead, behind];
    }
    let end = 0, bestEnd = -Infinity;
    for (let j = 0; j < candidates; j++) {
      const gap = Math.abs(j - pinned);
      const value = pinned < 0 ? behind[j] : gap <= jump ? behind[j] - cost[gap] : -Infinity;
      if (value > bestEnd) { bestEnd = value; end = j; }
    }
    const route = new Int32Array(steps);
    route[steps - 1] = end;
    for (let t = steps - 1; t > 0; t--) route[t - 1] = from[t * candidates + route[t]];
    return route;
  };
  const settled = lap(2 * S, -1);
  return lap(S, settled[S]);
}

// The grid blurred by a Gaussian of sigma cells (rows, then columns), cells without a height left
// out (and left without one).
function smoothed(grid, sigma) {
  const reach = Math.max(1, Math.ceil(3 * sigma));
  const weights = Float64Array.from({ length: 2 * reach + 1 }, (_, d) => Math.exp(-((d - reach) ** 2) / (2 * sigma * sigma)));
  const { cols, rows, data } = grid;
  const pass = (src, along) => {
    const out = new Float32Array(src.length);
    const [n, m] = along === 'row' ? [rows, cols] : [cols, rows];
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < m; b++) {
        const index = along === 'row' ? a * cols + b : b * cols + a;
        if (src[index] !== src[index]) { out[index] = NaN; continue; }
        let sum = 0, weight = 0;
        for (let d = -reach; d <= reach; d++) {
          const c = b + d;
          if (c < 0 || c >= m) continue;
          const value = src[along === 'row' ? a * cols + c : c * cols + a];
          if (value !== value) continue;
          sum += weights[d + reach] * value;
          weight += weights[d + reach];
        }
        out[index] = sum / weight;
      }
    }
    return out;
  };
  return new HeightGrid(cols, rows, pass(pass(data, 'row'), 'col'));
}
