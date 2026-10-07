"""Copernicus DEM heights straight from AWS Open Data: no key, no OpenTopography.

The 30 m model (GLO-30) lies on S3 as one Cloud Optimized GeoTIFF a degree of latitude and longitude:
float32, 1024 x 1024 internal tiles compressed with deflate and the floating-point predictor, and
smaller copies of itself (overviews) inside the same file. A region reads only the internal tiles it
covers, by HTTP range requests, and keeps them on disk. Where the 30 m model is not released (a few
countries), the 90 m one (GLO-90) answers; a degree with no file at all is open sea: 0 m.

Files are pixel-is-point: pixel (0, 0) of N43_00_E042_00 is the point 44° N, 42° E, and the file
covers latitudes above 43 and up to 44, longitudes from 42 up to 43. Away from the equator the
files are narrower east-west (2400 pixels from 50°, 1800 from 60° and so on): each file says so.
"""
from __future__ import annotations

import math
import os
import struct
import tempfile
import threading
import zlib
from pathlib import Path

import numpy as np

from .fetch import Fetcher, FetchError
from .grids import Grid

SOURCES = (
    ("https://copernicus-dem-30m.s3.amazonaws.com", "10", "Copernicus DEM GLO-30 (ESA), AWS Open Data"),
    ("https://copernicus-dem-90m.s3.amazonaws.com", "30", "Copernicus DEM GLO-90 (ESA), AWS Open Data"),
)
HEAD_BYTES = 65536
TYPE_SIZE = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 11: 4, 12: 8, 16: 8}


class CopError(Exception):
    """A file that cannot be read as the Copernicus files are made."""


def file_name(code: str, lat: int, lon: int) -> str:
    ns = f"{'N' if lat >= 0 else 'S'}{abs(lat):02d}"
    ew = f"{'E' if lon >= 0 else 'W'}{abs(lon):03d}"
    return f"Copernicus_DSM_COG_{code}_{ns}_00_{ew}_00_DEM"


def unpredict(raw: bytes, width: int, rows: int) -> np.ndarray:
    """The heights of one internal tile from its inflated bytes: the floating-point predictor (TIFF
    technical note 3) stores each row as byte differences, and the four bytes of each float in four
    runs, most significant first."""
    data = np.frombuffer(raw, dtype=np.uint8)[: rows * width * 4].reshape(rows, width * 4)
    data = np.cumsum(data, axis=1, dtype=np.uint8)
    floats = data.reshape(rows, 4, width).transpose(0, 2, 1).copy().view(">f4").reshape(rows, width)
    return floats.astype(np.float32)


class CogFile:
    """One Copernicus file: its header read once, its internal tiles read when asked."""

    def __init__(self, url: str, fetch_range):
        self.url = url
        self._fetch = fetch_range          # (url, start, length) -> bytes
        self.levels = []                    # [{width, height, tile_w, tile_h, offsets, counts}], full size first
        self.lon0 = self.lat0 = self.step = None
        self._read_header()

    def _read_header(self):
        head = self._fetch(self.url, 0, HEAD_BYTES)
        if head[:4] != b"II*\x00":
            raise CopError("not a little-endian TIFF")

        def need(pos, size):
            nonlocal head
            if pos + size > len(head):
                head += self._fetch(self.url, len(head), max(pos + size - len(head), HEAD_BYTES))
            return head[pos:pos + size]

        offset = struct.unpack("<I", head[4:8])[0]
        while offset:
            count = struct.unpack("<H", need(offset, 2))[0]
            entries = need(offset + 2, 12 * count + 4)
            tags = {}
            for i in range(count):
                tag, kind, n = struct.unpack("<HHI", entries[12 * i:12 * i + 8])
                size = TYPE_SIZE.get(kind, 1) * n
                raw = entries[12 * i + 8:12 * i + 8 + size] if size <= 4 else need(struct.unpack("<I", entries[12 * i + 8:12 * i + 12])[0], size)
                code = {3: "H", 4: "I", 12: "d", 16: "Q"}.get(kind)
                tags[tag] = struct.unpack(f"<{n}{code}", raw) if code else raw
            if tags.get(259, (1,))[0] != 8 or tags.get(339, (1,))[0] != 3 or tags.get(258, (0,))[0] != 32:
                raise CopError("expected float32 with deflate compression")
            self.levels.append({
                "width": tags[256][0], "height": tags[257][0], "tile_w": tags[322][0], "tile_h": tags[323][0],
                "offsets": tags[324], "counts": tags[325], "predictor": tags.get(317, (1,))[0],
            })
            if self.lon0 is None:
                self.step = tags[33550][0], tags[33550][1]          # degrees a pixel: lon, lat
                self.lon0, self.lat0 = tags[33922][3], tags[33922][4]
            offset = struct.unpack("<I", entries[12 * count:12 * count + 4])[0]
        if not self.levels:
            raise CopError("no image in the file")

    def factor(self, level: int) -> float:
        return self.levels[0]["width"] / self.levels[level]["width"]

    def tile(self, level: int, tx: int, ty: int) -> np.ndarray:
        info = self.levels[level]
        across = math.ceil(info["width"] / info["tile_w"])
        k = ty * across + tx
        raw = zlib.decompress(self._fetch(self.url, info["offsets"][k], info["counts"][k]))
        tile = (unpredict(raw, info["tile_w"], info["tile_h"]) if info["predictor"] == 3
                else np.frombuffer(raw, dtype="<f4").reshape(info["tile_h"], info["tile_w"]).astype(np.float32))
        return tile

    def window(self, level: int, x0: int, y0: int, x1: int, y1: int) -> np.ndarray:
        """Pixels x0..x1, y0..y1 (inclusive, clamped to the image) of a level, as one array."""
        info = self.levels[level]
        x0, x1 = max(0, x0), min(info["width"] - 1, x1)
        y0, y1 = max(0, y0), min(info["height"] - 1, y1)
        out = np.empty((y1 - y0 + 1, x1 - x0 + 1), dtype=np.float32)
        tw, th = info["tile_w"], info["tile_h"]
        for ty in range(y0 // th, y1 // th + 1):
            for tx in range(x0 // tw, x1 // tw + 1):
                tile = self.tile(level, tx, ty)
                ax0, ay0 = max(x0, tx * tw), max(y0, ty * th)
                ax1, ay1 = min(x1, tx * tw + tw - 1), min(y1, ty * th + th - 1)
                out[ay0 - y0:ay1 - y0 + 1, ax0 - x0:ax1 - x0 + 1] = tile[ay0 - ty * th:ay1 - ty * th + 1, ax0 - tx * tw:ax1 - tx * tw + 1]
        return out, x0, y0


class CopernicusAws:
    """Heights of a region from the Copernicus files on AWS, as a Grid."""

    def __init__(self, fetcher: Fetcher, cache_dir: Path, log=print):
        self.fetcher = fetcher
        self.cache_dir = Path(cache_dir)
        self.log = log
        self._files = {}                     # (lat, lon) -> (CogFile, name) or None for open sea
        self._lock = threading.Lock()
        self._unwritable = False

    # ---------- bytes, kept on disk ----------

    def _fetch_range(self, url: str, start: int, length: int) -> bytes:
        name = url.rsplit("/", 1)[-1].removesuffix(".tif")
        path = self.cache_dir / name / f"{start}-{length}.bin"
        try:
            return path.read_bytes()
        except FileNotFoundError:
            pass
        body = self.fetcher.get(url, headers={"Range": f"bytes={start}-{start + length - 1}"}, timeout=60).body
        if len(body) > length:          # a server that ignored the range sent the whole file
            body = body[start:start + length]
        if not self._unwritable:
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".part-")
                with os.fdopen(fd, "wb") as f:
                    f.write(body)
                os.replace(tmp, path)
            except OSError as e:
                self._unwritable = True
                self.log(f"copernicus: pieces are not kept, {self.cache_dir} cannot be written: {e}")
        return body

    def _file(self, lat: int, lon: int):
        key = (lat, lon)
        with self._lock:
            if key in self._files:
                return self._files[key]
        found = None
        for base, code, source in SOURCES:
            name = file_name(code, lat, lon)
            try:
                found = (CogFile(f"{base}/{name}/{name}.tif", self._fetch_range), source)
                break
            except FetchError as e:
                if e.status not in (403, 404):
                    raise
        with self._lock:
            self._files[key] = found
        return found

    # ---------- a region ----------

    def grid(self, south: float, north: float, west: float, east: float, max_cells: int) -> Grid:
        if not (-90 <= south < north <= 90 and -180 <= west < east <= 180):
            raise ValueError("the region needs south < north and west < east, in degrees")
        # Degrees of latitude a cell of the grid may cover at most, and the cell the grid gets: the
        # files' 1 arc-second, doubled while the grid would pass max_cells (each file then reads the
        # smallest copy of itself that is still as fine).
        want = max(north - south, (east - west) * math.cos(math.radians((south + north) / 2))) / (max_cells - 1)
        level_step = 1 / 3600
        while level_step * 2 <= want:
            level_step *= 2
        cols = max(2, min(max_cells, round((east - west) * math.cos(math.radians((south + north) / 2)) / level_step) + 1))
        rows = max(2, min(max_cells, round((north - south) / level_step) + 1))
        lats = north - (north - south) * np.arange(rows) / (rows - 1)
        lons = west + (east - west) * np.arange(cols) / (cols - 1)
        out = np.zeros((rows, cols), dtype=np.float32)
        names = set()
        for lat in range(math.floor(south), math.floor(north) + 1):
            for lon in range(math.floor(west), math.floor(min(east, 179.9999999)) + 1):
                rmask = (lats >= lat) & (lats < lat + 1) if lat + 1 <= 90 else (lats >= lat)
                cmask = (lons >= lon) & (lons < lon + 1)
                if not rmask.any() or not cmask.any():
                    continue
                found = self._file(lat, lon)
                if found is None:
                    continue                  # open sea: 0 m, as the array starts
                cog, source = found
                names.add(source)
                # the smallest copy whose pixels are still as fine as the grid's cells
                lv = 0
                while lv + 1 < len(cog.levels) and cog.step[1] * cog.factor(lv + 1) <= want:
                    lv += 1
                f = cog.factor(lv)
                # pixel-is-point: the full image's pixel i is at lon0 + i * step; a level's pixel
                # covers f of them, centred between their centres
                fx = ((lons[cmask] - cog.lon0) / cog.step[0] + 0.5) / f - 0.5
                fy = ((cog.lat0 - lats[rmask]) / cog.step[1] + 0.5) / f - 0.5
                x0, x1 = int(np.floor(fx.min())), int(np.floor(fx.max())) + 1
                y0, y1 = int(np.floor(fy.min())), int(np.floor(fy.max())) + 1
                win, wx0, wy0 = cog.window(lv, x0, y0, x1, y1)
                gx = np.clip(fx - wx0, 0, win.shape[1] - 1)
                gy = np.clip(fy - wy0, 0, win.shape[0] - 1)
                ix0 = np.floor(gx).astype(int)
                iy0 = np.floor(gy).astype(int)
                ix1 = np.minimum(ix0 + 1, win.shape[1] - 1)
                iy1 = np.minimum(iy0 + 1, win.shape[0] - 1)
                tx = (gx - ix0)[None, :]
                ty = (gy - iy0)[:, None]
                a = win[np.ix_(iy0, ix0)]
                b = win[np.ix_(iy0, ix1)]
                c = win[np.ix_(iy1, ix0)]
                d = win[np.ix_(iy1, ix1)]
                block = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty
                out[np.ix_(np.nonzero(rmask)[0], np.nonzero(cmask)[0])] = block
        source = " + ".join(sorted(names)) or "Copernicus DEM (ESA), AWS Open Data: open sea"
        return Grid(cols, rows, out.ravel().tolist(), (south, north, west, east), source)
