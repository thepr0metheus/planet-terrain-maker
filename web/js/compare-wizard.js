// The guided way to a model of two places: first a place on the map, framed as any place is, and
// captured at once; then the line that divides it, drawn on that place in 3D (the line is chosen on
// the relief, where it can follow a ridge or a valley, not on the map); then the second place, in
// the same shape; then the places arranged; then saved.
//
//   1. Where is the first place?      a dialog: Earth, Moon, Mars or Venus (skipped when the
//      Frame it                       map's "Two places" starts the guide on the map on show);
//                                     a bar over that world's map: the circle follows the zoom,
//                                     or the user draws a contour; Next captures it
//   2. The line                       a bar over the first place's model: the line through the
//                                     centre, turned, or the user's own: points clicked on the
//                                     model, a smooth curve through them
//   3. Where is the second place?     a dialog
//      Find it                        a bar; the shape at the first place's size goes with the map,
//                                     the first place's part dimmed; Next captures the second
//   4. Arrange the places             a bar over the model: turn and raise each place, choose how
//                                     heights stand; Save
//
//   Another place for one part        from a model of two places on screen, with or without the
//                                     guide: that part's map opens on its place, in the shape; a
//                                     capture of the new place takes the part, the other part
//                                     stays as it was, and the places are arranged.
//   A new line                        from a model of two places on screen: drawn on the model as
//                                     the first one; Done gives the model the new line.
//
// This class only decides: which step is on and what it shows (`view`), and what the page must do
// (`app`, given by compare-flow.js). Drawing the view is done outside, so the steps are checked with
// plain numbers in the tests.

import { worldOf } from './worlds.js';
import { t } from './i18n.js';

// The view each step works on. The dialogs of worlds open over any view; the places are found on the
// map; the line is drawn and the places are arranged on the model.
const SCREENS = { world1: null, place1: 'map', line: 'model', world2: null, place2: 'map', arrange: 'model', replace: 'map', reline: 'model' };

export class CompareWizard {
  // app: { begin(), showWorld(id), captureFirst() -> Promise<{ name, size } or null>, unpickFirst(),
  //        drawLine(), lineReady() -> boolean, backToLine(), findSecond(), captureSecond() -> Promise<boolean>,
  //        arrange(), backToSecond(), save() -> Promise<boolean>, end(),
  //        showPlaceToReplace(index) -> { name, size }, captureReplacement(index) -> Promise<boolean>,
  //        showLineToRedraw(), applyLine(), showModel() }
  // onChange: called with the new view after every step.
  constructor(app, onChange = () => {}) {
    this._app = app;
    this._onChange = onChange;
    this._step = 'idle';
    this._worlds = [null, null];
    this._first = null;
    this._busy = false;
    this._onMap = false;      // started on the map on show: no dialog of worlds before the first place
    this._captured = false;   // the places on the model were captured by this guide: Back finds the second again
    this._side = null;        // { index, name, size, fromArrange } while a part is given another place
    this._reline = null;      // { fromArrange } while the model's line is drawn anew
  }

  get active() { return this._step !== 'idle'; }
  get step() { return this._step; }
  // Which part is being given another place, or null.
  get replacingIndex() { return this._side?.index ?? null; }

  start() {
    this._worlds = [null, null];
    this._first = null;
    this._onMap = false;
    this._captured = false;
    this._go('world1');
  }

  // Start on the map that is open now: its world is the first place's, and the place is framed
  // there (no dialog of worlds first). The way in from the map's "Two places side by side".
  startAt(worldId) {
    if (this.active) return;
    this._worlds = [worldId, null];
    this._first = null;
    this._onMap = true;
    this._captured = false;
    this._app.begin();
    this._go('place1');
  }

  // Another place for part `index` (0 or 1) of the model of two places on screen.
  replace(index) {
    if (this._busy || this._step === 'replace' || this._step === 'reline') return;
    const fromArrange = this._step === 'arrange';
    if (!this.active) this._app.begin();
    // The step first: the map the app opens is this step's own view.
    this._step = 'replace';
    this._side = { index, fromArrange, ...this._app.showPlaceToReplace(index) };
    this._go('replace');
  }

  // A new line for the model of two places on screen.
  redrawLine() {
    if (this._busy || this._step === 'replace' || this._step === 'reline') return;
    const fromArrange = this._step === 'arrange';
    if (!this.active) this._app.begin();
    this._step = 'reline';
    this._reline = { fromArrange };
    this._app.showLineToRedraw();
    this._go('reline');
  }

  chooseWorld(id) {
    if (this._step === 'replace') {
      this._app.showWorld(id);
      this._go('replace');
    } else if (this._step === 'place1' || this._step === 'place2') {
      // another world while a place is looked for: the place is looked for there
      this._worlds[this._step === 'place1' ? 0 : 1] = id;
      this._app.showWorld(id);
      this._go(this._step);
    } else if (this._step === 'world1') {
      this._worlds[0] = id;
      this._app.begin();
      this._app.showWorld(id);
      this._go('place1');
    } else if (this._step === 'world2') {
      this._worlds[1] = id;
      this._app.showWorld(id);
      this._app.findSecond();
      this._go('place2');
    }
  }

  // The main button of the step on show.
  async next() {
    if (this._busy) return;
    if (this._step === 'place1') {
      // the first place captured and shown in 3D, for the line to be drawn on it
      const first = await this._wait(() => this._app.captureFirst());
      if (!first) return;               // the shape is not ready, or the capture failed: the page has said why
      this._first = first;
      this._app.drawLine();
      this._go('line');
    } else if (this._step === 'line') {
      if (this._app.lineReady()) this._go('world2');
    } else if (this._step === 'place2') {
      if (await this._wait(() => this._app.captureSecond())) {
        this._captured = true;
        this._app.arrange();
        this._go('arrange');
      }
    } else if (this._step === 'arrange') {
      if (await this._wait(() => this._app.save())) this._finish();
    } else if (this._step === 'replace') {
      if (await this._wait(() => this._app.captureReplacement(this._side.index))) {
        this._side = null;
        this._app.arrange();
        this._go('arrange');
      }
    } else if (this._step === 'reline') {
      if (!this._app.lineReady()) return;
      const { fromArrange } = this._reline;
      this._reline = null;
      this._app.applyLine();
      this._backToModel(fromArrange);
    }
  }

  // Each step back that changes the view sets its step first: the view the app opens is then the
  // step's own, and the guide does not take it for the user leaving (viewChanged).
  back() {
    if (this._busy) return;
    if (this._step === 'place1' && !this._onMap) this._go('world1');
    else if (this._step === 'line') {
      // Back to the first place on the map, framed again as it was.
      this._step = 'place1';
      this._app.unpickFirst();
      this._first = null;
      this._go('place1');
    } else if (this._step === 'world2') {
      this._step = 'line';
      this._app.backToLine();
      this._go('line');
    } else if (this._step === 'place2') this._go('world2');
    else if (this._step === 'arrange' && this._captured) {
      this._step = 'place2';
      this._app.backToSecond();
      this._go('place2');
    }
  }

  // The step's Cancel. While a part is given another place, or the line is drawn anew, it gives up
  // only that: back to the model as it was, and to arranging if that is where it began.
  cancel() {
    if (!this.active || this._busy) return;
    if (this._step === 'replace' || this._step === 'reline') {
      const { fromArrange } = this._step === 'replace' ? this._side : this._reline;
      this._side = null;
      this._reline = null;
      this._backToModel(fromArrange);
      return;
    }
    this._finish();
  }

  // Ends the guide from any step: another model takes the screen.
  close() {
    if (!this.active || this._busy) return;
    this._side = null;
    this._reline = null;
    this._finish();
  }

  // The page went to another view. The guide's own moves come while it waits (the capture opens
  // the model) or before its step changes (a world is shown); any other move, to the library or to
  // a saved model, ends the guide.
  viewChanged(name) {
    if (!this.active || this._busy) return;
    const screen = SCREENS[this._step];
    if (screen && name !== screen) this._finish();
  }

  // What to show: a dialog, a bar, or nothing.
  // Titles and texts come in the language in use (i18n.js); the button words are the English keys
  // the page translates as it draws them.
  get view() {
    const size = this._first?.size ?? '';
    const world = (i) => t(worldOf(this._worlds[i]).inSentence);
    switch (this._step) {
      case 'world1': return {
        kind: 'dialog', step: 1, title: t('Where is the first place?'),
        text: t('Pick its world. On the map you frame the place with the circle or your own contour.'),
        worlds: true, primary: null, back: null, cancel: 'Cancel',
      };
      case 'place1': return {
        kind: 'bar', step: 1, title: t('First place, on {world}', { world: world(0) }),
        text: this._busy ? t('Capturing the first place…')
          : t('Find it and frame it: the circle follows the zoom, or draw your own contour. Next, it is captured and shown in 3D for the line.'),
        primary: 'Next: the line', back: this._onMap ? null : 'Back', cancel: 'Cancel', busy: this._busy,
      };
      case 'line': return {
        kind: 'bar', step: 2, title: t('The line between the places'),
        text: t('Through the centre, or by points: click the model to put points 1, 2, 3…, a click on a point takes it away. The dimmed part goes to the second place.'),
        line: true, primary: 'Next: the second place', back: 'Back', cancel: 'Cancel',
      };
      case 'world2': return {
        kind: 'dialog', step: 3, title: t('Where is the second place?'),
        text: this._first?.name
          ? t('The second place takes the dimmed part of the shape. First place: {name}, {size}. Which world is the second on?', { name: this._first.name, size })
          : t('The second place takes the dimmed part of the shape, {size}. Which world is it on?', { size }),
        worlds: true, primary: null, back: 'Back', cancel: 'Cancel',
      };
      case 'place2': return {
        kind: 'bar', step: 3, title: t('Second place, on {world} · {size}', { world: world(1), size }),
        text: this._busy ? t('Capturing the second place…') : t('Find it and put it in the clear part of the shape, turning the shape if it fits better so, then capture it.'),
        mask: true, primary: 'Capture the second place', back: 'Back', cancel: 'Cancel', busy: this._busy,
      };
      case 'replace': return {
        kind: 'bar', step: 4, title: t('Another place instead of {name}', { name: this._side.name }),
        text: this._busy ? t('Capturing the new place…')
          : t('Find it on the map: the shape keeps {size}. Another world: a button below.', { size: this._side.size }),
        worlds: true, mask: true, primary: 'Capture this place', back: null, cancel: 'Cancel', busy: this._busy,
      };
      case 'reline': return {
        kind: 'bar', step: 4, title: t('A new line for the model'),
        text: t('Through the centre, or by points: click the model. The places stay as they are.'),
        line: true, primary: 'Done', back: null, cancel: 'Cancel',
      };
      case 'arrange': return {
        kind: 'bar', step: 4, title: t('Arrange the places'),
        text: t('In the panel: turn each place to show its best side, raise or lower it, choose how the heights stand. Then save.'),
        // Closing here keeps the model on screen, unsaved: nothing is cancelled.
        primary: 'Save', back: this._captured ? 'Back' : null, cancel: 'Close', busy: this._busy,
      };
      default: return { kind: null };
    }
  }

  _backToModel(fromArrange) {
    if (!fromArrange) {
      this._finish();
      this._app.showModel();
      return;
    }
    // The step first: the model the app shows is the arranging step's own view.
    this._step = 'arrange';
    this._app.showModel();
    this._app.arrange();
    this._go('arrange');
  }

  async _wait(job) {
    this._busy = true;
    this._onChange(this.view);
    try {
      return await job();
    } finally {
      this._busy = false;
      this._onChange(this.view);
    }
  }

  _go(step) {
    this._step = step;
    this._onChange(this.view);
  }

  _finish() {
    this._step = 'idle';
    this._captured = false;
    this._app.end();
    this._onChange(this.view);
  }
}
