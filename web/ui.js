'use strict';

/*
 * The small tools the page draws with: a way to make elements without ever parsing text as
 * HTML (Dom), icons drawn in code (Icon), a message with a way back (Toast), the search box (Search)
 * and the light that follows the mouse over a surface (Glow).
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
