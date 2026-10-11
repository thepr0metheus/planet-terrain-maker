// Asteroids, comets and spacecraft put on the model at their real size, to see how big they are, as
// many as one likes: each shape fetched through the server (app/shapes.py keeps it) or, for a rocket
// without a model of NASA's, drawn from its dimensions (vehicle-shapes.js); turned so that its own up
// is the view's, scaled from metres to the model's millimetres, and hung over a point of the model's
// top, its projection: on the ground there, or raised above it. They cast their shadows with the
// model's sun. Below, "an asteroid" is any of them.
//
// Over the view, for each: a label above it that says what it is and how big, and carries it over
// another point (carry.js: the point under the label, kept as far below it as when it was grabbed).
// While one moves — carried, or raised and lowered by the page's slider — its projection shows too, a
// ring on the ground with a dashed line up to it and its height over the ground; they go a moment
// after it stops. One of them is chosen at a time: the slider raises that one, and grabbing a label or
// a click on an asteroid chooses it. A click on an asteroid also makes the view turn about the point
// clicked, as a click on the ground does (ModelView.pickAt with extras). A new asteroid put at the
// same point as the one before stands beside it, to the right as the camera looks, so the two compare.
//
// A model of one place only (the page hides the tool for two places). The asteroids are drawn into the
// view, so a picture or a video of the view has them; the model's files never do.

import * as THREE from '../vendor/three/three.module.js';
import { GLTFLoader } from '../vendor/three/addons/GLTFLoader.js';
import { disposeTree } from './dispose.js';
import { CarriedPoint } from './carry.js';
import { metresPerUnit, readObj, readRadiusGrid, readWrl } from './asteroid-shapes.js';
import { asteroidWords, keyOf } from './asteroid-search.js';
import { VehicleShapes } from './vehicle-shapes.js';
import { number, t } from './i18n.js';

const SVG = 'http://www.w3.org/2000/svg';
const ROCK = 0x8c8378;          // the colour of a shape that comes without a picture of its own
const TINY_MM = 0.5;            // shorter than this on the model, the label says to come closer
const HIGHEST = 10;             // one may hang this many times its length (or the model's width) high
const MOVED_MS = 1200;          // the projection stays this long after the asteroid stopped moving
const BESIDE = 1.2;             // a new one beside the last: their half lengths apart, times this
const GATEWAY = [502, 503, 504];          // a proxy's answers for a server that is not there just now
const AGAIN_MS = 1500;

// ---------- a shape ----------
// The builders of a shape hold no state of their own: functions; the vehicles' builder keeps the
// glTF loader with its Draco decoder, made once.

const VEHICLES = new VehicleShapes();
const COMET = 0x4a4642;         // a comet's nucleus: darker than coal (it reflects some 4 % of the light)
const READERS = { obj: readObj, wrl: readWrl, grid: readRadiusGrid };

// Where each list's shapes come from (null: drawn here, nothing to fetch), and how one is read into a
// three.js object in metres, y up.
const SHAPES = {
  top: {
    url: (a) => `/api/asteroids/top/${encodeURIComponent(a.id)}`,
    read: async (answer, a) => (a.kind === 'glb' ? glbShape(await answer.arrayBuffer(), a.metresPerUnit)
      : bodyShape(readObj(await answer.text()), a.metresPerUnit, ROCK)),
  },
  damit: {
    url: (a) => `/api/asteroids/damit/${a.model}`,
    read: async (answer, a) => {
      const read = readObj(await answer.text());
      return bodyShape(read, metresPerUnit(read, a.diameterKm), ROCK);
    },
  },
  comet: {
    url: (a) => `/api/comets/${encodeURIComponent(a.id)}`,
    read: async (answer, a) => bodyShape(READERS[a.kind](await answer.text()), a.metresPerUnit, COMET),
  },
  vehicle: {
    url: (a) => (a.kind === 'glb' ? `/api/vehicles/${encodeURIComponent(a.id)}` : null),
    read: async (answer, a) => (answer ? VEHICLES.fromGlb(await answer.arrayBuffer(), a) : VEHICLES.build(a)),
  },
};

// The shape of what is put on the model as a three.js object in metres, y up, its lowest point at 0
// and its middle over the origin.
async function fetchShape(entry) {
  const source = SHAPES[entry.source];
  const url = source.url(entry);
  let answer = null;
  if (url) {
    answer = await fetch(url);
    // the proxy in front of the server answers so while the server restarts (a new version): once more
    if (GATEWAY.includes(answer.status)) {
      await new Promise((resolve) => setTimeout(resolve, AGAIN_MS));
      answer = await fetch(url);
    }
    if (!answer.ok) {
      const said = (await answer.json().catch(() => ({}))).error;
      throw new Error(said ?? t('The server did not answer ({status}): try again in a moment.', { status: `HTTP ${answer.status}` }));
    }
  }
  const inner = await source.read(answer, entry);
  const shape = new THREE.Group();
  shape.add(inner);
  const box = new THREE.Box3().setFromObject(shape);
  const middle = box.getCenter(new THREE.Vector3());
  inner.position.sub(new THREE.Vector3(middle.x, box.min.y, middle.z));
  shape.traverse((part) => {
    if (part.isMesh) part.castShadow = part.receiveShadow = true;
  });
  return shape;
}

// NASA's models of asteroids: glTF, y up already, in metres divided by the scale of the file's name.
async function glbShape(buffer, metres) {
  const gltf = await new Promise((resolve, reject) => new GLTFLoader().parse(buffer, '', resolve, reject));
  gltf.scene.scale.setScalar(metres);
  gltf.scene.updateMatrixWorld(true);
  return gltf.scene;
}

// Vertices and facets in the body's own frame, z up, at `metres` a unit.
function bodyShape(read, metres, colour) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(read.positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(read.indices, 1));
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: colour, roughness: 0.95, metalness: 0, side: THREE.DoubleSide }));
  mesh.rotation.x = -Math.PI / 2;                 // its z up is the view's y up
  mesh.scale.setScalar(metres);
  mesh.updateMatrixWorld(true);
  return mesh;
}

// ---------- one asteroid on the model ----------

class PlacedAsteroid {
  // asteroid: the list's entry. shape: fetchShape's. at: { u, v }, its projection. model: as
  // AsteroidsOnModel.measure takes it. onChoose(this): its label was grabbed. onMove(): it moved.
  constructor({ view, container, distance, asteroid, shape, at, altitudeM = 0, model, onChoose, onMove }) {
    this.asteroid = asteroid;
    this.at = at;
    this.altitudeM = Math.max(0, altitudeM);   // how high its lowest point hangs over the ground under it
    this._view = view;
    this._container = container;
    this._distance = distance;
    this._shape = shape;
    this._holder = new THREE.Group();      // metres in, the model's millimetres out, at the point
    this._holder.add(shape);
    const size = new THREE.Box3().setFromObject(shape).getSize(new THREE.Vector3());
    this.lengthM = Math.max(size.x, size.y, size.z);     // its longest extent, metres
    this._heightM = size.y;                                // and its height as it stands
    this._movedAt = -Infinity;    // when it last moved (performance.now): the projection shows a while
    this._shown = null;           // where the projection shows now, page pixels
    this._build();
    this._carrier = new CarriedPoint(this._label, {
      view, shownAt: () => this._shown, active: () => true,
      onPoint: (point) => {
        this.at = point;
        this._movedAt = performance.now();
        this._lay();
        onMove();
      },
    });
    this._onMove = onMove;
    this._label.addEventListener('pointerdown', () => onChoose(this));
    view.extras.add(this._holder);
    this.measure(model);
  }

  get name() { return asteroidWords(this.asteroid, this._distance).name; }

  setAltitude(metres) {
    this.altitudeM = Math.max(0, metres);
    this._movedAt = performance.now();
    this._lay();
    this._onMove();
  }

  choose(on) {
    this._label.classList.toggle('chosen', on);
  }

  // Whether a three.js object (a click's hit) is part of this asteroid.
  owns(object) {
    for (let part = object; part; part = part.parent) if (part === this._holder) return true;
    return false;
  }

  measure(model) {
    this._model = model;
    this._holder.scale.setScalar(model.mmPerM);
    this._lay();
    this._words();
  }

  dispose() {
    this._carrier.cancel();
    this._view.extras.remove(this._holder);
    disposeTree(this._shape);
    this._root.remove();
  }

  // Keep its marks where the camera shows it now; the label being carried goes first. Every frame.
  place() {
    this._carrier.step();
    const view = this._view.canvas.getBoundingClientRect(), box = this._container.getBoundingClientRect();
    const at = (point) => {
      const s = this._view.screenOf(point);
      return s && { x: s.x + view.left - box.left, y: s.y + view.top - box.top };
    };
    const bottom = this._holder.position.clone();
    const top = bottom.clone().setY(bottom.y + this._heightM * this._model.mmPerM);
    const ground = bottom.clone().setY(bottom.y - this.altitudeM * this._model.mmPerM);
    const sTop = at(top), sBottom = at(bottom), sGround = at(ground);
    this._shown = sGround && { x: sGround.x + box.left, y: sGround.y + box.top };
    PlacedAsteroid._put(this._label, sTop);
    // the projection, while it moves and a moment after
    if (this._carrier.carried) this._movedAt = performance.now();
    const moving = performance.now() - this._movedAt < MOVED_MS;
    PlacedAsteroid._put(this._ground, moving && sGround);
    const drop = moving && this.altitudeM > 0 && sGround && sBottom;
    PlacedAsteroid._put(this._height, drop && { x: (sGround.x + sBottom.x) / 2, y: (sGround.y + sBottom.y) / 2 });
    if (drop) {
      const words = t('{d} above the ground', { d: this._distance(this.altitudeM) });
      if (this._height.textContent !== words) this._height.textContent = words;
    }
    for (const line of this._drop) {
      line.toggleAttribute('hidden', !drop);
      if (!drop) continue;
      line.setAttribute('x1', sGround.x.toFixed(1));
      line.setAttribute('y1', sGround.y.toFixed(1));
      line.setAttribute('x2', sBottom.x.toFixed(1));
      line.setAttribute('y2', sBottom.y.toFixed(1));
    }
  }

  _build() {
    const svg = (tag, cls) => {
      const el = document.createElementNS(SVG, tag);
      el.setAttribute('class', cls);
      return el;
    };
    const lines = svg('svg', 'asteroid-lines');
    lines.setAttribute('aria-hidden', 'true');
    this._drop = [svg('line', 'asteroid-drop-shade'), svg('line', 'asteroid-drop')];
    lines.append(...this._drop);
    const words = t('Carry the asteroid over another point');
    this._label = Dom.el('button', { type: 'button', class: 'asteroid-label', title: words, 'aria-label': words });
    this._ground = Dom.el('div', { class: 'asteroid-ground', hidden: true });
    this._height = Dom.el('div', { class: 'asteroid-height-tag', hidden: true });
    this._root = Dom.el('div', { class: 'asteroid-marks' }, lines, this._ground, this._height, this._label);
    this._container.append(this._root);
  }

  static _put(el, s) {
    el.hidden = !s;
    if (!s) return;
    el.style.setProperty('--x', `${Math.round(s.x)}px`);
    el.style.setProperty('--y', `${Math.round(s.y)}px`);
  }

  // The asteroid over its projection, its lowest point the altitude above the ground there.
  _lay() {
    const ground = this._model.top(this.at.u, this.at.v);
    this._holder.position.set(ground.x, ground.z + this.altitudeM * this._model.mmPerM, -ground.y);
  }

  // The label: the name and size, and how it shows on this model when that needs saying.
  _words() {
    const words = asteroidWords(this.asteroid, this._distance);
    const mm = this.lengthM * this._model.mmPerM;
    const note = mm < TINY_MM ? t('{n} mm on this model: come closer to see it', { n: number(mm, mm < 0.1 ? 2 : 1) })
      : mm > this._model.widthMm ? t('{n} times as long as this model is wide', { n: number(Math.round(mm / this._model.widthMm)) })
        : null;
    this._label.replaceChildren(Dom.el('span', { class: 'name' }, words.name), Dom.el('span', { class: 'size' }, words.size),
      ...(note ? [Dom.el('span', { class: 'note' }, note)] : []));
  }
}

// ---------- all of them ----------

export class AsteroidsOnModel {
  // view: the 3D view (ModelView). container: the element the marks lie in, over the view.
  // distance(m): a distance in words. say(text, kind): a message. onChange(): one came, went or was
  // chosen; onMove(): one moved. Both also mean saved() says something new.
  constructor({ view, container, distance, say, onChange = () => {}, onMove = () => {} }) {
    this._view = view;
    this._container = container;
    this._distance = distance;
    this._say = say;
    this._onChange = onChange;
    this._onMove = onMove;
    this._items = [];
    this._chosen = null;
    this._model = null;           // { top(u, v), mmPerM, widthMm, frame } (ModelScreen._measured)
    this._generation = 0;         // a new model, or all taken away: shapes still coming are dropped
    this._lastStart = null;       // the point the last one was asked for at
  }

  get items() { return [...this._items]; }
  get chosen() { return this._chosen; }

  // The highest the chosen one may hang, metres: HIGHEST times its length, or the model's width when
  // that is more.
  get highestM() {
    const one = this._chosen;
    return one && this._model ? HIGHEST * Math.max(one.lengthM, this._model.widthMm / this._model.mmPerM) : 0;
  }

  // What a saved model keeps of them (settings.asteroids): each one's key in its list, its projection
  // and its height over the ground.
  saved() {
    return this._items.map((item) => ({
      asteroid: keyOf(item.asteroid), at: { u: Number(item.at.u.toFixed(6)), v: Number(item.at.v.toFixed(6)) },
      altitudeM: Math.round(item.altitudeM),
    }));
  }

  // Put an asteroid on the model, its projection at a point of its top (beside the last one when that
  // was put at the same point; exactly there with `exact`, as a saved model has it), `altitudeM` over
  // the ground, and choose it. The new one, or null when it did not come (said already) or the model
  // changed meanwhile.
  async add(asteroid, at, { exact = false, altitudeM = 0 } = {}) {
    const generation = this._generation;
    let shape;
    try {
      shape = await fetchShape(asteroid);
    } catch (e) {
      if (generation === this._generation) this._say(t('The asteroid did not come: {why}', { why: t(e.message ?? String(e)) }), 'error');
      return null;
    }
    if (generation !== this._generation || !this._model) {
      disposeTree(shape);
      return null;
    }
    const last = this._items.at(-1);
    const again = !exact && last && this._lastStart && this._lastStart.u === at.u && this._lastStart.v === at.v;
    this._lastStart = at;
    const item = new PlacedAsteroid({
      view: this._view, container: this._container, distance: this._distance, asteroid, shape, model: this._model,
      at: again ? this._beside(last, shape) : at, altitudeM, onChoose: (one) => this.choose(one), onMove: () => this._onMove(),
    });
    this._items.push(item);
    this._reach();
    this.choose(item);
    return item;
  }

  choose(item) {
    this._chosen?.choose(false);
    this._chosen = item ?? null;
    this._chosen?.choose(true);
    this._onChange();
  }

  remove(item) {
    item.dispose();
    this._items = this._items.filter((one) => one !== item);
    if (this._chosen === item) this._chosen = null;
    this._reach();
    this.choose(this._chosen ?? this._items.at(-1));
  }

  clear() {
    this._generation += 1;
    for (const item of this._items) item.dispose();
    this._items = [];
    this._chosen = null;
    this._lastStart = null;
    this._reach();
    this._onChange();
  }

  setAltitude(metres) {
    this._chosen?.setAltitude(metres);
  }

  // The one a three.js object (a click's hit) is part of, or null.
  itemOf(object) {
    return this._items.find((item) => item.owns(object)) ?? null;
  }

  // The model as built now (after a slider moved): each asteroid scaled and hung over it again.
  measure(model) {
    this._model = model;
    for (const item of this._items) item.measure(model);
    this._reach();
  }

  // Keep their marks where the camera shows them now. Every frame.
  place() {
    for (const item of this._items) item.place();
  }

  // The camera may go back far enough to see the biggest whole.
  _reach() {
    const longest = Math.max(0, ...this._items.map((item) => item.lengthM));
    this._view.allowFar(this._model ? longest * this._model.mmPerM : 0);
  }

  // Where a new shape stands beside the last one: to its right as the camera looks, their half lengths
  // apart and a little more, on the model's frame (the projection may lie past the outline).
  _beside(last, shape) {
    const size = new THREE.Box3().setFromObject(shape).getSize(new THREE.Vector3());
    const apart = (last.lengthM + Math.max(size.x, size.y, size.z)) / 2 * BESIDE;
    const right = new THREE.Vector3().setFromMatrixColumn(this._view.camera.matrixWorld, 0).setY(0);
    if (right.lengthSq() < 1e-9) right.set(1, 0, 0);
    right.normalize();
    // the view's x is east, its z south: in metres east and north of the frame's middle
    const { widthM, heightM } = this._model.frame;
    const east = (last.at.u - 0.5) * widthM + right.x * apart;
    const north = (0.5 - last.at.v) * heightM - right.z * apart;
    const clamp = (n) => Math.min(1, Math.max(0, n));
    return { u: clamp(east / widthM + 0.5), v: clamp(0.5 - north / heightM) };
  }
}
