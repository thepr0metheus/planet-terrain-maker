// The line between two places drawn onto the model's picture while it is chosen (line-tool.js): the
// second place's part dimmed, the line in white over a dark edge (its points are numbered marks over
// the model: line-points.js). Drawn into the picture, the line lies on the relief as the ground does. The preview is at most `most`
// points a side: it is drawn again at every click and turn, and only shows where the line goes.
// A builder of a picture without state: a function, as split.js's composeCanvas.

import { toFrame } from './split.js';

const DIM = 'rgba(6, 8, 18, 0.55)';

// picture: a canvas or an image. divider: the line (a Divider), or null while a line by points has
// fewer than two. outline, frame: the model's. canvas(w, h): a new canvas.
export function linePreview(picture, { divider, outline, frame }, { most = 4096, canvas = blank } = {}) {
  const scale = Math.min(1, most / Math.max(picture.width, picture.height));
  const w = Math.max(1, Math.round(picture.width * scale)), h = Math.max(1, Math.round(picture.height * scale));
  const out = canvas(w, h);
  const ctx = out.getContext('2d');
  ctx.drawImage(picture, 0, 0, w, h);
  const at = ([x, y]) => {
    const [u, v] = toFrame(x, y, frame);
    return [u * w, v * h];
  };
  const trace = (path, closed) => {
    ctx.beginPath();
    path.forEach((p, i) => (i ? ctx.lineTo(...at(p)) : ctx.moveTo(...at(p))));
    if (closed) ctx.closePath();
  };
  const unit = Math.max(w, h) / 1000;                 // a thousandth of the picture: the pen's measure
  if (divider) {
    trace(divider.sides(outline.reachM).second, true);
    ctx.fillStyle = DIM;
    ctx.fill();
    const line = divider.path(outline.reachM);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const [style, width] of [['rgba(0, 0, 0, 0.65)', 7 * unit], ['#ffffff', 3.2 * unit]]) {
      trace(line, false);
      ctx.strokeStyle = style;
      ctx.lineWidth = width;
      ctx.stroke();
    }
  }
  return out;
}

function blank(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}
