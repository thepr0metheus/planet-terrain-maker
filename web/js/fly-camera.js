// Free flight over a model, the way a bird or a plane flies: the camera goes where it is sent,
// instead of turning about the model's middle.
//
//   look         drag with the mouse (or one finger); R and F tilt the view up and down (pitch);
//                Space (and the page's Level) brings the view back to the horizon
//   fly          W and S (or ↑ ↓) forward and back; A and D (or ← →) turn left and right; Q and E
//                slide left and right; Shift goes up and Ctrl down; the wheel glides forward and
//                back; Alt held is slower
//   hold on      two quick taps of a move's key hold the move on by itself, as if held down (W
//                twice, and the flight goes on at its speed). Both must be short taps, the
//                second soon after the first is let go, and the move is held on as the second is let
//                go: a key let go and pressed again to go on moving holds nothing (it did, and too
//                often, when only the time between the presses counted). A press of the same key
//                lets it go
//   speeds       each action has its own, 0.001 to 1 times the full one (the page's sliders): flight
//                forward and back (also + and −), slide, climb, turn, tilt, and how far the camera
//                leans into a turn
//   on a phone   one finger looks; two fingers pinch to fly forward and back, and drag to slide
//
// The flight has weight. The keys say what the camera is to do, and it comes to that little by
// little: it gathers speed, glides on when let go, eases into a turn and out of it (EASE_S,
// TURN_EASE_S). Like a wing it leans into a turn (BANK) and lifts or dips its nose as it climbs or
// comes down (NOSE); both settle back to level by themselves. A notch of the wheel is a glide of a
// set length, flown out smoothly. Looking with the pointer stays direct: the view follows the hand.
//
// The way the camera goes is set by its heading alone, the turn about the vertical (yaw) and the
// tilt (pitch, kept short of straight up and down); the lean and the nose only show on screen.

import { Euler, MathUtils, Vector3 } from '../vendor/three/three.module.js';

const LOOK_PER_PX = 0.0042;          // radians a pixel of drag turns the view
const PITCH_LIMIT = MathUtils.degToRad(88);
const TURN_PER_S = MathUtils.degToRad(60);     // A and D turn this much a second, at full speed
const PITCH_PER_S = MathUtils.degToRad(40);    // R and F tilt this much a second, at full speed
const EASE_S = 0.6;                  // speed comes to what the keys say in about 3 of these
const TURN_EASE_S = 0.45;            // the same for turning and tilting
const BANK = MathUtils.degToRad(18);           // the lean at a full-speed turn
const NOSE = MathUtils.degToRad(6);            // the nose up (or down) at a full-speed climb
const LEAN_EASE_S = 0.5;             // the lean and the nose follow the turn and the climb this slowly
const LEVEL_EASE_S = 0.35;           // Space: the view comes back to the horizon this smoothly
const GLIDE_S = 0.4;                 // a wheel's glide: most of it flown in about 3 of these
const TAP_MS = 220;                  // a press this short is a tap
const TAP_GAP_MS = 250;              // and a second tap begun this soon after the first is let go holds the move on
// The speed of each action, times its full speed: flight, slide, climb, turn, tilt, and the lean.
export const RATE = { least: 0.001, most: 1, step: 1.25 };       // + and − step the flight by RATE.step
export const RATES = ['move', 'slide', 'climb', 'turn', 'tilt', 'bank'];
// The speeds a flight starts with, each a share of its full speed: found by flying with them.
export const DEFAULT_RATES = Object.freeze({ move: 0.05, slide: 0.05, climb: 0.01, turn: 0.16, tilt: 0.1, bank: 0.5 });
// What each key does, by the key's place on the keyboard (so a Russian layout flies the same).
const KEYS = {
  forward: ['KeyW', 'ArrowUp'], back: ['KeyS', 'ArrowDown'], left: ['KeyQ'], right: ['KeyE'],
  turnLeft: ['KeyA', 'ArrowLeft'], turnRight: ['KeyD', 'ArrowRight'], tiltUp: ['KeyR'], tiltDown: ['KeyF'],
  up: ['ShiftLeft', 'ShiftRight', 'PageUp'], down: ['ControlLeft', 'ControlRight', 'PageDown'],
  slow: ['AltLeft', 'AltRight'],
};
const HOLDABLE = Object.keys(KEYS).filter((move) => move !== 'slow');   // Alt only slows: it is not held on
const LEVEL_KEYS = ['Space'];
const SPEED_KEYS = { Equal: RATE.step, NumpadAdd: RATE.step, Minus: 1 / RATE.step, NumpadSubtract: 1 / RATE.step };

export class FlyCamera {
  // camera: the three.js camera. element: what the pointer drags on (the view's canvas).
  // keys: where key presses are heard (the window; the tests give their own). now(): milliseconds,
  // for the double tap (the tests give their own clock).
  constructor(camera, element, keys = globalThis.window, now = () => performance.now()) {
    this.camera = camera;
    this.element = element;
    this.enabled = false;
    this.speed = 40;                  // the full speed of flight: scene units (millimetres) a second
    this.rates = { ...DEFAULT_RATES };   // each action's share of its full speed
    this.onRate = () => {};           // (name, rate): a rate changed by a key
    this.onHold = () => {};           // (moves): the moves held on by a double tap, after each change
    this._now = now;
    this._yaw = 0;
    this._pitch = 0;
    this._bank = 0;                   // the lean into a turn, radians; shown only
    this._nose = 0;                   // the nose up in a climb, radians; shown only
    this._leveling = false;           // the view on its way back to the horizon
    this._held = new Set();
    this._holding = new Set();        // moves held on by a double tap of their key
    this._tapped = new Map();         // move -> when its last tap was let go, for the double tap
    this._keysDown = new Map();       // key code -> when it went down; a key down already is not pressed again
    this._letGo = new Set();          // key codes whose press let a held move go: no tap of their own
    this._velocity = { forward: 0, right: 0, up: 0, yaw: 0, pitch: 0 };   // what the camera does now: units (radians) a second
    this._glide = 0;                  // the length the wheel still has to fly, forward or back
    this._pointers = new Map();       // pointerId -> { x, y }
    this._pinch = null;               // { distance, x, y } while two fingers are down
    this._euler = new Euler(0, 0, 0, 'YXZ');

    element.addEventListener('pointerdown', (e) => this._down(e));
    element.addEventListener('pointermove', (e) => this._move(e));
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) element.addEventListener(type, (e) => this._up(e));
    element.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
    // Ctrl with a click is the right button on a Mac: in flight it brings no menu
    element.addEventListener('contextmenu', (e) => { if (this.enabled) e.preventDefault(); });
    keys.addEventListener('keydown', (e) => this._key(e, true));
    keys.addEventListener('keyup', (e) => this._key(e, false));
    keys.addEventListener('blur', () => this._held.clear());
  }

  // Take the camera as it stands, still and level. speed: how far a second of flying goes at full
  // speed.
  start(speed) {
    this.speed = speed;
    this._euler.setFromQuaternion(this.camera.quaternion, 'YXZ');
    this._yaw = this._euler.y;
    this._pitch = MathUtils.clamp(this._euler.x, -PITCH_LIMIT, PITCH_LIMIT);
    this._still();
    this.enabled = true;
    this._aim();
  }

  stop() {
    this.enabled = false;
    this._still();
    this._pointers.clear();
    this._pinch = null;
  }

  // An action's speed, times its full speed: kept between RATE.least and RATE.most.
  setRate(name, times) {
    if (!RATES.includes(name)) throw new RangeError(`no such rate: ${name}`);
    const value = Number(times);
    this.rates[name] = MathUtils.clamp(Number.isFinite(value) ? value : 1, RATE.least, RATE.most);
    return this.rates[name];
  }

  // Bring the view back to the horizon, smoothly: the tilt to 0. A tilt by hand stops it.
  level() {
    if (!this.enabled) return;
    this._leveling = true;
    this._velocity.pitch = 0;
  }

  // Move and turn by the keys held, for dt seconds. Run every frame.
  update(dt) {
    if (!this.enabled || !(dt > 0)) return;
    const held = new Set([...this._held, ...this._holding]), v = this._velocity;
    const axis = (plus, minus) => (held.has(plus) ? 1 : 0) - (held.has(minus) ? 1 : 0);
    const pace = held.has('slow') ? 0.3 : 1;
    const rate = this.rates;
    const full = { forward: this.speed * rate.move * pace, right: this.speed * rate.slide * pace, up: this.speed * rate.climb * pace };
    const forward = axis('forward', 'back'), right = axis('right', 'left'), up = axis('up', 'down');
    const keys = Math.hypot(forward, right, up) || 1;          // keys held together go no faster
    const fullTurn = TURN_PER_S * rate.turn * pace;
    const wanted = {
      forward: forward / keys * full.forward, right: right / keys * full.right, up: up / keys * full.up,
      yaw: axis('turnLeft', 'turnRight') * fullTurn,
      pitch: axis('tiltUp', 'tiltDown') * PITCH_PER_S * rate.tilt * pace,
    };
    const ease = 1 - Math.exp(-dt / EASE_S), turnEase = 1 - Math.exp(-dt / TURN_EASE_S);
    for (const key of ['forward', 'right', 'up']) {
      v[key] += (wanted[key] - v[key]) * ease;
      // what is left of a stop is too small to see (a thousandth of the full speed): it ends there
      if (!wanted[key] && Math.abs(v[key]) < full[key] * 1e-3) v[key] = 0;
    }
    const fullAngle = { yaw: fullTurn, pitch: PITCH_PER_S * rate.tilt * pace };
    for (const key of ['yaw', 'pitch']) {
      v[key] += (wanted[key] - v[key]) * turnEase;
      if (!wanted[key] && Math.abs(v[key]) < fullAngle[key] * 1e-3) v[key] = 0;
    }
    this._yaw += v.yaw * dt;
    if (wanted.pitch) this._leveling = false;
    if (this._leveling) {
      this._pitch *= Math.exp(-dt / LEVEL_EASE_S);
      if (Math.abs(this._pitch) < 1e-4) {
        this._pitch = 0;
        this._leveling = false;
      }
    }
    const pitch = this._pitch + v.pitch * dt;
    this._pitch = MathUtils.clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT);
    if (pitch !== this._pitch) v.pitch = 0;          // at the limit the tilt stops
    // The lean into the turn and the nose in a climb, as a wing has them: by how much of its full
    // speed the turn (the climb) goes, the lean times its own rate.
    const leanEase = 1 - Math.exp(-dt / LEAN_EASE_S);
    // a turn to the left leans to the left: the camera rolls about its own axis, its right side up
    const bank = MathUtils.clamp(v.yaw / (TURN_PER_S * rate.turn), -1.5, 1.5) * BANK * rate.bank;
    const nose = MathUtils.clamp(v.up / (this.speed * rate.climb), -1.5, 1.5) * NOSE;
    this._bank += (bank - this._bank) * leanEase;
    this._nose += (nose - this._nose) * leanEase;
    if (Math.abs(this._bank) < 1e-5 && !bank) this._bank = 0;
    if (Math.abs(this._nose) < 1e-5 && !nose) this._nose = 0;
    this._aim();
    let glided = this._glide * (1 - Math.exp(-dt / GLIDE_S));
    if (Math.abs(this._glide - glided) < this.speed * rate.move * 1e-4) glided = this._glide;
    this._glide -= glided;
    const along = v.forward * dt + glided, side = v.right * dt, lift = v.up * dt;
    if (along || side || lift) this._fly(along, side, lift);
  }

  // How the camera leans now, for the tests: { bank, nose } in radians.
  get lean() {
    return { bank: this._bank, nose: this._nose };
  }

  // The moves held on by a double tap: 'forward', 'turnLeft', ...
  get holding() {
    return [...this._holding];
  }

  _still() {
    this._held.clear();
    this._tapped.clear();
    this._keysDown.clear();
    this._letGo.clear();
    if (this._holding.size) {
      this._holding.clear();
      this.onHold([]);
    }
    this._velocity = { forward: 0, right: 0, up: 0, yaw: 0, pitch: 0 };
    this._glide = 0;
    this._bank = 0;
    this._nose = 0;
    this._leveling = false;
  }

  // The camera turned to the heading, with the lean and the nose on top of it.
  _aim() {
    const pitch = MathUtils.clamp(this._pitch + this._nose, -PITCH_LIMIT, PITCH_LIMIT);
    this._euler.set(pitch, this._yaw, this._bank, 'YXZ');
    this.camera.quaternion.setFromEuler(this._euler);
  }

  _look(dx, dy) {
    if (dy) this._leveling = false;
    this._yaw -= dx * LOOK_PER_PX;
    this._pitch = MathUtils.clamp(this._pitch - dy * LOOK_PER_PX, -PITCH_LIMIT, PITCH_LIMIT);
    this._aim();
  }

  // Along the heading (where the camera looks, without its lean), across it, and straight up.
  _fly(forward, right = 0, up = 0) {
    const heading = new Euler(this._pitch, this._yaw, 0, 'YXZ');
    const f = new Vector3(0, 0, -1).applyEuler(heading).multiplyScalar(forward);
    const r = new Vector3(1, 0, 0).applyEuler(heading).multiplyScalar(right);
    this.camera.position.add(f).add(r).add(new Vector3(0, up, 0));
  }

  _down(e) {
    if (!this.enabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
    this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try {
      this.element.setPointerCapture(e.pointerId);
    } catch {
      // a pointer the browser no longer knows: the drag still works while it stays over the view
    }
    if (this._pointers.size === 2) this._pinch = this._twoFingers();
  }

  _move(e) {
    if (!this.enabled || !this._pointers.has(e.pointerId)) return;
    const before = this._pointers.get(e.pointerId);
    this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this._pointers.size === 1) {
      this._look(e.clientX - before.x, e.clientY - before.y);
    } else if (this._pointers.size === 2 && this._pinch) {
      const now = this._twoFingers();
      const box = this.element.getBoundingClientRect();
      // a screen's height of drag: two seconds of flight
      const per = this.speed * this.rates.move * 2 / Math.max(1, box.height);
      this._fly((now.distance - this._pinch.distance) * per, -(now.x - this._pinch.x) * per, (now.y - this._pinch.y) * per);
      this._pinch = now;
    }
  }

  _up(e) {
    this._pointers.delete(e.pointerId);
    this._pinch = this._pointers.size === 2 ? this._twoFingers() : null;
  }

  _twoFingers() {
    const [a, b] = [...this._pointers.values()];
    return { distance: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  // A notch of the wheel: a glide forward or back, a quarter of a second of flight.
  _wheel(e) {
    if (!this.enabled) return;
    e.preventDefault();
    this._glide += -Math.sign(e.deltaY) * this.speed * this.rates.move * 0.25 * Math.min(4, Math.abs(e.deltaY) / 60 + 0.5);
  }

  _key(e, down) {
    if (!this.enabled) return;
    if (e.target?.closest?.('input, select, textarea, [contenteditable]')) return;
    if (down && SPEED_KEYS[e.code]) {
      e.preventDefault();
      this.onRate('move', this.setRate('move', this.rates.move * SPEED_KEYS[e.code]));
      return;
    }
    if (LEVEL_KEYS.includes(e.code)) {
      e.preventDefault();
      if (down) this.level();
      return;
    }
    for (const [move, codes] of Object.entries(KEYS)) {
      if (!codes.includes(e.code)) continue;
      e.preventDefault();
      if (down) {
        this._held.add(move);
        // a key down already repeats, whatever the browser says of it
        if (e.repeat || this._keysDown.has(e.code)) continue;
        this._keysDown.set(e.code, this._now());
        if (this._holding.has(move)) {
          // a press of a move held on lets it go; it goes on while the key is down, as any press
          this._holding.delete(move);
          this._tapped.delete(move);
          this._letGo.add(e.code);
          this.onHold(this.holding);
        }
      } else {
        this._held.delete(move);
        const at = this._keysDown.get(e.code);
        this._keysDown.delete(e.code);
        if (this._letGo.delete(e.code) || at === undefined || !HOLDABLE.includes(move)) continue;
        this._tapEnd(move, at);
      }
    }
  }

  // A press of a move's key let go: a tap when it was short; the second of two quick taps holds the
  // move on. A press held longer is a move, and forgets the tap before it.
  _tapEnd(move, downAt) {
    const now = this._now();
    if (now - downAt > TAP_MS) {
      this._tapped.delete(move);
      return;
    }
    const before = this._tapped.get(move);
    if (before !== undefined && downAt - before <= TAP_GAP_MS) {
      this._holding.add(move);
      this._tapped.delete(move);
      this.onHold(this.holding);
    } else {
      this._tapped.set(move, now);
    }
  }
}
