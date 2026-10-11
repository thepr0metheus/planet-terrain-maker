// A bounded, least-recently-used cache of ready meshes, including their uploaded GPU textures.
// It is local to the current model view; the original tile bytes stay in the server's data folder
// (data/picture-tiles).
import { disposeTree } from './dispose.js';

export class DetailPatchCache {
  constructor({ mostBytes, dispose = disposeTree }) {
    this.mostBytes = mostBytes;
    this.bytes = 0;
    this._dispose = dispose;
    this._entries = new Map();
  }

  static bytesOf(patch) {
    const image = patch.material.map.image;
    // CPU canvas + GPU RGBA texture with mipmaps, plus geometry buffers.
    const pixels = image.width * image.height * 4 * (1 + 4 / 3);
    const buffers = Object.values(patch.geometry.attributes).reduce((sum, attribute) => sum + attribute.array.byteLength, 0);
    return Math.ceil(pixels + buffers);
  }

  keep(key, patch) {
    const previous = this.take(key);
    if (previous && previous !== patch) this._dispose(previous);
    const bytes = DetailPatchCache.bytesOf(patch);
    if (bytes > this.mostBytes) { this._dispose(patch); return; }
    this._entries.set(key, { patch, bytes }); this.bytes += bytes;
    while (this.bytes > this.mostBytes) this._drop(this._entries.keys().next().value);
  }

  take(key) {
    const entry = this._entries.get(key);
    if (!entry) return null;
    this._entries.delete(key); this.bytes -= entry.bytes;
    return entry.patch;
  }

  _drop(key) {
    const patch = this.take(key);
    if (patch) this._dispose(patch);
  }

  clear() { for (const key of this._entries.keys()) this._drop(key); }
}
