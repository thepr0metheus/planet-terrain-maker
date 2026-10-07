// The places last found by the search on this device, for each world: the search lists them while its
// field is empty, something to pick from before typing. Kept in localStorage
// (stored-choice.js: a storage that refuses reads as nothing kept); at most MOST a world, newest first.

import { StoredChoice } from './stored-choice.js';

export const MOST = 5;

export class RecentPlaces {
  constructor(store = new StoredChoice('ptm.recentPlaces')) {
    this._store = store;
  }

  // The world's places, newest first: [{ name, detail, lat, lon, widthM }].
  list(world) {
    return this._all()[world] ?? [];
  }

  // A place found: first in its world's list, once (the same name at the same point counts once).
  add(world, place) {
    const all = this._all();
    const kept = { name: place.name, detail: place.detail ?? '', lat: place.lat, lon: place.lon, widthM: place.widthM ?? null };
    const same = (p) => p.name === kept.name && Math.abs(p.lat - kept.lat) < 1e-6 && Math.abs(p.lon - kept.lon) < 1e-6;
    all[world] = [kept, ...(all[world] ?? []).filter((p) => !same(p))].slice(0, MOST);
    this._store.set(JSON.stringify(all));
  }

  _all() {
    try {
      const all = JSON.parse(this._store.get('{}'));
      return all && typeof all === 'object' && !Array.isArray(all) ? all : {};
    } catch {
      return {};             // a hand-edited or broken value counts as nothing kept
    }
  }
}
