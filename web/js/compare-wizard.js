// The guide for one or two places. Each place is framed, then its picture source and heights
// source are chosen separately. The existing comparison steps still draw the line in 3D.
// One place: framing -> picture -> heights/capture -> adjust/save.
// Two places: framing -> picture -> heights/capture -> line on the first model -> second framing
// -> its picture -> its heights/capture -> arrange/save. Replacement uses the same source steps.
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
const SCREENS = { world1: null, place1: 'map', picture: 'map', heights: 'map', line: 'model', world2: null, place2: 'map', arrange: 'model', replace: 'map', reline: 'model' };

export class CompareWizard {
  // app: { begin(kind), showWorld(id), pickPlace(origin, index), showSources(stage), pictureReady(),
  //        backToPlace(origin), backToSources(), captureFirst() -> Promise<{ name, size } or null>,
  //        drawLine(), lineReady() -> boolean, backToLine(), findSecond(), captureSecond() -> Promise<boolean>,
  //        arrange(), save() -> Promise<boolean>, end(),
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
    this._kind = 'two';
    this._sourceFrom = null;  // the place being configured: place1, place2 or replace
  }

  get active() { return this._step !== 'idle'; }
  get step() { return this._step; }
  get kind() { return this._kind; }
  get sourceFrom() { return this._sourceFrom; }
  // Which part is being given another place, or null.
  get replacingIndex() { return this._side?.index ?? null; }

  start() {
    this._kind = 'two';
    this._sourceFrom = null;
    this._worlds = [null, null];
    this._first = null;
    this._onMap = false;
    this._captured = false;
    this._go('world1');
  }

  // Start on the map that is open now: its world is the first place's, and the place is framed
  // there (no dialog of worlds first). The way in from the map's "Two places side by side".
  startAt(worldId, kind = 'two') {
    if (this.active) return;
    this._sourceFrom = null;
    this._worlds = [worldId, null];
    this._kind = kind;
    this._first = null;
    this._onMap = true;
    this._captured = false;
    this._app.begin(kind);
    this._go('place1');
  }

  // Another place for part `index` (0 or 1) of the model of two places on screen.
  replace(index) {
    if (this._busy || this._step === 'replace' || this._step === 'reline') return;
    const fromArrange = this._step === 'arrange';
    this._kind = 'two';
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
    this._kind = 'two';
    if (!this.active) this._app.begin();
    this._step = 'reline';
    this._reline = { fromArrange };
    this._app.showLineToRedraw();
    this._go('reline');
  }

  chooseWorld(id) {
    if (this._busy) return;
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
    if (['place1', 'place2', 'replace'].includes(this._step)) {
      if (!this._app.pickPlace(this._step, this._side?.index ?? null)) return;
      this._sourceFrom = this._step;
      this._goSources('picture');
    } else if (this._step === 'picture') {
      if (await this._wait(() => this._app.pictureReady())) this._goSources('heights');
    } else if (this._step === 'heights' && this._sourceFrom === 'place1') {
      // the first place captured and shown in 3D, for the line to be drawn on it
      const first = await this._wait(() => this._app.captureFirst());
      if (!first) return;               // the shape is not ready, or the capture failed: the page has said why
      this._first = first;
      if (this._kind === 'one') {
        this._captured = true;
        this._app.arrange();
        this._go('arrange');
      } else {
        this._app.drawLine();
        this._go('line');
      }
    } else if (this._step === 'line') {
      if (this._app.lineReady()) this._go('world2');
    } else if (this._step === 'heights' && this._sourceFrom === 'place2') {
      if (await this._wait(() => this._app.captureSecond())) {
        this._captured = true;
        this._app.arrange();
        this._go('arrange');
      }
    } else if (this._step === 'arrange') {
      if (await this._wait(() => this._app.save())) this._finish();
    } else if (this._step === 'heights' && this._sourceFrom === 'replace') {
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
    if (this._step === 'picture') {
      this._step = this._sourceFrom;
      this._app.backToPlace(this._sourceFrom);
      this._go(this._sourceFrom);
    } else if (this._step === 'heights') this._goSources('picture');
    else if (this._step === 'place1' && !this._onMap) this._go('world1');
    else if (this._step === 'line') {
      this._sourceFrom = 'place1';
      this._step = 'heights';
      this._app.backToSources();
      this._goSources('heights');
    } else if (this._step === 'world2') {
      this._step = 'line';
      this._app.backToLine();
      this._go('line');
    } else if (this._step === 'place2') this._go('world2');
    else if (this._step === 'arrange' && this._captured) {
      this._sourceFrom = this._kind === 'one' ? 'place1' : 'place2';
      this._step = 'heights';
      this._app.backToSources();
      this._goSources('heights');
    }
  }

  // The step's Cancel. While a part is given another place, or the line is drawn anew, it gives up
  // only that: back to the model as it was, and to arranging if that is where it began.
  cancel() {
    if (!this.active || this._busy) return;
    if (this._side || this._reline) {
      const { fromArrange } = this._side ?? this._reline;
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
        kind: 'bar', step: 1, total: this._kind === 'one' ? 4 : 8,
        title: t(this._kind === 'one' ? 'Place, on {world}' : 'First place, on {world}', { world: world(0) }),
        text: t('Find and frame the place. Next, choose its picture and height sources.'),
        primary: 'Next: picture', back: this._onMap ? null : 'Back', cancel: 'Cancel', busy: this._busy,
      };
      case 'picture': return {
        kind: 'bar', step: this._sourceFrom === 'place1' ? 2 : 6, total: this._kind === 'one' ? 4 : 8,
        title: t('Choose the picture'), text: t('Choose a built-in picture or enter your own tile URL. The selection map stays the same.'),
        sources: 'picture', primary: 'Next: heights', back: 'Back', cancel: 'Cancel', busy: this._busy,
      };
      case 'heights': return {
        kind: 'bar', step: this._sourceFrom === 'place1' ? 3 : 7, total: this._kind === 'one' ? 4 : 8,
        title: t('Choose the heights'), text: this._busy ? t('Capturing the place…') : t('Choose the height source. Next, build this place in 3D with the selected picture.'),
        sources: 'heights', primary: 'Build the model', back: 'Back', cancel: 'Cancel', busy: this._busy,
      };
      case 'line': return {
        kind: 'bar', step: 4, total: 8, title: t('The line between the places'),
        text: t('Through the centre, or by points: click the model to put points 1, 2, 3…, a click on a point takes it away. The dimmed part goes to the second place.'),
        line: true, primary: 'Next: the second place', back: 'Back', cancel: 'Cancel',
      };
      case 'world2': return {
        kind: 'dialog', step: 5, title: t('Where is the second place?'),
        text: this._first?.name
          ? t('The second place takes the dimmed part of the shape. First place: {name}, {size}. Which world is the second on?', { name: this._first.name, size })
          : t('The second place takes the dimmed part of the shape, {size}. Which world is it on?', { size }),
        worlds: true, primary: null, back: 'Back', cancel: 'Cancel',
      };
      case 'place2': return {
        kind: 'bar', step: 5, total: 8, title: t('Second place, on {world} · {size}', { world: world(1), size }),
        text: t('Find it and put it in the clear part of the shape, turning the shape if it fits better so, then capture it.'),
        mask: true, primary: 'Next: picture', back: 'Back', cancel: 'Cancel', busy: this._busy,
      };
      case 'replace': return {
        kind: 'bar', step: 5, total: 8, title: t('Another place instead of {name}', { name: this._side.name }),
        text: this._busy ? t('Capturing the new place…')
          : t('Find it on the map: the shape keeps {size}. Another world: a button below.', { size: this._side.size }),
        worlds: true, mask: true, primary: 'Next: picture', back: null, cancel: 'Cancel', busy: this._busy,
      };
      case 'reline': return {
        kind: 'bar', step: 8, total: 8, title: t('A new line for the model'),
        text: t('Through the centre, or by points: click the model. The places stay as they are.'),
        line: true, primary: 'Done', back: null, cancel: 'Cancel',
      };
      case 'arrange': return {
        kind: 'bar', step: this._kind === 'one' ? 4 : 8, total: this._kind === 'one' ? 4 : 8,
        title: t(this._kind === 'one' ? 'Adjust the model' : 'Arrange the places'),
        text: this._kind === 'one' ? t('Set the size, heights and picture style in the panel, then save the model.')
          : t('In the panel: turn each place to show its best side, raise or lower it, choose how the heights stand. Then save.'),
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

  _goSources(step) {
    this._app.showSources(step);
    this._go(step);
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
