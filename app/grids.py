"""A grid of heights, as the server sends it to the page: rows from the north, columns from the west,
metres, and NaN where the source has no height.

On the wire it is the raw numbers (float32, little-endian), and its size and place go in headers:
a 1000 x 1000 grid is 4 MB this way, and about 9 MB as JSON text.
"""
from __future__ import annotations

import math
import struct
from array import array

NAN = float("nan")


class Grid:
    """`values` holds cols * rows heights, row by row from the north-west corner. The corners of the
    grid are the centres of its corner cells: `box` is (south, north, west, east) of those centres."""

    def __init__(self, cols: int, rows: int, values, box, source: str):
        if cols < 2 or rows < 2:
            raise ValueError(f"a grid needs 2 x 2 cells at least, not {cols} x {rows}")
        if len(values) != cols * rows:
            raise ValueError(f"{cols} x {rows} cells, but {len(values)} values")
        self.cols = cols
        self.rows = rows
        self.values = array("f", (NAN if v is None else v for v in values))
        self.box = tuple(box)
        self.source = source

    @property
    def known(self) -> int:
        """How many cells have a height."""
        return sum(1 for v in self.values if v == v)

    def to_bytes(self) -> bytes:
        data = array("f", self.values)
        if struct.pack("=f", 1.0) != struct.pack("<f", 1.0):
            data.byteswap()
        return data.tobytes()

    def headers(self) -> dict:
        south, north, west, east = self.box
        return {
            "X-Grid-Cols": str(self.cols), "X-Grid-Rows": str(self.rows),
            "X-Grid-Box": f"{south!r},{north!r},{west!r},{east!r}",
            "X-Grid-Source": self.source,
        }

    def reduced(self, max_cells: int) -> "Grid":
        """The same ground in at most max_cells a side. The corners stay where they are, the new
        cells are spaced evenly between them, and each is the mean of the old cells within half a
        new step of it (those with a height). A grid within the limit comes back as it is."""
        if max(self.cols, self.rows) <= max_cells:
            return self
        step = (max(self.cols, self.rows) - 1) / (max_cells - 1)       # old cells a new step
        cols = max(2, round((self.cols - 1) / step) + 1)
        rows = max(2, round((self.rows - 1) / step) + 1)
        sx = (self.cols - 1) / (cols - 1)
        sy = (self.rows - 1) / (rows - 1)
        spans_x = [(max(0, math.ceil(c * sx - sx / 2)), min(self.cols - 1, math.floor(c * sx + sx / 2)))
                   for c in range(cols)]
        out = []
        for r in range(rows):
            r0 = max(0, math.ceil(r * sy - sy / 2))
            r1 = min(self.rows - 1, math.floor(r * sy + sy / 2))
            for c0, c1 in spans_x:
                total = count = 0
                for rr in range(r0, r1 + 1):
                    base = rr * self.cols
                    for v in self.values[base + c0:base + c1 + 1]:
                        if v == v:
                            total += v
                            count += 1
                out.append(total / count if count else None)
        return Grid(cols, rows, out, self.box, self.source)


def parse_aaigrid(text: str, source: str) -> Grid:
    """An ESRI ASCII grid (what OpenTopography sends) as a Grid. Its header gives the lower-left
    corner of the lower-left cell (or its centre) and the cell size, in degrees."""
    lines = text.splitlines()
    head = {}
    at = 0
    while at < len(lines):
        parts = lines[at].split()
        if len(parts) == 2 and parts[0].replace("_", "").isalpha():
            head[parts[0].lower()] = parts[1]
            at += 1
            continue
        break
    try:
        cols = int(head["ncols"])
        rows = int(head["nrows"])
        size = float(head["cellsize"])
    except (KeyError, ValueError):
        raise ValueError("not an ASCII grid: no ncols, nrows or cellsize in its header") from None
    nodata = float(head.get("nodata_value", "-9999"))
    if "xllcenter" in head:
        west = float(head["xllcenter"])
        south = float(head["yllcenter"])
    else:
        west = float(head["xllcorner"]) + size / 2
        south = float(head["yllcorner"]) + size / 2
    numbers = " ".join(lines[at:]).split()
    if len(numbers) < cols * rows:
        raise ValueError(f"the grid is cut short: {len(numbers)} of {cols * rows} values")
    values = []
    for token in numbers[:cols * rows]:
        v = float(token)
        values.append(None if v == nodata or not math.isfinite(v) else v)
    box = (south, south + size * (rows - 1), west, west + size * (cols - 1))
    return Grid(cols, rows, values, box, source)
