import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CompareWizard } from '../../web/js/compare-wizard.js';

// A page that records what the wizard asks of it.
function fakeApp({ captureOk = true, saveOk = true, shapeOk = true, lineOk = true, firstOk = true } = {}) {
  const calls = [];
  return {
    calls,
    begin: () => calls.push(['begin']),
    pickPlace: () => shapeOk,
    showSources: () => {},
    pictureReady: () => true,
    backToPlace: () => {},
    backToSources: () => calls.push(['backToSources']),
    showWorld: (id) => calls.push(['showWorld', id]),
    captureFirst: async () => { calls.push(['captureFirst']); return shapeOk && firstOk ? { name: 'Batumi', size: '⌀ 3.20 km' } : null; },
    unpickFirst: () => calls.push(['unpickFirst']),
    drawLine: () => calls.push(['drawLine']),
    lineReady: () => { calls.push(['lineReady']); return lineOk; },
    backToLine: () => calls.push(['backToLine']),
    findSecond: () => calls.push(['findSecond']),
    captureSecond: async () => { calls.push(['captureSecond']); return captureOk; },
    arrange: () => calls.push(['arrange']),
    backToSecond: () => calls.push(['backToSecond']),
    save: async () => { calls.push(['save']); return saveOk; },
    end: () => calls.push(['end']),
    showPlaceToReplace: (index) => { calls.push(['showPlaceToReplace', index]); return { name: 'Collins (Moon)', size: '⌀ 3.20 km' }; },
    captureReplacement: async (index) => { calls.push(['captureReplacement', index]); return captureOk; },
    showLineToRedraw: () => calls.push(['showLineToRedraw']),
    applyLine: () => calls.push(['applyLine']),
    showModel: () => calls.push(['showModel']),
  };
}

// The guide begun from the dialog of worlds, up to arranging: earth, then the line, then the Moon.
async function toArrange(w) {
  w.start(); w.chooseWorld('earth'); await chooseSourcesAndCapture(w); await w.next(); w.chooseWorld('moon'); await chooseSourcesAndCapture(w);
}

async function chooseSourcesAndCapture(w) {
  await w.next();
  await w.next();
  await w.next();
}

test('the guide\'s order: a place framed as any place, then the line, then the second, then arrange and save', async () => {
  const app = fakeApp();
  const views = [];
  const w = new CompareWizard(app, (v) => views.push(v));
  assert.equal(w.active, false);
  w.start();
  assert.equal(w.view.kind, 'dialog');
  assert.equal(w.view.title, 'Where is the first place?');
  assert.equal(w.view.worlds, true);
  w.chooseWorld('earth');
  assert.deepEqual(app.calls.splice(0), [['begin'], ['showWorld', 'earth']]);
  assert.equal(w.view.kind, 'bar');
  assert.equal(w.view.step, 1);
  assert.equal(w.view.primary, 'Next: picture');
  await chooseSourcesAndCapture(w);
  assert.deepEqual(app.calls.splice(0), [['captureFirst'], ['drawLine']], 'the first place captured at once, the line drawn on it');
  assert.equal(w.step, 'line');
  assert.equal(w.view.step, 4);
  assert.equal(w.view.primary, 'Next: the second place');
  await w.next();
  assert.deepEqual(app.calls.splice(0), [['lineReady']]);
  assert.equal(w.view.kind, 'dialog');
  assert.match(w.view.text, /First place: Batumi, ⌀ 3.20 km/);
  w.chooseWorld('moon');
  assert.deepEqual(app.calls.splice(0), [['showWorld', 'moon'], ['findSecond']]);
  assert.equal(w.view.title, 'Second place, on the Moon · ⌀ 3.20 km');
  await chooseSourcesAndCapture(w);
  assert.deepEqual(app.calls.splice(0), [['captureSecond'], ['arrange']], 'only the second place is captured now');
  assert.equal(w.view.title, 'Arrange the places');
  assert.equal(w.view.step, 8);
  assert.equal(w.view.primary, 'Save');
  assert.equal(w.view.cancel, 'Close', 'the model exists now: closing the guide keeps it');
  await w.next();
  assert.deepEqual(app.calls, [['save'], ['end']]);
  assert.equal(w.active, false);
  assert.equal(w.view.kind, null);
  assert.ok(views.some((v) => v.busy), 'the waits are shown');
});

test('one place chooses framing, picture and heights before any capture, then adjusts and saves', async () => {
  const app = fakeApp(), events = [];
  app.pickPlace = (origin) => { events.push(['place', origin]); return true; };
  app.showSources = (stage) => events.push(['sources', stage]);
  app.pictureReady = () => { events.push(['picture']); return true; };
  const wizard = new CompareWizard(app);
  wizard.startAt('earth', 'one');
  assert.equal(wizard.view.total, 4);
  await wizard.next();
  assert.equal(wizard.step, 'picture');
  assert.deepEqual(app.calls, [['begin']], 'no downloads until both source choices are complete');
  await wizard.next();
  assert.equal(wizard.step, 'heights');
  assert.deepEqual(events, [['place', 'place1'], ['sources', 'picture'], ['picture'], ['sources', 'heights']]);
  await wizard.next();
  assert.equal(wizard.step, 'arrange');
  assert.equal(wizard.view.title, 'Adjust the model');
  assert.deepEqual(app.calls, [['begin'], ['captureFirst'], ['arrange']]);
  await wizard.next();
  assert.equal(wizard.active, false);
  assert.deepEqual(app.calls.slice(-2), [['save'], ['end']]);
});

test('an invalid custom picture stays at the picture step and cannot request heights or capture', async () => {
  const app = fakeApp(); app.pictureReady = () => false;
  const wizard = new CompareWizard(app);
  wizard.startAt('earth', 'one');
  await wizard.next(); await wizard.next();
  assert.equal(wizard.step, 'picture');
  assert.deepEqual(app.calls, [['begin']]);
});

test('one-place back goes from model through heights and picture to the original frame', async () => {
  const app = fakeApp();
  const wizard = new CompareWizard(app);
  wizard.startAt('earth', 'one');
  await chooseSourcesAndCapture(wizard);
  wizard.back(); assert.equal(wizard.step, 'heights');
  wizard.back(); assert.equal(wizard.step, 'picture');
  wizard.back(); assert.equal(wizard.step, 'place1');
  assert.equal(wizard.active, true);
});

test('a shape or a line that is not ready keeps the step on', async () => {
  const unclosed = new CompareWizard(fakeApp({ shapeOk: false }));
  unclosed.startAt('earth');
  await unclosed.next();
  assert.equal(unclosed.step, 'place1', 'an open contour: still framing');
  const uncaptured = new CompareWizard(fakeApp({ firstOk: false }));
  uncaptured.startAt('earth');
  await chooseSourcesAndCapture(uncaptured);
  assert.equal(uncaptured.step, 'heights', 'a failed capture retains the selected sources');
  const lineless = new CompareWizard(fakeApp({ lineOk: false }));
  lineless.startAt('earth');
  await chooseSourcesAndCapture(lineless);
  await lineless.next();
  assert.equal(lineless.step, 'line', 'an own line of one point: still drawing');
});

test('back goes a step at a time: the line, the first place, the dialog', async () => {
  const app = fakeApp();
  const w = new CompareWizard(app);
  w.start();
  w.chooseWorld('mars');
  await chooseSourcesAndCapture(w);
  app.calls.length = 0;
  w.back();
  assert.deepEqual(app.calls, [['backToSources']]);
  assert.equal(w.step, 'heights');
  w.back();
  assert.equal(w.step, 'picture');
  w.back();
  assert.equal(w.step, 'place1');
  w.back();
  assert.equal(w.step, 'world1');
  w.back();
  assert.equal(w.step, 'world1', 'nothing before the first step');
  w.chooseWorld('earth');
  await chooseSourcesAndCapture(w);
  await w.next();
  w.chooseWorld('moon');
  w.back();
  assert.equal(w.step, 'world2', 'from the second place back to its world');
  app.calls.length = 0;
  w.back();
  assert.deepEqual(app.calls, [['backToLine']]);
  assert.equal(w.step, 'line', 'from the second world back to the line on the first place');
});

test('arranging goes back to the second place; a model the guide did not capture has no such way back', async () => {
  const app = fakeApp();
  const w = new CompareWizard(app);
  await toArrange(w);
  assert.equal(w.view.back, 'Back');
  app.calls.length = 0;
  w.back();
  assert.deepEqual(app.calls, [['backToSources']]);
  assert.equal(w.step, 'heights');
  const lone = new CompareWizard(fakeApp());
  lone.replace(0);
  await chooseSourcesAndCapture(lone);
  assert.equal(lone.step, 'arrange');
  assert.equal(lone.view.back, null);
  lone.back();
  assert.equal(lone.step, 'arrange');
});

test('a failed capture or a refused save keeps the step on', async () => {
  const failing = new CompareWizard(fakeApp({ captureOk: false }));
  failing.start(); failing.chooseWorld('earth'); await chooseSourcesAndCapture(failing); await failing.next(); failing.chooseWorld('earth');
  await chooseSourcesAndCapture(failing);
  assert.equal(failing.step, 'heights');
  const app = fakeApp({ saveOk: false });
  const unsaved = new CompareWizard(app);
  await toArrange(unsaved);
  await unsaved.next();
  assert.equal(unsaved.step, 'arrange', 'the name prompt was cancelled: still arranging');
  assert.ok(!app.calls.some(([name]) => name === 'end'));
});

test('cancel ends it from any step; a world chosen while framing moves the search there', async () => {
  const app = fakeApp();
  const w = new CompareWizard(app);
  w.cancel();
  assert.deepEqual(app.calls, [], 'nothing to cancel');
  w.start();
  w.chooseWorld('moon');
  w.chooseWorld('earth');
  assert.deepEqual(app.calls.filter(([n]) => n === 'showWorld'), [['showWorld', 'moon'], ['showWorld', 'earth']]);
  assert.equal(w.step, 'place1', 'still framing the first place');
  w.cancel();
  assert.deepEqual(app.calls.at(-1), ['end']);
  assert.equal(w.active, false);
});

test('while something is under way, the buttons do nothing', async () => {
  let release;
  const app = fakeApp();
  app.captureSecond = () => new Promise((resolve) => { release = resolve; });
  const w = new CompareWizard(app);
  w.start(); w.chooseWorld('earth'); await chooseSourcesAndCapture(w); await w.next(); w.chooseWorld('earth');
  await w.next(); await w.next();
  const capturing = w.next();
  assert.equal(w.view.busy, true);
  w.back(); w.cancel(); await w.next();
  assert.equal(w.step, 'heights');
  release(true);
  await capturing;
  assert.equal(w.step, 'arrange');
});

test('leaving the guide\'s view ends it, but not its own moves', async () => {
  let release;
  const app = fakeApp();
  app.captureSecond = () => new Promise((resolve) => { release = resolve; });
  const w = new CompareWizard(app);
  w.viewChanged('model');
  assert.deepEqual(app.calls, [], 'nothing to end');
  w.start();
  w.viewChanged('gallery');
  assert.equal(w.step, 'world1', 'the first dialog opens over any view');
  w.chooseWorld('earth');
  w.viewChanged('map');
  assert.equal(w.step, 'place1', 'the map is where places are found');
  await chooseSourcesAndCapture(w);
  w.viewChanged('model');
  assert.equal(w.step, 'line', 'the line is drawn on the first place\'s model');
  await w.next(); w.chooseWorld('moon');
  await w.next(); await w.next();
  const capturing = w.next();
  w.viewChanged('model');
  assert.equal(w.step, 'heights', 'the capture opens the model itself');
  release(true);
  await capturing;
  w.viewChanged('model');
  assert.equal(w.step, 'arrange');
  w.viewChanged('library');
  assert.equal(w.active, false, 'the library while arranging ends the guide');
  assert.deepEqual(app.calls.at(-1), ['end']);

  const onMap = new CompareWizard(fakeApp());
  onMap.start(); onMap.chooseWorld('mars');
  onMap.viewChanged('model');
  assert.equal(onMap.active, false, 'a model from the library while framing ends it');
});

test('one part takes another place from arranging, and the places are arranged again', async () => {
  const app = fakeApp();
  const w = new CompareWizard(app);
  await toArrange(w);
  assert.equal(w.step, 'arrange');
  app.calls.length = 0;
  w.replace(1);
  assert.deepEqual(app.calls, [['showPlaceToReplace', 1]], 'the guide is on already: no new beginning');
  assert.equal(w.step, 'replace');
  assert.equal(w.replacingIndex, 1);
  assert.equal(w.view.kind, 'bar');
  assert.equal(w.view.title, 'Another place instead of Collins (Moon)');
  assert.match(w.view.text, /⌀ 3.20 km/);
  assert.equal(w.view.worlds, true, 'the new place may be on another world');
  assert.equal(w.view.primary, 'Next: picture');
  w.chooseWorld('mars');
  assert.deepEqual(app.calls.at(-1), ['showWorld', 'mars']);
  assert.equal(w.step, 'replace');
  await chooseSourcesAndCapture(w);
  assert.deepEqual(app.calls.slice(-2), [['captureReplacement', 1], ['arrange']]);
  assert.equal(w.step, 'arrange');
});

test('cancelling a new place goes back to the model as it was', async () => {
  const app = fakeApp();
  const w = new CompareWizard(app);
  await toArrange(w);
  w.replace(0);
  app.calls.length = 0;
  w.cancel();
  assert.equal(w.step, 'arrange', 'still arranging');
  assert.deepEqual(app.calls, [['showModel'], ['arrange']]);
  assert.equal(w.replacingIndex, null);

  // Begun from a saved model, without the guide: cancel ends it.
  const lone = fakeApp();
  const v = new CompareWizard(lone);
  v.replace(0);
  assert.deepEqual(lone.calls, [['begin'], ['showPlaceToReplace', 0]]);
  v.cancel();
  assert.equal(v.active, false);
  assert.deepEqual(lone.calls.slice(-2), [['end'], ['showModel']]);
});

test('a new line for a model: Done gives it the line, Cancel leaves the model as it was', async () => {
  const app = fakeApp();
  const w = new CompareWizard(app);
  w.redrawLine();
  assert.deepEqual(app.calls.splice(0), [['begin'], ['showLineToRedraw']]);
  assert.equal(w.step, 'reline');
  assert.equal(w.view.primary, 'Done');
  w.chooseWorld('mars');
  assert.equal(w.step, 'reline', 'the line stays on the first place\'s world');
  await w.next();
  assert.deepEqual(app.calls.splice(0), [['lineReady'], ['applyLine'], ['end'], ['showModel']]);
  assert.equal(w.active, false);

  await toArrange(w);
  w.redrawLine();
  app.calls.length = 0;
  w.cancel();
  assert.deepEqual(app.calls, [['showModel'], ['arrange']], 'from arranging back to arranging');
  assert.equal(w.step, 'arrange');
});

test('a failed capture of the new place keeps it on; another model closes the guide', async () => {
  const app = fakeApp({ captureOk: false });
  const w = new CompareWizard(app);
  w.replace(1);
  await chooseSourcesAndCapture(w);
  assert.equal(w.step, 'heights');
  w.viewChanged('map');
  assert.equal(w.step, 'heights', 'the new place is configured on the map');
  w.close();
  assert.equal(w.active, false);
  assert.deepEqual(app.calls.at(-1), ['end']);
});

test('from the map: the guide starts at the first place, on the world on show, without the dialog', () => {
  const app = fakeApp();
  const w = new CompareWizard(app);
  w.startAt('moon');
  assert.equal(w.step, 'place1');
  assert.deepEqual(app.calls, [['begin']]);
  assert.match(w.view.title, /Moon/);
  assert.equal(w.view.back, null, 'no dialog of worlds to go back to');
  w.startAt('mars');
  assert.equal(w.step, 'place1', 'a second start while on is ignored');
});

test('another world while a place is framed: the place is looked for there', () => {
  const app = fakeApp();
  const w = new CompareWizard(app);
  w.startAt('earth');
  w.chooseWorld('venus');
  assert.equal(w.step, 'place1');
  assert.match(w.view.title, /Venus/);
  assert.deepEqual(app.calls.slice(-1), [['showWorld', 'venus']]);
});

test('back from the line, from the second world and from arranging changes the view, and the guide stays on', async () => {
  const app = fakeApp();
  let w = null;
  // the page's views, as App.show tells the guide of each (viewChanged)
  app.backToSources = () => { app.calls.push(['backToSources']); w.viewChanged('map'); };
  app.backToLine = () => { app.calls.push(['backToLine']); w.viewChanged('model'); };
  app.backToSecond = () => { app.calls.push(['backToSecond']); w.viewChanged('map'); };
  w = new CompareWizard(app);
  await toArrange(w);
  w.back();
  assert.equal(w.step, 'heights', 'from arranging back to the second place sources');
  w.back();
  w.back();
  assert.equal(w.step, 'place2');
  w.back();
  w.back();
  assert.equal(w.step, 'line', 'and to the line on the first place\'s model');
  w.back();
  assert.equal(w.step, 'heights');
  w.back(); w.back();
  assert.equal(w.step, 'place1', 'and to framing the first place');
  assert.equal(w.active, true);
  assert.ok(!app.calls.some(([name]) => name === 'end'), 'never ended on the way');
});
