'use strict';

/*
 * The small tools the page draws with: a way to make elements without ever parsing text as
 * HTML (Dom), icons drawn in code (Icon), a message with a way back (Toast), the search box (Search),
 * the pinned panel under the header (Dock), the names of the page's two blocks (BlockNames) and the
 * light that follows the mouse over a surface (Glow).
 */

class Dom {
  /** el('a', {class: 'card', href}, child, 'text') — attributes one by one, text never parsed as HTML. */
  static el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs || {})) {
      if (value === null || value === undefined || value === false) continue;
      node.setAttribute(name, value === true ? '' : String(value));
    }
    node.append(...children.filter((child) => child !== null && child !== undefined));
    return node;
  }
}

class Icon {
  static NS = 'http://www.w3.org/2000/svg';

  /**
   * Drawn by hand on a 24-unit square with one stroke weight: nothing to download, and they take
   * the colour of the text around them. A shape is [element, attributes].
   */
  static SHAPES = {
    search: [['circle', { cx: 11, cy: 11, r: 7 }], ['path', { d: 'm20 20-3.5-3.5' }]],
    plus: [['path', { d: 'M12 5v14M5 12h14' }]],
    table: [['rect', { x: 3, y: 4, width: 18, height: 16, rx: 3 }], ['path', { d: 'M3 10h18M9 10v10' }]],
    pencil: [['path', { d: 'M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z' }], ['path', { d: 'm15 5 4 4' }]],
    trash: [['path', { d: 'M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2M10 11v6M14 11v6' }]],
    check: [['path', { d: 'M20 6 9 17l-5-5' }]],
    sun: [['circle', { cx: 12, cy: 12, r: 4 }],
          ['path', { d: 'M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41' }]],
    moon: [['path', { d: 'M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z' }]],
    out: [['path', { d: 'M7 7h10v10M7 17 17 7' }]],
    x: [['path', { d: 'M18 6 6 18M6 6l12 12' }]],
    eye: [['path', { d: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z' }], ['circle', { cx: 12, cy: 12, r: 3 }]],
    clock: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M12 7v5l3 2' }]],
    server: [['rect', { x: 3, y: 4, width: 18, height: 7, rx: 2 }], ['rect', { x: 3, y: 13, width: 18, height: 7, rx: 2 }],
             ['path', { d: 'M7 7.5h.01M7 16.5h.01' }]],
    alert: [['path', { d: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z' }],
            ['path', { d: 'M12 9v4M12 17h.01' }]],
    book: [['path', { d: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20' }],
           ['path', { d: 'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z' }]],
    bot: [['path', { d: 'M12 8V4H8' }], ['rect', { x: 4, y: 8, width: 16, height: 12, rx: 2 }],
          ['path', { d: 'M2 14h2M20 14h2M15 13v2M9 13v2' }]],
    home: [['path', { d: 'm3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }], ['path', { d: 'M9 22V12h6v10' }]],
    key: [['circle', { cx: 7.5, cy: 15.5, r: 5.5 }], ['path', { d: 'm21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3' }]],
    logout: [['path', { d: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9' }]],
    shield: [['path', { d: 'M20 13c0 5-3.5 7.5-7.7 8.9a1 1 0 0 1-.6 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1.2 1.2 0 0 1 1.6 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1z' }],
             ['path', { d: 'm9 12 2 2 4-4' }]],
    back: [['path', { d: 'M19 12H5M12 19l-7-7 7-7' }]],
    activity: [['path', { d: 'M22 12h-4l-3 9L9 3l-3 9H2' }]],
    layers: [['path', { d: 'm12 2 10 5-10 5L2 7z' }], ['path', { d: 'm2 17 10 5 10-5M2 12l10 5 10-5' }]],
    ok: [['circle', { cx: 12, cy: 12, r: 10 }], ['path', { d: 'm9 12 2 2 4-4' }]],
    fail: [['circle', { cx: 12, cy: 12, r: 10 }], ['path', { d: 'm15 9-6 6M9 9l6 6' }]],
    retry: [['path', { d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5' }]],
    grip: [[9, 6], [15, 6], [9, 12], [15, 12], [9, 18], [15, 18]]
      .map(([cx, cy]) => ['circle', { cx, cy, r: 1.6, fill: 'currentColor', stroke: 'none' }]),
  };

  static make(name, size = 18) {
    const shapes = Icon.SHAPES[name];
    // a mistyped name must fail loudly, not draw an empty square that looks like a design choice
    if (!shapes) throw new Error(`no icon called "${name}"`);
    const svg = document.createElementNS(Icon.NS, 'svg');
    const frame = {
      viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor',
      'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      'aria-hidden': 'true', focusable: 'false', class: 'icon',
    };
    for (const [attribute, value] of Object.entries(frame)) svg.setAttribute(attribute, value);
    for (const [tag, attributes] of shapes) {
      const part = document.createElementNS(Icon.NS, tag);
      for (const [attribute, value] of Object.entries(attributes)) part.setAttribute(attribute, value);
      svg.append(part);
    }
    return svg;
  }
}

class Toast {
  static LIFE = 7000; // ms a message stays; an error stays until it is closed
  static LIFE_WITH_UNDO = 12000; // a message with a way back stays longer: people read it, then decide

  constructor(element) {
    this.element = element;
    this.text = element.querySelector('.toast-text');
    this.action = element.querySelector('.toast-action');
    this.timer = 0;
    this.run = null; // what the action button does, while there is one
    this.action.addEventListener('click', () => {
      const run = this.run;
      this.hide();
      if (run) run();
    });
    const close = element.querySelector('.toast-close');
    close.append(Icon.make('x', 16));
    close.addEventListener('click', () => this.hide());
  }

  /** `message` is {text, kind: 'info' | 'error', action: {label, run} | null}. */
  show({ text, kind, action }) {
    window.clearTimeout(this.timer);
    this.text.textContent = text;
    this.element.classList.toggle('error', kind === 'error');
    this.element.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    this.run = action ? action.run : null;
    this.action.hidden = !action;
    if (action) this.action.textContent = action.label;
    this.element.hidden = false;
    // a message that replaces another comes in again, so that the change is seen
    this.element.classList.remove('shown');
    void this.element.offsetWidth;
    this.element.classList.add('shown');
    if (kind !== 'error') {
      this.timer = window.setTimeout(() => this.hide(), action ? Toast.LIFE_WITH_UNDO : Toast.LIFE);
    }
  }

  hide() {
    window.clearTimeout(this.timer);
    this.element.hidden = true;
    this.run = null;
  }
}

class Search {
  /** The box under the name. `changed` is called whenever what it holds changes. */
  constructor(input, changed) {
    this.input = input;
    this.changed = changed;
    input.addEventListener('input', () => this.changed());
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (this.active) this.clear();
      else input.blur();
    });
  }

  get query() {
    return this.input.value.trim();
  }

  get active() {
    return this.query !== '';
  }

  clear() {
    this.input.value = '';
    this.changed();
  }

  focus() {
    this.input.focus();
    this.input.select();
  }
}

class Dock {
  /**
   * The pinned panel under the header — the scheme ui-home-style.md, its part on the header and the panel. The header goes up
   * with the page; the panel sticks to the top of the window and holds what the page keeps in sight: its search and its
   * main buttons. Once the header is out of the window, the page's mark (a press goes to the top) and the way to the home's
   * services stand at the panel's left: that way is needed in any place of the page.
   *
   *   const dock = new Dock(document.getElementById('dock'), document.querySelector('header.top'), upTitle);
   *   dock.set(buttons, services);    // nodes, as often as they change; `services`: the way to the services, or null
   *   dock.finder(fieldBox, lens);    // the search's box, and the magnifier a narrow screen shows in its place
   *
   * The panel is hidden while it has no search and no button in sight (a hidden node is not one). On a narrow screen
   * the search is the magnifier: a press on it opens the field over the whole panel (`finding`), and the field closes when
   * it loses the focus or Enter is pressed. The panel's height and the room above it are `--pinbar-h`: what else sticks
   * on the page stands under it; `--pinbar-space` is the room a jump to a heading leaves.
   *
   * The words a person reads — the mark's hint, the buttons' names — are the page's: this file holds no language.
   */
  constructor(box, top, up = 'Back to the top') {
    this.box = box;
    this.gap = 8; // the room between the window's top and the panel where its own `top` cannot be read
    this.lens = null; // the magnifier of a narrow screen, once the page gives one
    this.mark = Dom.el('button', { type: 'button', class: 'dock-mark', title: up, 'aria-label': up }, Dock.mark(top));
    this.mark.addEventListener('click', () => window.scrollTo({ top: 0, behavior: Dock.motion() }));
    this.services = Dom.el('span', { class: 'dock-services' });
    this.start = Dom.el('div', { class: 'dock-start' }, this.mark, this.services);
    this.find = Dom.el('div', { class: 'dock-find' });
    this.tools = Dom.el('div', { class: 'dock-tools' });
    this.box.replaceChildren(this.start, this.find, this.tools);
    this.gone = false; // the header is out of the window, above it
    // the focus passing from the magnifier to the field is not the focus leaving the search
    this.find.addEventListener('focusout', (event) => { if (!this.find.contains(event.relatedTarget)) this.fold(); });
    // Enter says "found": the field folds back and the keyboard of a phone goes away
    this.find.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && this.box.classList.contains('finding') && event.target.blur) event.target.blur();
    });
    // Where nothing can watch (a page's tests under Node), the header simply stays: the panel has no mark then.
    if (typeof IntersectionObserver === 'function') {
      new IntersectionObserver(([seen]) => this.leave(!seen.isIntersecting && seen.boundingClientRect.bottom <= 0)).observe(top);
    }
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => this.measure()).observe(this.box);
    this.draw();
  }

  /** The page's buttons, nodes, as often as they change; `services` — the way to the services, as a button, or null where
   *  the page has none. The nodes are the page's: their ids and handlers stay. */
  set(buttons, services = null) {
    this.tools.replaceChildren(...buttons.filter(Boolean));
    this.services.replaceChildren(...(services ? [services] : []));
    this.draw();
  }

  /** The search the page has: its box and the magnifier for a narrow screen. A page without a search gives nothing. */
  finder(field = null, lens = null) {
    this.lens = lens;
    this.find.replaceChildren(...[lens, field].filter(Boolean));
    this.box.classList.remove('finding');
    this.draw();
  }

  /** The screen is narrow when the magnifier is shown: only then a field is put away behind it. */
  narrow() {
    return Boolean(this.lens && this.lens.getClientRects().length);
  }

  /** On a narrow screen the field is shown, where only a magnifier stood: the caller puts the cursor in it. */
  reveal() {
    if (this.narrow()) this.box.classList.add('finding');
  }

  /** The field is put away again: what was typed in it stays, and the page says so by the magnifier. */
  fold() {
    this.box.classList.remove('finding');
  }

  /** The header has left the window or is back. */
  leave(gone) {
    if (gone === this.gone) return;
    this.gone = gone;
    this.draw();
  }

  draw() {
    const buttons = [...this.tools.children].some((node) => !node.hidden); // a chip that says nothing yet is there, and hidden
    this.tools.hidden = !buttons;
    this.box.hidden = !this.find.children.length && !buttons;
    this.box.classList.toggle('gone', this.gone);
    this.measure();
  }

  /** The room between the window's top and the panel when it sticks: its own `top` (ui.css; it is smaller on a phone). */
  room() {
    const top = typeof getComputedStyle === 'function' ? Number.parseFloat(getComputedStyle(this.box).top) : Number.NaN;
    return Number.isFinite(top) ? top : this.gap;
  }

  /** The room the panel takes at the top of the window, for what sticks under it and for the links that stop under it. */
  measure() {
    const root = document.documentElement;
    if (this.box.hidden) {
      root.style.removeProperty('--pinbar-h');
      root.style.removeProperty('--pinbar-space');
      return;
    }
    const height = Math.ceil(this.box.getBoundingClientRect().height) + this.room();
    root.style.setProperty('--pinbar-h', `${height}px`);
    root.style.setProperty('--pinbar-space', `${height + 14}px`);
  }

  /** The tool the keyboard stands on, as its group (one of the boxes: the header's row of buttons, the panel's `tools`)
   *  and its key — the `data-tool` of the button, which the page gives to every one: the words on it, or a name of its own
   *  for a button whose words change (the theme's). A redrawn toolbar must not drop the keyboard's place, and must not
   *  give it to a neighbour either: the buttons of one group change with the view. */
  static held(...boxes) {
    const at = document.activeElement;
    for (const box of boxes) {
      const tool = box && box.contains(at) && at.closest ? at.closest('[data-tool]') : null;
      if (tool) return { box, key: tool.dataset.tool };
    }
    return null;
  }

  /** The keyboard goes back to the button of the same key in the same group, once the buttons are drawn again. Where the
   *  group has none (the main button of a mode went with the mode) it stays where the browser put it: a wrong button
   *  under Enter is worse than none. */
  static hold(held) {
    const same = held && [...held.box.children].find((tool) => tool.dataset && tool.dataset.tool === held.key);
    if (same && same.focus) same.focus();
  }

  /** The page's mark for the panel: a copy of its logo, with ids of its own — two elements of one id would be one. */
  static mark(top) {
    const logo = top && top.querySelector ? top.querySelector('.logo') : null;
    if (!logo) return Icon.make('back');
    const copy = logo.cloneNode(true);
    for (const named of copy.querySelectorAll('[id]')) {
      const id = named.id;
      named.id = `${id}-pinbar`;
      for (const user of copy.querySelectorAll('*')) {
        for (const attribute of ['fill', 'stroke', 'href', 'clip-path', 'mask', 'filter']) {
          const value = user.getAttribute(attribute);
          if (value && value.includes(`#${id}`)) user.setAttribute(attribute, value.split(`#${id}`).join(`#${id}-pinbar`));
        }
      }
    }
    return copy;
  }

  /** "Reduce motion" is the device's word: the jump is then at once. */
  static motion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  }
}

class BlockNames {
  /**
   * The names of the page's two blocks, written on them on demand, so that two people, or a person and an agent, mean the
   * same parts of a page when they speak of it. The header and the panel carry their names in `data-name` in the markup;
   * with the class `names` on the body ui.css draws a dashed line round each and its name on a tab. A button in the footer
   * turns it on and off, and this browser remembers the choice for every home page of this address.
   *
   *   BlockNames.apply();                              // at the start: the choice made before is shown
   *   footer.append(BlockNames.button(text, title));   // the words are the page's
   */
  static KEY = 'home.names';

  static on() {
    try {
      return window.localStorage.getItem(BlockNames.KEY) === 'true';
    } catch (err) {
      return false; // a private window may not let it: the names are then off
    }
  }

  static apply() {
    document.body.classList.toggle('names', BlockNames.on());
  }

  static button(text, title) {
    const button = Dom.el('button', { type: 'button', class: 'linklike', title }, text);
    button.setAttribute('aria-pressed', String(BlockNames.on()));
    button.addEventListener('click', () => {
      const on = !BlockNames.on();
      try {
        window.localStorage.setItem(BlockNames.KEY, String(on));
      } catch (err) {
        // not kept: it is shown for this visit only
        document.body.classList.toggle('names', on);
        button.setAttribute('aria-pressed', String(on));
        return;
      }
      BlockNames.apply();
      button.setAttribute('aria-pressed', String(on));
    });
    return button;
  }
}

class Glow {
  /** Where the mouse is over a `.glow` surface, as its own custom properties (ui.css draws the light there).
   *  Only a mouse: a finger has no "over". One listener on the container serves every surface in it. */
  static follow(container, selector) {
    container.addEventListener('pointermove', (event) => {
      if (event.pointerType !== 'mouse') return;
      const surface = event.target.closest(selector);
      if (!surface) return;
      const box = surface.getBoundingClientRect();
      surface.style.setProperty('--mx', `${event.clientX - box.left}px`);
      surface.style.setProperty('--my', `${event.clientY - box.top}px`);
    });
  }
}

if (typeof module !== 'undefined') module.exports = { Dom, Icon, Toast, Search, Dock, BlockNames, Glow };
