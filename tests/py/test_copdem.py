"""Copernicus heights from AWS: files made here the way the real ones are made (float32, deflate, the
floating-point predictor, internal tiles, pixel-is-point, an overview), served by a fake S3."""
import struct
import tempfile
import unittest
import zlib
from pathlib import Path

import numpy as np
from fakes import FakeFetcher

from app.copdem import CopernicusAws, file_name, unpredict
from app.fetch import Answer, FetchError


def predict(heights: np.ndarray) -> bytes:
    """The floating-point predictor, the way a writer applies it: the floats big-endian, their bytes in
    four runs a row, each byte minus the one before it."""
    rows, width = heights.shape
    planes = heights.astype(">f4").view(np.uint8).reshape(rows, width, 4).transpose(0, 2, 1).reshape(rows, width * 4)
    diff = planes.copy()
    diff[:, 1:] = planes[:, 1:] - planes[:, :-1]
    return diff.tobytes()


def make_cog(heights: np.ndarray, lon0: float, lat0: float, step: float, tile: int = 4) -> bytes:
    """A little-endian GeoTIFF of these heights (pixel (0, 0) at lon0, lat0), and an overview of half size
    made as GDAL makes it: each pixel the mean of the four under it."""
    half = (heights[0::2, 0::2] + heights[1::2, 0::2] + heights[0::2, 1::2] + heights[1::2, 1::2]) / 4
    levels = [heights, half.astype(np.float32)]
    body = bytearray(b"II*\x00\x00\x00\x00\x00")
    blobs = []
    for level in levels:
        h, w = level.shape
        tiles = []
        for ty in range(0, h, tile):
            for tx in range(0, w, tile):
                block = np.zeros((tile, tile), dtype=np.float32)
                part = level[ty:ty + tile, tx:tx + tile]
                block[:part.shape[0], :part.shape[1]] = part
                tiles.append(zlib.compress(predict(block)))
        blobs.append(tiles)
    data_at = []
    for tiles in blobs:
        offsets = []
        for t in tiles:
            offsets.append(len(body))
            body += t
        data_at.append(offsets)
    ifd_offsets = []
    for n, level in enumerate(levels):
        h, w = level.shape
        extra = bytearray()
        base = len(body)
        entries = [(256, 3, 1, w), (257, 3, 1, h), (258, 3, 1, 32), (259, 3, 1, 8), (277, 3, 1, 1), (317, 3, 1, 3),
                   (322, 3, 1, tile), (323, 3, 1, tile), (324, 4, len(blobs[n]), data_at[n]),
                   (325, 4, len(blobs[n]), [len(t) for t in blobs[n]]), (339, 3, 1, 3)]
        if n == 0:
            entries += [(33550, 12, 3, [step, step, 0.0]), (33922, 12, 6, [0.0, 0.0, 0.0, lon0, lat0, 0.0])]
        size = 2 + 12 * len(entries) + 4
        ifd_offsets.append(base)
        packed = bytearray(struct.pack("<H", len(entries)))
        for tag, kind, count, value in entries:
            code = {3: "H", 4: "I", 12: "d"}[kind]
            values = value if isinstance(value, list) else [value]
            raw = struct.pack(f"<{count}{code}", *values)
            if len(raw) <= 4:
                packed += struct.pack("<HHI", tag, kind, count) + raw.ljust(4, b"\0")
            else:
                packed += struct.pack("<HHII", tag, kind, count, base + size + len(extra))
                extra += raw
        packed += b"\0\0\0\0"            # next IFD, set below
        body += packed + extra
    struct.pack_into("<I", body, 4, ifd_offsets[0])
    struct.pack_into("<I", body, ifd_offsets[0] + 2 + 12 * 13, ifd_offsets[1])
    return bytes(body)


class FakeS3(FakeFetcher):
    """Files by name; a Range header gets that part of the file."""

    def __init__(self, files):
        super().__init__()
        self.files = files

    def get(self, url, headers=None, timeout=None):
        self.asked.append(url)
        name = url.rsplit("/", 1)[-1]
        if name not in self.files:
            raise FetchError("HTTP 404", 404)
        body = self.files[name]
        if headers and "Range" in headers:
            start, end = (int(v) for v in headers["Range"].split("=")[1].split("-"))
            body = body[start:end + 1]
        return Answer(body, "image/tiff", 206)


def plane(lon0, lat0, step, n):
    """Heights that rise 1000 m a degree east and 100 m a degree north, at each pixel's point."""
    lons = lon0 + step * np.arange(n)
    lats = lat0 - step * np.arange(n)
    return (lons[None, :] * 1000 + lats[:, None] * 100).astype(np.float32)


class CopernicusAwsTest(unittest.TestCase):
    STEP = 1 / 8                      # 8 pixels a degree: small files

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.dir.cleanup()

    def cop(self, files):
        fetcher = FakeS3(files)
        return CopernicusAws(fetcher, Path(self.dir.name), log=lambda *a: None), fetcher

    def test_the_predictor_comes_undone(self):
        heights = (np.random.default_rng(1).random((4, 6), dtype=np.float32) * 9000 - 400).astype(np.float32)
        self.assertTrue(np.array_equal(unpredict(predict(heights), 6, 4), heights))

    def test_heights_across_two_files_are_the_plane_they_were_made_of(self):
        files = {}
        for lon in (42, 43):
            name = file_name("10", 43, lon)
            files[f"{name}.tif"] = make_cog(plane(lon, 44.0, self.STEP, 8), lon, 44.0, self.STEP)
        cop, fetcher = self.cop(files)
        grid = cop.grid(43.2, 43.8, 42.3, 43.6, 64)
        got = np.array(grid.values, dtype=np.float32).reshape(grid.rows, grid.cols)
        lats = 43.8 - 0.6 * np.arange(grid.rows) / (grid.rows - 1)
        lons = 42.3 + 1.3 * np.arange(grid.cols) / (grid.cols - 1)
        want = lons[None, :] * 1000 + lats[:, None] * 100
        inside = lons < 42.0 + 7 * self.STEP        # past the last pixel of the first file the edge is held
        self.assertLess(float(np.abs(got[:, inside] - want[:, inside]).max()), 0.05)
        right = lons >= 43.0
        self.assertLess(float(np.abs(got[:, right] - want[:, right]).max()), 0.05)
        self.assertIn("GLO-30", grid.source)
        asked = len(fetcher.asked)
        cop2, fetcher2 = self.cop(files)
        cop2.grid(43.2, 43.8, 42.3, 43.6, 64)
        self.assertEqual(fetcher2.asked, [], "the second time every piece comes from disk")
        self.assertGreater(asked, 0)

    def test_where_30_m_is_not_released_90_m_answers_and_open_sea_is_0(self):
        name90 = file_name("30", 43, 42)
        cop, _ = self.cop({f"{name90}.tif": make_cog(np.full((8, 8), 777, dtype=np.float32), 42, 44.0, self.STEP)})
        grid = cop.grid(43.3, 43.6, 42.3, 42.6, 16)
        self.assertTrue(all(abs(v - 777) < 1e-3 for v in grid.values))
        self.assertIn("GLO-90", grid.source)
        with tempfile.TemporaryDirectory() as other:
            sea = CopernicusAws(FakeS3({}), Path(other), log=lambda *a: None)
            empty = sea.grid(43.3, 43.6, 42.3, 42.6, 16)
        self.assertTrue(all(v == 0 for v in empty.values))

    def test_a_big_region_reads_the_smaller_copy(self):
        name = file_name("10", 43, 42)
        cop, _ = self.cop({f"{name}.tif": make_cog(plane(42, 44.0, self.STEP, 8), 42, 44.0, self.STEP)})
        grid = cop.grid(43.05, 43.9, 42.05, 42.85, 4)
        self.assertLessEqual(max(grid.cols, grid.rows), 4)
        got = np.array(grid.values).reshape(grid.rows, grid.cols)
        self.assertTrue(np.all(np.diff(got, axis=1) > 0), "still rising eastwards")


if __name__ == "__main__":
    unittest.main()
