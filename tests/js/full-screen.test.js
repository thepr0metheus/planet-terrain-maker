import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FullScreen } from '../../web/js/full-screen.js';

// A page whose browser has the standard names, Safari's webkit ones, or none that work.
function page({ standard = true, webkit = false, enabled = true } = {}) {
  const doc = new EventTarget();
  const calls = [];
  doc.documentElement = {};
  const go = (element, change, on) => {
    doc[element] = on ? doc.documentElement : null;
    doc.dispatchEvent(new Event(change));
  };
  if (standard) {
    Object.assign(doc, { fullscreenEnabled: enabled, fullscreenElement: null });
    doc.documentElement.requestFullscreen = async () => { calls.push('request'); go('fullscreenElement', 'fullscreenchange', true); };
    doc.exitFullscreen = async () => { calls.push('exit'); go('fullscreenElement', 'fullscreenchange', false); };
  }
  if (webkit) {
    Object.assign(doc, { webkitFullscreenEnabled: enabled, webkitFullscreenElement: null });
    doc.documentElement.webkitRequestFullscreen = () => { calls.push('webkit request'); go('webkitFullscreenElement', 'webkitfullscreenchange', true); };
    doc.webkitExitFullscreen = () => { calls.push('webkit exit'); go('webkitFullscreenElement', 'webkitfullscreenchange', false); };
  }
  return { doc, calls, go };
}

test('the whole page goes to the full screen and back; the button hears each change', async () => {
  const { doc, calls, go } = page();
  const full = new FullScreen(doc);
  const told = [];
  full.onChange = (on) => told.push(on);
  assert.equal(full.can, true);
  assert.equal(full.on, false);
  await full.toggle();
  assert.equal(full.on, true);
  await full.toggle();
  assert.deepEqual(calls, ['request', 'exit']);
  await full.toggle();
  go('fullscreenElement', 'fullscreenchange', false);         // Esc, or the browser's own button
  assert.equal(full.on, false);
  assert.deepEqual(told, [true, false, true, false]);
});

test('an iPad before iPadOS 16.4 has only the webkit names', async () => {
  const { doc, calls } = page({ standard: false, webkit: true });
  const full = new FullScreen(doc);
  assert.equal(full.can, true);
  await full.toggle();
  assert.equal(full.on, true);
  await full.toggle();
  assert.deepEqual(calls, ['webkit request', 'webkit exit']);
});

test('Safari on an iPhone gives a page no full screen: no button, and a toggle says so', async () => {
  const iphone = new FullScreen(page({ standard: true, webkit: true, enabled: false }).doc);
  assert.equal(iphone.can, false);
  assert.equal(iphone.on, false);
  await assert.rejects(iphone.toggle(), /no full screen/);
  assert.equal(new FullScreen(page({ standard: false }).doc).can, false, 'an old browser with neither');
});
