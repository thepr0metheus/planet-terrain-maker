// Browser-side fetching plus mounted-data persistence. Original source credentials never become
// server-side fetch targets; saved tiles reopen from our API without asking their upstream again.
import { PlaceCapture, CaptureError } from './capture.js';

export class MissingDetailTile extends CaptureError {
  constructor(z) {
    super('The custom layer could not load tiles. Check its URL, coverage and CORS support.');
    this.z = z;
  }
}

export class DetailTileLoader {
  constructor({ fetchFn = (...args) => fetch(...args), capture = null } = {}) {
    this._fetch = fetchFn;
    this._capture = capture ?? new PlaceCapture({ fetchFn });
  }

  async tile(source, z, x, y, signal) {
    const path = `/api/picture-sources/${source.key}/tiles/${z}/${x}/${y}`;
    const saved = await this._fetch(path, { signal });
    if (saved.ok) return this._capture._tilePicture(await saved.blob());
    if (saved.status !== 404) throw new CaptureError('Detailed pictures could not be loaded.');
    const response = await this._capture._tile(source.tileUrl(z, x, y), signal, true);
    if (response.status === 404) throw new MissingDetailTile(z);
    if (!response.ok) throw new CaptureError('The custom layer could not load tiles. Check its URL, coverage and CORS support.');
    const blob = await response.blob(), image = await this._capture._tilePicture(blob);
    if (!image) throw new CaptureError('Detailed pictures could not be loaded.');
    try {
      const kept = await this._fetch(path, { method: 'PUT', body: blob, signal });
      if (!kept.ok) throw new CaptureError('Detailed pictures could not be saved on the server.');
    } catch (error) { image.close?.(); throw error; }
    return image;
  }

  async atlas(source, x, y, z, tiles, signal) {
    const size = tiles * 256;
    const canvas = Object.assign(document.createElement('canvas'), { width: size + 2, height: size + 2 });
    const ctx = canvas.getContext('2d');
    // Each patch is small; four workers prevent a close view from flooding the provider.
    const jobs = [];
    for (let dy = 0; dy < tiles; dy++) for (let dx = 0; dx < tiles; dx++) jobs.push([dx, dy]);
    let next = 0;
    const worker = async () => {
      while (next < jobs.length && !signal.aborted) {
        const [dx, dy] = jobs[next++];
        const image = await this.tile(source, z, x + dx, y + dy, signal);
        if (!image) throw new CaptureError('Detailed pictures could not be loaded.');
        ctx.drawImage(image, 1 + dx * 256, 1 + dy * 256, 256, 256);
        image.close?.();
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    ctx.drawImage(canvas, 1, 1, size, 1, 1, 0, size, 1);
    ctx.drawImage(canvas, 1, size, size, 1, 1, size + 1, size, 1);
    ctx.drawImage(canvas, 1, 1, 1, size, 0, 1, 1, size);
    ctx.drawImage(canvas, size, 1, 1, size, size + 1, 1, 1, size);
    return canvas;
  }
}
