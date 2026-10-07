// Places on a sphere and on flat pictures of it.
//
// A captured place has a flat frame of its own: metres east (x) and north (y) of its centre. The
// model, the outline and the two places all work in it. Between it and the maps:
//
//   LocalFrame          the place's frame and degrees: sinusoidal about the centre, so a metre
//                       east is a metre at every latitude of the place
//   Mercator            Earth's map and its tiles (Web Mercator, 256-pixel tiles)
//   LonLat              the Moon's, Mars's and Venus's maps (plain degrees, Trek's tiles)

const DEG = Math.PI / 180;

export const metresPerDegree = (radiusM) => 2 * Math.PI * radiusM / 360;

export class LocalFrame {
  // lat, lon: the centre. mPerDeg: metres of ground in a degree of latitude on this world.
  constructor(lat, lon, mPerDeg) {
    if (!(Math.abs(lat) < 90 && Math.abs(lon) <= 180 && mPerDeg > 0)) throw new RangeError(`no frame at ${lat}, ${lon}`);
    this.lat = lat;
    this.lon = lon;
    this.mPerDeg = mPerDeg;
  }

  toLatLon(x, y) {
    const lat = this.lat + y / this.mPerDeg;
    const lon = this.lon + x / (this.mPerDeg * Math.cos(lat * DEG));
    return { lat, lon };
  }

  toXY(lat, lon) {
    return { x: (lon - this.lon) * this.mPerDeg * Math.cos(lat * DEG), y: (lat - this.lat) * this.mPerDeg };
  }

  // The degrees that hold the rectangle of halfW x halfH metres about the centre:
  // { south, north, west, east }. West and east reach as far as the rectangle's widest latitude.
  boxOf(halfW, halfH) {
    const south = this.lat - halfH / this.mPerDeg;
    const north = this.lat + halfH / this.mPerDeg;
    const narrowest = Math.min(Math.cos(south * DEG), Math.cos(north * DEG));
    const halfLon = halfW / (this.mPerDeg * Math.max(1e-6, narrowest));
    return { south, north, west: this.lon - halfLon, east: this.lon + halfLon };
  }
}

// Web Mercator, as Earth's tiles are cut: at zoom z the world is 256 * 2^z pixels a side.
export const Mercator = {
  EARTH_RADIUS: 6378137,
  MAX_LAT: 85.0511287798,

  px(lat, lon, z) {
    const scale = 256 * 2 ** z;
    const s = Math.sin(Math.max(-this.MAX_LAT, Math.min(this.MAX_LAT, lat)) * DEG);
    return {
      x: (lon + 180) / 360 * scale,
      y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale,
    };
  },

  // Ground metres a pixel covers at a latitude.
  metresPerPx(lat, z) {
    return 2 * Math.PI * this.EARTH_RADIUS * Math.cos(lat * DEG) / (256 * 2 ** z);
  },
};

// Plain degrees, as Trek cuts its tiles: at zoom 0 two 256-pixel tiles side by side cover the
// world, so a pixel is 360 / (512 * 2^z) degrees both ways.
export const LonLat = {
  degPerPx(z) {
    return 360 / (512 * 2 ** z);
  },

  px(lat, lon, z) {
    const d = this.degPerPx(z);
    return { x: (lon + 180) / d, y: (90 - lat) / d };
  },
};

// The ground distance between two points on a sphere of the given radius (haversine).
export function distanceM(lat1, lon1, lat2, lon2, radiusM) {
  const a = Math.sin((lat2 - lat1) * DEG / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin((lon2 - lon1) * DEG / 2) ** 2;
  return 2 * radiusM * Math.asin(Math.min(1, Math.sqrt(a)));
}
