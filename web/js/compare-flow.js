// The two-places guide at work: what CompareWizard decides, done on the map and model screens, and
// the guide's bar and world dialog drawn from its view. The first place is captured as soon as it is
// framed, and the line between the places is drawn on its model, in 3D (line-tool.js): through the
// centre at a turn, or the user's own points clicked on the model. Once drawn, the line is a Divider
// in metres about the first place's centre (divider.js). While the second place is found on the map,
// the shape (the mask) can be turned over it; the line stays as drawn and the place takes the turn
// (split.js turnForMask).

import { CompareWizard } from './compare-wizard.js';
import { TerrainModel } from './model.js';
import { LineTool } from './line-tool.js';
import { defaultVertical, normalTurn, toMetres, turnForMask } from './split.js';
import { worldOf } from './worlds.js';
import { formatDistance } from './map-view.js';
import { t } from './i18n.js';

const $ = (id) => document.getElementById(id);

// The size of a shape, as written under it: the circle's width, or the contour's width by height.
export function sizeOf(outline) {
  if (outline.kind === 'circle') return `⌀ ${formatDistance(2 * outline.radiusM)}`;
  const b = outline.bounds;
  return `${formatDistance(b.maxX - b.minX)} × ${formatDistance(b.maxY - b.minY)}`;
}

export class CompareFlow {
  // app: { show(screen), say(text, kind), modelFrom(screen) }; map: MapScreen; models: ModelScreen.
  constructor({ app, map, models }) {
    this._app = app;
    this._map = map;
    this._models = models;
    this._first = null;             // the first place as framed: { world, center, outline, where }
    this._firstPlace = null;        // the first place captured (a Place), and its model to draw the line on
    this._firstModel = null;
    this._second = null;            // the second place's map, to come back to: { world, where }
    this._line = null;              // the line once drawn: a Divider
    this._maskTurn = 0;             // the shape turned over the map while a place is found for a part
    this.lineTool = new LineTool(() => this._lineChanged());
    this.wizard = new CompareWizard(this._steps(), (view) => this._draw(view));

    $('guide-next').addEventListener('click', () => this.wizard.next());
    $('guide-back').addEventListener('click', () => this.wizard.back());
    $('guide-cancel').addEventListener('click', () => this.wizard.cancel());
    $('worlds-back').addEventListener('click', () => this.wizard.back());
    $('worlds-cancel').addEventListener('click', () => this.wizard.cancel());
    $('worlds-dialog').addEventListener('cancel', (e) => { e.preventDefault(); this.wizard.cancel(); });
    for (const button of [...$('worlds-choice').querySelectorAll('[data-world]'), ...$('guide-worlds').querySelectorAll('[data-world]')]) {
      button.addEventListener('click', () => this.wizard.chooseWorld(button.dataset.world));
    }
    // the line on the model: its kind, its turn, its parts and the own line's points
    const tool = this.lineTool;
    for (const button of $('line-kind').querySelectorAll('[data-line-kind]')) {
      button.addEventListener('click', () => tool.setKind(button.dataset.lineKind));
    }
    for (const button of $('guide-line').querySelectorAll('[data-model-line]')) {
      button.addEventListener('click', () => tool.turn(Number(button.dataset.modelLine)));
    }
    $('model-line-deg').addEventListener('change', () => tool.setAngle(Number.parseFloat($('model-line-deg').value)));
    $('model-line-swap').addEventListener('click', () => tool.swap());
    $('line-undo').addEventListener('click', () => tool.undo());
    $('line-clear').addEventListener('click', () => tool.clear());
    models.onLinePick = (pick) => this._pointAt(pick);
    models.onLinePointRemove = (index) => tool.removeAt(index);
    window.addEventListener('keydown', (e) => this._lineKey(e));
    // the shape turned over the map while a place is found for a part, 5° a step
    for (const button of $('guide-mask').querySelectorAll('[data-mask]')) {
      button.addEventListener('click', () => this._turnMask(this._maskTurn + Number(button.dataset.mask)));
    }
    $('mask-deg').addEventListener('change', () => {
      const deg = Number.parseFloat($('mask-deg').value);
      if (Number.isFinite(deg)) this._turnMask(deg);
    });
    // One place or two: chosen on the map. The guide takes the choice of world while it looks for a
    // place; while the line is drawn the world stays.
    map.onKind = (kind) => {
      if (kind === 'two' && !this.wizard.active) this.startHere();
      else if (kind === 'one' && this.wizard.active) this.wizard.cancel();
      map.setKind(this.wizard.active ? 'two' : 'one');
    };
    map.onWorldPicked = (id) => {
      if (['line', 'reline'].includes(this.wizard.step)) return true;
      if (!['place1', 'place2', 'replace'].includes(this.wizard.step)) return false;
      this.wizard.chooseWorld(id);
      return true;
    };
  }

  start() { this.wizard.start(); }
  // The map's "Two places side by side": the place framed now is the first place.
  startHere() { this.wizard.startAt(this._map.world); }
  replace(index) { this.wizard.replace(index); }
  redrawLine() { this.wizard.redrawLine(); }

  // ---------- the line on the model ----------

  // The line tool changed, or began or ended: the model shows the line on its picture, the tools
  // their state.
  _lineChanged() {
    const tool = this.lineTool;
    this._models.showLine(tool.active ? { divider: tool.divider(), points: tool.kind === 'drawn' ? tool.points : [] } : null);
    for (const button of $('line-kind').querySelectorAll('[data-line-kind]')) {
      button.setAttribute('aria-pressed', String(button.dataset.lineKind === tool.kind));
    }
    $('line-draw').hidden = tool.kind !== 'drawn';
    // a line by points has no angle of its own: the arrows turn its points
    $('model-line-deg-label').hidden = tool.kind === 'drawn';
    $('model-line-deg').value = tool.angleDeg;
  }

  // A click on the model while an own line is drawn: a point of the line where the model's top was
  // hit (a click on its side gives none). Taken here, the click shows no height and turns no view.
  _pointAt(pick) {
    const tool = this.lineTool;
    if (!tool.active || tool.kind !== 'drawn') return false;
    if (pick.u !== null) tool.add(toMetres(pick.u, pick.v, this._models.model.frame));
    return true;
  }

  // Cmd+Z (Ctrl+Z) or Backspace takes the last point back; with Shift (or Ctrl+Y) it comes back. The
  // keys are read by their place, so the Russian layout works too.
  _lineKey(e) {
    const tool = this.lineTool;
    if (!tool.active || tool.kind !== 'drawn' || $('model-screen').hidden || e.target.closest?.('input, select, textarea')) return;
    const command = (e.metaKey || e.ctrlKey) && !e.altKey;
    if ((command && e.code === 'KeyZ' && !e.shiftKey) || (e.key === 'Backspace' && !command)) {
      e.preventDefault();
      tool.undo();
    } else if (command && ((e.code === 'KeyZ' && e.shiftKey) || e.code === 'KeyY')) {
      e.preventDefault();
      tool.redo();
    }
  }

  // ---------- the shape on the map ----------

  // The shape going with the map, while another place is looked for: `keep` is the part it takes,
  // the whole shape turned by the mask's turn.
  _showOther(keep = this._keep ?? 1) {
    this._keep = keep;
    const outline = this._outlineOther;
    this._map.view.setOverlay({
      outline, centre: null, divider: this._line, keep, names: this._namesOther, size: sizeOf(outline), turnDeg: this._maskTurn,
    });
    $('mask-deg').value = this._maskTurn;
  }

  // The mask at a turn, in degrees clockwise: the place found under its clear part comes in turned.
  _turnMask(deg) {
    this._maskTurn = normalTurn(Math.round(deg));
    if (this._outlineOther) this._showOther();
  }

  // ---------- what the wizard asks for ----------

  _steps() {
    return {
      begin: () => {
        this._first = null;
        this._firstPlace = null;
        this._firstModel = null;
        this._second = null;
        this._line = null;
        this._maskTurn = 0;
        this.lineTool.stop();
        this._map.guide('place');
        this._map.setKind('two');
      },
      showWorld: (id) => {
        this._app.show('map');
        this._map.showWorld(id);
      },
      // The first place captured at once and shown alone in 3D, the line to be drawn on it.
      captureFirst: async () => {
        const first = this._map.framedShape();
        if (!first) return null;
        const place = await this._map.capture({ ...first, turnable: true }, t('Capturing the first place…'));
        if (!place) return null;
        this._first = first;
        this._firstPlace = place;
        this._firstModel = new TerrainModel({ places: [place] });
        this._line = null;
        this._app.modelFrom('map');
        this._app.show('model');
        this._models.show(this._firstModel);
        return { name: place.name, size: sizeOf(first.outline) };
      },
      // Back to framing the first place on the map, as it was left.
      unpickFirst: () => {
        this.lineTool.stop();
        this._first = null;
        this._firstPlace = null;
        this._firstModel = null;
        this._line = null;
        this._app.show('map');
        this._map.guide('place');
      },
      drawLine: () => this.lineTool.start(this._line),
      lineReady: () => {
        const divider = this.lineTool.divider();
        if (!divider) {
          this._app.say(t('Put two points or more for your own line, or choose the line through the centre.'));
          return false;
        }
        this._line = divider;
        return true;
      },
      // Back from the second place's world to the line, on the first place's model.
      backToLine: () => {
        this._app.show('model');
        if (this._models.model !== this._firstModel) this._models.show(this._firstModel);
        this.lineTool.start(this._line);
      },
      findSecond: () => {
        this.lineTool.stop();
        this._map.guide('other');
        this._outlineOther = this._first.outline;
        this._namesOther = [this._firstPlace?.name ?? t('First place'), t('Second place')];
        this._map.view.holdWidth(2 * this._first.outline.reachM);
        const f = this._map.view.frameNow();
        if (f) this._map.view.showPlace(f.lat, f.lon);       // the shape fits the free part of the map
        this._showOther(1);
      },
      // The second place captured in the first one's shape; with the first, already captured, and the
      // line, the model of two places.
      captureSecond: async () => {
        const second = this._map.framed();
        this._second = { world: second.world, where: second.where };
        const b = await this._map.capture({ world: second.world, center: second.center, outline: this._first.outline, turnable: true }, t('Capturing the second place…'));
        if (!b) return false;
        const a = this._firstPlace, line = this._line;
        const model = new TerrainModel({
          places: [a, b],
          compare: {
            angleDeg: line.angleDeg, points: line.points, smooth: line.smooth, vertical: defaultVertical([a.world, b.world]),
            turns: [0, turnForMask(this._maskTurn)],
          },
        });
        this._app.modelFrom('map');
        this._app.show('model');
        this._models.show(model);
        return true;
      },
      arrange: () => {
        $('two-places-fold').hidden = false;
        $('two-places-fold').open = true;
      },
      backToSecond: () => {
        this._app.show('map');
        if (this._map.world !== this._second.world) this._map.showWorld(this._second.world, this._second.where);
        this._map.guide('other');
        this._showOther(1);
      },
      save: () => this._models.save(),
      end: () => {
        this.lineTool.stop();
        this._first = null;
        this._firstPlace = null;
        this._firstModel = null;
        this._line = null;
        this._map.guide(null);
        this._map.setKind('one');
      },
      showPlaceToReplace: (index) => {
        const model = this._models.model;
        const place = model.places[index];
        this._app.show('map');
        this._map.guide('other');
        this._map.showWorld(place.world);
        this._map.view.holdWidth(2 * model.outline.reachM);
        this._map.view.showPlace(place.center.lat, place.center.lon);
        this._line = model.divider;
        this._outlineOther = model.outline;
        this._namesOther = model.places.map((p, i) => (i === index ? t('New place') : p.name));
        this._maskTurn = 0;
        this._showOther(index);
        return { name: place.name, size: sizeOf(model.outline) };
      },
      captureReplacement: async (index) => {
        const model = this._models.model;
        const framed = this._map.framed();
        const place = await this._map.capture({ world: framed.world, center: framed.center, outline: model.outline, turnable: true }, t('Capturing the new place…'));
        if (!place) return false;
        model.replacePlace(index, place);
        const turns = [...model.compare.turns];
        turns[index] = turnForMask(this._maskTurn);
        model.arrange({ turns });
        this._app.show('model');
        this._models.show(model);
        return true;
      },
      // A new line for the model of two places on screen, drawn on it as the first one was: from the
      // model's line as it is.
      showLineToRedraw: () => {
        this.lineTool.start(this._models.model.divider);
      },
      // The model takes the line; it is laid again when its screen is on (showModel): showing the
      // model from here, while the step is still the line's, would end the guide.
      applyLine: () => {
        const line = this._line;
        this.lineTool.stop();
        this._models.model.arrange({ angleDeg: line.angleDeg, points: line.points, smooth: line.smooth });
        this._relined = true;
      },
      showModel: () => {
        this.lineTool.stop();
        this._app.show('model');
        if (this._relined) {
          this._relined = false;
          this._models.show(this._models.model);
        }
      },
    };
  }

  // The wizard's view: its bar over the screen, or its dialog of worlds.
  _draw(view) {
    const dialog = $('worlds-dialog'), bar = $('guide-bar');
    if (view.kind !== 'dialog' && dialog.open) dialog.close();
    bar.hidden = view.kind !== 'bar';
    if (view.kind === 'dialog') {
      $('worlds-title').textContent = view.title;
      $('worlds-text').textContent = view.text;
      $('worlds-back').hidden = !view.back;
      if (!dialog.open) dialog.showModal();
      return;
    }
    if (view.kind !== 'bar') return;
    $('guide-step').textContent = t('Step {n} of 4', { n: view.step });
    $('guide-title').textContent = view.title;
    $('guide-text').textContent = view.text;
    $('guide-worlds').hidden = !view.worlds;
    $('guide-line').hidden = !view.line;
    $('guide-mask').hidden = !view.mask;
    for (const button of $('guide-worlds').querySelectorAll('[data-world]')) {
      button.setAttribute('aria-pressed', String(button.dataset.world === this._map.world));
    }
    $('guide-back').hidden = !view.back;
    $('guide-back').textContent = t(view.back ?? 'Back');
    $('guide-cancel').textContent = t(view.cancel ?? 'Cancel');
    $('guide-next').hidden = !view.primary;
    $('guide-next').textContent = t(view.primary ?? '');
    for (const id of ['guide-next', 'guide-back', 'guide-cancel']) $(id).disabled = Boolean(view.busy);
    this._map.view.refresh();
  }
}

export const worldName = (id) => t(worldOf(id).label);
