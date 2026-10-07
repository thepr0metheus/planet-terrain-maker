import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { t, countOf, setLanguage, language } from '../../web/js/i18n.js';
import { RU } from '../../web/js/i18n-ru.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const squeeze = (s) => s.replace(/\s+/g, ' ').trim();

// Texts that read the same in Russian: names of things, and marks.
const KEEP = new Set([
  'Planet Terrain Maker', 'OpenTopography', 'OpenStreetMap', 'Nominatim', 'three.js', 'Leaflet', 'RU', 'EN',
  'STL', '3MF', 'GLB', 'OBJ', 'USDZ', 'PNG', '°', 'km', 'Esri World Imagery', 'Sentinel-2 cloudless 2025',
]);

function withLanguage(id, fn) {
  const before = language();
  setLanguage(id);
  try { return fn(); } finally { setLanguage(before); }
}

test('English passes through; Russian comes from the dictionary, with the values filled in', () => {
  assert.equal(t('Save'), 'Save');
  assert.equal(t('{n} km', { n: 3.2 }), '3.2 km');
  withLanguage('ru', () => {
    assert.equal(t('Save'), RU['Save']);
    assert.equal(t('{n} km', { n: 3.2 }), RU['{n} km'].replace('{n}', '3.2'));
    assert.equal(t('A text nobody translated'), 'A text nobody translated', 'missing: stays English');
  });
  withLanguage('xx', () => assert.equal(language(), 'en', 'an unknown language is English'));
});

test('Russian counts take the right one of three forms', () => {
  assert.equal(countOf(1, 'model', 'models'), '1 model');
  assert.equal(countOf(5, 'model', 'models'), '5 models');
  withLanguage('ru', () => {
    const counts = [1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 101, 111];
    // 1, 21 and 101 take the first form; 2, 4 and 22 the second; 5 to 20, 25 and 111 the third
    const [one, few, lots] = RU.models;
    const wanted = [one, few, few, lots, lots, lots, lots, one, few, lots, one, lots];
    assert.deepEqual(counts.map((n) => countOf(n, 'model', 'models')), counts.map((n, k) => `${n} ${wanted[k]}`));
  });
});

test('every Russian text keeps the values of its English', () => {
  const names = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const [en, ru] of Object.entries(RU)) {
    if (typeof ru !== 'string') continue;
    assert.deepEqual(names(ru), names(en), en);
  }
});

test('every text the code passes through t() has its Russian', () => {
  const missing = [];
  for (const file of readdirSync(new URL('../../web/js/', import.meta.url))) {
    if (!file.endsWith('.js') || file.startsWith('i18n')) continue;
    const source = read(`../../web/js/${file}`);
    for (const m of source.matchAll(/(?<![\w$.])t\(\s*'((?:[^'\\]|\\.)*)'/g)) {
      const key = m[1].replace(/\\'/g, "'");
      if (!(key in RU)) missing.push(`${file}: ${key}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('every fixed text the code puts on the screen has its Russian', () => {
  const missing = [];
  // A text put whole: into an element, as a step's button, as a source's name, or as an error the
  // page shows through t(error.message). What reportError() sends goes to the server, not the screen.
  const pattern = /textContent\s*=\s*'((?:[^'\\]|\\.)*)'|(?:label|primary|back|cancel)\s*:\s*'((?:[^'\\]|\\.)*)'|(?<!Range|report)Error\(\s*'((?:[^'\\]|\\.)*)'/g;
  for (const file of readdirSync(new URL('../../web/js/', import.meta.url))) {
    if (!file.endsWith('.js') || file.startsWith('i18n')) continue;
    for (const m of read(`../../web/js/${file}`).matchAll(pattern)) {
      const key = m.slice(1).find((g) => g !== undefined);
      if (!/[A-Za-z]/.test(key) || KEEP.has(key)) continue;
      if (!(key in RU)) missing.push(`${file}: ${key}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('every text and hint of the page itself has its Russian', () => {
  const html = read('../../web/index.html')
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const texts = [...html.matchAll(/>([^<]+)</g)].map((m) => squeeze(decode(m[1])));
  const hints = [...html.matchAll(/\s(?:title|placeholder|aria-label)="([^"]*)"/g)].map((m) => squeeze(decode(m[1])));
  const missing = [...texts, ...hints].filter((s) => /[A-Za-z]/.test(s) && !KEEP.has(s) && !(s in RU));
  assert.deepEqual([...new Set(missing)], []);
});
