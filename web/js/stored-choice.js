// A choice the page remembers for this viewer between visits, in localStorage.
//
// Storage may be missing or refuse: a private window, site data blocked, a full
// quota. Even reading window.localStorage throws then, so the storage is looked
// up inside the guard on every use. A refusing storage reads as "nothing saved"
// and drops writes: the page then behaves as on a first visit instead of
// stopping at the first line that touches storage.
export class StoredChoice {
  // allowed: the values this choice may take; anything else read back (an old
  // option, a hand-edited value) counts as nothing saved.
  constructor(key, { allowed = null, storage = () => globalThis.localStorage } = {}) {
    this.key = key;
    this.allowed = allowed;
    this._storage = storage;
  }

  get(fallback = null) {
    let value;
    try { value = this._storage().getItem(this.key); } catch { return fallback; }
    if (value === null || value === undefined) return fallback;
    if (this.allowed && !this.allowed.includes(value)) return fallback;
    return value;
  }

  set(value) {
    try { this._storage().setItem(this.key, String(value)); } catch {}
  }
}
