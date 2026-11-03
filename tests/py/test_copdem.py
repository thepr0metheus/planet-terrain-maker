"""Copernicus heights from AWS: files made here the way the real ones are made (float32, deflate, the
floating-point predictor, internal tiles, pixel-is-point, an overview), served by a fake S3."""
import struct
import unittest
import zlib

from helpers import Answer, ServerCase, Upstream

STEP = 1 / 8                      # 8 pixels a degree: small files


def predict(rows: list) -> bytes:
    """The floating-point predictor, the way a writer applies it: the floats big-endian, their bytes in
    four runs a row, each byte minus the one before it."""
    out = bytearray()
    for row in rows:
        raw = b"".join(struct.pack(">f", value) for value in row)
        before = 0
        for plane in range(4):
            for at in range(plane, len(raw), 4):
                out.append((raw[at] - before) & 255)
                before = raw[at]
    return bytes(out)


def make_cog(heights: list, lon0: float, lat0: float, step: float, tile: int = 4) -> bytes:
    """A little-endian GeoTIFF of these heights (rows from the north; pixel (0, 0) at lon0, lat0), and an
    overview of half size made as GDAL makes it: each pixel the mean of the four under it."""
    half = [[(heights[r][c] + heights[r + 1][c] + heights[r][c + 1] + heights[r + 1][c + 1]) / 4
             for c in range(0, len(heights[0]) - 1, 2)] for r in range(0, len(heights) - 1, 2)]
    levels = [heights, half]
    body = bytearray(b"II*\x00\x00\x00\x00\x00")
    blobs = []
    for level in levels:
        tiles = []
        for ty in range(0, len(level), tile):
            for tx in range(0, len(level[0]), tile):
                block = [[level[r][c] if r < len(level) and c < len(level[0]) else 0.0
                          for c in range(tx, tx + tile)] for r in range(ty, ty + tile)]
                tiles.append(zlib.compress(predict(block)))
        blobs.append(tiles)
    data_at = []
    for tiles in blobs:
        offsets = []
        for piece in tiles:
            offsets.append(len(body))
            body += piece
        data_at.append(offsets)
    ifd_offsets = []
    for n, level in enumerate(levels):
        h, w = len(level), len(level[0])
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


def file_name(code: str, lat: int, lon: int) -> str:
    ns = f"{'N' if lat >= 0 else 'S'}{abs(lat):02d}"
    ew = f"{'E' if lon >= 0 else 'W'}{abs(lon):03d}"
    return f"Copernicus_DSM_COG_{code}_{ns}_00_{ew}_00_DEM"


def plane(lon0, lat0, step, n):
    """Heights that rise 1000 m a degree east and 100 m a degree north, at each pixel's point."""
    return [[(lon0 + step * c) * 1000 + (lat0 - step * r) * 100 for c in range(n)] for r in range(n)]


def full(value, n):
    return [[value] * n for _ in range(n)]


class FakeS3:
    """Files by name; a Range header gets that part of the file."""

    def __init__(self, files: dict):
        self.files = files

    def __call__(self, asked):
        name = asked.url.rsplit("/", 1)[-1]
        if name not in self.files:
            return 404
        body = self.files[name]
        said = asked.headers.get("Range")
        if said:
            start, end = (int(v) for v in said.split("=")[1].split("-"))
            body = body[start:end + 1]
        return Answer(body, "image/tiff", 206)


class CopernicusAwsTest(ServerCase):
    def serve(self, files):
        """A server of its own on a data folder of its own, and S3 holding these files."""
        upstream = Upstream({"s3.amazonaws.com": FakeS3(files)})
        self.addCleanup(upstream.close)
        data = self.home / f"data-{len(list(self.home.iterdir()))}"
        data.mkdir()
        return self.new_server(upstream, data), upstream

    def heights(self, server, south, north, west, east, cells):
        return server.get(f"/api/earth/heights?south={south}&north={north}&west={west}&east={east}&cells={cells}&source=aws")

    @staticmethod
    def values(grid) -> list:
        cols, rows = int(grid.headers["X-Grid-Cols"]), int(grid.headers["X-Grid-Rows"])
        flat = struct.unpack(f"<{cols * rows}f", grid.data)
        return [list(flat[r * cols:(r + 1) * cols]) for r in range(rows)]

    def test_heights_across_two_files_are_the_plane_they_were_made_of(self):
        files = {f"{file_name('10', 43, lon)}.tif": make_cog(plane(lon, 44.0, STEP, 8), lon, 44.0, STEP) for lon in (42, 43)}
        server, upstream = self.serve(files)
        grid = self.heights(server, 43.2, 43.8, 42.3, 43.6, 64)
        self.assertEqual(grid.status, 200)
        got = self.values(grid)
        rows, cols = len(got), len(got[0])
        for r, row in enumerate(got):
            lat = 43.8 - 0.6 * r / (rows - 1)
            for c, value in enumerate(row):
                lon = 42.3 + 1.3 * c / (cols - 1)
                if lon < 42.0 + 7 * STEP or lon >= 43.0:     # past the last pixel of the first file the edge is held
                    self.assertLess(abs(value - (lon * 1000 + lat * 100)), 0.05, (lat, lon))
        self.assertIn("GLO-30", grid.headers["X-Grid-Source"])
        self.assertEqual(grid.headers["X-Grid-Box"], "43.2,43.8,42.3,43.6")
        asked = len(upstream.asked)
        self.assertGreater(asked, 0)
        self.assertIn("https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N43_00_E042_00_DEM/Copernicus_DSM_COG_10_N43_00_E042_00_DEM.tif", upstream.asked)
        self.assertEqual(upstream.requests[0].headers["Range"], "bytes=0-65535")

    def test_the_second_time_every_piece_comes_from_disk(self):
        name = file_name("10", 43, 42)
        server, upstream = self.serve({f"{name}.tif": make_cog(plane(42, 44.0, STEP, 8), 42, 44.0, STEP)})
        first = self.heights(server, 43.2, 43.8, 42.3, 42.6, 32)
        before = len(upstream.asked)
        self.assertEqual(self.heights(server, 43.2, 43.8, 42.3, 42.6, 32).data, first.data)
        self.assertEqual(len(upstream.asked), before, "the file's head is known, its tiles are on disk")
        pieces = list((server.data / "cache" / "copernicus" / name).iterdir())
        self.assertTrue(pieces)
        for piece in pieces:
            self.assertRegex(piece.name, r"^\d+-\d+\.bin$")
        server.restart()
        self.assertEqual(self.heights(server, 43.2, 43.8, 42.3, 42.6, 32).data, first.data)
        self.assertEqual(len(upstream.asked), before, "after a restart too")

    def test_where_30_m_is_not_released_90_m_answers_and_open_sea_is_0(self):
        name90 = file_name("30", 43, 42)
        server, _ = self.serve({f"{name90}.tif": make_cog(full(777.0, 8), 42, 44.0, STEP)})
        grid = self.heights(server, 43.3, 43.6, 42.3, 42.6, 16)
        self.assertTrue(all(abs(v - 777) < 1e-3 for row in self.values(grid) for v in row))
        self.assertIn("GLO-90", grid.headers["X-Grid-Source"])
        sea, _ = self.serve({})
        empty = self.heights(sea, 43.3, 43.6, 42.3, 42.6, 16)
        self.assertEqual(empty.status, 200)
        self.assertTrue(all(v == 0 for row in self.values(empty) for v in row))
        self.assertEqual(empty.headers["X-Grid-Source"], "Copernicus DEM (ESA), AWS Open Data: open sea")

    def test_a_grid_across_the_30_and_the_90_m_files_names_both(self):
        server, _ = self.serve({f"{file_name('10', 43, 42)}.tif": make_cog(full(1.0, 8), 42, 44.0, STEP),
                                f"{file_name('30', 43, 43)}.tif": make_cog(full(2.0, 8), 43, 44.0, STEP)})
        grid = self.heights(server, 43.3, 43.6, 42.5, 43.5, 16)
        self.assertEqual(grid.headers["X-Grid-Source"], "Copernicus DEM GLO-30 (ESA), AWS Open Data + Copernicus DEM GLO-90 (ESA), AWS Open Data")

    def test_a_big_region_reads_the_smaller_copy(self):
        name = file_name("10", 43, 42)
        server, _ = self.serve({f"{name}.tif": make_cog(plane(42, 44.0, STEP, 8), 42, 44.0, STEP)})
        grid = self.heights(server, 43.05, 43.9, 42.05, 42.85, 4)
        got = self.values(grid)
        self.assertLessEqual(max(len(got), len(got[0])), 4)
        for row in got:
            self.assertTrue(all(b > a for a, b in zip(row, row[1:])), "still rising eastwards")

    def test_a_damaged_file_is_a_bad_gateway_and_says_what_it_is(self):
        # what a service that sends a cut-off file, a page that is not a file or a file that is not made
        # as these are made leaves behind: each used to end in struct.error, KeyError or zlib.error, a crash
        good = make_cog(plane(42, 44.0, STEP, 8), 42, 44.0, STEP)
        first_directory = struct.unpack_from("<I", good, 4)[0]

        def entry_of(tag):
            count = struct.unpack_from("<H", good, first_directory)[0]
            tags = [struct.unpack_from("<H", good, first_directory + 2 + 12 * i)[0] for i in range(count)]
            return first_directory + 2 + 12 * tags.index(tag)

        no_width = bytearray(good)
        struct.pack_into("<H", no_width, entry_of(256), 999)                  # ImageWidth is now another tag
        short_scale = bytearray(good)
        struct.pack_into("<I", short_scale, entry_of(33550) + 4, 1)           # the pixel size has one value, not three
        broken_tile = bytearray(good)
        broken_tile[8:40] = b"\xff" * 32                                        # the first tile's deflate stream
        small_tile = bytearray(good)
        stream = zlib.compress(b"\x00" * 16)
        small_tile[8:8 + len(stream)] = stream                                # inflates, to 16 bytes, not a tile's worth
        wide = bytearray(good)
        struct.pack_into("<H", wide, entry_of(256) + 8, 64)                   # a width that needs more tiles than are listed
        damaged = {
            "the magic and nothing else": b"II*\x00",
            "the magic and a directory that is not there": b"II*\x00\x08\x00\x00\x00",
            "the first bytes only": good[:8],
            "cut in half": good[: len(good) // 2],
            "without a tag that is needed": bytes(no_width),
            "a tag with fewer values than it needs": bytes(short_scale),
            "a tile that does not inflate": bytes(broken_tile),
            "a tile that inflates to too little": bytes(small_tile),
            "more tiles across than the table lists": bytes(wide),
            "big-endian": b"MM\x00*\x00\x00\x00\x08",
        }
        name = f"{file_name('10', 43, 42)}.tif"
        for what, body in damaged.items():
            with self.subTest(what):
                server, _ = self.serve({name: body})
                answer = self.heights(server, 43.3, 43.6, 42.3, 42.6, 16)
                self.assertEqual(answer.status, 502)
                self.assertIn("Copernicus on AWS", answer.json()["error"])
                self.assertNotIn("HTTP", answer.json()["error"], "the file is damaged, the service did answer")

    def test_a_service_that_does_not_answer_is_not_a_damaged_file(self):
        upstream = Upstream({"s3.amazonaws.com": 500})
        self.addCleanup(upstream.close)
        answer = self.new_server(upstream).get("/api/earth/heights?south=43.3&north=43.6&west=42.3&east=42.6&cells=16&source=aws")
        self.assertEqual(answer.status, 502)
        self.assertIn("HTTP 500", answer.json()["error"])

    def test_a_tile_that_cannot_be_fetched_is_not_a_damaged_file(self):
        # the header comes, the tiles do not: the service failed, the file is not damaged
        good = make_cog(plane(42, 44.0, STEP, 8), 42, 44.0, STEP)
        s3 = FakeS3({f"{file_name('10', 43, 42)}.tif": good})
        upstream = Upstream({"s3.amazonaws.com": lambda asked: s3(asked) if asked.headers["Range"].startswith("bytes=0-") else 500})
        self.addCleanup(upstream.close)
        answer = self.new_server(upstream).get("/api/earth/heights?south=43.3&north=43.6&west=42.3&east=42.6&cells=16&source=aws")
        self.assertEqual(answer.status, 502)
        self.assertIn("HTTP 500", answer.json()["error"])

    def test_a_server_that_ignores_the_range_sends_the_whole_file(self):
        name = file_name("10", 43, 42)
        whole = make_cog(full(5.0, 8), 42, 44.0, STEP)
        upstream = Upstream({"s3.amazonaws.com": lambda asked: Answer(whole, "image/tiff") if name in asked.url and "_10_" in asked.url else 404})
        self.addCleanup(upstream.close)
        grid = self.new_server(upstream).get("/api/earth/heights?south=43.3&north=43.6&west=42.3&east=42.6&cells=16&source=aws")
        self.assertEqual(grid.status, 200)
        self.assertTrue(all(abs(v - 5) < 1e-3 for row in self.values(grid) for v in row))


if __name__ == "__main__":
    unittest.main()
