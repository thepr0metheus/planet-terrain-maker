"""Map tiles through our own server: the page asks /api/tile/<source>/<z>/<x>/<y>, the server fetches
the tile once from its service and keeps it on disk.

Why not straight from the services: the page draws tiles into canvases (a capture stitches them, the
planets' maps stretch their greys), and a canvas may read pixels only from its own site. And a tile
kept on the server's disk is not asked for again: tiles of a place do not change.
"""
from __future__ import annotations

import os
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from .fetch import Fetcher, FetchError

TREK = "https://trek.nasa.gov/tiles/{body}/EQ/{layer}/1.0.0/default/default028mm/{{z}}/{{y}}/{{x}}.{ext}"


@dataclass(frozen=True)
class TileSource:
    """One tiled layer of one world. `grid` says how its tiles cover the world: "mercator" (Web
    Mercator, 2^z x 2^z tiles) or "lonlat" (plain degrees, 2^(z+1) x 2^z tiles, as Trek serves)."""
    id: str
    url: str          # with {z}, {x} and {y}
    ext: str
    max_zoom: int
    grid: str
    credit: str
    at_once: int = 12  # fetches from the service at a time, at most

    @property
    def content_type(self) -> str:
        return {"jpg": "image/jpeg", "png": "image/png"}[self.ext]

    def has(self, z: int, x: int, y: int) -> bool:
        """Whether (z, x, y) names a tile of this layer at all."""
        if not 0 <= z <= self.max_zoom:
            return False
        columns = 2 ** (z + 1) if self.grid == "lonlat" else 2 ** z
        return 0 <= x < columns and 0 <= y < 2 ** z

    def url_of(self, z: int, x: int, y: int) -> str:
        return self.url.format(z=z, x=x, y=y)


def _trek(source_id, body, layer, ext, max_zoom, credit):
    return TileSource(source_id, TREK.format(body=body, layer=layer, ext=ext), ext, max_zoom, "lonlat", credit)


SOURCES = {s.id: s for s in (
    TileSource("earth-photo", "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
               "jpg", 19, "mercator", "Esri World Imagery (Esri, Maxar, Earthstar Geographics)"),
    # EOX's newest cloudless mosaic of Sentinel-2 (10 m): CC BY-NC-SA 4.0, for non-commercial use.
    # EOX resets a burst of a dozen connections at once (Errno 104 in the server's log): six.
    TileSource("earth-s2-2025", "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/{z}/{y}/{x}.jpg",
               "jpg", 15, "mercator", "Sentinel-2 cloudless 2025 by EOX (contains modified Copernicus Sentinel data 2025)", 6),
    # The USA only: NAIP aerial photos of USDA, about 1 m, public domain; tiles up to zoom 16.
    TileSource("earth-usgs", "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}",
               "jpg", 16, "mercator", "USGS The National Map: Orthoimagery (USDA NAIP)"),
    TileSource("earth-labels", "https://services.arcgisonline.com/arcgis/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
               "png", 19, "mercator", "Esri reference layer"),
    TileSource("earth-heights", "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
               "png", 15, "mercator", "AWS Terrain Tiles (Mapzen terrarium)"),
    _trek("moon-wac", "Moon", "LRO_WAC_Mosaic_Global_303ppd_v02", "jpg", 8,
          "NASA/GSFC/Arizona State University (LRO WAC), via NASA Moon Trek"),
    _trek("moon-kaguya", "Moon", "Kaguya_TCortho_Mosaic_Global_4096ppd", "png", 10,
          "JAXA/SELENE (Kaguya TC mosaic), via NASA Moon Trek"),
    _trek("mars-mdim", "Mars", "Mars_Viking_MDIM21_ClrMosaic_global_232m", "jpg", 7,
          "NASA/JPL/USGS (Viking MDIM 2.1), via NASA Mars Trek"),
    _trek("mars-themis", "Mars", "THEMIS_DayIR_ControlledMosaics_100m_v2_oct2018", "png", 9,
          "NASA/JPL/ASU (Mars Odyssey THEMIS day IR, 100 m), via NASA Mars Trek"),
    # The global CTX mosaic of Mars (Caltech Murray Lab, about 5 m), served by Esri: tiles of 512
    # points in plain degrees, its level L as fine as the 256-point zoom L + 1 of the other layers.
    TileSource("mars-ctx", "https://astro.arcgis.com/arcgis/rest/services/OnMars/CTX/MapServer/tile/{z}/{y}/{x}",
               "png", 12, "lonlat", "NASA/JPL/MSSS, Caltech Murray Lab (CTX global mosaic), via Esri"),
    _trek("venus-c3", "Venus", "Venus_Magellan_C3-MDIR_Global_Mosaic_2025m", "png", 5,
          "NASA/JPL/USGS (Magellan C3-MDIR mosaic), via NASA Venus Trek"),
    _trek("venus-sar", "Venus", "Venus_Magellan_LeftLook_mosaic_global_75m", "png", 10,
          "NASA/JPL/USGS (Magellan SAR mosaic, 75 m), via NASA Venus Trek"),
)}


class Tile:
    """A tile as the page gets it."""

    def __init__(self, body: bytes, content_type: str, cached: bool):
        self.body = body
        self.content_type = content_type
        self.cached = cached


class TileMissing(Exception):
    """The service has no such tile (it answered 404, or did so lately)."""


class TileRelay:
    """Fetches tiles and keeps them under `root`, at most about `max_bytes` of them: past that the
    tiles not served for longest go first. A tile the service does not have is remembered for
    MISSING_TTL, so that a map zoomed past its data does not ask again on every move."""

    MISSING_TTL = 24 * 3600
    TRIM_EVERY = 600          # seconds between two looks at the size of the store, at most
    # A busy service (EOX, Esri) now and then answers 5xx, 429 or nothing, and the next request
    # gets the tile: a failed fetch is asked again after these pauses before it counts.
    REPEAT_AFTER = (0.5, 1.5)

    def __init__(self, root: Path, fetcher: Fetcher, max_bytes: int, clock=time.time, sleep=time.sleep):
        self.root = Path(root)
        self.fetcher = fetcher
        self.max_bytes = max_bytes
        self.clock = clock
        self.sleep = sleep
        self._gates = {}                 # source id -> a semaphore of the source's at_once
        self._gates_lock = threading.Lock()
        self._last_trim = 0.0
        self._trim_lock = threading.Lock()
        self.unwritable = None          # why the store cannot be written, once that is known

    def path_of(self, source: TileSource, z: int, x: int, y: int) -> Path:
        return self.root / source.id / str(z) / str(x) / f"{y}.{source.ext}"

    def get(self, source: TileSource, z: int, x: int, y: int) -> Tile:
        """The tile; TileMissing when the service has none; FetchError when it failed otherwise."""
        path = self.path_of(source, z, x, y)
        try:
            body = path.read_bytes()
            os.utime(path)           # served now: the last to go when the store is trimmed
            return Tile(body, source.content_type, True)
        except FileNotFoundError:
            pass
        missing = path.with_suffix(".missing")
        try:
            if self.clock() - missing.stat().st_mtime < self.MISSING_TTL:
                raise TileMissing(f"{source.id} {z}/{x}/{y}")
        except FileNotFoundError:
            pass
        try:
            answer = self._fetch(source, source.url_of(z, x, y))
        except FetchError as e:
            if e.status == 404:
                self._keep(missing, b"")
                raise TileMissing(f"{source.id} {z}/{x}/{y}") from None
            raise
        if not answer.content_type.startswith("image/"):
            raise FetchError(f"{source.id} {z}/{x}/{y}: not a picture ({answer.content_type or 'no type'})")
        if self._keep(path, answer.body):
            self._maybe_trim()
        return Tile(answer.body, answer.content_type.split(";")[0], False)

    def _fetch(self, source: TileSource, url: str):
        with self._gates_lock:
            gate = self._gates.setdefault(source.id, threading.BoundedSemaphore(source.at_once))
        for pause in (*self.REPEAT_AFTER, None):
            try:
                with gate:
                    return self.fetcher.get(url, timeout=30)
            except FetchError as e:
                passing = e.status is None or e.status == 429 or e.status >= 500
                if not passing or pause is None:
                    raise
            self.sleep(pause)

    def _keep(self, path: Path, body: bytes) -> bool:
        """Write a tile to the store. A store that cannot be written (data/ without the right to
        write, a full disk) costs the cache, not the tile: it is said once in the log, and the
        tile is served all the same."""
        try:
            self._write(path, body)
            return True
        except OSError as e:
            if not self.unwritable:
                print(f"tile store: tiles are not kept, {self.root} cannot be written: {e}", flush=True)
            self.unwritable = str(e)
            return False

    @staticmethod
    def _write(path: Path, body: bytes):
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".part-")
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(body)
            os.replace(tmp, path)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise

    def _maybe_trim(self):
        now = self.clock()
        if now - self._last_trim < self.TRIM_EVERY or not self._trim_lock.acquire(blocking=False):
            return
        self._last_trim = now
        threading.Thread(target=self._trim_locked, daemon=True).start()

    def _trim_locked(self):
        try:
            self.trim()
        except OSError as e:
            print(f"tile store: trim failed: {e}", flush=True)
        finally:
            self._trim_lock.release()

    def trim(self) -> int:
        """Removes the tiles served longest ago until the store is under 90% of max_bytes.
        Returns how many files went."""
        files = []
        total = 0
        for path in self.root.rglob("*"):
            try:
                if not path.is_file():
                    continue
                st = path.stat()
            except FileNotFoundError:        # served and replaced, or trimmed, while we walked
                continue
            files.append((st.st_mtime, st.st_size, path))
            total += st.st_size
        if total <= self.max_bytes:
            return 0
        removed = 0
        for _, size, path in sorted(files):
            if total <= self.max_bytes * 0.9:
                break
            path.unlink(missing_ok=True)
            total -= size
            removed += 1
        return removed
