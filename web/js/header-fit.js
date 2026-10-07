// The header's buttons in one row beside the app's name. Where their words do not fit (a model's
// eight buttons near 1024 points wide put the full-screen button on a second row), the secondary
// buttons show their icons only, their words staying in their titles; the primary one keeps its
// word. Where the words fit, they come back. Measured, not guessed from the width: the buttons on
// show and the language of their words decide.

export class HeaderFit {
  // tools: the header's row of buttons. win: where resizes are heard (the window).
  constructor(tools, win = globalThis.window) {
    this._tools = tools;
    let queued = false;
    win.addEventListener('resize', () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        this.fit();
      });
    });
    globalThis.document?.fonts?.ready.then(() => this.fit());
  }

  // Words where one row holds them, icons where it does not. Run when the buttons on show change.
  fit() {
    this._tools.classList.remove('compact');
    if (this._wraps()) this._tools.classList.add('compact');
  }

  // Whether the buttons on show stand on more than one row.
  _wraps() {
    const tops = [...this._tools.children].filter((el) => !el.hidden && el.offsetParent !== null)
      .map((el) => el.getBoundingClientRect().top);
    return tops.length > 1 && Math.max(...tops) - Math.min(...tops) > 10;
  }
}
