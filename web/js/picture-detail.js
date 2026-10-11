// One rule for automatic picture size: keep source detail, bounded by the picture sizes the
// app supports and this device's canvas. It does not invent extra detail by always making 8192.
import { DEVICE } from './device.js';
import { LonLat, Mercator } from './geo.js';
import { mPerDegOf } from './worlds.js';

export class PictureDetail {
  static metres(world, lat, zoom) {
    return world.grid === 'mercator' ? Mercator.metresPerPx(lat, zoom)
      : LonLat.degPerPx(zoom) * mPerDegOf(world) * Math.cos(lat * Math.PI / 180);
  }

  static pixels(sideM, nativeM, most = DEVICE.canvasMostPx) {
    const wanted = nativeM > 0 ? sideM / nativeM : 8192;
    return Math.max(1, Math.min(most, 8192, Math.max(512, 2 ** Math.ceil(Math.log2(wanted)))));
  }
}
