// The model screen: the model in 3D, the panel that sets its size, heights, picture, water,
// buildings and light, the halves of two places, and what is made from it: files and pictures.

import { ModelView } from './model-view.js';
import { DEFAULT_RATES, RATES } from './fly-camera.js';
import { DETAIL, OutlineTooSmall, buildTerrainMesh, topMm } from './terrain-mesh.js';
import { StylePainter, TRITONES, needsPainting } from './styles.js';
import { Buildings, BuildingsError, buildingsSolid } from './buildings.js';
import { TurnDials } from './turn-dials.js';
import { HeightProbe } from './height-probe.js';
import { HeightRuler } from './height-ruler.js';
import { AsteroidsOnModel, LabelLook } from './asteroid-on-model.js';
import { AsteroidLists, AsteroidSearch, ObjectChoices, entryOf } from './asteroid-search.js';
import { objZipOf, stlOf, threeMfOf } from './exporters.js';
import { exportScene, glbOf, usdzOf } from './export-scene.js';
import { formatDistance } from './map-view.js';
import { worldOf } from './worlds.js';
import { number, t } from './i18n.js';
import { StoredChoice } from './stored-choice.js';
import { nameOfPlaces, placesOfName } from './names.js';
import { linePreview } from './line-preview.js';
import { LinePoints } from './line-points.js';
import { DEVICE } from './device.js';
import { reportError } from './client-errors.js';
import { CustomPicture } from './custom-picture.js';
import { DetailedPictures } from './detailed-pictures.js';

// The buttons of what can be put on the model, and whose tools each opens.
const OBJECT_TOGGLES = [['asteroid-toggle', 'asteroid'], ['comet-toggle', 'comet'], ['vehicle-toggle', 'vehicle']];
const $ = (id) => document.getElementById(id);

// The model's name, or the one its places' names make (names.js) while it has none of its own.
function titleOf(m) {
  return m.name || nameOfPlaces(m.places.map((p) => p.name), t(' and '));
}
// The moves of free flight in words, for the line that says which are held on (fly-camera.js).
const MOVE_WORDS = {
  forward: 'forward', back: 'back', left: 'slide left', right: 'slide right', turnLeft: 'turn left',
  turnRight: 'turn right', tiltUp: 'tilt up', tiltDown: 'tilt down', up: 'up', down: 'down',
};
const PICK_PAUSE_MS = 250;     // the height label shows this long at the click before the view turns there
const SETTLE_MS = 120;
const USDZ_NODES = 350;           // AR Quick Look opens files of about 250 000 triangles; more may not open

export function toJpeg(canvas, quality = 0.9) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = Dom.el('a', { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// A file name from a model's name: its words, joined by hyphens.
export function fileName(name, ext) {
  const words = String(name || 'model').normalize('NFC').replace(/[\\/:*?"<>|]+/g, ' ').trim().split(/\s+/).slice(0, 8).join('-');
  return `${words || 'model'}.${ext}`;
}

export class ModelScreen {
  // say(text, kind): a message. library: Library. onReplace(index): another place for part index.
  // onRedrawLine(): the line between the two places drawn anew on the map.
  // askName(current, title) -> Promise<name | null>; askNames({ model, places }) -> Promise<the same | null>.
  constructor({ say, library, onReplace, onRedrawLine = () => {}, askName, askNames }) {
    this._say = say;
    this._library = library;
    this._askName = askName;
    this._askNames = askNames;
    this._model = null;
    this._mesh = null;
    this._picture = null;
    this._buildingsSolid = null;
    this._timer = null;
    this._painter = new StylePainter();
    this._buildings = new Buildings();
    this._customPicture = new CustomPicture({
      onChanged: () => this._build({ picture: true }),
    });
    this.view = new ModelView($('view'));
    this._details = new DetailedPictures({ view: this.view, say });
    this.view.onLost = () => this._lost();
    this.view.coverWith($('panel'));
    this._dials = new TurnDials({
      container: $('model-screen'), view: this.view,
      onTurn: (place, deg) => this._arrange({ turns: this._model.compare.turns.map((d, i) => (i === place ? deg : d)) }),
      onReplace: (place) => onReplace(place),
    });
    this._probe = new HeightProbe({ container: $('model-screen'), view: this.view, describe: (u, v) => this._describe(u, v) });
    // the ruler of heights: out by its button, both its ends carried by hand; clicks stay as they are
    this._ruler = new HeightRuler({ container: $('model-screen'), view: this.view, distance: formatDistance });
    this._lastPick = null;          // { u, v }: the point of the top clicked last, where the ruler comes out
    // an asteroid put on a model of one place at its real size, found by its tool in the camera bar
    // They are kept in the model's settings as they change (settings.asteroids), so that a save keeps
    // them and the model shown again (a saved one opened, the language changed) has them again.
    this._asteroids = new AsteroidsOnModel({
      container: $('model-screen'), view: this.view, distance: formatDistance, say,
      onChange: () => { this._asteroidControls(); this._keepAsteroids(); },
      onMove: () => this._keepAsteroids(),
    });
    this._asteroidLists = new AsteroidLists();
    this._asteroidsToRestore = [];  // the model's saved asteroids, put back once its solid is built
    this._restoring = false;
    this._asteroidSearch = new AsteroidSearch({
      input: $('asteroid-search'), results: $('asteroid-results'), lists: this._asteroidLists, distance: formatDistance, say,
      onPick: (asteroid) => this._putAsteroid(asteroid),
    });
    this._objectChoices = new ObjectChoices({ list: $('object-choices'), distance: formatDistance, onPick: (entry) => this._putAsteroid(entry) });
    this._objectsShown = null;      // whose tools are open: 'asteroid', 'comet', 'vehicle', or null
    this._labelLook = new LabelLook($('model-screen'));
    this.view.onFrame(() => {
      this._dials.place(); this._probe.place(); this._linePoints.place(); this._ruler.place(); this._asteroids.place();
    });
    // a click on the model: its height first, where it was clicked, then the view turns about it
    // While the line between two places is drawn, a click on the model may be a point of it: the
    // page takes it first (onLinePick returns true), and then it is no height and no turn.
    this.onLinePick = () => false;
    this._lineView = null;          // { divider, points } while the line is drawn on this model
    // the line's points as numbered marks over the model; a click on one takes it away
    this.onLinePointRemove = () => {};
    this._linePoints = new LinePoints({ container: $('model-screen'), view: this.view, onRemove: (i) => this.onLinePointRemove(i) });
    this.view.onPick = (pick) => {
      if (this.onLinePick(pick)) return;
      if (pick.u !== null) {
        this._probe.labelAt(pick.u, pick.v);
        this._lastPick = { u: pick.u, v: pick.v };
      }
      // a click on an asteroid chooses it: the slider raises that one
      const asteroid = pick.object && this._asteroids.itemOf(pick.object);
      if (asteroid) this._asteroids.choose(asteroid);
      this.view.aboutPoint(pick.point, PICK_PAUSE_MS);
    };
    this._wire(onReplace, onRedrawLine);
  }

  get model() { return this._model; }

  // Show a model: its settings in the panel, its solid and its picture.
  show(model) {
    this._model = model;
    this._lineView = null;
    this._linePoints.show([], null);
    this._probe.clear();
    this._lastPick = null;
    this._showRuler(false);
    // the model's saved asteroids, read before the old ones go: their going must not write over them
    const saved = model.isSplit ? [] : [...(model.settings.asteroids ?? [])];
    this._restoring = true;
    this._asteroids.clear();
    this._restoring = false;
    this._asteroidsToRestore = saved;
    this._asteroidSearch.clear();
    this._showObjects(null);
    for (const [id] of OBJECT_TOGGLES) $(id).hidden = model.isSplit;
    this.view.setMode('orbit');
    this.syncCameraButtons();
    this._fillPanel();
    this._customPicture.show(model);
    this._build({ geometry: true, picture: true, fresh: true });
  }

  // ---------- the camera ----------

  // 'orbit' (round the model) or 'fly' (free flight). "Around the model" pressed again turns about
  // the point clicked last.
  cameraMode(mode) {
    if (mode === 'orbit' && this.view.mode === 'orbit') this.view.aboutLastPoint();
    else this.view.setMode(mode);
    this.syncCameraButtons();
  }

  // The settings panel on or off; the model is laid in the view it leaves (refit: whole again).
  _showPanel(on, refit = true) {
    $('panel').hidden = !on;
    const toggle = $('panel-toggle');
    const words = t(on ? 'Hide panel' : 'Show panel');
    toggle.setAttribute('aria-pressed', String(!on));
    toggle.title = words;
    toggle.setAttribute('aria-label', words);
    toggle.querySelector('.panel-close').toggleAttribute('hidden', !on);
    toggle.querySelector('.panel-open').toggleAttribute('hidden', on);
    this._panelChoice.set(on ? 'shown' : 'hidden');
    this.view.coverWith($('panel'));
    if (refit && this._model) this.view.wholeModel();
  }

  // The ruler of heights out (at the point clicked last, or the one in the middle of the view) or away.
  _showRuler(on) {
    if (on && this._mesh) {
      this._ruler.start(this._startPoint(), this._measured());
    } else {
      this._ruler.stop();
    }
    const button = $('ruler-toggle');
    button.setAttribute('aria-pressed', String(this._ruler.on));
    $('ruler-hint').hidden = !this._ruler.on;
  }

  // Where a tool puts its thing first: the point of the top clicked last, else the one in the middle of
  // the view, else the middle of the frame.
  _startPoint() {
    const free = this.view.freeRect();
    const middle = this.view.pickAt((free.left + free.right) / 2, (free.top + free.bottom) / 2);
    return this._lastPick ?? (middle?.u != null ? { u: middle.u, v: middle.v } : { u: 0.5, v: 0.5 });
  }

  // The tools under the camera bar for what can be put on the model: a button each for asteroids (a
  // search), comets and spacecraft (a short list), and with any of them the row of what stands on the
  // model, the height, turn and tilt of the one chosen, the labels' size and a button to hide them, and
  // a way to take them all off. The asteroid list opens by itself only while nothing is on the model: it
  // would cover their chips. kind: whose, or null.
  async _showObjects(kind) {
    this._objectsShown = kind;
    $('asteroid-tools').hidden = !kind;
    for (const [id, own] of OBJECT_TOGGLES) $(id).setAttribute('aria-pressed', String(own === kind));
    $('asteroid-search-row').hidden = kind !== 'asteroid';
    this._asteroidControls();
    if (kind === 'asteroid' && !this._asteroids.items.length) this._asteroidSearch.open();
    else this._asteroidSearch.close();
    if (kind !== 'comet' && kind !== 'vehicle') {
      this._objectChoices.hide();
      return;
    }
    try {
      const lists = await this._asteroidLists.lists();
      if (this._objectsShown === kind) this._objectChoices.show(kind === 'comet' ? lists.comets : lists.vehicles);
    } catch (e) {
      this._say(t('The list did not come: {why}', { why: e.message }), 'error');
    }
  }

  async _putAsteroid(asteroid) {
    if (!this._mesh || this._model?.isSplit) return;
    this._busy(t('Loading the shape…'));
    try {
      await this._asteroids.add(asteroid, this._startPoint());
    } finally {
      this._busy(null);
    }
  }

  // The asteroids on the model as a row of their names: a name chooses that one, its cross takes it
  // off; the height over the ground, the turn and the tilt of the one chosen; the labels' look; and a
  // way to take them all off.
  _asteroidControls() {
    const items = this._asteroids.items, chosen = this._asteroids.chosen;
    $('asteroid-list').replaceChildren(...items.map((item) => {
      const name = item.name;
      const pick = Dom.el('button', { type: 'button', class: 'pick', 'aria-pressed': String(item === chosen),
        title: t('{name}: the sliders raise, turn and tilt it', { name }) }, name);
      pick.addEventListener('click', () => this._asteroids.choose(item));
      const drop = Dom.el('button', { type: 'button', class: 'drop', title: t('Take {name} off the model', { name }),
        'aria-label': t('Take {name} off the model', { name }) }, Icon.make('x', 14));
      drop.addEventListener('click', () => this._asteroids.remove(item));
      return Dom.el('span', { class: 'asteroid-chip' }, pick, drop);
    }));
    $('asteroid-list').hidden = !items.length;
    $('asteroid-remove').hidden = items.length < 2;
    $('object-labels').hidden = !items.length;
    this._labelControls();
    for (const id of ['asteroid-height-row', 'asteroid-turn-row', 'asteroid-tilt-row']) $(id).hidden = !chosen;
    if (!chosen) return;
    $('asteroid-turn').value = String(chosen.turnDeg);
    $('asteroid-tilt').value = String(chosen.tiltDeg);
    this._turnWords(chosen);
    // the slider goes as the square root of the height: the low heights, which matter most, get most of it
    const highest = this._asteroids.highestM;
    $('asteroid-height').value = String(highest > 0 ? Math.sqrt(chosen.altitudeM / highest) : 0);
    $('asteroid-height-val').textContent = chosen.altitudeM > 0 ? formatDistance(chosen.altitudeM) : t('on the ground');
  }

  // The asteroids on the model, kept in its settings (not while the saved ones are put back: one that
  // did not come back would be lost from them).
  _keepAsteroids() {
    if (this._model && !this._model.isSplit && !this._restoring) this._model.settings.asteroids = this._asteroids.saved();
  }

  // A model's saved asteroids put back where they were, as high and as turned as they were.
  async _restoreAsteroids(saved) {
    const model = this._model;
    this._restoring = true;
    try {
      const lists = await this._asteroidLists.lists();
      let back = 0;
      for (const one of saved) {
        const asteroid = entryOf(one.asteroid, lists);
        if (!asteroid || this._model !== model) continue;
        const placed = { exact: true, altitudeM: one.altitudeM ?? 0, turnDeg: one.turnDeg ?? 0, tiltDeg: one.tiltDeg ?? 0 };
        if (await this._asteroids.add(asteroid, one.at, placed)) back += 1;
      }
      if (this._model === model && back === saved.length) model.settings.asteroids = this._asteroids.saved();
    } catch (e) {
      this._say(t('The list of asteroids did not come: {why}', { why: e.message }), 'error');
    } finally {
      if (this._model === model) this._restoring = false;    // a newer model's restore keeps its own
    }
  }

  // The turn or the tilt slider moved: the chosen one turned round the vertical and tilted round a
  // horizontal axis, about its middle.
  _asteroidTurn() {
    this._asteroids.setTurn(Number($('asteroid-turn').value), Number($('asteroid-tilt').value));
    if (this._asteroids.chosen) this._turnWords(this._asteroids.chosen);
  }

  // The labels' size and whether they show, as chosen.
  _labelControls() {
    for (const button of $('label-sizes').querySelectorAll('[data-label-size]')) {
      button.setAttribute('aria-pressed', String(button.dataset.labelSize === this._labelLook.size));
    }
    const shown = this._labelLook.shown;
    $('labels-toggle').textContent = shown ? t('Hide labels') : t('Show labels');
    $('labels-toggle').setAttribute('aria-pressed', String(!shown));
  }

  _turnWords(item) {
    $('asteroid-turn-val').textContent = `${number(item.turnDeg)}°`;
    $('asteroid-tilt-val').textContent = `${number(item.tiltDeg)}°`;
  }

  // The slider moved: the chosen asteroid's new height over the ground.
  _asteroidHeight() {
    const metres = this._asteroids.highestM * Number($('asteroid-height').value) ** 2;
    this._asteroids.setAltitude(metres);
    $('asteroid-height-val').textContent = metres > 0 ? formatDistance(metres) : t('on the ground');
  }

  // What the ruler measures: the solid's own top (terrain-mesh.js topMm), and at each point the data's
  // height and what stands the model's apart from it: the place's lift (the heights mode's offset and
  // its "Raise"), and calm water holding the ground up to its level (height-ruler.js differenceParts).
  _measured() {
    const m = this._model, mesh = this._mesh, s = m.settings;
    const heights = m.heights();
    const offsets = m.isSplit ? heights.offsets : [0];
    const raises = m.isSplit ? m.compare.raises : [0];
    const floor = s.water.calm ? s.water.levelM : -Infinity;
    return {
      top: (u, v) => ({ x: (u - 0.5) * m.frame.widthM * mesh.mmPerM, y: (0.5 - v) * m.frame.heightM * mesh.mmPerM, z: topMm(mesh, u, v) }),
      ground: (u, v) => {
        const { height, place } = m.groundAt(u, v);
        const composed = heights.sample(u, v);
        return { data: height, place, offset: offsets[place ?? 0], raise: raises[place ?? 0], held: Math.max(composed, floor) - composed };
      },
      zMmPerM: mesh.zMmPerM,
      mmPerM: mesh.mmPerM,
      widthMm: Math.max(mesh.size.x, mesh.size.y),
      frame: { widthM: m.frame.widthM, heightM: m.frame.heightM },
      names: m.places.map((p) => p.name),
      stepM: m.frame.widthM / (mesh.top.nx - 1),
    };
  }

  // The moves a double tap holds on in free flight, said over the speeds, so that a flight going on
  // by itself is not taken for a key stuck.
  _showHolding(moves) {
    const line = $('fly-holding');
    line.hidden = !moves.length;
    if (moves.length) line.textContent = t('Held on: {moves}. The same key again, or the opposite one, lets go.', { moves: moves.map((m) => t(MOVE_WORDS[m])).join(', ') });
  }

  syncCameraButtons() {
    const mode = this.view.mode;
    for (const button of $('camera-modes').querySelectorAll('[data-camera]')) {
      button.setAttribute('aria-pressed', String(button.dataset.camera === mode));
    }
    $('fly-hint').hidden = mode !== 'fly';
    $('fly-tools').hidden = mode !== 'fly';
    $('orbit-centre').hidden = mode !== 'orbit';
    if (mode === 'fly') $('app').dataset.flying = '';
    else delete $('app').dataset.flying;
  }

  // ---------- the panel ----------

  _wire(onReplace, onRedrawLine) {
    const slider = (id, key, apply) => {
      $(id).addEventListener('input', () => {
        this._model.settings[key] = Number($(id).value);
        this._outputs();
        apply();
      });
    };
    const geometry = () => this._later({ geometry: true });
    slider('size-mm', 'sizeMm', geometry);
    slider('z-scale', 'zScale', geometry);
    slider('base-mm', 'baseMm', geometry);
    $('detail').addEventListener('change', () => { this._model.settings.detail = $('detail').value; geometry(); });
    $('style').addEventListener('change', () => {
      this._model.settings.style = $('style').value;
      this._model.settings.styleOptions = {};
      this._styleOptions();
      this._later({ picture: true });
    });
    $('water-on').addEventListener('change', () => { this._model.settings.water.on = $('water-on').checked; this._later({ picture: true, geometry: this._model.settings.water.calm }); });
    $('water-calm').addEventListener('change', () => { this._model.settings.water.calm = $('water-calm').checked; geometry(); });
    $('water-level').addEventListener('input', () => {
      this._model.settings.water.levelM = Number($('water-level').value);
      this._outputs();
      const w = this._model.settings.water;
      this._later({ picture: w.on, geometry: w.calm });
    });
    $('buildings-on').addEventListener('change', () => { this._model.settings.buildings = $('buildings-on').checked; geometry(); });
    const light = () => {
      this._model.settings.light = { azimuthDeg: Number($('sun-az').value), elevationDeg: Number($('sun-el').value) };
      this._outputs();
      this.view.setLight(this._model.settings.light);
      if (['contours', 'pencil'].includes(this._model.settings.style)) this._later({ picture: true });
    };
    $('sun-az').addEventListener('input', light);
    $('sun-el').addEventListener('input', light);
    $('angle').addEventListener('input', () => this._arrange({ angleDeg: Number($('angle').value) }));
    $('line-redraw').addEventListener('click', () => onRedrawLine());
    $('line-swap-model').addEventListener('click', () => {
      const line = this._model.divider.swapped();
      this._arrange({ angleDeg: line.angleDeg, points: line.points, smooth: line.smooth });
    });
    for (const half of document.querySelectorAll('#two-places-fold .half')) {
      const i = Number(half.dataset.half);
      half.querySelector('.turn').addEventListener('input', (e) => this._arrange({
        turns: this._model.compare.turns.map((d, k) => (k === i ? Number(e.target.value) : d)) }));
      half.querySelector('.raise').addEventListener('input', (e) => this._arrange({
        raises: this._model.compare.raises.map((m, k) => (k === i ? Number(e.target.value) : m)) }));
      half.querySelector('.half-replace').addEventListener('click', () => onReplace(i));
    }
    for (const button of $('vertical').querySelectorAll('[data-vertical]')) {
      // Lining the pieces up again takes the raises back to nothing.
      button.addEventListener('click', () => this._arrange({ vertical: button.dataset.vertical, raises: [0, 0] }));
    }
    for (const button of $('camera-modes').querySelectorAll('[data-camera]')) {
      button.addEventListener('click', () => this.cameraMode(button.dataset.camera));
    }
    $('orbit-centre').addEventListener('click', () => this.view.centre());
    $('ruler-toggle').addEventListener('click', () => this._showRuler(!this._ruler.on));
    for (const [id, own] of OBJECT_TOGGLES) $(id).addEventListener('click', () => this._showObjects(this._objectsShown === own ? null : own));
    $('asteroid-remove').addEventListener('click', () => {
      this._asteroids.clear();
      this._asteroidSearch.clear();
    });
    $('asteroid-height').addEventListener('input', () => this._asteroidHeight());
    for (const id of ['asteroid-turn', 'asteroid-tilt']) $(id).addEventListener('input', () => this._asteroidTurn());
    for (const button of $('label-sizes').querySelectorAll('[data-label-size]')) {
      button.addEventListener('click', () => {
        this._labelLook.setSize(button.dataset.labelSize);
        this._labelControls();
      });
    }
    $('labels-toggle').addEventListener('click', () => {
      this._labelLook.setShown(!this._labelLook.shown);
      this._labelControls();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !this._ruler.on || $('model-screen').hidden) return;
      if (e.target?.closest?.('input, select, textarea, [contenteditable], dialog')) return;
      this._showRuler(false);
    });
    $('whole-model').addEventListener('click', () => {
      this.view.wholeModel();
      this.syncCameraButtons();
    });
    // The speed of each action of free flight, kept as its slider has it (the power of ten of its
    // share of the full speed, from 0.001 to 1), and Level, which brings the view back to the horizon
    // as Space does.
    this._flyRates = Object.fromEntries(RATES.map((name) => [name, new StoredChoice(`ptm.fly.${name}`)]));
    const showRate = (name, rate) => {
      const input = $('fly-rates').querySelector(`[data-rate="${name}"]`);
      input.value = String(Math.log10(rate));
      input.nextElementSibling.textContent = `×${number(Number(rate.toPrecision(2)))}`;
      this._flyRates[name].set(String(Math.log10(rate)));
    };
    this.view.fly.onRate = showRate;
    this.view.fly.onHold = (moves) => this._showHolding(moves);
    for (const input of $('fly-rates').querySelectorAll('[data-rate]')) {
      const name = input.dataset.rate;
      input.addEventListener('input', () => showRate(name, this.view.fly.setRate(name, 10 ** Number(input.value))));
      // the keys fly again once a slider is let go
      input.addEventListener('change', () => input.blur());
      showRate(name, this.view.fly.setRate(name, 10 ** Number(this._flyRates[name].get(String(Math.log10(DEFAULT_RATES[name]))))));
    }
    const setAll = (rates) => {
      for (const name of RATES) showRate(name, this.view.fly.setRate(name, rates[name]));
    };
    $('fly-defaults').addEventListener('click', () => setAll(DEFAULT_RATES));
    // The set of your own lives on the server (settings.json): the same on every device.
    $('fly-mine').addEventListener('click', async () => {
      try {
        const preset = (await (await fetch('/api/settings')).json()).fly_preset;
        if (!preset) {
          this._say(t('There is no set of yours yet: save one first.'));
          return;
        }
        setAll(preset);
        this._say(t('Your set of speeds is on.'));
      } catch (e) {
        this._say(t('The set did not come: {why}', { why: t(e.message ?? String(e)) }), 'error');
      }
    });
    $('fly-keep').addEventListener('click', async () => {
      try {
        const response = await fetch('/api/settings/fly-preset', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(this.view.fly.rates),
        });
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? String(response.status));
        this._say(t('Kept as your set, for every device.'));
      } catch (e) {
        this._say(t('The set was not kept: {why}', { why: t(e.message ?? String(e)) }), 'error');
      }
    });
    $('fly-level').addEventListener('click', () => this.view.fly.level());
    // The panel can step aside, for looking at the model on a tablet or a small window; the choice is kept.
    this._panelChoice = new StoredChoice('ptm.panel', { allowed: ['shown', 'hidden'] });
    $('panel-toggle').addEventListener('click', () => this._showPanel($('panel').hidden));
    this._showPanel(this._panelChoice.get('shown') === 'shown', false);
    for (const item of $('export-menu').querySelectorAll('[data-export]')) {
      item.addEventListener('click', () => {
        $('export-menu').hidden = true;
        $('export-btn').setAttribute('aria-expanded', 'false');
        this.exportAs(item.dataset.export);
      });
    }
  }

  _fillPanel() {
    const m = this._model, s = m.settings;
    $('size-mm').value = s.sizeMm;
    $('z-scale').value = s.zScale;
    $('base-mm').value = s.baseMm;
    $('detail').value = s.detail;
    $('style').value = s.style;
    $('style').disabled = !this._painter.works;
    const { lowest, highest } = m.heights().range();
    const level = $('water-level');
    level.min = Math.floor(lowest);
    level.max = Math.ceil(highest);
    level.step = Math.max(1, Math.round((highest - lowest) / 400));
    if (s.water.levelM === 0 && m.worlds.some((w) => !worldOf(w).hasSea)) s.water.levelM = Math.round(lowest + (highest - lowest) * 0.12);
    level.value = s.water.levelM;
    $('water-on').checked = s.water.on;
    $('water-calm').checked = s.water.calm;
    const canBuild = !m.isSplit && Buildings.fits(m.places[0]);
    $('buildings-on').disabled = !canBuild;
    $('buildings-on').checked = canBuild && s.buildings;
    $('buildings-note').textContent = canBuild ? t('From OpenStreetMap, for places up to about 10 km across.')
      : t('Buildings come for one place on Earth, up to about 10 km across.');
    $('sun-az').value = s.light.azimuthDeg;
    $('sun-el').value = s.light.elevationDeg;
    this.view.setLight(s.light);
    $('two-places-fold').hidden = !m.isSplit || Boolean(this._lineView);
    if (m.isSplit) this._fillHalves();
    this._styleOptions();
    this._outputs();
    this._caption();
  }

  _fillHalves() {
    const m = this._model, c = m.compare;
    $('angle').value = c.angleDeg;
    for (const half of document.querySelectorAll('#two-places-fold .half')) {
      const i = Number(half.dataset.half);
      half.querySelector('.half-name').textContent = `${m.places[i].name} · ${t(worldOf(m.places[i].world).label)}`;
      half.querySelector('.turn').value = c.turns[i];
      half.querySelector('.raise').value = c.raises[i];
    }
    for (const button of $('vertical').querySelectorAll('[data-vertical]')) {
      button.setAttribute('aria-pressed', String(button.dataset.vertical === c.vertical));
    }
  }

  _outputs() {
    const s = this._model.settings;
    $('size-val').textContent = t('{n} mm', { n: s.sizeMm });
    $('z-val').textContent = number(s.zScale, 1);
    $('base-val').textContent = t('{n} mm', { n: s.baseMm });
    $('water-val').textContent = t('{n} m', { n: s.water.levelM });
    $('sun-az-val').textContent = `${s.light.azimuthDeg}°`;
    $('sun-el-val').textContent = `${s.light.elevationDeg}°`;
    if (this._model.isSplit) {
      const c = this._model.compare;
      $('angle-val').textContent = `${c.angleDeg}°`;
      for (const half of document.querySelectorAll('#two-places-fold .half')) {
        const i = Number(half.dataset.half);
        half.querySelector('.turn-val').textContent = `${c.turns[i]}°`;
        half.querySelector('.raise-val').textContent = t('{n} m', { n: (c.raises[i] > 0 ? '+' : '') + c.raises[i] });
      }
    }
  }

  // The options of the style chosen: a few fields under it.
  _styleOptions() {
    const s = this._model.settings;
    const box = $('style-options');
    box.replaceChildren();
    const options = s.styleOptions;
    const range = (label, key, min, max, step, value) => {
      const input = Dom.el('input', { type: 'range', min, max, step, value: options[key] ?? value });
      input.addEventListener('input', () => { options[key] = Number(input.value); this._later({ picture: true }); });
      box.append(Dom.el('label', { class: 'slider' }, t(label), Dom.el('output'), input));
    };
    const select = (label, key, choices, value) => {
      const input = Dom.el('select', {}, ...choices.map(([v, words]) => Dom.el('option', { value: v }, t(words))));
      input.value = String(options[key] ?? value);
      input.addEventListener('change', () => {
        options[key] = Number.isNaN(Number(input.value)) ? input.value : Number(input.value);
        this._later({ picture: true });
      });
      box.append(Dom.el('label', { class: 'select' }, t(label), input));
    };
    if (s.style === 'photo') {
      range('Brightness', 'brightness', -0.3, 0.3, 0.01, 0);
      range('Contrast', 'contrast', 0.6, 1.8, 0.02, 1);
      range('Colour', 'saturation', 0, 2, 0.05, 1);
    } else if (s.style === 'contours') {
      select('Lines every', 'stepM', [[0, 'Auto'], [5, '5 m'], [10, '10 m'], [20, '20 m'], [50, '50 m'], [100, '100 m'],
        [200, '200 m'], [500, '500 m'], [1000, '1000 m']], 0);
      const over = Dom.el('input', { type: 'checkbox' });
      over.checked = Boolean(options.overPhoto);
      over.addEventListener('change', () => { options.overPhoto = over.checked; this._later({ picture: true }); });
      box.append(Dom.el('label', { class: 'check' }, over, t('Over the photo')));
    } else if (s.style === 'tritone') {
      select('Colours', 'palette', Object.keys(TRITONES).map((k) => [k, { dusk: 'Dusk', sepia: 'Sepia', atlas: 'Atlas', ink: 'Ink' }[k]]), 'dusk');
    }
  }

  _caption() {
    const m = this._model;
    const names = m.places.map((p) => `${p.name}${m.worlds.length > 1 || p.world !== 'earth' ? ` (${t(worldOf(p.world).label)})` : ''}`);
    const title = m.name || names.join(t(' and '));
    const b = m.outline.bounds;
    const extent = m.outline.kind === 'circle' ? `⌀ ${formatDistance(m.places[0].widthM)}`
      : `${formatDistance(b.maxX - b.minX)} × ${formatDistance(b.maxY - b.minY)}`;
    const size = this._mesh ? `${Math.round(this._mesh.size.x)} × ${Math.round(this._mesh.size.y)} × ${Math.round(this._mesh.size.z)} ${t('mm')}` : '';
    const scale = this._mesh ? t('1 mm = {d}', { d: formatDistance(1 / this._mesh.mmPerM) }) : '';
    const rename = Dom.el('button', { type: 'button', class: 'caption-edit', title: t('Rename the model and its places'),
      'aria-label': t('Rename the model and its places') }, Icon.make('pencil', 16));
    rename.addEventListener('click', () => this._rename());
    const credits = [...new Set(m.places.filter((p) => p.sources.customPicture).map((p) => p.sources.pictureCredit))];
    $('model-caption').replaceChildren(
      Dom.el('div', { class: 'title' }, title, rename),
      Dom.el('div', { class: 'meta' }, [m.name ? names.join(' · ') : '', extent, size, scale].filter(Boolean).join(' · ')),
      ...credits.map((credit) => Dom.el('div', { class: 'meta' }, t('Picture source: {source}', { source: credit }))));
  }

  // ---------- building ----------

  _arrange(changes) {
    this._model.arrange(changes);
    this._fillHalves();
    this._outputs();
    this._later({ geometry: true, picture: true });
  }

  _later(what) {
    this._pending = { geometry: Boolean(this._pending?.geometry || what.geometry), picture: Boolean(this._pending?.picture || what.picture) };
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      const job = this._pending;
      this._pending = null;
      this._build(job);
    }, SETTLE_MS);
  }

  async _build({ geometry = false, picture = false, fresh = false }) {
    const m = this._model;
    if (!m) return;
    try {
      if (picture || !this._picture) {
        this._picture = this._paint();
        if (fresh) this._checkPicture(this._picture);
      }
      if (geometry || !this._mesh) {
        this._mesh = this._solid(m.settings.detail);
        this._buildingsSolid = m.settings.buildings ? await this._houses(this._mesh) : null;
        if (m !== this._model) return;
        this.view.show({ mesh: this._mesh, picture: this._picture, buildings: this._buildingsSolid,
          surface: (u, v) => this._surfaceAt(u, v), keepCamera: !fresh });
        this._details.show(m, this._mesh);
        if (this._ruler.on) this._ruler.measure(this._measured());
        this._asteroids.measure(this._measured());
        if (this._asteroidsToRestore.length) this._restoreAsteroids(this._asteroidsToRestore.splice(0));
        $('size-note').textContent = t('{n} triangles', { n: number(this._mesh.triangles) });
      } else {
        this.view.setPicture(this._picture);
        this._details.show(m, this._mesh);
      }
      if (m.isSplit) this._dials.show(m.dialAnchors(), m.compare.turns, m.places.map((p) => p.name));
      else this._dials.hide();
      this._caption();
    } catch (e) {
      if (e instanceof OutlineTooSmall) this._say(t('The outline is too small for the detail: choose a bigger place.'), 'error');
      else {
        this._say(t('The model could not be built: {why}', { why: t(e.message) }), 'error');
        reportError(e, 'build');
      }
    }
  }

  // The solid at a detail.
  _solid(detail, nodes = DETAIL[detail]) {
    const m = this._model, s = m.settings;
    return buildTerrainMesh({
      heights: m.heights(), frame: m.frame, outline: m.outline, sizeMm: s.sizeMm, zScale: s.zScale, baseMm: s.baseMm,
      nodes, floorM: s.water.calm ? s.water.levelM : -Infinity,
    });
  }

  // A picture that came out blank (all black or clear) is told to the server with what may explain
  // it: a device that could not hold a picture this big shows the model black.
  _checkPicture(picture) {
    try {
      const probe = document.createElement('canvas');
      probe.width = probe.height = 16;
      const ctx = probe.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(picture, 0, 0, 16, 16);
      const data = ctx.getImageData(0, 0, 16, 16).data;
      let lit = 0;
      for (let k = 0; k < data.length; k += 4) if (data[k + 3] && data[k] + data[k + 1] + data[k + 2] > 12) lit += 1;
      if (lit > 0) return;
    } catch {
      // a canvas that cannot be read is told too
    }
    const m = this._model;
    reportError('the picture of the model came out blank', 'picture', {
      picture: [picture?.width, picture?.height], places: m.places.map((p) => [p.picture?.width, p.picture?.height]),
      stored: m.places.map((p) => p.stored && [p.stored.width, p.stored.height]),
      style: m.settings.style, touch: DEVICE.touch, canvasMostPx: DEVICE.canvasMostPx,
      maxTexture: this.view.renderer.capabilities.maxTextureSize, pixelRatio: window.devicePixelRatio,
    });
    this._say(t('The picture came out blank: this device had no memory for it. The error is kept on the server.'), 'error');
  }

  // The view's WebGL was dropped by the browser (out of graphics memory): the model is gone from the
  // screen until the page is loaded again.
  _lost() {
    const m = this._model;
    reportError('the WebGL of the model view was lost', 'webgl', {
      places: m?.places.map((p) => [p.picture?.width, p.picture?.height]) ?? [], touch: DEVICE.touch,
      canvasMostPx: DEVICE.canvasMostPx, pixelRatio: window.devicePixelRatio,
    });
    this._say(t('The graphics of this browser stopped: it had no memory left. Reload the page.'), 'error');
  }

  _paint() {
    const m = this._model, s = m.settings;
    // the photo as it is goes straight on: no copy, and no limit on its size
    const picture = !this._painter.works || !needsPainting(s.style, s.styleOptions, s.water) ? m.picture()
      : this._painter.paint({
        picture: m.picture(), heights: m.heights(), metres: m.frame, style: s.style, options: s.styleOptions,
        water: s.water.on ? s.water : null, sun: s.light,
      });
    // the line being drawn lies on the picture, the second place's part dimmed (line-preview.js)
    return this._lineView ? linePreview(picture, { divider: this._lineView.divider, outline: m.outline, frame: m.frame }) : picture;
  }

  // The line between two places drawn on this model, or null when it is not drawn (any more): the
  // line on the picture, its points as marks over it, and the places' own tools out of the panel
  // meanwhile (the line's tools are in the guide's bar).
  showLine(view) {
    const was = this._lineView;
    this._lineView = view;
    this._details.line(Boolean(view));
    const m = this._model;
    if (!m) return;
    this._linePoints.show(view?.points ?? [], m.frame);
    $('two-places-fold').hidden = !m.isSplit || Boolean(view);
    if (view || was) this._build({ picture: true });
  }

  async _houses(mesh) {
    const m = this._model;
    try {
      const { buildings, cut } = await this._buildings.load(m.places[0]);
      if (cut) this._say(t('Only part of the buildings came: the place has very many.'));
      const solid = buildingsSolid(buildings, m.outline, mesh, (x, y) => this._groundMm(mesh, x, y));
      if (!solid) this._say(t('OpenStreetMap has no buildings inside this outline.'));
      return solid;
    } catch (e) {
      this._say(e instanceof BuildingsError ? t(e.message) : t('The buildings did not come.'), 'error');
      return null;
    }
  }

  // The top of the ground at a point (metres about the centre), millimetres above the bottom.
  _groundMm(mesh, x, y) {
    const m = this._model, s = m.settings;
    const h = m.heights().sample(x / m.frame.widthM + 0.5, 0.5 - y / m.frame.heightM);
    const floor = s.water.calm ? s.water.levelM : -Infinity;
    return mesh.baseMm + (Math.max(h, floor) - mesh.lowestM) * mesh.zMmPerM;
  }

  _surfaceAt(u, v) {
    const m = this._model, mesh = this._mesh;
    if (!mesh) return null;
    const x = (u - 0.5) * m.frame.widthM, y = (0.5 - v) * m.frame.heightM;
    return { x: x * mesh.mmPerM, y: y * mesh.mmPerM, z: this._groundMm(mesh, x, y) };
  }

  _describe(u, v) {
    const m = this._model;
    const { height, place } = m.groundAt(u, v);
    return {
      value: Number.isFinite(height) ? t('{n} m', { n: number(Math.round(height)) }) : t('no data'),
      name: place === null ? null : m.places[place].name,
    };
  }

  // ---------- files ----------

  async exportAs(kind) {
    const m = this._model;
    if (!m || !this._mesh) return;
    const name = titleOf(m);
    const solids = [this._mesh, this._buildingsSolid].filter(Boolean);
    this._busy(t('Making the file…'));
    try {
      if (kind === 'stl') download(new Blob([stlOf(solids, name)], { type: 'model/stl' }), fileName(name, 'stl'));
      else if (kind === '3mf') download(new Blob([threeMfOf(solids, name)], { type: 'model/3mf' }), fileName(name, '3mf'));
      else if (kind === 'obj') {
        const jpeg = new Uint8Array(await (await toJpeg(this._picture)).arrayBuffer());
        download(new Blob([objZipOf(this._mesh, jpeg, this._buildingsSolid ? [this._buildingsSolid] : [], name)], { type: 'application/zip' }), fileName(name, 'obj.zip'));
      } else if (kind === 'glb') {
        const scene = exportScene(this._mesh, this._picture, this._buildingsSolid, name);
        this._details.addToExport(scene);
        download(new Blob([await glbOf(scene)], { type: 'model/gltf-binary' }), fileName(name, 'glb'));
      } else if (kind === 'usdz') {
        const nodes = Math.min(USDZ_NODES, DETAIL[m.settings.detail]);
        const mesh = nodes === DETAIL[m.settings.detail] ? this._mesh : this._solid(m.settings.detail, nodes);
        const bytes = await usdzOf(exportScene(mesh, this._picture, this._buildingsSolid, name));
        download(new Blob([bytes], { type: 'model/vnd.usdz+zip' }), fileName(name, 'usdz'));
        if (nodes < DETAIL[m.settings.detail]) this._say(t('USDZ is made at {n} points a side, so that the iPhone opens it.', { n: nodes }));
      } else if (kind === 'png') {
        download(await this.view.snapshot(), fileName(name, 'png'));
      } else if (kind === 'video') {
        this._busy(t('Recording a turn around the model…'));
        const { blob, extension } = await this.view.recordTurn({ seconds: 8 });
        download(blob, fileName(name, extension));
        if (extension !== 'mp4') this._say(t('This browser records WebM, not MP4. Safari and Chrome on a Mac record MP4.'));
      }
    } catch (e) {
      this._say(t('The file was not made: {why}', { why: t(e.message ?? String(e)) }), 'error');
      reportError(e, `export ${kind}`);
    } finally {
      this._busy(null);
    }
  }

  // Save the model in the library: a name first. Whether it was saved.
  // New names for the model and its places (the names found on the map are not always right): on
  // screen at once, and in the library when the model is saved there.
  async _rename() {
    const m = this._model;
    if (!m) return;
    const names = await this._askNames({ model: titleOf(m), places: m.places.map((p) => p.name) });
    if (!names) return;
    m.name = names.model;
    this._namePlaces(names.places);
    if (!m.id) {
      this._say(t('The names are kept when the model is saved.'));
      return;
    }
    try {
      await this._library.rename(m.id, m.name, m.places.map((p) => p.name));
      this._say(t('Renamed: {name}', { name: m.name }));
    } catch (e) {
      this._say(t(e.message ?? String(e)), 'error');
    }
  }

  // The places' names, on the model and on screen: the caption, the halves of the panel and the dials.
  _namePlaces(names) {
    const m = this._model;
    m.places.forEach((place, i) => { place.name = names[i]; });
    this._caption();
    if (m.isSplit) {
      this._fillHalves();
      this._dials.show(m.dialAnchors(), m.compare.turns, m.places.map((p) => p.name));
    }
  }

  // A copy of the model as it is on screen, saved as a new model under the name asked for; the copy
  // is what stays on screen, the model copied is left as it was saved.
  async copy() {
    const m = this._model;
    if (!m) return false;
    const name = await this._askName(t('{name} (copy)', { name: titleOf(m) }), t('Copy the model'));
    if (name === null) return false;
    const before = { id: m.id, name: m.name };
    m.id = null;
    m.name = name;
    this._busy(t('Saving…'));
    try {
      await this._library.save(m, await this.view.thumbnail(), (canvas) => toJpeg(canvas, 0.88));
      this._caption();
      this._say(t('Copied: {name}. The copy is on screen now.', { name }));
      return true;
    } catch (e) {
      m.id = before.id;
      m.name = before.name;
      this._say(t('Not copied: {why}', { why: t(e.message ?? String(e)) }), 'error');
      reportError(e, 'copy');
      return false;
    } finally {
      this._busy(null);
    }
  }

  async save() {
    const m = this._model;
    if (!m) return false;
    const suggested = titleOf(m);
    const name = await this._askName(suggested, m.id ? t('Save again') : t('Save the model'));
    if (name === null) return false;
    m.name = name;
    // a name typed anew names the places too (names.js), as a rename does
    const given = name !== suggested ? placesOfName(name, m.places.length, t(' and ')) : null;
    if (given) this._namePlaces(given);
    this._busy(t('Saving…'));
    try {
      await this._library.save(m, await this.view.thumbnail(), (canvas) => toJpeg(canvas, 0.88));
      this._caption();
      this._say(t('Saved: {name}', { name }));
      return true;
    } catch (e) {
      this._say(t('Not saved: {why}', { why: t(e.message ?? String(e)) }), 'error');
      reportError(e, 'save');
      return false;
    } finally {
      this._busy(null);
    }
  }

  _busy(text) {
    $('model-busy').hidden = !text;
    $('model-busy-text').textContent = text ?? '';
  }
}
