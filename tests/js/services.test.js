// The way to the list of the home's services: an address where the page stands under the home's domain, nothing elsewhere.
import assert from 'node:assert/strict';
import test from 'node:test';

import { servicesAddress } from '../../web/js/services.js';

test('a page under a home domain leads to the home itself, over https', () => {
  assert.equal(servicesAddress('example.test'), 'https://example.test/');
});

test('a page under no home domain has no address, and so no button', () => {
  assert.equal(servicesAddress(null), null, 'a laptop\'s localhost, or the public copy, where the theme file names no domain');
  assert.equal(servicesAddress(undefined), null);
  assert.equal(servicesAddress(''), null);
});
