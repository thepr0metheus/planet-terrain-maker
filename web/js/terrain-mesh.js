// The solid of a model: the ground inside the outline on top, walls straight down along the
// outline, and a flat bottom. One closed surface, so that a slicer can print it.
//
// The top is a grid of nodes over the place's frame. The outline cuts it the marching-squares way:
// a cell wholly inside gives two triangles, a cell the outline crosses gives the part of it that is
// inside, cut where the outline crosses the cell's edges. Two cells that share an edge share the
// point where the outline crosses it, so the walls meet the top without a gap. The nodes on the
// frame's border count as outside: every outline closes inside the frame.
//
// Coordinates are millimetres: x east, y north, z up, the bottom at z = 0, the frame's centre at
// x = y = 0. The view turns them to three.js's y-up; STL and 3MF take them as they are.

import { ShapeUtils, Vector2 } from '../vendor/three/three.module.js';

// Nodes along the longer side of the frame.
export const DETAIL = { low: 200, standard: 400, fine: 700 };

export const GROUP = { top: 0, side: 1, bottom: 2 };

export class OutlineTooSmall extends Error {}

// heights: a HeightGrid over the frame (no holes: HeightGrid.filled()). frame: { widthM, heightM }.
// outline: CircleOutline or PolygonOutline, in metres about the frame's centre.
// sizeMm: the model's size along the outline's longer side. zScale: how many times the heights
// are stretched. baseMm: what stands under the lowest point. nodes: DETAIL. floorM: heights below
// it are raised to it (calm water).
export function buildTerrainMesh({ heights, frame, outline, sizeMm = 100, zScale = 1, baseMm = 2, nodes = DETAIL.standard, floorM = -Infinity }) {
  const W = frame.widthM, H = frame.heightM;
  const nx = W >= H ? nodes : Math.max(2, Math.round(nodes * W / H));
  const ny = W >= H ? Math.max(2, Math.round(nodes * H / W)) : nodes;
  const bounds = outline.bounds;
  const mmPerM = sizeMm / Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
  const zMmPerM = mmPerM * zScale;

  const xs = new Float64Array(nx), ys = new Float64Array(ny);
  for (let i = 0; i < nx; i++) xs[i] = (i / (nx - 1) - 0.5) * W;
  for (let j = 0; j < ny; j++) ys[j] = (0.5 - j / (ny - 1)) * H;

  const inside = new Uint8Array(nx * ny);
  const row = new Uint8Array(nx);
  for (let j = 1; j < ny - 1; j++) {
    outline.insideRow(ys[j], xs, row);
    row[0] = 0;
    row[nx - 1] = 0;
    inside.set(row, j * nx);
  }

  const nodeH = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const h = heights.sample(i / (nx - 1), j / (ny - 1));
      nodeH[j * nx + i] = Math.max(h === h ? h : 0, floorM);
    }
  }

  // The points of the top: grid nodes inside, and where the outline crosses grid edges.
  const P = { x: [], y: [], h: [], u: [], v: [] };
  const crossing = [];                       // per point: whether it lies on the outline
  const nodeId = new Int32Array(nx * ny).fill(-1);
  const rowEdgeId = new Int32Array(nx * ny).fill(-1);    // edge (i, j)-(i+1, j)
  const colEdgeId = new Int32Array(nx * ny).fill(-1);    // edge (i, j)-(i, j+1)
  const addPoint = (x, y, h, onOutline) => {
    P.x.push(x); P.y.push(y); P.h.push(h);
    P.u.push(x / W + 0.5); P.v.push(0.5 - y / H);
    crossing.push(onOutline);
    return P.x.length - 1;
  };
  const nodePoint = (i, j) => {
    const k = j * nx + i;
    if (nodeId[k] < 0) nodeId[k] = addPoint(xs[i], ys[j], nodeH[k], false);
    return nodeId[k];
  };
  // The point where the outline crosses the edge from node (ia, ja), inside, to (ib, jb), outside.
  const crossPoint = (ia, ja, ib, jb) => {
    const ids = ja === jb ? rowEdgeId : colEdgeId;
    const key = Math.min(ja, jb) * nx + Math.min(ia, ib);
    if (ids[key] < 0) {
      const t = outline.crossing(xs[ia], ys[ja], xs[ib], ys[jb]);
      const ha = nodeH[ja * nx + ia], hb = nodeH[jb * nx + ib];
      ids[key] = addPoint(xs[ia] + t * (xs[ib] - xs[ia]), ys[ja] + t * (ys[jb] - ys[ja]), ha + t * (hb - ha), true);
    }
    return ids[key];
  };

  const topTris = [];
  const segments = [];                       // [from, to]: along the outline, inside on the left
  const corners = [[0, 1], [1, 1], [1, 0], [0, 0]];   // SW, SE, NE, NW as (di, dj): anticlockwise from above
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const at = corners.map(([di, dj]) => inside[(j + dj) * nx + i + di]);
      const count = at[0] + at[1] + at[2] + at[3];
      if (count === 0) continue;
      if (count === 4) {
        const [sw, se, ne, nw] = corners.map(([di, dj]) => nodePoint(i + di, j + dj));
        topTris.push(sw, se, ne, sw, ne, nw);
        continue;
      }
      // Round the cell: its corners inside, and the crossings between an inside and an outside one.
      const ring = [], onEdge = [];
      for (let c = 0; c < 4; c++) {
        const [di, dj] = corners[c], [ei, ej] = corners[(c + 1) % 4];
        if (at[c]) { ring.push(nodePoint(i + di, j + dj)); onEdge.push(false); }
        if (at[c] !== at[(c + 1) % 4]) {
          const [inI, inJ, outI, outJ] = at[c] ? [i + di, j + dj, i + ei, j + ej] : [i + ei, j + ej, i + di, j + dj];
          ring.push(crossPoint(inI, inJ, outI, outJ));
          onEdge.push(true);
        }
      }
      let rings = [[ring, onEdge]];
      // Two opposite corners inside: one piece if the cell's middle is inside, else two.
      if (count === 2 && at[0] === at[2] && !outline.contains((xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2)) {
        rings = [];
        for (let k = 0; k < ring.length; k++) {
          if (onEdge[k]) continue;
          const n = ring.length;
          rings.push([[ring[k], ring[(k + 1) % n], ring[(k - 1 + n) % n]], [false, true, true]]);
        }
      }
      for (const [r, edge] of rings) {
        for (let k = 1; k < r.length - 1; k++) topTris.push(r[0], r[k], r[k + 1]);
        for (let k = 0; k < r.length; k++) {
          const next = (k + 1) % r.length;
          if (edge[k] && edge[next]) segments.push([r[k], r[next]]);
        }
      }
    }
  }
  if (!topTris.length) throw new OutlineTooSmall('The outline holds no ground at this detail.');

  let lowest = Infinity, highest = -Infinity;
  for (const h of P.h) {
    if (h < lowest) lowest = h;
    if (h > highest) highest = h;
  }
  const zOf = (h) => baseMm + (h - lowest) * zMmPerM;

  // Walls: their own points, shared along the outline so that a round wall shades round.
  const loops = chainLoops(segments);
  const topCount = P.x.length;
  const wallTop = new Map(), wallBottom = new Map();
  let vertexCount = topCount;
  for (const [a] of segments) {
    if (!wallTop.has(a)) { wallTop.set(a, vertexCount++); wallBottom.set(a, vertexCount++); }
  }
  const bottomStart = vertexCount;
  vertexCount += loops.reduce((n, loop) => n + loop.length, 0);

  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const put = (k, p, z) => {
    positions[k * 3] = P.x[p] * mmPerM;
    positions[k * 3 + 1] = P.y[p] * mmPerM;
    positions[k * 3 + 2] = z;
    uvs[k * 2] = P.u[p];
    uvs[k * 2 + 1] = 1 - P.v[p];
  };
  for (let p = 0; p < topCount; p++) put(p, p, zOf(P.h[p]));
  for (const [p, k] of wallTop) put(k, p, zOf(P.h[p]));
  for (const [p, k] of wallBottom) put(k, p, 0);

  const indices = [];
  const groups = [];
  const group = (materialIndex, from) => groups.push({ start: from, count: indices.length - from, materialIndex });
  for (const k of topTris) indices.push(k);
  group(GROUP.top, 0);
  let from = indices.length;
  for (const [a, b] of segments) {
    const at = wallTop.get(a), ab = wallBottom.get(a), bt = wallTop.get(b), bb = wallBottom.get(b);
    indices.push(ab, bb, bt, ab, bt, at);
  }
  group(GROUP.side, from);
  from = indices.length;
  let next = bottomStart;
  for (const loop of loops) {
    const first = next;
    for (const p of loop) put(next++, p, 0);
    const contour = loop.map((p) => new Vector2(P.x[p], P.y[p]));
    for (const [a, b, c] of ShapeUtils.triangulateShape([...contour], [])) {
      // Facing down: the loop runs anticlockwise seen from above, so each triangle is turned over.
      const ccw = ShapeUtils.isClockWise([contour[a], contour[b], contour[c]]) ? [first + a, first + c, first + b] : [first + a, first + b, first + c];
      indices.push(ccw[0], ccw[2], ccw[1]);
    }
  }
  group(GROUP.bottom, from);

  return {
    positions, uvs,
    indices: vertexCount > 65535 ? Uint32Array.from(indices) : Uint16Array.from(indices),
    groups,
    mmPerM, zMmPerM, lowestM: lowest, highestM: highest, baseMm,
    size: { x: (bounds.maxX - bounds.minX) * mmPerM, y: (bounds.maxY - bounds.minY) * mmPerM, z: zOf(highest) },
    triangles: indices.length / 3,
    // the top's grid, for what is measured on the solid itself (topMm): nodes along x and along y,
    // and each node's height in metres, north row first
    top: { nx, ny, heights: nodeH },
  };
}

// The top of a solid at frame position (u, v) (0..1 from the west and from the north), millimetres
// above its bottom, as its own triangles stand: each cell of the grid is two triangles, cut along its
// south-west to north-east diagonal. A cell the outline crosses is cut otherwise; there the top
// differs from this by less than the cell's slope.
export function topMm(mesh, u, v) {
  const { nx, ny, heights } = mesh.top;
  const fi = Math.min(1, Math.max(0, u)) * (nx - 1), fj = Math.min(1, Math.max(0, v)) * (ny - 1);
  const i = Math.min(nx - 2, Math.floor(fi)), j = Math.min(ny - 2, Math.floor(fj));
  const s = fi - i, w = fj - j;              // how far east of the cell's west side, and south of its north side
  const nw = heights[j * nx + i], ne = heights[j * nx + i + 1];
  const sw = heights[(j + 1) * nx + i], se = heights[(j + 1) * nx + i + 1];
  const h = s + w <= 1 ? nw + s * (ne - nw) + w * (sw - nw) : se + (1 - s) * (sw - se) + (1 - w) * (ne - se);
  return mesh.baseMm + (h - mesh.lowestM) * mesh.zMmPerM;
}

// The outline's segments as closed loops of points, each in the segments' own order.
export function chainLoops(segments) {
  const from = new Map();
  for (const [a, b] of segments) from.set(a, b);
  const loops = [];
  const seen = new Set();
  for (const [start] of segments) {
    if (seen.has(start)) continue;
    const loop = [];
    let p = start;
    while (p !== undefined && !seen.has(p)) {
      seen.add(p);
      loop.push(p);
      p = from.get(p);
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}
