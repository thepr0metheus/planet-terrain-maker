// The whole page on the whole screen, and back. Safari on an iPad has the standard names since
// iPadOS 16.4 and the webkit ones before; Safari on an iPhone gives a page no full screen at all, so
// `can` is false there and the page shows no button. Esc, or the browser's own button, leaves the full
// screen too: onChange tells each change, whoever made it.

// The two sets of names a browser may have, the standard one first.
const APIS = [
  { enabled: 'fullscreenEnabled', element: 'fullscreenElement', request: 'requestFullscreen', exit: 'exitFullscreen', change: 'fullscreenchange' },
  { enabled: 'webkitFullscreenEnabled', element: 'webkitFullscreenElement', request: 'webkitRequestFullscreen', exit: 'webkitExitFullscreen', change: 'webkitfullscreenchange' },
];

export class FullScreen {
  constructor(doc = document) {
    this._doc = doc;
    this._api = APIS.find((api) => doc[api.enabled]) ?? null;
    this.onChange = () => {};
    if (this._api) doc.addEventListener(this._api.change, () => this.onChange(this.on));
  }

  get can() {
    return this._api !== null;
  }

  get on() {
    return Boolean(this._api && this._doc[this._api.element]);
  }

  // Into the full screen, or out of it. Rejects when the browser refuses.
  async toggle() {
    if (!this._api) throw new Error('This browser gives a page no full screen.');
    if (this.on) await this._doc[this._api.exit]();
    else await this._doc.documentElement[this._api.request]();
  }
}
