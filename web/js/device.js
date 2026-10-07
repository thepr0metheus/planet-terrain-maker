// What this device can hold. The page tries it once, when first asked: a point drawn in the far corner
// of a canvas must read back (a canvas too big for the browser comes out blank, with no error). A
// computer that holds 8192 gets as much as the page ever makes. A touch device (an iPad, a phone) gets
// 4096 at most even where one canvas of 8192 works: a model holds three pictures that big at once (two
// places and the one made of them), with their copies on the graphics card. An iPad held one
// canvas of 8192, then gave the model a blank picture and lost its WebGL.
// A device that holds less than the page makes asks the server for smaller copies of a saved model's
// pictures (GET .../files/<name>?most=4096); the files there stay as they are. One place for the rule:
// the picture's detail on the map, the capture's tiles and the pictures of a saved model ask here.

const touch = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
const ALL = 16384;                    // a side as big as the page ever makes a canvas
const TOUCH_MOST = 4096;              // the most for a touch device: its memory, not one canvas

// Whether a canvas side x side works: make(w, h) gives a canvas.
function holds(make, side) {
  let canvas = null;
  try {
    canvas = make(side, side);
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    ctx.fillStyle = '#fff';
    ctx.fillRect(side - 1, side - 1, 1, 1);
    return ctx.getImageData(side - 1, side - 1, 1, 1).data[3] === 255;
  } catch {
    return false;
  } finally {
    if (canvas) canvas.width = canvas.height = 0;    // Safari gives the memory back only so
  }
}

// The longest side of a square canvas this browser holds, of `sides` (the biggest first); half the
// last one when none works.
export function canvasSide(make, sides) {
  for (const side of sides) if (holds(make, side)) return side;
  return sides[sides.length - 1] / 2;
}

// The most a side of a canvas may be here: tried from 4096 down on a touch device; on a computer,
// holding 8192 counts as holding ALL.
export function canvasMost(make, { touch: onTouch = false } = {}) {
  if (onTouch) return canvasSide(make, [TOUCH_MOST, 2048]);
  const side = canvasSide(make, [8192, 4096, 2048]);
  return side === 8192 ? ALL : side;
}

function measured() {
  if (typeof document === 'undefined') return ALL;     // no page (the tests): nothing to try
  return canvasMost((w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h }), { touch });
}

let most = null;

export const DEVICE = {
  touch,
  // a side of any canvas the page makes
  get canvasMostPx() {
    most ??= measured();
    return most;
  },
  // the pictures of a saved model are asked for smaller: this device holds less than the page makes
  get smaller() {
    return this.canvasMostPx < ALL;
  },
};

// width x height brought within the device's canvas: the same shape, at most canvasMostPx a side.
export function fitCanvas(width, height, most = DEVICE.canvasMostPx) {
  const scale = Math.min(1, most / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
