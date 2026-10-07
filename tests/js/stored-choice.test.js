import { test } from 'node:test';
import assert from 'node:assert/strict';

import { StoredChoice } from '../../web/js/stored-choice.js';

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    data,
  };
}

test('a saved value comes back, and nothing saved gives the fallback', () => {
  const storage = memoryStorage();
  const choice = new StoredChoice('dem', { storage: () => storage });
  assert.equal(choice.get('COP30'), 'COP30');
  choice.set('aws-terrain');
  assert.equal(storage.data.get('dem'), 'aws-terrain');
  assert.equal(choice.get('COP30'), 'aws-terrain');
});

test('a value outside the allowed ones counts as nothing saved', () => {
  const storage = memoryStorage({ dem: 'SRTMGL1' });
  const choice = new StoredChoice('dem', { allowed: ['COP30', 'aws-terrain'], storage: () => storage });
  assert.equal(choice.get('COP30'), 'COP30');
  storage.data.set('dem', 'aws-terrain');
  assert.equal(choice.get('COP30'), 'aws-terrain');
});

test('a storage that cannot even be reached reads as nothing saved and drops writes', () => {
  const blocked = () => { throw new DOMException('The operation is insecure.', 'SecurityError'); };
  const choice = new StoredChoice('fill', { storage: blocked });
  assert.equal(choice.get('off'), 'off');
  assert.doesNotThrow(() => choice.set('on'));
});

test('a storage that refuses a read or a write does the same', () => {
  const refusing = {
    getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); },
  };
  const choice = new StoredChoice('fill', { storage: () => refusing });
  assert.equal(choice.get('off'), 'off');
  assert.doesNotThrow(() => choice.set('on'));
});

test('without a fallback, nothing saved is null', () => {
  const choice = new StoredChoice('x', { storage: () => memoryStorage() });
  assert.equal(choice.get(), null);
});
