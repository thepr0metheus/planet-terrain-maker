import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PerspectiveCamera, MathUtils, Vector3 } from '../../web/vendor/three/three.module.js';
import { DEFAULT_RATES, FlyCamera, RATE, RATES } from '../../web/js/fly-camera.js';

function setup() {
  const camera = new PerspectiveCamera(32, 1, 1, 1000);
  camera.position.set(0, 50, 100);
  camera.lookAt(0, 50, 0);                      // looking north (-z), level
  const element = new EventTarget();
  const keys = new EventTarget();
  let clock = 0;                                            // milliseconds: the flight's own, not the wall's
  const fly = new FlyCamera(camera, element, keys, () => clock);
  fly.start(40);
  for (const name of RATES) fly.setRate(name, 1);           // the tests fly at full speeds
  const press = (code, down = true, more = {}) => keys.dispatchEvent(Object.assign(new Event(down ? 'keydown' : 'keyup'), { code, ...more }));
  // seconds of flight, a frame at a time
  const run = (seconds, frame = 1 / 60) => {
    for (let t = 0; t < seconds - 1e-9; t += frame) {
      fly.update(frame);
      clock += frame * 1000;
    }
  };
  return { camera, fly, press, run, element };
}

const look = (camera) => new Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
const yawOf = (camera) => MathUtils.radToDeg(Math.atan2(-look(camera).x, -look(camera).z));   // 0 north, + to the left
const pitchOf = (camera) => MathUtils.radToDeg(Math.asin(look(camera).y));
const turned = (from, to) => ((to - from) % 360 + 540) % 360 - 180;                           // degrees, across ±180
const rightSideUp = (camera) => new Vector3(1, 0, 0).applyQuaternion(camera.quaternion).y;

test('W gathers speed gently, flies at its speed, and glides on to a stop when let go', () => {
  const { camera, press, run } = setup();
  press('KeyW');
  run(0.1);
  const early = 100 - camera.position.z;
  assert.ok(early > 0 && early < 40 * 0.1 * 0.3, `in the first tenth of a second only ${early}: no jerk`);
  run(3.9);
  const z = camera.position.z;
  run(1);
  assert.ok(Math.abs(z - camera.position.z - 40) < 0.1, 'at full speed: 40 a second');
  press('KeyW', false);
  const at = camera.position.z;
  run(0.2);
  const coasting = at - camera.position.z;
  assert.ok(coasting > 40 * 0.2 * 0.5 && coasting < 40 * 0.2, `it glides on, it does not stop dead: ${coasting}`);
  run(5);
  const still = camera.position.z;
  run(1);
  assert.equal(camera.position.z, still, 'and then it stands still');
});

test('A and D turn smoothly, 60° a second at full speed, leaning into the turn like a wing', () => {
  const { camera, fly, press, run } = setup();
  press('KeyA');
  run(0.1);
  assert.ok(yawOf(camera) > 0 && yawOf(camera) < 6 * 0.5, `a gentle start: ${yawOf(camera)}°`);
  run(2.9);
  const yaw = yawOf(camera);
  run(1);
  assert.ok(Math.abs(turned(yaw, yawOf(camera)) - 60) < 0.2, 'then 60° a second');
  assert.ok(rightSideUp(camera) > 0.25, 'turning left, it leans left: its right side up');
  assert.ok(MathUtils.radToDeg(fly.lean.bank) > 15, `the lean: ${MathUtils.radToDeg(fly.lean.bank)}°`);
  press('KeyA', false);
  run(6);
  const settled = yawOf(camera);
  run(1);
  assert.ok(Math.abs(yawOf(camera) - settled) < 1e-9, 'the turn eases out and ends');
  assert.ok(Math.abs(rightSideUp(camera)) < 1e-4, 'and the wings are level again');
  assert.deepEqual(camera.position.toArray(), [0, 50, 100], 'turning alone does not move it');
});

test('Shift climbs and Ctrl comes down, smoothly, the nose up and down a little, then level', () => {
  const { camera, fly, press, run } = setup();
  press('ShiftLeft');
  run(0.05);
  assert.ok(camera.position.y - 50 < 40 * 0.05 * 0.5, 'a gentle start');
  run(3);
  assert.ok(pitchOf(camera) > 3 && pitchOf(camera) < 7, `the nose up in the climb: ${pitchOf(camera)}°`);
  press('ShiftLeft', false);
  run(5);
  const top = camera.position.y;
  assert.ok(top > 50 + 40 * 3 * 0.9, `climbed: ${top}`);
  press('ControlRight');
  run(3);
  assert.ok(camera.position.y < top - 40 * 2, 'came down');
  assert.ok(pitchOf(camera) < -3, 'the nose down coming down');
  press('ControlRight', false);
  run(6);
  assert.ok(Math.abs(pitchOf(camera)) < 1e-3 && Math.abs(rightSideUp(camera)) < 1e-6, 'level again');
});

test('Q and E slide left and right; R and F tilt the view, short of straight up; Space levels it', () => {
  const { camera, fly, press, run } = setup();
  press('KeyE');
  run(3);
  press('KeyE', false);
  run(5);
  assert.ok(camera.position.x > 40 * 2, `slid east: ${camera.position.x}`);
  assert.ok(Math.abs(yawOf(camera)) < 1e-9, 'without turning');
  press('KeyR');
  run(0.1);
  assert.ok(pitchOf(camera) > 0 && pitchOf(camera) < 4 * 0.5, `a gentle start: ${pitchOf(camera)}°`);
  run(5);
  assert.ok(Math.abs(pitchOf(camera) - 88) < 1e-6, 'held: up to 88°, not over');
  press('KeyR', false);
  press('KeyF');
  run(1.5);
  press('KeyF', false);
  assert.ok(pitchOf(camera) < 88 - 30, 'F tilts it down again');
  press('Space');
  press('Space', false);
  run(0.1);
  assert.ok(pitchOf(camera) > 10, 'Space brings it back smoothly, not at once');
  run(4);
  assert.equal(Math.round(pitchOf(camera) * 1e6) / 1e6, 0, 'on the horizon');
});

test('each action has its own speed, 0.001 to 1 of its full one; + and − step the flight', () => {
  const { camera, fly, press, run } = setup();
  const told = [];
  fly.onRate = (name, rate) => told.push([name, rate]);
  press('Minus');
  press('Minus', false);
  assert.equal(fly.rates.move, 0.8);
  press('Equal');
  press('NumpadAdd');
  assert.equal(fly.rates.move, 1, 'not past the full speed');
  assert.deepEqual(told, [['move', 0.8], ['move', 1], ['move', 1]]);
  assert.equal(fly.setRate('turn', 5), RATE.most);
  assert.equal(fly.setRate('turn', 0), RATE.least);
  assert.throws(() => fly.setRate('roll', 0.5), RangeError);
  fly.setRate('move', 0.5);
  press('KeyW');
  run(5);
  const z = camera.position.z;
  run(1);
  assert.ok(Math.abs(z - camera.position.z - 20) < 0.1, 'half the flight: 20 a second');
  press('KeyW', false);
  run(8);
  fly.setRate('move', 0.001);
  press('KeyW');
  run(5);
  const slow = camera.position.z;
  run(1);
  assert.ok(Math.abs(slow - camera.position.z - 0.04) < 1e-4, 'a thousandth: 0.04 a second');
});

test('a slower turn, a smaller lean: the turn and the lean each have their rate', () => {
  const { camera, fly, press, run } = setup();
  fly.setRate('turn', 0.5);
  press('KeyA');
  run(3);
  const yaw = yawOf(camera);
  run(1);
  assert.ok(Math.abs(turned(yaw, yawOf(camera)) - 30) < 0.2, 'half the turn: 30° a second');
  assert.ok(MathUtils.radToDeg(fly.lean.bank) > 17, 'the full lean, the turn being full for its rate');
  fly.setRate('bank', 0.001);
  run(4);
  assert.ok(MathUtils.radToDeg(fly.lean.bank) < 0.1, 'and almost none at a thousandth');
  press('KeyA', false);
  fly.setRate('tilt', 0.25);
  press('KeyR');
  run(3);
  const pitch = pitchOf(camera);
  run(0.5);
  assert.ok(Math.abs(pitchOf(camera) - pitch - 5) < 0.1, 'a quarter of the tilt: 10° a second');
});

test('a notch of the wheel is a glide, flown out smoothly', () => {
  const { camera, run, element } = setup();
  element.dispatchEvent(Object.assign(new Event('wheel'), { deltaY: -60, preventDefault() {} }));
  run(1 / 60);
  const first = 100 - camera.position.z;
  run(4);
  const total = 100 - camera.position.z;
  assert.ok(first > 0 && first < total * 0.2, `not all at once: ${first} of ${total}`);
  assert.ok(Math.abs(total - 40 * 0.25 * 1.5) < 1e-6, `a notch: ${total}`);
});

test('a flight starts at its default speeds', () => {
  const fly = new FlyCamera(new PerspectiveCamera(), new EventTarget(), new EventTarget());
  assert.deepEqual(fly.rates, { move: 0.05, slide: 0.05, climb: 0.01, turn: 0.16, tilt: 0.1, bank: 0.5 });
  assert.deepEqual(fly.rates, DEFAULT_RATES);
  fly.setRate('move', 1);
  assert.equal(DEFAULT_RATES.move, 0.05, 'the defaults stay as they are');
});

test('nothing moves while flight is off', () => {
  const { camera, fly, press, run } = setup();
  fly.stop();
  press('KeyW');
  run(1);
  assert.deepEqual(camera.position.toArray(), [0, 50, 100]);
});

test('W tapped twice quickly flies on by itself at its speed; a tap of W lets it go', () => {
  const { camera, fly, press, run } = setup();
  const told = [];
  fly.onHold = (moves) => told.push(moves);
  const tap = (code) => { press(code); run(0.05); press(code, false); };
  tap('KeyW');
  run(0.15);
  tap('KeyW');                                   // the second tap 0.15 s after the first is let go
  assert.deepEqual(fly.holding, ['forward']);
  run(5);
  const z = camera.position.z;
  run(1);
  assert.ok(Math.abs(z - camera.position.z - 40) < 0.1, 'no key down, and it flies at full speed: 40 a second');
  tap('KeyW');
  assert.deepEqual(fly.holding, []);
  run(6);
  const still = camera.position.z;
  run(1);
  assert.equal(camera.position.z, still, 'let go: it glides to a stop');
  assert.deepEqual(told, [['forward'], []]);
});

test('only two short quick taps hold a move on: not a key let go and pressed again to go on moving', () => {
  const { fly, press, run } = setup();
  const told = [];
  fly.onHold = (moves) => told.push(moves);
  // let go, and pressed again at once to fly on: the second press is held, it is no tap
  press('KeyW'); run(0.1); press('KeyW', false);
  run(0.05);
  press('KeyW'); run(0.6);
  assert.deepEqual(fly.holding, [], 'nothing held while the second press is down');
  press('KeyW', false);
  assert.deepEqual(fly.holding, [], 'nor when it is let go: it was a move');
  // a first press held as a move, then a tap
  run(1);
  press('KeyA'); run(0.4); press('KeyA', false);
  run(0.1);
  press('KeyA'); run(0.05); press('KeyA', false);
  assert.deepEqual(fly.holding, [], 'the first press was a move, not a tap');
  // two taps too far apart
  run(1);
  press('KeyD'); run(0.05); press('KeyD', false);
  run(0.3);
  press('KeyD'); run(0.05); press('KeyD', false);
  assert.deepEqual(fly.holding, [], 'the second tap began 0.3 s after the first was let go');
  // repeats a browser does not mark are no presses either: a key held half a second is no tap
  run(1);
  press('KeyQ');
  for (let k = 0; k < 16; k += 1) { run(0.03); press('KeyQ'); }
  press('KeyQ', false);
  run(0.1);
  press('KeyQ'); run(0.05); press('KeyQ', false);
  assert.deepEqual(fly.holding, [], 'held with unmarked repeats, then a tap: nothing held');
  // and the real double tap, held on as the second tap is let go
  run(1);
  press('KeyE'); run(0.06); press('KeyE', false);
  run(0.12);
  press('KeyE'); run(0.06);
  assert.deepEqual(fly.holding, [], 'not yet: the second tap is down');
  press('KeyE', false);
  assert.deepEqual(fly.holding, ['right'], 'two short quick taps: held on');
  assert.deepEqual(told, [['right']]);
});

test('slow taps, a key held down and Alt hold nothing on; leaving the flight lets all go', () => {
  const { fly, press, run } = setup();
  press('KeyA'); run(0.05); press('KeyA', false);
  run(0.6);
  press('KeyA'); run(0.05); press('KeyA', false);
  assert.deepEqual(fly.holding, [], 'taps 0.65 s apart: two presses, not a double tap');
  press('KeyD');
  for (let i = 0; i < 5; i += 1) { run(0.03); press('KeyD', true, { repeat: true }); }
  press('KeyD', false);
  assert.deepEqual(fly.holding, [], 'the repeats of a key held down are not taps');
  press('AltLeft'); press('AltLeft', false); press('AltLeft'); press('AltLeft', false);
  assert.deepEqual(fly.holding, [], 'Alt only slows');
  press('ShiftLeft'); press('ShiftLeft', false); press('ShiftLeft'); press('ShiftLeft', false);
  press('KeyR'); press('KeyR', false); press('KeyR'); press('KeyR', false);
  assert.deepEqual(fly.holding.sort(), ['tiltUp', 'up']);
  fly.stop();
  assert.deepEqual(fly.holding, []);
});

test('a drag of the mouse looks round in flight, the keys\' hold notwithstanding', () => {
  // a field of the keys once took the name of the pointer's handler, and a drag in flight broke
  const { camera, element, press, run } = setup();
  const pointer = (type, x, y) => element.dispatchEvent(Object.assign(new Event(type), { pointerId: 1, pointerType: 'mouse', button: 0, clientX: x, clientY: y }));
  element.setPointerCapture = () => {};
  press('KeyW'); run(0.05); press('KeyW', false);
  pointer('pointerdown', 100, 100);
  pointer('pointermove', 160, 100);
  pointer('pointerup', 160, 100);
  run(0.1);
  assert.ok(Math.abs(yawOf(camera)) > 5, `dragged 60 px sideways, it looks round: ${yawOf(camera)}°`);
});

