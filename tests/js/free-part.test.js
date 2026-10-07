import { test } from 'node:test';
import assert from 'node:assert/strict';

import { freePart } from '../../web/js/free-part.js';

const map = { left: 0, top: 0, right: 2000, bottom: 1000 };

test('the panel on the left takes the left; the guide\'s bar at the bottom takes the bottom', () => {
  const panel = { left: 16, top: 16, right: 480, bottom: 880 };
  const bar = { left: 830, top: 830, right: 1645, bottom: 1000 };          // right of the middle, at the bottom
  const free = freePart(map, [panel, bar]);
  assert.deepEqual(free, { left: 492, top: 0, right: 2000, bottom: 818 }, 'not squeezed between the panel and the bar');
});

test('a phone: the sheet at the bottom takes the bottom', () => {
  const phone = { left: 0, top: 0, right: 375, bottom: 700 };
  assert.deepEqual(freePart(phone, [{ left: 0, top: 380, right: 375, bottom: 700 }]), { left: 0, top: 0, right: 375, bottom: 368 });
});

test('a panel elsewhere, or one that would leave no room, changes nothing', () => {
  assert.deepEqual(freePart(map, [{ left: 2100, top: 0, right: 2200, bottom: 50 }]), map);
  const small = { left: 0, top: 0, right: 200, bottom: 200 };
  assert.deepEqual(freePart(small, [{ left: 10, top: 10, right: 190, bottom: 190 }]), small);
});
