// A map tile's picture with a border one pixel wide taken from its neighbours.
//
// Zoomed past a tile's own level, Leaflet scales the tiles one by one. Inside a
// tile the browser blends each pixel into the next; at the tile's edge it has
// nothing to blend with, so two tiles meet in a hard line. On a stretched map
// (stretched-tiles.js) a step of one grey there becomes ten, and the line shows.
// Drawn one pixel larger on every side and laid one pixel over its neighbours,
// a tile blends into them as into itself.
//
// Where a neighbour is missing (not loaded yet, or past the edge of the world)
// the tile's own edge pixel is repeated, which is what the browser does anyway.
//
// A plain function on pixel arrays: the tests run it on numbers.

// picture: { width, height, data } with data as RGBA bytes, like ImageData.
// neighbours: { n, s, w, e, nw, ne, sw, se }, each a picture of the same size,
// or null/undefined when it is not there. Returns a picture 2 pixels wider and
// taller.
export function borderedPicture(picture, neighbours) {
  const { width: w, height: h } = picture;
  const W = w + 2, H = h + 2;
  const data = new Uint8ClampedArray(W * H * 4);
  const fits = (p) => p && p.width === w && p.height === h ? p : null;
  const n = fits(neighbours.n), s = fits(neighbours.s), west = fits(neighbours.w), e = fits(neighbours.e);
  const put = (from, x, y, X, Y) => {
    const i = (y * w + x) * 4, o = (Y * W + X) * 4;
    data[o] = from.data[i];
    data[o + 1] = from.data[i + 1];
    data[o + 2] = from.data[i + 2];
    data[o + 3] = from.data[i + 3];
  };
  for (let y = 0; y < h; y++) data.set(picture.data.subarray(y * w * 4, (y + 1) * w * 4), ((y + 1) * W + 1) * 4);
  for (let x = 0; x < w; x++) {
    put(n ?? picture, x, n ? h - 1 : 0, x + 1, 0);
    put(s ?? picture, x, s ? 0 : h - 1, x + 1, H - 1);
  }
  for (let y = 0; y < h; y++) {
    put(west ?? picture, west ? w - 1 : 0, y, 0, y + 1);
    put(e ?? picture, e ? 0 : w - 1, y, W - 1, y + 1);
  }
  // A corner comes from the tile across it; without that tile, the nearest
  // border pixel along the top or bottom row is repeated.
  const corner = (diagonal, x, y, X, Y, besideX) => {
    const d = fits(diagonal);
    if (d) put(d, x, y, X, Y);
    else data.copyWithin((Y * W + X) * 4, (Y * W + besideX) * 4, (Y * W + besideX) * 4 + 4);
  };
  corner(neighbours.nw, w - 1, h - 1, 0, 0, 1);
  corner(neighbours.ne, 0, h - 1, W - 1, 0, W - 2);
  corner(neighbours.sw, w - 1, 0, 0, H - 1, 1);
  corner(neighbours.se, 0, 0, W - 1, H - 1, W - 2);
  return { width: W, height: H, data };
}
