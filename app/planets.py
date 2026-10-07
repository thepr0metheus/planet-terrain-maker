"""Heights and imagery of a region on the Moon, Mars or Venus, from NASA's Trek services.

Trek's ArcGIS image servers answer one request per region (exportImage): the heights as raw numbers,
the imagery as a JPEG of exactly the region. No key and no special header are needed. Checked on
2026-10-05 against known heights: Tranquility Base (Apollo 11) reads -1927.5 m on the Moon, the
Olympus Mons summit point about 20 km on Mars, Maxwell Montes 10.7 km and Maat Mons 9.0 km on Venus.

Venus has no one-picture imagery service on Trek: its Magellan radar mosaics come only as map tiles,
which the page stitches for a capture. The Moon's finest imagery (Kaguya) is stitched from tiles too.

All bodies are laid out in plain longitude and latitude (-180..180 east, the order Trek wants: a box
given in 0..360 comes back all empty, with no error).
"""
from __future__ import annotations

import http.client
import math
import struct
import threading
import urllib.parse

from .fetch import USER_AGENT, Fetcher, FetchError
from .grids import Grid

TREK = "https://trek.nasa.gov/{body}/trekarcgis/rest/services/{service}/ImageServer/exportImage"
NODATA = -32768
# Cells a side at least. A 3 km crater is 30 cells of LOLA and 55 of SLDEM: as a mesh that is a few
# facets. Interpolated up to this, the bowl comes out smooth.
SMALLEST_GRID = 96


class RegionError(ValueError):
    """The region asked for cannot be fetched as given."""


class NoHeights(Exception):
    """The service answered, but with no heights in the region."""


def check_region(south, north, west, east):
    """Refuse a region Trek would answer wrongly or not at all."""
    values = (south, north, west, east)
    if any(v is None or not math.isfinite(v) for v in values):
        raise RegionError("The region needs four numbers.")
    if not (-90 <= south < north <= 90):
        raise RegionError("South must lie below north, both within -90..90.")
    if not (-180 <= west < east <= 180):
        raise RegionError("West must lie west of east, both within -180..180; "
                          "a region across the 180th meridian is not supported.")


class SldemSource:
    """The Moon's finer heights: SLDEM2015 (LOLA laser heights merged with Kaguya stereo, 59 m a
    cell, 60 S to 60 N), half the cell size of Trek's LOLA. Trek has no server for it, but the USGS
    GeoTIFF on S3 is uncompressed int16, one strip per row: a region is one small range request per
    row of it. Fine for the small regions it is meant for (a 3 km crater is 55 rows); a big region
    takes Trek's LOLA instead, see MAX_ROWS.

    Heights are metres from the same 1737.4 km sphere as LOLA (int16 x 0.5). `connect` makes one
    HTTPS connection; each worker thread keeps its own."""

    HOST = "asc-pds-services.s3.us-west-2.amazonaws.com"
    PATH = "/mosaic/LolaKaguya_Topo/Lunar_LRO_LOLAKaguya_DEMmerge_60N60S_512ppd.tif"
    FIRST_ROW = 984003            # byte offset of row 0 (strips are contiguous)
    WIDTH = 184320                # pixels a row
    PX = 59.2252938               # metres a pixel, on the 1737.4 km sphere
    X0, Y0 = -5458203.076347, 1819401.025449   # top-left corner of pixel (0, 0), metres
    SCALE = 0.5
    RADIUS = 1737400.0
    MAX_LAT = 59.9
    MAX_ROWS = 420                # about 25 km of latitude; more is many requests
    THREADS = 16
    name = "SLDEM2015 59 m (NASA/GSFC, JAXA)"

    def __init__(self, connect=None):
        self._connect = connect or (lambda: http.client.HTTPSConnection(self.HOST, timeout=60))

    def deg_per_px(self):
        return math.degrees(self.PX / self.RADIUS)

    def _col(self, lon):
        """Fractional column whose pixel centre lies at this longitude."""
        return (self.RADIUS * math.radians(lon) - self.X0) / self.PX - 0.5

    def _row(self, lat):
        return (self.Y0 - self.RADIUS * math.radians(lat)) / self.PX - 0.5

    def covers(self, south, north, west, east):
        """Whether the file holds the region and it is small enough to read row by row."""
        if not (-self.MAX_LAT <= south and north <= self.MAX_LAT):
            return False
        return self._row(south) - self._row(north) <= self.MAX_ROWS

    def grid(self, south, north, west, east, max_cells) -> Grid:
        """Heights sampled from the north-west corner to the south-east one, at about the file's own
        spacing, NaN where it has none."""
        cols = max(SMALLEST_GRID, min(max_cells, round((east - west) / self.deg_per_px()) + 1))
        rows = max(SMALLEST_GRID, min(max_cells, round((north - south) / self.deg_per_px()) + 1))
        c_lo = math.floor(self._col(west))
        c_hi = math.ceil(self._col(east))
        r_lo = math.floor(self._row(north))
        r_hi = math.ceil(self._row(south))
        block = self._read(r_lo, r_hi, c_lo, c_hi)
        width = c_hi - c_lo + 1
        values = []
        for j in range(rows):
            fr = self._row(north - (north - south) * j / (rows - 1)) - r_lo
            for i in range(cols):
                fc = self._col(west + (east - west) * i / (cols - 1)) - c_lo
                values.append(_bilinear(block, width, fc, fr))
        return Grid(cols, rows, values, (south, north, west, east), self.name)

    def _read(self, r_lo, r_hi, c_lo, c_hi):
        """Rows r_lo..r_hi, columns c_lo..c_hi of the file, as one list of floats (None = no data),
        read by THREADS workers with a connection each."""
        width = c_hi - c_lo + 1
        rows = list(range(r_lo, r_hi + 1))
        out, errors = {}, []

        def work(part):
            conn = self._connect()
            try:
                for r in part:
                    start = self.FIRST_ROW + (r * self.WIDTH + c_lo) * 2
                    conn.request("GET", self.PATH, headers={
                        "Range": f"bytes={start}-{start + width * 2 - 1}", "User-Agent": USER_AGENT})
                    resp = conn.getresponse()
                    body = resp.read()
                    if resp.status != 206 or len(body) != width * 2:
                        raise ValueError(f"row {r}: HTTP {resp.status}, {len(body)} bytes")
                    out[r] = [None if v == NODATA else v * self.SCALE for v in struct.unpack(f"<{width}h", body)]
            except Exception as e:      # reported below: one failed row fails the region
                errors.append(e)
            finally:
                conn.close()

        threads = [threading.Thread(target=work, args=(rows[i::self.THREADS],))
                   for i in range(min(self.THREADS, len(rows)))]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        if errors:
            raise errors[0]
        return [v for r in rows for v in out[r]]


def _bilinear(block, width, fc, fr):
    """A value between the four cells around (fc, fr) of a row-major block; the cells without data
    are left out, None when all four are without."""
    nrows = len(block) // width
    fc = min(max(fc, 0.0), width - 1.0)
    fr = min(max(fr, 0.0), nrows - 1.0)
    c0, r0 = int(fc), int(fr)
    c1, r1 = min(c0 + 1, width - 1), min(r0 + 1, nrows - 1)
    tx, ty = fc - c0, fr - r0
    total = weight = 0.0
    for c, r, w in ((c0, r0, (1 - tx) * (1 - ty)), (c1, r0, tx * (1 - ty)), (c0, r1, (1 - tx) * ty), (c1, r1, tx * ty)):
        v = block[r * width + c]
        if v is not None and w > 0:
            total += v * w
            weight += w
    return total / weight if weight > 0 else None


class PlanetSource:
    """One body's height and imagery services, and how to read their answers."""

    def __init__(self, body, heights_service, pixel_type, deg_per_px, imagery_service, heights_name,
                 imagery_name, fine=None):
        self.body = body
        self.fine = fine                       # a finer height source for small regions, or None
        self._heights_service = heights_service
        self._pixel_type = pixel_type          # F32 (float32) or S16 (int16), little-endian
        self.deg_per_px = deg_per_px           # the native cell size of the heights
        self._imagery_service = imagery_service
        self.heights_name = heights_name
        self.imagery_name = imagery_name

    def heights_size(self, south, north, west, east, max_cells):
        """Cells (columns, rows) to ask for: the native size, at least SMALLEST_GRID and at most
        max_cells a side, keeping the shape of the region."""
        cols = (east - west) / self.deg_per_px
        rows = (north - south) / self.deg_per_px
        scale = 1.0
        if max(cols, rows) > max_cells:
            scale = max_cells / max(cols, rows)
        elif min(cols, rows) < SMALLEST_GRID:
            scale = SMALLEST_GRID / min(cols, rows)
        return max(2, round(cols * scale)), max(2, round(rows * scale))

    def _export_url(self, service, south, north, west, east, size, **extra):
        query = {"bbox": f"{west},{south},{east},{north}", "size": f"{size[0]},{size[1]}", "f": "image", **extra}
        return TREK.format(body=self.body, service=service) + "?" + urllib.parse.urlencode(query)

    def heights_url(self, south, north, west, east, size):
        return self._export_url(self._heights_service, south, north, west, east, size,
                                format="bsq", pixelType=self._pixel_type, noData=str(NODATA),
                                interpolation="RSP_BilinearInterpolation")

    @property
    def has_image_service(self):
        """Whether Trek serves this body's imagery as one picture of a region."""
        return self._imagery_service is not None

    def image_url(self, south, north, west, east, size):
        if not self.has_image_service:
            raise RegionError(f"{self.body} has no one-picture imagery: its map tiles are stitched instead")
        return self._export_url(self._imagery_service, south, north, west, east, size, format="jpg")

    def parse_heights(self, data, size):
        """The heights in metres, row by row from the north, None where there is no data. The answer
        is the raw grid, then a validity mask this ignores: a missing cell already reads NODATA."""
        cols, rows = size
        count = cols * rows
        code = "f" if self._pixel_type == "F32" else "h"
        width = struct.calcsize(code)
        if len(data) < count * width:
            raise ValueError(f"expected {count * width} bytes of heights for {cols}x{rows}, got {len(data)}")
        values = struct.unpack_from(f"<{count}{code}", data)
        return [None if (v == NODATA or v != v or abs(v) > 1e6) else float(v) for v in values]

    def grid(self, fetcher: Fetcher, south, north, west, east, max_cells, log=print, finest=True) -> Grid:
        """The heights of the region: from the finer source when it covers the region (falling back
        to Trek if it fails), else from Trek. finest=False: from Trek only."""
        check_region(south, north, west, east)
        if finest and self.fine is not None and self.fine.covers(south, north, west, east):
            try:
                return self.fine.grid(south, north, west, east, max_cells)
            except (OSError, ValueError, http.client.HTTPException) as e:
                log(f"{self.body} heights: SLDEM2015 failed, Trek's LOLA instead: {e}")
        size = self.heights_size(south, north, west, east, max_cells)
        answer = fetcher.get(self.heights_url(south, north, west, east, size), timeout=90)
        values = self.parse_heights(answer.body, size)
        if all(v is None for v in values):
            raise NoHeights(f"Trek has no heights of {self.body} in this region")
        return Grid(size[0], size[1], values, (south, north, west, east), self.heights_name)

    def image(self, fetcher: Fetcher, south, north, west, east, width, height) -> bytes:
        """A JPEG of exactly the region, width x height pixels, north up."""
        check_region(south, north, west, east)
        answer = fetcher.get(self.image_url(south, north, west, east, (width, height)), timeout=90)
        if not answer.content_type.startswith("image/"):
            raise FetchError(f"Trek sent no picture ({answer.content_type or 'no type'})")
        return answer.body


PLANETS = {
    "moon": PlanetSource(
        "moon", "LRO_LOLA_DEM_Global_256ppd_v06", "F32", 1 / 256,
        "LRO_WAC_Mosaic_Global_303ppd_v02",
        heights_name="LRO LOLA 118 m (NASA/GSFC)", imagery_name="LRO WAC mosaic (NASA/GSFC/ASU)",
        fine=SldemSource()),
    "mars": PlanetSource(
        "mars", "Mars_MOLA_blend200ppx_HRSC_DEM_clon0dd_200mpp_lzw", "S16", 0.00337412083064107,
        "Mars_Viking_MDIM21_ClrMosaic_global_232m",
        heights_name="HRSC-MOLA blend 200 m (ESA/DLR/FU Berlin, NASA)", imagery_name="Viking MDIM 2.1 (NASA/JPL/USGS)"),
    # Magellan's radar altimetry, gaps filled: one cell is 4.6 km, so only big regions (mountains
    # and craters of 50 km and more) have a shape. The service sits in Trek's "venus" folder.
    "venus": PlanetSource(
        "venus", "venus/Venus_Magellan_Topography_Global_4641m_gapfilled_v02", "F32", 0.0439453125,
        None,
        heights_name="Magellan topography 4.6 km (NASA/JPL/USGS)", imagery_name="Magellan SAR mosaic (NASA/JPL/USGS)"),
}
