// Capturing a place: its heights and its picture, in the place's own flat frame (geo.js).
//
// The sources come in two kinds. Map tiles (Earth's photos and heights, the Moon's Kaguya, Venus's
// radar) are fetched through the server's tile relay and stitched here. Other sources answer one
// request for the region (Copernicus, Trek's heights and the Moon's and Mars's pictures). Either
// way the result is laid into the place's frame: a grid of heights and a picture, both north up,
// both covering the same ground.

import { HeightGrid } from './height-grid.js';
import { LocalFrame, LonLat, Mercator } from './geo.js';
import { CircleOutline } from './outline.js';
import { mPerDegOf, worldOf } from './worlds.js';
import { stretchLevels } from './contrast.js';
import { DEVICE } from './device.js';
import { t } from './i18n.js';
import { PictureDetail } from './picture-detail.js';

// The frame reaches this share of the outline's size beyond it on every side, so that the outline
// closes inside the grid (terrain-mesh.js) and the picture has ground to blur at its edge.
export const FRAME_MARGIN = 0.06;
export const MAX_CELLS = 1024;         // heights a side
export const MIN_CELLS = 160;
export const PICTURE_PX = 2048;        // picture a side, unless another is asked for
const MAX_TILES = 324;                 // 18 x 18: the heights, and a picture of 2048 points
const SERVER_IMAGE_PX = 4096;          // the server's own limit for one picture of a region (app/server.py)

// How many tiles a picture of `px` points across may take: enough to fill it at a zoom that fits,
// and on a touch device (device.js) no more than its canvas holds: 16 x 16 tiles of 256 points.
export function tileBudget(px, { mostPx = DEVICE.canvasMostPx } = {}) {
  const wanted = px >= 8192 ? 1600 : px >= 4096 ? 900 : MAX_TILES;
  return Math.min(wanted, (Math.floor(mostPx / 256)) ** 2);
}
// A tile the server could not get (5xx, 429, no answer) is asked again after each of these pauses:
// a busy service (EOX resets a burst of connections) mostly gives it the next time.
const TILE_REPEATS_MS = [1000, 3000];
const PARALLEL = 12;              // tiles fetched at once (over HTTP/2 through the server; a browser on HTTP/1.1 takes 6)
const SEA_FLOOR_SENTINEL = -12000;     // terrarium's "no data" decodes to -32768

export class CaptureError extends Error {
  constructor(message, { keyNeeded = false } = {}) {
    super(message);
    this.keyNeeded = keyNeeded;
  }
}

// A captured place: everything a model needs from the world.
export class Place {
  constructor({ world, center, frame, outline, heights, picture, name = '', sources = {}, capturedAt = new Date().toISOString(), stored = null }) {
    this.world = world;            // 'earth', 'moon', ...
    this.center = center;          // { lat, lon } of the frame's centre
    this.frame = frame;            // { widthM, heightM }
    this.outline = outline;        // in metres about the centre
    this.heights = heights;        // HeightGrid over the frame
    this.picture = picture;        // a canvas over the frame
    this.name = name;
    this.sources = sources;        // { heights, picture }: names of the data, for the credits
    this.capturedAt = capturedAt;
    this.stored = stored;          // { width, height, bytes() } of the saved file the picture is from, or null
  }

  // The picture on screen is smaller than its saved file: this device holds no bigger one (device.js).
  get reduced() {
    return Boolean(this.stored) && Math.max(this.picture.width, this.picture.height) < Math.max(this.stored.width, this.stored.height);
  }

  get localFrame() {
    return new LocalFrame(this.center.lat, this.center.lon, mPerDegOf(worldOf(this.world)));
  }

  // The outline's width on the ground, metres (a circle's diameter).
  get widthM() {
    const b = this.outline.bounds;
    return Math.max(b.maxX - b.minX, b.maxY - b.minY);
  }
}

// The frame for an outline: square for a circle, the outline's box for a contour, with the margin.
export function frameFor(outline) {
  const b = outline.bounds;
  const pad = FRAME_MARGIN * Math.max(b.maxX - b.minX, b.maxY - b.minY);
  return {
    widthM: 2 * (Math.max(Math.abs(b.minX), Math.abs(b.maxX)) + pad),
    heightM: 2 * (Math.max(Math.abs(b.minY), Math.abs(b.maxY)) + pad),
  };
}

// Run jobs at most `n` at a time.
async function inTurns(jobs, n) {
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) await jobs[next++]();
  };
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, worker));
}

const projections = {
  mercator: (lat, lon, z) => Mercator.px(lat, lon, z),
  lonlat: (lat, lon, z) => LonLat.px(lat, lon, z),
};

export class PlaceCapture {
  // fetchFn: window.fetch. canvas(w, h): a new canvas. decode(blob): an ImageBitmap (or an image).
  // onProgress(text): what is being done now, for the page to show.
  // wait(ms, signal): a pause before a tile is asked again. decodeImage(blob): a picture read as an
  // <img> reads it, for one the strict decode refuses.
  constructor({ fetchFn = (...a) => fetch(...a), canvas = defaultCanvas, decode = (blob) => createImageBitmap(blob), onProgress = () => {},
    wait = pauseFor, decodeImage = imageOf } = {}) {
    this._fetch = fetchFn;
    this._canvas = canvas;
    this._decode = decode;
    this._decodeImage = decodeImage;
    this._progress = onProgress;
    this._wait = wait;
  }

  // world: an id. center: { lat, lon }. outline: in metres about the centre.
  // heightsId / pictureId: which of the world's sources (worlds.js); the first by default.
  // picturePx: the picture's points along its longer side. turnable: the frame holds the outline
  // turned any way (a square about the farthest point of it), as a place of two places needs.
  async capture({ world: worldId, center, outline, heightsId = null, pictureId = null, pictureSource: suppliedPicture = null,
    picturePx = PICTURE_PX, pictureMostPx = DEVICE.canvasMostPx, turnable = false, signal = null }) {
    const world = worldOf(worldId);
    if (Math.abs(center.lat) > 84) throw new CaptureError('Places this close to a pole cannot be captured yet.');
    const frame = frameFor(turnable ? new CircleOutline(outline.reachM) : outline);
    const local = new LocalFrame(center.lat, center.lon, mPerDegOf(world));
    const box = local.boxOf(frame.widthM / 2, frame.heightM / 2);
    if (box.west < -180 || box.east > 180) throw new CaptureError('The place crosses the 180th meridian: move it a little east or west.');
    const side = Math.max(frame.widthM, frame.heightM);
    const heightsSource = world.heights.find((s) => s.id === heightsId) ?? world.heights[0];
    if (pictureId === 'custom' && !suppliedPicture) throw new CaptureError('Set the custom picture URL before capturing.');
    const pictureSource = suppliedPicture ?? pictureSourceFor(world, pictureId, side);

    this._progress('Heights');
    const heights = await this._heights(world, heightsSource, local, frame, box, side, signal);
    this._progress('Picture');
    const picture = await this._picture(world, pictureSource, local, frame, box, side, picturePx, signal, pictureMostPx);
    return new Place({
      world: world.id, center: { lat: center.lat, lon: center.lon }, frame, outline, heights, picture,
      sources: { heights: heights.sourceName ?? heightsSource.label, picture: pictureSource.label, ...(pictureSource.metadata ?? {}) },
    });
  }

  // The heights about a centre out to reachM, for a look before the capture (the edge that follows
  // the relief): { heights: HeightGrid, frame }, at most maxCells a side.
  async heightsAround({ world: worldId, center, reachM, heightsId = null, maxCells = 256, signal = null }) {
    const world = worldOf(worldId);
    if (Math.abs(center.lat) > 84) throw new CaptureError('Places this close to a pole cannot be captured yet.');
    const frame = frameFor(new CircleOutline(reachM));
    const local = new LocalFrame(center.lat, center.lon, mPerDegOf(world));
    const box = local.boxOf(frame.widthM / 2, frame.heightM / 2);
    if (box.west < -180 || box.east > 180) throw new CaptureError('The place crosses the 180th meridian: move it a little east or west.');
    const source = world.heights.find((s) => s.id === heightsId) ?? world.heights[0];
    const heights = await this._heights(world, source, local, frame, box, Math.max(frame.widthM, frame.heightM), signal, maxCells);
    return { heights, frame };
  }

  // ---------- heights ----------

  async _heights(world, source, local, frame, box, side, signal, maxCells = MAX_CELLS) {
    let sample, nativeM, sourceName = null;
    if (source.tiles) {
      const z = zoomFor(world.grid, (box.south + box.north) / 2, side / maxCells, source.maxZoom, sideTiles(world.grid, box), mPerDegOf(world),
        Math.min(MAX_TILES, (Math.floor(DEVICE.canvasMostPx / 256)) ** 2));
      const stitched = await this._stitch(world.grid, source.tiles, box, z, signal);
      const values = terrariumHeights(stitched.pixels());
      sample = (lat, lon) => {
        const p = stitched.at(lat, lon);
        return bilinearArray(values, stitched.width, stitched.height, p.x - 0.5, p.y - 0.5);
      };
      nativeM = Mercator.metresPerPx((box.south + box.north) / 2, z);
    } else {
      const query = new URLSearchParams({ south: box.south, north: box.north, west: box.west, east: box.east, cells: maxCells, ...(source.query ?? {}) });
      if (world.id !== 'earth') query.set('world', world.id);
      const response = await this._fetch(`${source.server}?${query}`, { signal });
      if (!response.ok) {
        const said = await response.json().catch(() => ({}));
        throw new CaptureError(said.error || t('The heights did not come ({status}).', { status: response.status }), { keyNeeded: Boolean(said.key_needed) });
      }
      const grid = gridFromResponse(response.headers, await response.arrayBuffer());
      sourceName = response.headers.get('X-Grid-Source');
      const [s, n, w, e] = grid.box;
      sample = (lat, lon) => grid.heights.sample((lon - w) / (e - w), (n - lat) / (n - s));
      nativeM = (n - s) * mPerDegOf(world) / (grid.heights.rows - 1);
    }
    const cells = Math.max(Math.min(MIN_CELLS, maxCells), Math.min(maxCells, Math.round(side / nativeM)));
    const cols = frame.widthM >= frame.heightM ? cells : Math.max(2, Math.round(cells * frame.widthM / frame.heightM));
    const rows = frame.widthM >= frame.heightM ? Math.max(2, Math.round(cells * frame.heightM / frame.widthM)) : cells;
    const heights = HeightGrid.fill(cols, rows, (u, v) => {
      const { lat, lon } = local.toLatLon((u - 0.5) * frame.widthM, (0.5 - v) * frame.heightM);
      return sample(lat, lon);
    });
    if (heights.known < heights.data.length * 0.5) throw new CaptureError('The source has no heights for most of this place.');
    const filled = heights.filled();
    filled.sourceName = sourceName;
    return filled;
  }

  // ---------- picture ----------

  // A new picture over the captured place's exact frame. It needs no new heights, selection or
  // coordinates: using its saved frame also keeps the larger margin of a turnable split place.
  async pictureFor(place, source, { signal = null } = {}) {
    const world = worldOf(place.world);
    const local = new LocalFrame(place.center.lat, place.center.lon, mPerDegOf(world));
    const frame = place.frame;
    const box = local.boxOf(frame.widthM / 2, frame.heightM / 2);
    const picturePx = Math.min(Math.max(place.picture.width, place.picture.height), DEVICE.canvasMostPx);
    return this._picture(world, source, local, frame, box, Math.max(frame.widthM, frame.heightM), picturePx, signal);
  }

  async _picture(world, source, local, frame, box, side, picturePx, signal, pictureMostPx = DEVICE.canvasMostPx) {
    const automatic = picturePx === 'auto';
    if (source.describe) await source.describe(this._fetch, signal);
    if (automatic) picturePx = Math.min(8192, pictureMostPx);
    let from;            // { image, at(lat, lon) -> source pixel }
    if (source.tiles) {
      const lat = (box.south + box.north) / 2;
      let z = zoomFor(world.grid, lat, side / picturePx, source.maxZoom, sideTiles(world.grid, box), mPerDegOf(world), tileBudget(picturePx));
      const tilePx = source.tilePx ?? 256;
      z = Math.max(z, source.minZoom ?? 0, Math.log2(tilePx / 256));
      if (source.availableZoom) {
        z = source.availableZoom(z);
        if (z === null || sideTiles(world.grid, box)(z) ** 2 > tileBudget(picturePx)) {
          throw new CaptureError('This source cannot cover the selected area at this detail. Choose a smaller area or another source.');
        }
      }
      if (source.probeZoom) z = await this._availableZoom(source, box, z, signal);
      if (automatic) picturePx = PictureDetail.pixels(side, source.nativeM ?? PictureDetail.metres(world, lat, z), pictureMostPx);
      const stitched = await this._stitch(world.grid, source.tiles, box, z, signal, tilePx, source.tileUrl?.bind(source));
      from = { image: stitched.canvas, at: (la, lo) => stitched.at(la, lo) };
    } else {
      if (automatic) picturePx = PictureDetail.pixels(side, source.nativeM ?? null, Math.min(pictureMostPx, SERVER_IMAGE_PX));
      const lonSpan = box.east - box.west, latSpan = box.north - box.south;
      const most = Math.min(picturePx, SERVER_IMAGE_PX);
      const scale = Math.min(most / lonSpan, most / latSpan);
      const w = Math.max(2, Math.round(lonSpan * scale)), h = Math.max(2, Math.round(latSpan * scale));
      const query = new URLSearchParams({ world: world.id, south: box.south, north: box.north, west: box.west, east: box.east, width: w, height: h });
      const response = await this._fetch(`${source.server}?${query}`, { signal });
      if (!response.ok) {
        const said = await response.json().catch(() => ({}));
        throw new CaptureError(said.error || t('The picture did not come ({status}).', { status: response.status }));
      }
      const image = await this._decode(await response.blob());
      from = { image, at: (la, lo) => ({ x: (lo - box.west) / lonSpan * w, y: (box.north - la) / latSpan * h }) };
    }
    const width = frame.widthM >= frame.heightM ? picturePx : Math.max(1, Math.round(picturePx * frame.widthM / frame.heightM));
    const height = frame.widthM >= frame.heightM ? Math.max(1, Math.round(picturePx * frame.heightM / frame.widthM)) : picturePx;
    const out = this._canvas(width, height);
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#6b6b6b';
    ctx.fillRect(0, 0, width, height);
    // Row by row: along a row the latitude is one, and the source's x runs straight with the
    // longitude, so each row is one strip of the source scaled into place.
    for (let row = 0; row < height; row++) {
      const y = (0.5 - (row + 0.5) / height) * frame.heightM;
      const left = local.toLatLon(-frame.widthM / 2, y), right = local.toLatLon(frame.widthM / 2, y);
      const a = from.at(left.lat, left.lon), b = from.at(right.lat, right.lon);
      ctx.drawImage(from.image, a.x, a.y - 0.5, Math.max(1e-3, b.x - a.x), 1, 0, row, width, 1);
    }
    // The Moon's, Mars's and Venus's mosaics are grey and flat where the ground is even: the picture
    // is stretched by its own levels (contrast.js), the darkest and brightest 1% cut.
    if (world.id !== 'earth') {
      const pixels = ctx.getImageData(0, 0, width, height);
      if (stretchLevels(pixels.data)) ctx.putImageData(pixels, 0, 0);
    }
    return out;
  }

  // ---------- tiles ----------

  // Without a service description, test only the chosen location's centre, lowering the level
  // on a 404. Network/CORS/server failures are errors, not evidence that the detail is too fine.
  async _availableZoom(source, box, wanted, signal) {
    for (let z = wanted; z >= 0; z--) {
      const p = Mercator.px((box.south + box.north) / 2, (box.west + box.east) / 2, z);
      const answer = await this._tile(source.tileUrl(z, Math.floor(p.x / 256), Math.floor(p.y / 256)), signal, true);
      if (answer.status === 404) continue;
      if (answer.ok && await this._tilePicture(await answer.blob())) return z;
      throw new CaptureError('The custom layer could not load tiles. Check its URL, coverage and CORS support.');
    }
    throw new CaptureError('The map has no tiles here at this size.');
  }

  // The tiles of `layer` over the box at zoom z, drawn into one canvas. z is the zoom of 256-point
  // tiles; a layer of bigger tiles (tilePx 512: CTX) is asked for the level as fine as that, one
  // below for 512.
  async _stitch(grid, layer, box, z, signal, tilePx = 256, tileUrl = null) {
    const project = projections[grid];
    const level = z - Math.log2(tilePx / 256);
    const nw = project(box.north, box.west, z), se = project(box.south, box.east, z);
    const x0 = Math.floor(nw.x / tilePx), x1 = Math.floor(se.x / tilePx);
    const y0 = Math.floor(nw.y / tilePx), y1 = Math.floor(se.y / tilePx);
    const width = (x1 - x0 + 1) * tilePx, height = (y1 - y0 + 1) * tilePx;
    const canvas = this._canvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const jobs = [];
    let missing = 0, done = 0;
    const total = (x1 - x0 + 1) * (y1 - y0 + 1);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        jobs.push(async () => {
          if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
          const response = await this._tile(tileUrl ? tileUrl(level, tx, ty) : `/api/tile/${layer}/${level}/${tx}/${ty}`, signal, Boolean(tileUrl));
          const image = response.ok ? await this._tilePicture(await response.blob()) : null;
          if (image) {
            ctx.drawImage(image, (tx - x0) * tilePx, (ty - y0) * tilePx, tilePx, tilePx);
          } else if (tileUrl) {
            throw new CaptureError('The custom layer could not load tiles. Check its URL, coverage and CORS support.');
          } else if (response.ok || response.status === 404) {
            // no such tile, or one no decoder reads: its place stays grey
            missing += 1;
          } else {
            throw new CaptureError(t('The map service did not give a tile {n} times ({status}). Try again in a minute, or choose another picture.',
              { n: TILE_REPEATS_MS.length + 1, status: response.status || t('no answer') }));
          }
          done += 1;
          if (done % 8 === 0 || done === total) this._progress(null, done / total);
        });
      }
    }
    await inTurns(jobs, PARALLEL);
    if (missing === total) throw new CaptureError('The map has no tiles here at this size.');
    return {
      canvas, width, height,
      at: (lat, lon) => {
        const p = project(lat, lon, z);
        return { x: p.x - x0 * tilePx, y: p.y - y0 * tilePx };
      },
      pixels: () => ctx.getImageData(0, 0, width, height).data,
    };
  }

  // A tile's picture, or null when nothing reads it. A few of Esri's CTX tiles come with a broken
  // chunk: createImageBitmap refuses them, the <img> of the map shows all it can of them.
  async _tilePicture(blob) {
    try {
      return await this._decode(blob);
    } catch {
      try {
        return await this._decodeImage(blob);
      } catch {
        return null;
      }
    }
  }

  // A tile's answer. A failed one is asked again after each pause; the last answer is given as it
  // is, and no answer at all as { ok: false, status: 0 }.
  async _tile(url, signal, external = false) {
    let answer = null;
    for (const pause of [...TILE_REPEATS_MS, null]) {
      try {
        answer = await this._fetch(url, { signal, ...(external ? { mode: 'cors', credentials: 'omit' } : {}) });
        if (!(answer.status >= 500 || answer.status === 429)) return answer;
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        answer = { ok: false, status: 0 };
      }
      if (pause !== null) await this._wait(pause, signal);
    }
    return answer;
  }
}

// A picture read as an <img>, as the map reads its tiles.
function imageOf(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('not a picture'));
    };
    img.src = url;
  });
}

function pauseFor(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Stopped', 'AbortError'));
    }, { once: true });
  });
}

function defaultCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// The picture source a capture takes: the one asked for, else the first that suits the region's
// size (Kaguya only for small regions on the Moon).
export function pictureSourceFor(world, pictureId, sideM) {
  const chosen = world.pictures.find((s) => s.id === pictureId);
  if (chosen) return chosen;
  return world.pictures.find((s) => !s.upToKm || sideM / 1000 <= s.upToKm) ?? world.pictures[world.pictures.length - 1];
}

// About how many metres of ground a point of the picture will cover: the picture's own share of
// the frame, or the source's finest, whichever is coarser.
export function pictureMetres(world, source, lat, sideM, picturePx) {
  const share = sideM / picturePx;
  let finest;
  if (source.tiles) {
    finest = world.grid === 'mercator' ? Mercator.metresPerPx(lat, source.maxZoom)
      : LonLat.degPerPx(source.maxZoom) * mPerDegOf(world) * Math.cos(lat * Math.PI / 180);
  } else {
    finest = Math.max(source.nativeM ?? 0, sideM / Math.min(picturePx, SERVER_IMAGE_PX));
  }
  return Math.max(share, finest);
}

// The zoom whose pixels are at most `wantM` metres (as fine as needed), but at most maxZoom and
// not so fine that the region takes more than maxTiles tiles. tilesAt(z): tiles across at z.
// mPerDeg: the world's metres in a degree (plain-degree tiles).
export function zoomFor(grid, lat, wantM, maxZoom, tilesAt, mPerDeg, maxTiles = MAX_TILES) {
  const metres = grid === 'mercator'
    ? (z) => Mercator.metresPerPx(lat, z)
    : (z) => LonLat.degPerPx(z) * mPerDeg * Math.cos(lat * Math.PI / 180);
  let z = 0;
  while (z < maxZoom && metres(z) > wantM) z += 1;
  while (z > 0 && tilesAt(z) ** 2 > maxTiles) z -= 1;
  return z;
}

// How many tiles across the box takes at a zoom.
function sideTiles(grid, box) {
  const project = projections[grid];
  return (z) => {
    const nw = project(box.north, box.west, z), se = project(box.south, box.east, z);
    return Math.max(Math.floor(se.x / 256) - Math.floor(nw.x / 256), Math.floor(se.y / 256) - Math.floor(nw.y / 256)) + 1;
  };
}

// Heights from terrarium-coded pixels: (R * 256 + G + B / 256) - 32768 metres; NaN for no data.
export function terrariumHeights(rgba) {
  const out = new Float32Array(rgba.length / 4);
  for (let k = 0; k < out.length; k++) {
    const r = rgba[k * 4], g = rgba[k * 4 + 1], b = rgba[k * 4 + 2], a = rgba[k * 4 + 3];
    const h = r * 256 + g + b / 256 - 32768;
    out[k] = a === 0 || h < SEA_FLOOR_SENTINEL ? NaN : h;
  }
  return out;
}

// A value between the four nearest of a row-major array, those without a value left out.
export function bilinearArray(values, width, height, fx, fy) {
  fx = Math.min(width - 1, Math.max(0, fx));
  fy = Math.min(height - 1, Math.max(0, fy));
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
  const tx = fx - x0, ty = fy - y0;
  let total = 0, weight = 0;
  for (const [x, y, w] of [[x0, y0, (1 - tx) * (1 - ty)], [x1, y0, tx * (1 - ty)], [x0, y1, (1 - tx) * ty], [x1, y1, tx * ty]]) {
    const h = values[y * width + x];
    if (w > 0 && h === h) { total += h * w; weight += w; }
  }
  return weight > 0 ? total / weight : NaN;
}

// The grid the server sends (app/grids.py): float32 numbers and their size and box in headers.
export function gridFromResponse(headers, buffer) {
  const cols = Number(headers.get('X-Grid-Cols')), rows = Number(headers.get('X-Grid-Rows'));
  const box = (headers.get('X-Grid-Box') || '').split(',').map(Number);
  if (!(cols >= 2 && rows >= 2) || box.length !== 4 || box.some((n) => !Number.isFinite(n))) {
    throw new CaptureError('The server sent heights without their size or place.');
  }
  return { heights: HeightGrid.fromBytes(cols, rows, buffer), box };
}

// The circle of a place framed on the map: a CircleOutline of that radius.
export const circleOf = (radiusM) => new CircleOutline(radiusM);
