// Close-up picture patches. The overview remains one portable image; visible detail is downloaded
// in small atlases, draped over the same terrain triangles and kept as original tiles in the
// server's data folder (data/picture-tiles).
import * as THREE from '../vendor/three/three.module.js';
import { CustomLayerStore } from './custom-layer.js';
import { DetailTileLoader, MissingDetailTile } from './detail-tile-loader.js';
import { PatchSurface } from './patch-surface.js';
import { TopSurfacePicker } from './top-surface-picker.js';
import { DetailPatchCache } from './detail-patch-cache.js';
import { TileFrame } from './tile-frame.js';
import { Mercator } from './geo.js';
import { GROUP } from './terrain-mesh.js';
import { toFrame } from './split.js';
import { HeightGrid } from './height-grid.js';
import { StylePainter, needsPainting } from './styles.js';
import { disposeTree } from './dispose.js';
import { DEVICE } from './device.js';
import { t } from './i18n.js';

const TILES = 4, SIZE = 256 * TILES;
const MOST_PATCHES = DEVICE.touch ? 12 : 32;
const WAIT_MS = 350;

export class DetailedPictures {
  constructor({ view, say }) {
    this.view = view;
    this._say = say;
    this.group = new THREE.Group();
    this.group.name = 'detailed-pictures';
    view.scene.add(this.group);
    this._loader = new DetailTileLoader();
    this._store = new CustomLayerStore();
    this._patches = new Map();
    this._cache = new DetailPatchCache({ mostBytes: (DEVICE.touch ? 48 : 96) * 1024 ** 2 });
    this._ray = new THREE.Raycaster();
    this._pointer = new THREE.Vector2();
    this._jobs = new Map();
    this._model = null;
    this._last = 0;
    this._signature = null;
    this._wanted = new Map();
    this._generation = 0;
    this._painter = null;
    view.onFrame(() => this.update());
  }

  show(model, mesh) {
    const generation = ++this._generation;
    for (const controller of this._jobs.values()) controller.abort();
    this._jobs.clear();
    this._patches.clear();
    this._cache.clear();
    this._skipped = new Set();
    this._retry = new Map();
    disposeTree(this.group); this.group.clear();
    this._model = model;
    this._sources = [];
    this._last = 0;
    this._signature = null;
    this._wanted = new Map();
    this._reported = false;
    if (!model.places.some((p) => p.world === 'earth' && p.sources.customPicture)) return;
    const top = mesh.groups.find((g) => g.materialIndex === GROUP.top);
    this._surface = new PatchSurface(this.view.terrainGeometry, top);
    this._picker = new TopSurfacePicker(this.view.terrainGeometry, top);
    this._store.history().then(async ({ layers }) => {
      const found = [];
      for (const [index, place] of model.places.entries()) {
        if (place.world !== 'earth' || !place.sources.customPicture) continue;
        let source = layers.find((layer) => layer.key === place.sources.pictureSourceKey);
        if (!source && !place.sources.pictureSourceKey) {
          // Older models have only a title. Match an unambiguous WMTS identifier, never another map.
          const normal = (text) => text.replace(/[\s_-]+/g, '').toLowerCase();
          const candidates = layers.filter((layer) => {
            const parts = new URL(layer.url.replace(/\{[zxy]\}/g, '0')).pathname.split('/');
            const wmts = parts.findIndex((part) => part.toLowerCase() === 'wmts');
            return wmts >= 0 && normal(parts[wmts + 1]) === normal(place.sources.picture);
          });
          if (candidates.length === 1) source = candidates[0];
        }
        if (!source?.key) {
          if (generation === this._generation) this._say(t('The detailed picture source is missing. Set its URL again.'), 'error');
          continue;
        }
        await source.describe((...args) => fetch(...args), null);
        found.push({ source, index, place, frame: new TileFrame(place, model.compare?.turns[index] ?? 0) });
      }
      if (generation === this._generation) this._sources = found;
    }).catch(() => {
      if (generation === this._generation) this._say(t('Detailed picture sources could not be read.'), 'error');
    });
  }

  update(force = false) {
    const now = performance.now(), model = this._model;
    this.group.visible = !!model && model.settings.style === 'photo' && !this._line;
    if (!this.group.visible || !this.view.running || !this._sources?.length || (!force && now - this._last < WAIT_MS)) return;
    this._last = now;
    const camera = this.view.camera;
    camera.updateMatrixWorld(true);
    const signature = [...camera.position.toArray(), ...camera.quaternion.toArray(), this.view.canvas.width, this.view.canvas.height].join('/');
    if (!force && signature === this._signature) { this._pump(now); return; }
    this._signature = signature;
    const rect = this.view.freeRect(), samples = [];
    const canvasBox = this.view.canvas.getBoundingClientRect();
    for (let y = 0; y <= 4; y++) for (let x = 0; x <= 6; x++) {
      this._pointer.set(((rect.left + (rect.right - rect.left) * x / 6 - canvasBox.left) / canvasBox.width) * 2 - 1,
        1 - ((rect.top + (rect.bottom - rect.top) * y / 4 - canvasBox.top) / canvasBox.height) * 2);
      this._ray.setFromCamera(this._pointer, camera);
      const pick = this._picker.hit(this._ray.ray);
      if (pick?.u !== null && pick?.u !== undefined) samples.push(pick);
    }
    const wanted = new Map();
    for (const entry of this._sources) {
      const points = samples.filter((p) => !model.isSplit || model.groundAt(p.u, p.v).place === entry.index);
      if (!points.length) continue;
      const us = points.map((p) => p.u), vs = points.map((p) => p.v);
      const left = Math.min(...us), right = Math.max(...us), top = Math.min(...vs), bottom = Math.max(...vs);
      if (right - left < 1e-7 || bottom - top < 1e-7) continue;
      const pixels = Math.max(1, Math.min(rect.right - rect.left, rect.bottom - rect.top) * this.view.renderer.getPixelRatio());
      const metres = Math.max((right - left) * model.frame.widthM, (bottom - top) * model.frame.heightM) / pixels;
      let z = Math.min(entry.ceiling ?? entry.source.maxZoom, entry.place.sources.pictureMaxZoom ?? entry.source.maxZoom,
        Math.max(0, Math.ceil(Math.log2(Mercator.metresPerPx(entry.place.center.lat, 0) / metres))));
      z = entry.source.availableZoom(z) ?? z;
      const baseMetres = Math.max(entry.place.frame.widthM, entry.place.frame.heightM) / Math.max(entry.place.picture.width, entry.place.picture.height);
      if (Mercator.metresPerPx(entry.place.center.lat, z) >= baseMetres * .8) continue;
      let tiles;
      do {
        const projected = [[left, top], [right, top], [left, bottom], [right, bottom]].map(([u, v]) => entry.frame.pixel(u, v, z));
        const xs = projected.map((p) => p.x), ys = projected.map((p) => p.y);
        const x0 = Math.floor(Math.min(...xs) / SIZE), x1 = Math.floor(Math.max(...xs) / SIZE);
        const y0 = Math.floor(Math.min(...ys) / SIZE), y1 = Math.floor(Math.max(...ys) / SIZE);
        tiles = { x0, x1, y0, y1, count: (x1 - x0 + 1) * (y1 - y0 + 1) };
        if (tiles.count <= MOST_PATCHES || z === 0) break;
        const lower = entry.source.availableZoom(z - 1);
        if (lower === null || lower >= z) { tiles.count = 0; break; }
        z = lower;
      } while (z >= 0);
      if (!tiles.count) continue;
      for (let y = tiles.y0; y <= tiles.y1; y++) for (let x = tiles.x0; x <= tiles.x1; x++) {
        const key = `${entry.index}/${z}/${x}/${y}`;
        wanted.set(key, { ...entry, origin: entry, x: x * TILES, y: y * TILES, z });
      }
    }
    for (const [key, controller] of this._jobs) if (!wanted.has(key)) { controller.abort(); this._jobs.delete(key); }
    for (const [key, patch] of this._patches) if (!wanted.has(key)) {
      this.group.remove(patch); this._cache.keep(key, patch); this._patches.delete(key);
    }
    this._wanted = wanted;
    this._pump(now);
  }

  _pump(now) {
    for (const key of this._wanted.keys()) {
      if (this._patches.has(key)) continue;
      const patch = this._cache.take(key);
      if (patch) { this.group.add(patch); this._patches.set(key, patch); }
    }
    // Two atlases at a time, each with four tile workers.
    for (const [key, entry] of this._wanted) {
      if (this._jobs.size >= 2) break;
      if (!this._patches.has(key) && !this._jobs.has(key) && !this._skipped.has(key) && (this._retry.get(key) ?? 0) <= now) this._load(key, entry);
    }
  }

  async _load(key, entry) {
    const controller = new AbortController(), generation = this._generation;
    this._jobs.set(key, controller);
    try {
      const part = this._surface.patch(entry.frame, entry.x * 256, entry.y * 256, entry.z, SIZE);
      if (!part) { this._skipped.add(key); return; }
      let canvas = await this._loader.atlas(entry.source, entry.x, entry.y, entry.z, TILES, controller.signal);
      if (controller.signal.aborted || generation !== this._generation) return;
      canvas = this._finishPicture(canvas, entry);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(part.positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(part.normals, 3));
      geometry.setAttribute('uv', new THREE.BufferAttribute(part.uvs, 2));
      const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = this.view.renderer.capabilities.getMaxAnisotropy();
      const patch = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ map: texture, roughness: .93, metalness: 0, alphaTest: .001 }));
      patch.receiveShadow = true; patch.renderOrder = 1;
      patch.userData.detail = { sourceKey: entry.source.key, z: entry.z, x: entry.x, y: entry.y };
      this.group.add(patch); this._patches.set(key, patch);
    } catch (error) {
      if (!controller.signal.aborted && generation === this._generation) {
        if (error instanceof MissingDetailTile && entry.source.probeZoom && entry.z > 0) {
          entry.origin.ceiling = entry.z - 1;
          this._signature = null;
        } else {
          this._retry.set(key, performance.now() + 30000);
          if (!this._reported) { this._reported = true; this._say(t(error.message), 'error'); }
        }
      }
      controller.abort(); // Stop this atlas's other workers as soon as any tile fails.
    } finally {
      if (this._jobs.get(key) === controller) this._jobs.delete(key);
    }
  }

  _finishPicture(canvas, entry) {
    const model = this._model, settings = model.settings;
    if (needsPainting('photo', settings.styleOptions, settings.water)) {
      this._painter ??= new StylePainter();
      const heights = HeightGrid.fill(64, 64, (u, v) => {
        const uv = entry.frame.modelUv(entry.x * 256 + u * SIZE, entry.y * 256 + v * SIZE, entry.z);
        return model.heights().sample(...uv);
      });
      const painted = this._painter.paint({ picture: canvas, heights, metres: { widthM: SIZE * Mercator.metresPerPx(entry.place.center.lat, entry.z), heightM: SIZE * Mercator.metresPerPx(entry.place.center.lat, entry.z) },
        style: 'photo', options: settings.styleOptions, water: settings.water.on ? settings.water : null, sun: settings.light });
      const copy = Object.assign(document.createElement('canvas'), { width: canvas.width, height: canvas.height });
      copy.getContext('2d').drawImage(painted, 0, 0); canvas = copy;
    }
    if (model.isSplit) {
      const ctx = canvas.getContext('2d'), sides = model.divider.sides(model.outline.reachM);
      const polygon = sides.second;
      ctx.globalCompositeOperation = entry.index === 0 ? 'destination-out' : 'destination-in'; ctx.beginPath();
      polygon.forEach(([x, y], i) => {
        const p = entry.frame.pixel(...toFrame(x, y, model.frame), entry.z);
        const px = p.x - entry.x * 256 + 1, py = p.y - entry.y * 256 + 1;
        if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      });
      ctx.closePath(); ctx.fill(); ctx.globalCompositeOperation = 'source-over';
    }
    return canvas;
  }

  line(on) { this._line = on; this.group.visible = !on && this._model?.settings.style === 'photo'; }

  addToExport(scene) {
    if (!this.group.visible) return;
    for (const patch of this._patches.values()) scene.children[0].add(patch.clone());
  }

}
