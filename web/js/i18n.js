// The page in English or in Russian.
//
// The page and the code are written in English. RU (i18n-ru.js) gives the
// Russian of each text, keyed by the English exactly as it stands (spaces
// squeezed to one).
//
//   t(text, params)       the text in the language in use, {name} filled from
//                         params. A text built from numbers or names goes
//                         through t() where it is built.
//   countOf(n, one, many) "5 models", and in Russian the right one of its three forms.
//   PageTranslator        keeps every text node and title, placeholder and
//                         aria-label of the page in the language in use, as the
//                         page changes (a MutationObserver), and turns them all
//                         when the language changes. A fixed text the page or
//                         the code puts as a whole node needs nothing more.
//
// t() and countOf are plain functions on the language in use (module state that only
// setLanguage changes). PageTranslator is the only part that touches the DOM.

import { RU } from './i18n-ru.js';

export const LANGUAGES = ['en', 'ru'];
let current = 'en';

export function language() {
  return current;
}

export function setLanguage(id) {
  current = LANGUAGES.includes(id) ? id : 'en';
}

// The English of a Russian text the dictionary gives, so a node that holds a
// translated text can be turned back.
const ENGLISH_OF = new Map(Object.entries(RU).filter(([, ru]) => typeof ru === 'string').map(([en, ru]) => [ru, en]));

export function t(text, params = null) {
  let s = current === 'ru' && typeof RU[text] === 'string' ? RU[text] : text;
  if (params) s = s.replace(/\{(\w+)\}/g, (whole, key) => (key in params ? String(params[key]) : whole));
  return s;
}

// A number as the language in use writes it: 205,004 / 205 004.
// n as the language writes it (a decimal comma in Russian); digits: exactly that many after the point.
export function number(n, digits = null) {
  const exactly = digits === null ? undefined : { minimumFractionDigits: digits, maximumFractionDigits: digits };
  return Number(n).toLocaleString(current === 'ru' ? 'ru-RU' : 'en-GB', exactly);
}

// n and its noun. In Russian RU[many] holds the three forms: for 1 (and 21, 31...),
// for 2-4 (22-24...), and for the rest (5-20, 25-30...).
export function countOf(n, one, many) {
  if (current !== 'ru' || !Array.isArray(RU[many])) return `${n} ${n === 1 ? one : many}`;
  const [single, few, lots] = RU[many];
  const n10 = n % 10, n100 = n % 100;
  const form = n10 === 1 && n100 !== 11 ? single : n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14) ? few : lots;
  return `${n} ${form}`;
}

// A text's key: its words with the spaces around and between them squeezed.
function keyOf(text) {
  return text.replace(/\s+/g, ' ').trim();
}

// `text` shown in the language in use, keeping the spaces around it as they were.
function shown(text) {
  const key = keyOf(text);
  if (!key) return text;
  const english = ENGLISH_OF.get(key) ?? key;
  const wanted = t(english);
  if (wanted === key) return text;
  const lead = text.match(/^\s*/)[0], trail = text.match(/\s*$/)[0];
  return lead + wanted + trail;
}

const ATTRIBUTES = ['title', 'placeholder', 'aria-label'];

export class PageTranslator {
  // root: the part of the page to keep translated. skip: a selector for parts
  // to leave alone (the maps' tiles and credits, the 3D view).
  constructor(root, { skip = null } = {}) {
    this._root = root;
    this._skip = skip;
    this._observer = new MutationObserver((records) => this._onChanges(records));
  }

  start() {
    this._translateTree(this._root);
    this._observer.observe(this._root, {
      subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRIBUTES,
    });
  }

  // The language changed: turn everything on the page.
  refresh() {
    this._translateTree(this._root);
    this._observer.takeRecords();   // our own changes
  }

  _skipped(node) {
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return !el || (this._skip && el.closest(this._skip)) || el.closest('script, style');
  }

  _translateText(node) {
    const value = node.nodeValue;
    const next = shown(value);
    if (next !== value) node.nodeValue = next;
  }

  _translateAttributes(el) {
    for (const name of ATTRIBUTES) {
      const value = el.getAttribute(name);
      if (value === null) continue;
      const next = shown(value);
      if (next !== value) el.setAttribute(name, next);
    }
  }

  _translateTree(node) {
    if (this._skipped(node)) return;
    if (node.nodeType === Node.TEXT_NODE) {
      this._translateText(node);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    this._translateAttributes(node);
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: (n) => (this._skipped(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === Node.TEXT_NODE) this._translateText(n);
      else this._translateAttributes(n);
    }
  }

  _onChanges(records) {
    for (const record of records) {
      if (record.type === 'childList') {
        for (const node of record.addedNodes) this._translateTree(node);
      } else if (record.type === 'characterData') {
        if (!this._skipped(record.target)) this._translateText(record.target);
      } else if (record.type === 'attributes') {
        if (!this._skipped(record.target)) this._translateAttributes(record.target);
      }
    }
    this._observer.takeRecords();   // the changes made just now are ours
  }
}
