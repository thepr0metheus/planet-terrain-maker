// The model on screen: three.js, a camera the mouse or a finger turns, the sun, and the model's
// solid with its picture on top. Also what is made from the view: a PNG and a video of a turn.
//
// The solid comes in millimetres with z up (terrain-mesh.js); three.js stands y up, so the view
// lays it as (x, z, -y): north away from the camera's start, east to the right.

import * as THREE from '../vendor/three/three.module.js';
import { OrbitControls } from '../vendor/three/addons/OrbitControls.js';
import { FlyCamera } from './fly-camera.js';
import { disposeTree } from './dispose.js';
import { GROUP } from './terrain-mesh.js';

export const SIDE_COLOUR = 0x7b6c5d;
const ORBIT_TILT_PER_S = THREE.MathUtils.degToRad(30);   // R and F move the camera round its point this fast
const ORBIT_TILT_EASE_S = 0.35;                          // and come to that speed this smoothly
export const BOTTOM_COLOUR = 0x4a4a4f;
export const BUILDING_COLOUR = 0xe9e4da;

// A solid in millimetres, z up, as a three.js geometry, y up.
export function geometryOf({ positions, uvs = null, indices, groups = null }) {
  const turned = new Float32Array(positions.length);
  for (let k = 0; k < positions.length; k += 3) {
    turned[k] = positions[k];
    turned[k + 1] = positions[k + 2];
    turned[k + 2] = -positions[k + 1];
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(turned, 3));
  if (uvs) geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  for (const g of groups ?? []) geometry.addGroup(g.start, g.count, g.materialIndex);
  geometry.computeVertexNormals();
  return geometry;
}

// A point of the model, in its own millimetres with z up (terrain-mesh.js), in the view's coordinates.
const toView = (p) => new THREE.Vector3(p.x, p.z, -p.y);

const CLICK_PX = 6;            // a press that moves further than this is a drag that turns the camera
const CLICK_MS = 600;          // and one held longer than this is not a click
const DOUBLE_MS = 400;         // a click this soon at the same place is the second of a double click
const GLIDE_MS = 450;          // the orbit's centre glides to a point this long
const START_SIDE = new THREE.Vector3(0.42, 0.78, 1).normalize();   // the camera at the start: from the south-east and above
const FIT = 0.95;              // the whole model a little inside the frame

export class ModelView {
  constructor(container) {
    this._container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false });
    // The browser drops a page's WebGL when the graphics memory runs out (three.js waits for it to
    // come back); the screen says so.
    this.onLost = () => {};
    this.renderer.domElement.addEventListener('webglcontextlost', () => this.onLost());
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, 1, 1, 20000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = THREE.MathUtils.degToRad(88);
    this.controls.screenSpacePanning = true;

    this.scene.add(new THREE.HemisphereLight(0xf3f6ff, 0x3a3326, 1.15));
    this.sun = new THREE.DirectionalLight(0xffffff, 2.3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    this.scene.add(this.sun, this.sun.target);

    this.model = new THREE.Group();
    this.scene.add(this.model);
    // What is drawn beside the model and never picked by a click (an asteroid put on it for its size).
    this.extras = new THREE.Group();
    this.scene.add(this.extras);
    this._farMm = 0;                // the size of the biggest of them, mm: the camera may go back to see it
    // Two ways to move the camera: round the model (OrbitControls), or free flight (FlyCamera).
    this.fly = new FlyCamera(this.camera, this.renderer.domElement);
    this.mode = 'orbit';
    this._glide = null;               // { to, at, from, started } while the orbit's centre moves to a point
    this._lastFrame = null;
    // A short click on the model: the point under it is found once, at the click, and told to the page
    // (onPick), which shows the height there first and then turns the view about it (a label placed
    // after the view had moved went elsewhere). The point is kept for "Around the model" from free
    // flight. The second click of a double click is let go: the view may
    // have moved under it already.
    this.onPick = (pick) => this.aboutPoint(pick.point);
    this._lastPoint = null;
    this._press = null;
    this._lastClick = null;
    this.renderer.domElement.addEventListener('pointerdown', (e) => {
      if (e.button === 0) this._press = { x: e.clientX, y: e.clientY, at: performance.now() };
    });
    this.renderer.domElement.addEventListener('pointerup', (e) => {
      const press = this._press;
      this._press = null;
      const now = performance.now();
      if (!press || e.button !== 0 || Math.hypot(e.clientX - press.x, e.clientY - press.y) > CLICK_PX || now - press.at > CLICK_MS) return;
      const last = this._lastClick;
      this._lastClick = { x: e.clientX, y: e.clientY, at: now };
      if (last && now - last.at < DOUBLE_MS && Math.hypot(e.clientX - last.x, e.clientY - last.y) <= CLICK_PX) return;
      const pick = this.pickAt(e.clientX, e.clientY, { extras: true });
      if (!pick) return;
      this._lastPoint = pick.point.clone();
      this.onPick(pick);
    });
    // R and F move the camera up and down round the point it turns about, smoothly.
    this._tilt = { held: 0, speed: 0 };
    this._running = false;
    window.addEventListener('keydown', (e) => this._tiltKey(e, true));
    window.addEventListener('keyup', (e) => this._tiltKey(e, false));
    window.addEventListener('blur', () => { this._tilt.held = 0; });
    this._terrain = null;
    this._texture = null;
    this._surface = null;           // (u, v) -> { x, y, z } in the view's own coordinates
    this._light = { azimuthDeg: 315, elevationDeg: 40 };
    this._covered = { right: 0, bottom: 0 };     // what the panel covers of the view, px
    this._size = 100;
    this._callbacks = [];
    this._turning = null;           // { started, seconds, from, resolve } while a video is made

    this._resize = new ResizeObserver(() => this._fit());
    this._resize.observe(container);
    this._fit();
  }

  get canvas() { return this.renderer.domElement; }

  // Draw only while the model is on screen. Leaving it ends free flight: its keys are the map's then.
  run(on) {
    if (!on && this.mode === 'fly') this.setMode('orbit');
    this._running = on;
    this._tilt.held = 0;
    this.renderer.setAnimationLoop(on ? (now) => this._frame(now) : null);
    this._lastFrame = null;
    if (on) this._fit();
  }

  // Something to run every frame (the dials and the height labels follow the model with it).
  onFrame(callback) {
    this._callbacks.push(callback);
  }

  // Show a model. mesh: terrain-mesh.js's solid; picture: a canvas for the top; buildings: a solid
  // or null; surface(u, v): the top's point over frame position (u, v) in millimetres, z up.
  // keepCamera: the same model changed (a slider moved): the camera stays where the user put it.
  show({ mesh, picture, buildings = null, surface, keepCamera = false }) {
    disposeTree(this.model, { keep: this._texture ? [this._texture] : [] });
    this.model.clear();
    if (!this._texture || this._texture.image !== picture) {
      this._texture?.dispose();
      this._texture = new THREE.CanvasTexture(picture);
      this._texture.colorSpace = THREE.SRGBColorSpace;
      this._texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    }
    const materials = [
      new THREE.MeshStandardMaterial({ map: this._texture, roughness: 0.93, metalness: 0 }),
      new THREE.MeshStandardMaterial({ color: SIDE_COLOUR, roughness: 1 }),
      new THREE.MeshStandardMaterial({ color: BOTTOM_COLOUR, roughness: 1 }),
    ];
    this._terrain = new THREE.Mesh(geometryOf(mesh), materials);
    this._terrain.castShadow = true;
    this._terrain.receiveShadow = true;
    this.model.add(this._terrain);
    if (buildings) {
      const houses = new THREE.Mesh(geometryOf(buildings), new THREE.MeshStandardMaterial({ color: BUILDING_COLOUR, roughness: 0.85 }));
      houses.castShadow = true;
      houses.receiveShadow = true;
      this.model.add(houses);
    }
    this._surface = (u, v) => {
      const p = surface(u, v);
      return p && toView(p);
    };
    const size = Math.max(mesh.size.x, mesh.size.y);
    const sizeChanged = Math.abs(size - this._size) > 0.5;
    this._size = size;
    this._placeSun();
    this._heightMm = mesh.size.z;
    if (!keepCamera || sizeChanged) {
      this._lastPoint = null;
      this.lookAtModel(mesh.size.z);
    }
  }

  // The picture on top changed (a style, the water): the same solid, a new texture.
  setPicture(picture) {
    if (!this._terrain || !this._texture) return;
    if (this._texture.image === picture) {
      this._texture.needsUpdate = true;
      return;
    }
    const old = this._texture;
    this._texture = new THREE.CanvasTexture(picture);
    this._texture.colorSpace = THREE.SRGBColorSpace;
    this._texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    this._terrain.material[GROUP.top].map = this._texture;
    this._terrain.material[GROUP.top].needsUpdate = true;
    old.dispose();
  }

  // 'orbit': the camera turns about a point of the model (its middle, a point double-clicked, or the
  // point clicked last). 'fly': free flight (fly-camera.js). Back from flight, the camera turns about
  // the point clicked last, gliding there; when none was, about the point it looks at.
  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode === 'fly') {
      this.controls.enabled = false;
      this.fly.start(this._size * 0.4);
      return;
    }
    this.fly.stop();
    const free = this.freeRect();
    const hit = this._hit((free.left + free.right) / 2, (free.top + free.bottom) / 2);
    const ahead = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion).multiplyScalar(this._size * 0.8);
    this.controls.target.copy(hit ? hit.point : this.camera.position.clone().add(ahead));
    this.controls.enabled = true;
    this.controls.update();
    this.aboutLastPoint();
  }

  // Turn about this point from now on (around the model only), gliding there after `afterMs`.
  aboutPoint(point, afterMs = 0) {
    if (this.mode !== 'orbit') return;
    this._glide = { to: point.clone(), at: performance.now() + afterMs, from: null, started: null };
  }

  // Turn about the point clicked last, gliding there; nothing when none was clicked.
  aboutLastPoint() {
    if (this._lastPoint) this.aboutPoint(this._lastPoint);
  }

  // Turn about the model's middle again, as at the start, the camera keeping its angle and distance.
  centre() {
    this._lastPoint = null;
    if (this.mode !== 'orbit') this.setMode('orbit');
    this.aboutPoint(new THREE.Vector3(0, (this._heightMm ?? 10) * 0.3, 0));
  }

  _tiltKey(e, down) {
    const sign = { KeyR: 1, KeyF: -1 }[e.code];
    if (!sign || !this._running || this.mode !== 'orbit') return;
    if (e.target?.closest?.('input, select, textarea, [contenteditable]')) return;
    e.preventDefault();
    if (down) this._tilt.held = sign;
    else if (this._tilt.held === sign) this._tilt.held = 0;
  }

  // R (up): the camera goes down towards the horizon, so the view rises; F: it goes up, to look down.
  _tiltOrbit(dt) {
    const tilt = this._tilt;
    const wanted = tilt.held * ORBIT_TILT_PER_S;
    tilt.speed += (wanted - tilt.speed) * (1 - Math.exp(-dt / ORBIT_TILT_EASE_S));
    if (!wanted && Math.abs(tilt.speed) < ORBIT_TILT_PER_S * 1e-3) tilt.speed = 0;
    if (!tilt.speed || !dt) return;
    const sphere = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target));
    sphere.phi = THREE.MathUtils.clamp(sphere.phi + tilt.speed * dt, 0.02, this.controls.maxPolarAngle);
    this.camera.position.copy(this.controls.target).add(new THREE.Vector3().setFromSpherical(sphere));
  }

  // The whole model in view again, turning about its middle.
  wholeModel() {
    if (this.mode !== 'orbit') this.setMode('orbit');
    this._glide = null;
    this.lookAtModel(this._heightMm);
  }

  // What of the model lies under a point of the page: three.js's hit, or null. extras: what is drawn
  // beside the model counts too (an asteroid in front of the ground is what a click hits).
  _hit(clientX, clientY, extras = false) {
    const box = this.canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(((clientX - box.left) / box.width) * 2 - 1, -((clientY - box.top) / box.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(pointer, this.camera);
    const targets = extras ? [...this.model.children, ...this.extras.children] : this.model.children;
    return ray.intersectObjects(targets, extras)[0] ?? null;
  }

  // The camera at the start: from the south-east and above, the whole model in view (in the part
  // of the view the panel leaves free).
  lookAtModel(heightMm = 10) {
    const s = this._size;
    this.controls.target.set(0, heightMm * 0.3, 0);
    const radius = Math.hypot(s / 2, s / 2, heightMm / 2);
    // The half-angles the free part of the view (not under the panel) spans from its middle.
    const size = this.renderer.getSize(new THREE.Vector2());
    const { right, bottom } = this._covered;
    const tan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const fullH = Math.max(1, size.y + bottom);
    const across = Math.atan(tan * Math.max(1, size.x - right) / fullH);
    const down = Math.atan(tan * Math.max(1, size.y - bottom) / fullH);
    const distance = radius / Math.sin(Math.min(across, down)) * FIT;
    this.camera.position.copy(this.controls.target).addScaledVector(START_SIDE, distance);
    // the camera comes as close as a twelfth of the model,
    // and sees from a third of a hundredth, so that the ground that near is not cut
    this.controls.minDistance = s / 12;
    this._reach();
    this.camera.near = s / 300;
    this.controls.update();
  }

  // Something drawn beside the model, sizeMm long (an asteroid), may be much bigger than it: the camera
  // may then go back far enough to see it whole, and sees that far. 0: nothing such any more.
  allowFar(sizeMm) {
    this._farMm = sizeMm;
    this._reach();
  }

  _reach() {
    const s = this._size;
    this.controls.maxDistance = Math.max(s * 8, this._farMm * 4);
    this.camera.far = Math.max(s * 40, this._farMm * 20);
    this.camera.updateProjectionMatrix();
  }

  setLight({ azimuthDeg, elevationDeg }) {
    this._light = { azimuthDeg, elevationDeg };
    this._placeSun();
  }

  _placeSun() {
    const az = THREE.MathUtils.degToRad(this._light.azimuthDeg);
    const el = THREE.MathUtils.degToRad(this._light.elevationDeg);
    const d = this._size * 3;
    // azimuth clockwise from north; north is -z in the view
    this.sun.position.set(Math.sin(az) * Math.cos(el) * d, Math.sin(el) * d, -Math.cos(az) * Math.cos(el) * d);
    const cam = this.sun.shadow.camera;
    const r = this._size * 0.75;
    Object.assign(cam, { left: -r, right: r, top: r, bottom: -r, near: d * 0.2, far: d * 2 });
    cam.updateProjectionMatrix();
  }

  // The point of the model under the pointer: { point } in the view's own coordinates, { u, v } where it
  // is on the model's top (null on its sides, a building, or with extras an asteroid), and the three.js
  // object hit; null off the model.
  pickAt(clientX, clientY, { extras = false } = {}) {
    const hit = this._hit(clientX, clientY, extras);
    if (!hit) return null;
    const top = this._terrain && hit.object === this._terrain && hit.face?.materialIndex === GROUP.top && hit.uv;
    return { point: hit.point.clone(), u: top ? hit.uv.x : null, v: top ? 1 - hit.uv.y : null, object: hit.object };
  }

  // Where a point of the model's top shows on the screen, in the view's own pixels; null when it is
  // behind the camera.
  pointOnScreen(u, v) {
    const p = this._surface?.(u, v);
    return p ? this._onScreen(p) : null;
  }

  // Where a point in the model's own millimetres (z up) shows on the screen, as pointOnScreen.
  onScreen(point) {
    return this._onScreen(toView(point));
  }

  // Where a point in the view's own coordinates (a THREE.Vector3, y up) shows on the screen.
  screenOf(point) {
    return this._onScreen(point.clone());
  }

  _onScreen(p) {
    p.project(this.camera);
    if (p.z > 1) return null;
    const box = this.canvas.getBoundingClientRect();
    return { x: (p.x + 1) / 2 * box.width, y: (1 - p.y) / 2 * box.height };
  }

  // A PNG of the view as it is, with a see-through background.
  async snapshot() {
    this.renderer.render(this.scene, this.camera);
    return new Promise((resolve) => this.canvas.toBlob(resolve, 'image/png'));
  }

  // A JPEG of the view, small, for the library's list.
  // The model's picture for the library: the frame as it is on screen at the save — its angle, its
  // zoom — cut to 4:3 about the middle of the part of the view the panel leaves free (the pictures
  // came out shifted when they were cut about the middle of the whole view, the panel's part in it,
  // while the model stands in the middle of the free part).
  async thumbnail(width = 480) {
    const height = Math.round(width * 3 / 4);
    this.renderer.render(this.scene, this.camera);
    const src = this.canvas;
    const scale = src.width / Math.max(1, this.renderer.getSize(new THREE.Vector2()).x);    // points of the picture a screen point
    const freeW = Math.max(1, src.width - this._covered.right * scale);
    const freeH = Math.max(1, src.height - this._covered.bottom * scale);
    const fit = Math.min(freeW / width, freeH / height);       // the 4:3 part that fills the picture
    const cutW = width * fit, cutH = height * fit;
    const thumb = document.createElement('canvas');
    thumb.width = width;
    thumb.height = height;
    const ctx = thumb.getContext('2d');
    ctx.fillStyle = '#1b1e2a';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(src, (freeW - cutW) / 2, (freeH - cutH) / 2, cutW, cutH, 0, 0, width, height);
    return new Promise((resolve) => thumb.toBlob(resolve, 'image/jpeg', 0.85));
  }

  // A video of one turn around the model: MP4 where the browser can make one, else WebM.
  // background: the colour behind the model (a video has no see-through).
  async recordTurn({ seconds = 8, background = '#14161f', onProgress = () => {} } = {}) {
    const type = ['video/mp4;codecs=avc1.640028', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm']
      .find((t) => window.MediaRecorder?.isTypeSupported?.(t));
    if (!type) throw new Error('This browser cannot record video.');
    const stream = this.canvas.captureStream(30);
    const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 10_000_000 });
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
    const before = this.scene.background;
    this.scene.background = new THREE.Color(background);
    this.setMode('orbit');
    this.controls.enabled = false;
    recorder.start(250);
    await new Promise((resolve) => {
      const offset = this.camera.position.clone().sub(this.controls.target);
      this._turning = { started: null, seconds, offset, resolve, onProgress };
    });
    recorder.stop();
    await stopped;
    stream.getTracks().forEach((track) => track.stop());
    this.scene.background = before;
    this.controls.enabled = true;
    return { blob: new Blob(chunks, { type: type.split(';')[0] }), extension: type.startsWith('video/mp4') ? 'mp4' : 'webm' };
  }

  _frame(now) {
    if (this._turning) {
      const turn = this._turning;
      turn.started ??= now;
      const share = Math.min(1, (now - turn.started) / (turn.seconds * 1000));
      const angle = share * Math.PI * 2;
      const o = turn.offset;
      this.camera.position.set(
        this.controls.target.x + o.x * Math.cos(angle) + o.z * Math.sin(angle),
        this.controls.target.y + o.y,
        this.controls.target.z - o.x * Math.sin(angle) + o.z * Math.cos(angle));
      this.camera.lookAt(this.controls.target);
      turn.onProgress(share);
      if (share >= 1) {
        this._turning = null;
        turn.resolve();
      }
    } else if (this.mode === 'fly') {
      this.fly.update(this._lastFrame === null ? 0 : Math.min(0.1, (now - this._lastFrame) / 1000));
    } else {
      this._tiltOrbit(this._lastFrame === null ? 0 : Math.min(0.1, (now - this._lastFrame) / 1000));
      if (this._glide && performance.now() >= this._glide.at) {
        const glide = this._glide;
        if (glide.started === null) {
          glide.started = now;
          glide.from = this.controls.target.clone();
        }
        const share = Math.min(1, (now - glide.started) / GLIDE_MS);
        const eased = share < 0.5 ? 4 * share ** 3 : 1 - (2 - 2 * share) ** 3 / 2;      // in and out gently
        const target = glide.from.clone().lerp(glide.to, eased);
        this.camera.position.add(target.clone().sub(this.controls.target));
        this.controls.target.copy(target);
        if (share >= 1) this._glide = null;
      }
      this.controls.update();
    }
    this._lastFrame = now;
    this.renderer.render(this.scene, this.camera);
    for (const callback of this._callbacks) callback();
  }

  // The part of the view the panel leaves free, in page pixels: { left, top, right, bottom }.
  freeRect() {
    const box = this.canvas.getBoundingClientRect();
    const free = { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
    const panel = this._panel && !this._panel.hidden ? this._panel.getBoundingClientRect() : null;
    if (panel && panel.height > box.height * 0.6) free.right = Math.min(free.right, panel.left - 8);
    else if (panel && panel.width > box.width * 0.6) free.bottom = Math.min(free.bottom, panel.top - 8);
    return free;
  }

  // A panel lies over part of the view: the model is centred in the rest of it.
  coverWith(panel) {
    this._panel = panel;
    this._fit();
  }

  _fit() {
    const w = Math.max(1, this._container.clientWidth), h = Math.max(1, this._container.clientHeight);
    // The window turned or changed much (a phone turned on its side): the whole model in view again.
    const before = this.renderer.getSize(new THREE.Vector2());
    const changed = before.x <= 1 || Math.abs(w - before.x) / before.x > 0.3 || Math.abs(h - before.y) / before.y > 0.3;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // The middle of the picture moves to the middle of the part the panel leaves free: the camera
    // draws a part of a wider (or taller) picture whose middle is there.
    const box = this._container.getBoundingClientRect();
    const panel = this._panel && !this._panel.hidden ? this._panel.getBoundingClientRect() : null;
    const right = panel && panel.height > box.height * 0.6 ? Math.max(0, box.right - panel.left) : 0;
    const bottom = panel && !right && panel.width > box.width * 0.6 ? Math.max(0, box.bottom - panel.top) : 0;
    this._covered = { right, bottom };
    this.camera.aspect = (w + right) / (h + bottom);
    if (right || bottom) this.camera.setViewOffset(w + right, h + bottom, right, bottom, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    if (changed && this._terrain) this.lookAtModel(this._heightMm);
  }
}
