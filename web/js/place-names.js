// The named places of the Moon, Mars and Venus: every name the IAU has adopted, from the
// lists tools/planet_names.py builds ([name, lat, lon, diameter_km, code], lon in
// -180..180). Nominatim knows only Earth, so on those bodies the map searches
// these, and a captured place is called after the feature it lies in.

// What a feature is, in a word, by its IAU type code, as the IAU's descriptor
// terms define it (planetarynames.wr.usgs.gov/DescriptorTerms). A code not listed
// here gets no word rather than a guessed one.
const KINDS = {
  AA: 'crater', SF: 'satellite crater', MO: 'mountain', ME: 'mare', OC: 'ocean', VA: 'valley',
  LC: 'lake', SI: 'bay', PA: 'marsh', RI: 'rille', DO: 'ridge', CA: 'crater chain', RU: 'scarp',
  PR: 'cape', TH: 'dome', PL: 'plain', PM: 'plateau', CH: 'chaos', CM: 'chasm', FO: 'fossa',
  LA: 'landslide', LB: 'labyrinth', PE: 'patera', TA: 'land', MN: 'mesa', LF: 'landing site name',
  AL: 'albedo feature', ST: 'landing site', CB: 'hollows', CO: 'hills', FL: 'lava flow', LN: 'plateau tongue',
  MA: 'dark spot', SC: 'scarp', SE: 'sinuous ridge', SU: 'furrows', UN: 'dunes', VS: 'plain',
  // Venus
  CR: 'corona', TE: 'tessera', FR: 'pancake dome', LI: 'line', RE: 'region',
};

export class PlaceNames {
  // load: () => Promise of the list. radiusM: the body's radius, to measure distances.
  constructor(load, radiusM) {
    this._load = load;
    this._radiusM = radiusM;
    this._list = null;
  }

  async _names() {
    if (!this._list) this._list = Promise.resolve(this._load());
    try {
      return await this._list;
    } catch (e) {
      this._list = null;       // a failed load is tried again next time
      throw e;
    }
  }

  // Up to `limit` places whose name holds the query, in the order a person
  // expects: the exact name, then names that start with it, then the rest,
  // the biggest first within each.
  async search(query, limit = 8) {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const rank = (name) => (name === q ? 0 : name.startsWith(q) ? 1 : 2);
    return (await this._names())
      .filter(([name]) => name.toLowerCase().includes(q))
      .map((n) => ({ n, r: rank(n[0].toLowerCase()) }))
      .sort((a, b) => a.r - b.r || b.n[3] - a.n[3])
      .slice(0, limit)
      .map(({ n }) => PlaceNames.place(n));
  }

  // The `limit` largest named places, the biggest first (the search lists them while its field is
  // empty); a name with no size is left out.
  async largest(limit = 10) {
    return (await this._names())
      .filter((n) => n[3] > 0)
      .sort((a, b) => b[3] - a[3])
      .slice(0, limit)
      .map((n) => PlaceNames.place(n));
  }

  // The smallest named feature that holds the point, or null when none does.
  async nameAt(lat, lon) {
    let best = null;
    for (const n of await this._names()) {
      const radiusKm = n[3] / 2;
      if (!(radiusKm > 0) || this.distanceKm(lat, lon, n[1], n[2]) > radiusKm) continue;
      if (!best || n[3] < best[3]) best = n;
    }
    return best ? PlaceNames.place(best) : null;
  }

  // Great-circle distance on the body's sphere.
  distanceKm(lat1, lon1, lat2, lon2) {
    const rad = Math.PI / 180;
    const a = Math.sin((lat2 - lat1) * rad / 2) ** 2 +
      Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin((lon2 - lon1) * rad / 2) ** 2;
    return 2 * this._radiusM * Math.asin(Math.min(1, Math.sqrt(a))) / 1000;
  }

  static place([name, lat, lon, diameterKm, code]) {
    return { name, lat, lon, diameterKm, kind: KINDS[code] ?? '' };
  }
}
