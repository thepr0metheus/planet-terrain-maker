// The map screen: pick a world, find a place, frame it with the circle or a drawn contour, and
// capture it. In the two-places guide the same screen frames the first place (circle or contour),
// draws the line that divides it, and finds the other place in that shape, with the guide's own
// buttons instead of Capture.

import { CraftSearch } from './craft-search.js';
import { MapView, formatDistance } from './map-view.js';
import { ContourTool } from './contour-tool.js';
import { SearchBox } from './search-box.js';
import { CaptureError, PlaceCapture, frameFor, pictureMetres, pictureSourceFor } from './capture.js';
import { CircleOutline, PolygonOutline } from './outline.js';
import { BAND, TerrainEdge } from './terrain-edge.js';
import { LocalFrame } from './geo.js';
import { PlaceNames } from './place-names.js';
import { WORLDS, WORLD_ORDER, mPerDegOf, pictureOptions, worldOf } from './worlds.js';
import { StoredChoice } from './stored-choice.js';
import { DEVICE } from './device.js';
import { language, number, t } from './i18n.js';
import { reportError } from './client-errors.js';

const $ = (id) => document.getElementById(id);
const WIDE_KM = 150;            // past this a capture is slow and coarse; the circle says so in yellow

export class MapScreen {
  // say(text, kind): a message at the bottom. onCaptured(place): a place was captured (outside the guide).
  constructor({ say, onCaptured, keyNeeded }) {
    this._say = say;
    this._onCaptured = onCaptured;
    this._keyNeeded = keyNeeded;
    this._shape = 'circle';
    this._guide = null;             // the two-places guide's step on the map: 'place', 'other'; null: no guide
    this._starts = {};              // world -> { lat, lon, zoom } where its map opens (the server keeps them)
    this.onWorldPicked = null;      // (id) -> true when the guide takes the choice of a world
    this.onKind = () => {};         // ('one' | 'two'): the kind of model asked for
    this._abort = null;
    // The heights and the picture each world's captures take, kept per world (Earth's under the keys
    // it had when only Earth had a choice).
    this._choices = Object.fromEntries(WORLD_ORDER.map((id) => {
      const key = (what) => (id === 'earth' ? `ptm.${what}` : `ptm.${what}.${id}`);
      return [id, {
        heights: new StoredChoice(key('heights'), { allowed: WORLDS[id].heights.map((s) => s.id) }),
        picture: new StoredChoice(key('picture'), { allowed: this._pictureOptions(WORLDS[id]).map((s) => s.id) }),
      }];
    }));
    this._pxChoice = new StoredChoice('ptm.pictureDetail', { allowed: ['auto', '2048', '4096', '8192'] });
    this._cornersChoice = new StoredChoice('ptm.corners', { allowed: ['smooth', 'sharp'] });
    this._followChoice = new StoredChoice('ptm.follow', { allowed: ['ridge', 'valley'] });
    this._terrain = null;           // the edge found in the relief: { world, center, radiusM, follow, points, strength, reason }
    this._terrainAbort = null;
    this._terrainTimer = null;
    this._fitPictureDetail();
    this._capture = new PlaceCapture({ onProgress: (text, share) => this._progress(text, share) });
    this._names = Object.fromEntries(WORLD_ORDER.filter((id) => WORLDS[id].names !== 'nominatim').map((id) =>
      [id, new PlaceNames(() => fetch(WORLDS[id].names).then((r) => r.json()), WORLDS[id].radiusM)]));

    this.view = new MapView({
      element: $('map'), frame: $('frame-circle'), sizeLabel: $('frame-size'), shape: $('frame-shape'),
      panels: () => [$('map-panel')],
      onMove: () => this._moved(),
    });
    this.contour = new ContourTool({ onChange: (state) => this._contourChanged(state), smooth: this._cornersChoice.get('smooth') === 'smooth' });
    this.crafts = new CraftSearch({ input: $('landers-search'), results: $('landers-results'), onPick: (craft) => this._toCraft(craft) });
    this.search = new SearchBox({
      input: $('search'), results: $('search-results'), world: () => this.view.world?.id ?? 'earth',
      onPick: (place) => this.view.showPlace(place.lat, place.lon, place.widthM ? place.widthM * 1.25 : null),
    });

    for (const button of $('worlds').querySelectorAll('[data-world]')) {
      button.addEventListener('click', () => {
        if (!this.onWorldPicked?.(button.dataset.world)) this.showWorld(button.dataset.world);
      });
    }
    for (const button of $('model-kind').querySelectorAll('[data-kind]')) {
      button.addEventListener('click', () => this.onKind(button.dataset.kind));
    }
    $('start-go').addEventListener('click', () => {
      const start = this._starts[this.world] ?? worldOf(this.world).start;
      this.view.showPlace(start.lat, start.lon, null, start.zoom);
    });
    $('start-set').addEventListener('click', () => this._setStart());
    $('start-reset').addEventListener('click', () => this._resetStart());
    for (const button of $('shapes').querySelectorAll('[data-shape]')) {
      button.addEventListener('click', () => this.setShape(button.dataset.shape));
    }
    for (const button of $('contour-corners').querySelectorAll('[data-corners]')) {
      button.addEventListener('click', () => {
        this._cornersChoice.set(button.dataset.corners);
        this.contour.setSmooth(button.dataset.corners === 'smooth');
      });
    }
    for (const button of $('terrain-follow').querySelectorAll('[data-follow]')) {
      button.addEventListener('click', () => {
        this._followChoice.set(button.dataset.follow);
        this._traceSoon(0);
      });
    }
    $('contour-undo').addEventListener('click', () => this.contour.undo());
    $('contour-clear').addEventListener('click', () => this.contour.clear());
    $('capture-btn').addEventListener('click', () => this.captureHere());
    $('map-busy-stop').addEventListener('click', () => this._abort?.abort());
    $('heights-source').addEventListener('change', () => {
      this._choices[this.world].heights.set($('heights-source').value);
      this._sources(this.view.world);
    });
    $('picture-source').addEventListener('change', () => {
      this._choices[this.world].picture.set($('picture-source').value);
      this._sources(this.view.world);
    });
    $('picture-px').addEventListener('change', () => {
      this._pxChoice.set($('picture-px').value);
      this._pictureHint();
    });
    document.addEventListener('keydown', (e) => this._key(e));
  }

  // ---------- opening ----------

  // A world's map. view: { lat, lon, zoom } to open at, or the world's start (the one set for it, else
  // the page's own).
  showWorld(id, view = null) {
    const world = worldOf(id);
    const changed = this.view.world?.id !== id;
    this.contour.detach();
    // Earth always uses Sentinel-2 for selection; the model's source is chosen in later steps.
    this.view.showWorld(id, view ?? this._starts[id] ?? null, id === 'earth' ? world.pictures.find((p) => p.id === 's2').map : null);
    if (changed) this.search.reset();
    if (this._shape === 'contour' && this._shapesOn) this.contour.attach(this.view.map);
    this._terrain = null;
    this.view.showEdge(null);
    for (const button of $('worlds').querySelectorAll('[data-world]')) {
      button.setAttribute('aria-pressed', String(button.dataset.world === id));
    }
    $('search').placeholder = id === 'earth' ? t('Find a place') : t('Find on {world}: a crater, a mountain…', { world: t(world.inSentence) });
    this._sources(world);
    this._landers(world);
    $('start-reset').hidden = !this._starts[id];
    this._moved();
  }

  // The craft on the surface of the world on the map (worlds.js landers), found by name or year in
  // their own search (craft-search.js): a pick takes the map there and marks the point. Earth has
  // none.
  _landers(world) {
    this._landersOn = world.landers ?? null;
    this.view.showMark(null);
    $('landers-field').hidden = !this._landersOn;
    this.crafts.setList(this._landersOn?.list ?? []);
  }

  _toCraft(craft) {
    this.view.showPlace(craft.lat, craft.lon, this._landersOn.viewKm * 1000);
    this.view.showMark({ lat: craft.lat, lon: craft.lon, name: t(craft.label) });
  }

  // Where each world's map opens, as the server keeps them.
  async loadStarts() {
    try {
      this._starts = (await (await fetch('/api/settings')).json()).starts ?? {};
    } catch {
      this._starts = {};
    }
    if (this.view.world) $('start-reset').hidden = !this._starts[this.world];
  }

  async _setStart() {
    const where = this.view.where();
    const response = await fetch(`/api/settings/start/${this.world}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(where),
    });
    if (!response.ok) {
      this._say(t('The start was not kept: {why}', { why: t((await response.json().catch(() => ({}))).error ?? String(response.status)) }), 'error');
      return;
    }
    this._starts[this.world] = await response.json();
    $('start-reset').hidden = false;
    this._say(t('The map of {world} opens here now, on every device.', { world: t(worldOf(this.world).inSentence) }));
  }

  async _resetStart() {
    const response = await fetch(`/api/settings/start/${this.world}`, { method: 'DELETE' });
    if (!response.ok) return;
    delete this._starts[this.world];
    $('start-reset').hidden = true;
    this._say(t('The map of {world} opens at its usual place again.', { world: t(worldOf(this.world).inSentence) }));
  }

  // Which kind of model the panel shows as chosen: one place, or two side by side.
  setKind(kind) {
    for (const button of $('model-kind').querySelectorAll('[data-kind]')) {
      button.setAttribute('aria-pressed', String(button.dataset.kind === kind));
    }
  }

  // Whether the place is framed by a shape of the user's now (the circle or a contour): outside the
  // guide, and on the guide's first place. Later the first place's shape stands on the map instead.
  get _shapesOn() { return this._guide === null || this._guide === 'place'; }

  // The circle or a contour.
  setShape(shape) {
    this._shape = shape;
    const on = this._shapesOn;
    $('shapes').hidden = !on;
    for (const button of $('shapes').querySelectorAll('[data-shape]')) {
      button.setAttribute('aria-pressed', String(button.dataset.shape === this._shape));
    }
    $('circle-help').hidden = !on || this._shape !== 'circle';
    $('contour-help').hidden = !on || this._shape !== 'contour';
    $('terrain-help').hidden = !on || this._shape !== 'terrain';
    // the edge in the relief is looked for about the circle: the circle stays on show
    this.view.setShape(on ? (this._shape === 'terrain' ? 'circle' : this._shape) : 'none');
    if (on && this._shape === 'contour' && this.view.map) this.contour.attach(this.view.map);
    else this.contour.detach();
    if (on && this._shape === 'terrain') {
      this._drawEdge();
      this._traceSoon(0);
    } else {
      this.view.showEdge(null);
    }
    this._moved();
  }

  // The two-places guide's step on the map: 'place' (the first place framed as any place is),
  // 'other' (another place found in the first one's shape, which the guide's bar turns), or null
  // (no guide: our own Capture button). The line itself is drawn on the first place's model
  // (compare-flow.js); the shape on the map is the guide's to set (view.setOverlay).
  guide(step) {
    this._guide = step;
    $('capture-row').hidden = true; // Both kinds use the guide's source-selection and capture steps.
    if (step === null || step === 'place') {
      this.view.setOverlay(null);
      this.view.holdWidth(null);
    }
    this.setShape(this._shape);
  }

  get guideStep() { return this._guide; }

  setSources({ world, pictureId, heightsId }) {
    if (pictureId) this._choices[world].picture.set(pictureId);
    if (heightsId) this._choices[world].heights.set(heightsId);
    this._sources(worldOf(world));
  }

  lockSelection(on) {
    this.view.lock(on);
    $('map-screen').toggleAttribute('data-selection-locked', on);
    if (on && !this._disabledControls) {
      this._disabledControls = [...$('map-panel').querySelectorAll('button, input, select')].map((el) => [el, el.disabled]);
      for (const [el] of this._disabledControls) el.disabled = true;
      this.contour.detach();
    } else if (!on && this._disabledControls) {
      for (const [el, disabled] of this._disabledControls) el.disabled = disabled;
      this._disabledControls = null;
      if (this._shape === 'contour' && this._shapesOn) this.contour.attach(this.view.map);
    }
  }

  // ---------- the frame ----------

  get world() { return this.view.world?.id ?? 'earth'; }

  // What a capture of the circle now would take: the world, the centre, the outline, the map view.
  framed() {
    const f = this.view.frameNow();
    if (!f) throw new Error('The map is hidden, so it has no circle. Open the map and try again.');
    return { world: this.world, center: { lat: f.lat, lon: f.lon }, outline: new CircleOutline(f.radiusM), where: this.view.where() };
  }

  // What is framed now by the shape on show, the circle, the contour or the edge in the relief, as
  // framed() gives it; null when the shape is not ready (the page has said why).
  framedShape() {
    if (this._shape === 'terrain') return this._framedEdge();
    if (this._shape !== 'contour') return this.framed();
    if (!this.contour.closed) {
      this._say(t('Close the contour first: click its first corner.'));
      return null;
    }
    try {
      return { world: this.world, ...this._contourOutline(this.contour.shapePoints), where: this.view.where() };
    } catch {
      this._say(t('The contour crosses itself: move a corner.'), 'error');
      return null;
    }
  }

  // ---------- the edge that follows the relief ----------

  // Look for the edge again `ms` after the map stops: the heights about the circle, then the edge.
  _traceSoon(ms = 700) {
    clearTimeout(this._terrainTimer);
    if (this._shape !== 'terrain' || !this._shapesOn) return;
    this._terrainTimer = setTimeout(() => this._trace(), ms);
  }

  async _trace() {
    const f = this.view.map && this.view.frameNow();
    if (!f || this._shape !== 'terrain' || !this._shapesOn) return;
    const follow = this._followChoice.get('ridge');
    for (const button of $('terrain-follow').querySelectorAll('[data-follow]')) {
      button.setAttribute('aria-pressed', String(button.dataset.follow === follow));
    }
    const asked = { world: this.world, center: { lat: f.lat, lon: f.lon }, radiusM: f.radiusM, follow };
    if (this._sameEdge(this._terrain, asked)) return;
    this._terrainAbort?.abort();
    const abort = this._terrainAbort = new AbortController();
    $('terrain-state').textContent = t('Finding the edge…');
    try {
      const { heights, frame } = await this._capture.heightsAround({
        world: asked.world, center: asked.center, reachM: asked.radiusM * (1 + BAND),
        heightsId: this._heights(asked.world).id, signal: abort.signal,
      });
      if (abort.signal.aborted) return;
      this._terrain = { ...asked, ...new TerrainEdge({ heights, frame, radiusM: asked.radiusM, follow }).trace() };
    } catch (e) {
      if (e?.name === 'AbortError' || abort.signal.aborted) return;
      this._terrain = { ...asked, points: null, reason: 'no-heights', why: t(e.message ?? String(e)) };
    }
    this._drawEdge();
  }

  // Whether an edge found is the one for what is asked: the same world, ridges or valleys, and the
  // same circle to a hundredth of its radius.
  _sameEdge(edge, asked) {
    if (!edge || edge.world !== asked.world || edge.follow !== asked.follow) return false;
    if (Math.abs(edge.radiusM - asked.radiusM) > asked.radiusM * 0.01) return false;
    const { x, y } = new LocalFrame(edge.center.lat, edge.center.lon, mPerDegOf(worldOf(edge.world))).toXY(asked.center.lat, asked.center.lon);
    return Math.hypot(x, y) <= asked.radiusM * 0.01;
  }

  _drawEdge() {
    const edge = this._terrain;
    const on = this._shape === 'terrain' && this._shapesOn;
    if (!on || !edge?.points) {
      this.view.showEdge(null);
    } else {
      const frame = new LocalFrame(edge.center.lat, edge.center.lon, mPerDegOf(worldOf(edge.world)));
      this.view.showEdge(edge.points.map(([x, y]) => frame.toLatLon(x, y)));
    }
    $('terrain-state').textContent = edge ? this._edgeSaid(edge) : '';
    this._pictureHint();
  }

  _edgeSaid(edge) {
    const pct = Math.round(edge.strength * 100);
    if (edge.points) {
      return edge.follow === 'ridge' ? t('The edge follows ridges along {pct}% of the circle.', { pct })
        : t('The edge follows valleys along {pct}% of the circle.', { pct });
    }
    if (edge.reason === 'flat') {
      return edge.follow === 'ridge' ? t('No ridge runs round the circle here. Try Valleys, or another size.')
        : t('No valley runs round the circle here. Try Ridges, or another size.');
    }
    if (edge.reason === 'no-heights') return t('The heights did not come: {why}', { why: edge.why });
    return t('The edge was not found: zoom in a little.');
  }

  _framedEdge() {
    const f = this.view.frameNow();
    if (!f) return this.framed();          // says the map is hidden
    const asked = { world: this.world, center: { lat: f.lat, lon: f.lon }, radiusM: f.radiusM, follow: this._followChoice.get('ridge') };
    const edge = this._terrain;
    if (!this._sameEdge(edge, asked)) {
      this._say(t('The edge is being found: wait a moment, then try again.'));
      this._traceSoon(0);
      return null;
    }
    if (!edge.points) {
      this._say(this._edgeSaid(edge), 'error');
      return null;
    }
    return { world: edge.world, center: edge.center, outline: new PolygonOutline(edge.points), where: this.view.where() };
  }

  _moved() {
    const f = this.view.map && this.view.frameNow();
    if (!f) return;
    $('frame-circle').classList.toggle('wide', 2 * f.radiusM / 1000 > WIDE_KM);
    this._traceSoon();
    this._pictureHint();
  }

  // ---------- the picture's detail ----------

  // The picture detail this device can hold: 8192 points needs a big graphics card and a browser that
  // holds such a canvas (a computer); an iPad and an iPhone get 4096 at most (device.js). The choice
  // kept, or 4096 (2048 on a touch screen) to start with.
  _fitPictureDetail() {
    let texture = 4096;
    try {
      const gl = document.createElement('canvas').getContext('webgl2');
      texture = gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : 4096;
    } catch {
      // no WebGL 2: the smaller pictures only
    }
    const most = Math.min(8192, texture, DEVICE.canvasMostPx);
    this._pictureMost = most;
    for (const option of $('picture-px').options) option.hidden = option.disabled = Number(option.value) > most;
    const kept = this._pxChoice.get('auto');
    $('picture-px').value = kept === 'auto' || Number(kept) <= most ? kept : 'auto';
  }

  get picturePx() {
    return $('picture-px').value === 'auto' ? 'auto' : Number($('picture-px').value) || 2048;
  }

  // The picture chosen for a world: one of pictureOptions(world), the first by default.
  _pictureOptions(world) {
    return [...pictureOptions(world), ...(world.id === 'earth' ? [{ id: 'custom', label: 'Custom picture source' }] : [])];
  }

  _picture(id) {
    const world = worldOf(id);
    const options = this._pictureOptions(world);
    return options.find((p) => p.id === this._choices[id].picture.get()) ?? options.find((p) => p.id === 's2') ?? options[0];
  }

  // The heights chosen for a world, the first by default.
  _heights(id) {
    const list = worldOf(id).heights;
    return list.find((s) => s.id === this._choices[id].heights.get()) ?? list[0];
  }

  // "Picture: about 6 m a point": what the capture will give for the frame on show.
  _pictureHint() {
    const f = this.view.map && this.view.frameNow();
    if (!f) return;
    const world = this.view.world;
    let outline = new CircleOutline(f.radiusM);
    const shape = this.view.overlay;
    if (shape) {
      outline = new CircleOutline(shape.outline.reachM);       // two places are captured turnable
    } else if (this._shape === 'contour' && this.contour.points.length >= 3) {
      outline = this._contourOutline(this.contour.shapePoints, false)?.outline ?? outline;
    } else if (this._shape === 'terrain') {
      outline = new CircleOutline(f.radiusM * (1 + BAND));     // the edge may reach this far
    }
    const frame = frameFor(outline);
    const side = Math.max(frame.widthM, frame.heightM);
    const chosen = this._picture(world.id);
    if (this.picturePx === 'auto') {
      $('picture-res').textContent = t('Picture detail is chosen automatically from the source and this device.');
      return;
    }
    if (chosen.id === 'custom') {
      $('picture-res').textContent = t('The custom picture uses the coordinates of this place.');
      return;
    }
    const source = pictureSourceFor(world, chosen.id, side);
    const metres = pictureMetres(world, source, f.lat, side, this.picturePx);
    const n = number(metres, metres < 10 ? 1 : 0);
    $('picture-res').textContent = t('Picture: about {m} a point. Source: {source}.', { m: t('{n} m', { n }), source: t(source.label) });
  }

  _contourChanged({ points, closed }) {
    for (const button of $('contour-corners').querySelectorAll('[data-corners]')) {
      button.setAttribute('aria-pressed', String((button.dataset.corners === 'smooth') === this.contour.smooth));
    }
    this._pictureHint();
    const note = $('contour-size');
    if (!points.length) {
      note.textContent = '';
      return;
    }
    const outline = this._contourOutline(this.contour.shapePoints, false);
    if (!outline) {
      note.textContent = t('{n} corners', { n: points.length });
      return;
    }
    const b = outline.outline.bounds;
    note.textContent = closed
      ? t('Closed: {w} × {h}', { w: formatDistance(b.maxX - b.minX), h: formatDistance(b.maxY - b.minY) })
      : t('{n} corners; close the contour to capture it', { n: points.length });
  }

  // A drawn contour as { center, outline } in metres about the middle of its box; null when it has
  // fewer than 3 corners or (strict) crosses itself.
  _contourOutline(points, strict = true) {
    if (points.length < 3) return null;
    const lats = points.map((p) => p.lat), lons = points.map((p) => p.lon);
    const center = { lat: (Math.min(...lats) + Math.max(...lats)) / 2, lon: (Math.min(...lons) + Math.max(...lons)) / 2 };
    const frame = new LocalFrame(center.lat, center.lon, mPerDegOf(this.view.world));
    try {
      return { center, outline: new PolygonOutline(points.map((p) => {
        const { x, y } = frame.toXY(p.lat, p.lon);
        return [x, y];
      })) };
    } catch (e) {
      if (strict) throw e;
      return null;
    }
  }

  // ---------- capturing ----------

  // Capture what is framed now (outside the guide) and hand the place on.
  async captureHere() {
    const request = this.framedShape();
    if (!request) return;
    const place = await this.capture(request);
    if (place) this._onCaptured(place);
  }

  // Capture a place: { world, center, outline, turnable }. The place, or null when it failed (said
  // why) or was stopped.
  async capture({ world, center, outline, turnable = false, heightsId = this._heights(world).id,
    pictureId = this._picture(world).id, pictureSource = null }, what = null) {
    this._abort = new AbortController();
    this._busy(true, what ?? t('Capturing the place…'));
    try {
      const place = await this._capture.capture({
        world, center, outline, turnable, signal: this._abort.signal, picturePx: this.picturePx, pictureMostPx: this._pictureMost,
        // the choices of the place's own world: in the two-places guide the first place is
        // captured while the map shows the second one's
        heightsId, pictureId, pictureSource,
      });
      this._progress(t('Naming the place…'));
      place.name = await this.nameOf(world, center);
      return place;
    } catch (e) {
      if (e?.name === 'AbortError') return null;
      if (e instanceof CaptureError && e.keyNeeded) this._keyNeeded(e.message);
      else this._say(e instanceof CaptureError ? t(e.message) : t('The capture failed: {why}', { why: t(e.message ?? String(e)) }), 'error');
      if (!(e instanceof CaptureError)) reportError(e, 'capture');
      return null;
    } finally {
      this._busy(false);
      this._abort = null;
    }
  }

  // A name for the place at a point: the town on Earth, the named feature elsewhere, else the numbers.
  async nameOf(world, { lat, lon }) {
    try {
      if (world === 'earth') {
        const response = await fetch(`/api/place?${new URLSearchParams({ lat, lon, lang: language() })}`);
        const found = response.ok ? await response.json() : null;
        if (found?.name) return found.name;
      } else {
        const found = await this._names[world].nameAt(lat, lon);
        if (found) return found.name;
      }
    } catch {
      // the numbers below will do
    }
    return `${lat.toFixed(3)}°, ${lon.toFixed(3)}°`;
  }

  // ---------- inside ----------

  _sources(world) {
    const fill = (select, list, chosen) => {
      select.replaceChildren(...list.map((s) => Dom.el('option', { value: s.id, title: t(s.hint ?? s.label) }, t(s.label))));
      if (list.some((s) => s.id === chosen)) select.value = chosen;
      select.title = t(list.find((s) => s.id === select.value)?.hint ?? '');
    };
    fill($('heights-source'), world.heights, this._heights(world.id).id);
    fill($('picture-source'), this._pictureOptions(world), this._picture(world.id).id);
    this._pictureHint();
  }

  _busy(on, text = '') {
    $('map-busy').hidden = !on;
    $('map-busy-text').textContent = text;
    $('map-busy-bar').value = 0;
    $('map-busy-bar').hidden = true;
  }

  _progress(text, share = null) {
    if (text) {
      const words = { Heights: t('Heights…'), Picture: t('The picture…') };
      $('map-busy-text').textContent = words[text] ?? text;
    }
    if (share !== null) {
      $('map-busy-bar').hidden = false;
      $('map-busy-bar').value = share;
    }
  }

  // The keys of the contour's corners: undo is Cmd+Z (Ctrl+Z) or Backspace, redo Shift with it (or
  // Ctrl+Y), Esc clears, Enter closes the contour. The keys are read by their place on the keyboard,
  // so Cmd+Z works with the Russian layout too.
  _key(e) {
    if ($('map-screen').hidden || this._disabledControls || e.target.closest('input, select, textarea')) return;
    const tool = this._shape === 'contour' && this._shapesOn ? this.contour : null;
    if (!tool) return;
    const command = (e.metaKey || e.ctrlKey) && !e.altKey;
    const undo = (command && e.code === 'KeyZ' && !e.shiftKey) || (e.key === 'Backspace' && !command);
    const redo = command && ((e.code === 'KeyZ' && e.shiftKey) || e.code === 'KeyY');
    if (undo) { e.preventDefault(); tool.undo(); }
    else if (redo) { e.preventDefault(); tool.redo(); }
    else if (e.key === 'Escape') { tool.clear(); }
    else if (e.key === 'Enter' && tool === this.contour) { e.preventDefault(); tool.close(); }
  }
}
