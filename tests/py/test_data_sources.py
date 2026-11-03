"""Map tiles, OpenTopography, Trek, Nominatim and Overpass, with the services faked behind the server."""
import json
import math
import os
import re
import struct
import threading
import time
import unittest
from urllib.parse import parse_qs, urlsplit

from helpers import Answer, ServerCase, Upstream

KEY = "0123456789abcdef0123456789abcdef"
NODATA = -32768.0


def size_asked(asked) -> tuple[int, int]:
    cols, rows = parse_qs(urlsplit(asked.url).query)["size"][0].split(",")
    return int(cols), int(rows)


def floats(data: bytes) -> list:
    return list(struct.unpack(f"<{len(data) // 4}f", data))


class TileTest(ServerCase):
    def tile(self, layer="earth-photo", z=3, x=1, y=2):
        return self.server.get(f"/api/tile/{layer}/{z}/{x}/{y}")

    def test_which_tiles_a_layer_has(self):
        self.upstream.table.update({"": Answer(b"t", "image/jpeg")})
        for layer, z, x, y, status in (("earth-photo", 2, 3, 3, 200), ("earth-photo", 2, 4, 0, 404),
                                       ("moon-wac", 2, 7, 3, 200), ("moon-wac", 2, 8, 0, 404), ("moon-wac", 2, 0, 4, 404),
                                       ("earth-photo", 20, 0, 0, 404), ("earth-photo", 19, 0, 0, 200),
                                       ("earth-photo", 99999999999999999999, 0, 0, 404)):
            with self.subTest(layer=layer, z=z, x=x, y=y):
                self.assertEqual(self.tile(layer, z, x, y).status, status)
        self.assertEqual(self.tile("earth-photo", "a", 0, 0).status, 404)
        self.assertEqual(self.tile("earth-photo", -1, 0, 0).status, 404)

    def test_the_address_of_each_layer(self):
        self.upstream.table.update({"": Answer(b"t", "image/png")})
        for layer, part in (("earth-photo", "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/3/2/5"),
                            ("earth-s2-2025", "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/3/2/5.jpg"),
                            ("earth-usgs", "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/3/2/5"),
                            ("earth-labels", "https://services.arcgisonline.com/arcgis/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/3/2/5"),
                            ("earth-heights", "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/3/5/2.png"),
                            ("moon-wac", "https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm/3/2/5.jpg"),
                            ("moon-kaguya", "https://trek.nasa.gov/tiles/Moon/EQ/Kaguya_TCortho_Mosaic_Global_4096ppd/1.0.0/default/default028mm/3/2/5.png"),
                            ("mars-mdim", "https://trek.nasa.gov/tiles/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/1.0.0/default/default028mm/3/2/5.jpg"),
                            ("mars-themis", "https://trek.nasa.gov/tiles/Mars/EQ/THEMIS_DayIR_ControlledMosaics_100m_v2_oct2018/1.0.0/default/default028mm/3/2/5.png"),
                            ("mars-ctx", "https://astro.arcgis.com/arcgis/rest/services/OnMars/CTX/MapServer/tile/3/2/5"),
                            ("venus-c3", "https://trek.nasa.gov/tiles/Venus/EQ/Venus_Magellan_C3-MDIR_Global_Mosaic_2025m/1.0.0/default/default028mm/3/2/5.png"),
                            ("venus-sar", "https://trek.nasa.gov/tiles/Venus/EQ/Venus_Magellan_LeftLook_mosaic_global_75m/1.0.0/default/default028mm/3/2/5.png")):
            with self.subTest(layer=layer):
                self.assertEqual(self.tile(layer, 3, 5, 2).status, 200)
                self.assertEqual(self.upstream.asked[-1], part)

    def test_a_tile_says_who_asks(self):
        self.upstream.table.update({"World_Imagery": Answer(b"j", "image/jpeg")})
        self.tile()
        self.assertEqual(self.upstream.requests[0].headers["User-Agent"], "planet-terrain-maker/1.0")
        other = self.new_server(env={"APP_USER_AGENT": "planet-terrain-maker/1.0 (+https://example.org)"})
        other.get("/api/tile/earth-photo/3/1/3")
        self.assertEqual(self.upstream.requests[1].headers["User-Agent"], "planet-terrain-maker/1.0 (+https://example.org)")

    def test_a_tile_is_fetched_once_then_read_from_disk(self):
        self.upstream.table.update({"World_Imagery": Answer(b"jpeg!", "image/jpeg; charset=x")})
        first, second = self.tile(), self.tile()
        self.assertEqual((first.status, first.data, first.mimetype), (200, b"jpeg!", "image/jpeg"))
        self.assertEqual((second.status, second.data, second.mimetype), (200, b"jpeg!", "image/jpeg"))
        self.assertEqual(len(self.upstream.asked), 1)
        self.assertEqual((self.data / "cache/tiles/earth-photo/3/1/2.jpg").read_bytes(), b"jpeg!")

    def test_a_tile_served_is_the_last_to_go(self):
        self.upstream.table.update({"World_Imagery": Answer(b"j", "image/jpeg")})
        self.tile()
        path = self.data / "cache/tiles/earth-photo/3/1/2.jpg"
        os.utime(path, (1000, 1000))
        self.tile()
        self.assertGreater(path.stat().st_mtime, time.time() - 60)

    def test_a_busy_service_is_asked_again_and_a_refusal_is_not(self):
        answers = [503, Upstream.DROP, Answer(b"jpeg!", "image/jpeg")]
        self.upstream.table.update({"World_Imagery": lambda asked: answers.pop(0)})
        started = time.monotonic()
        self.assertEqual(self.tile().data, b"jpeg!")
        self.assertGreaterEqual(time.monotonic() - started, 2.0, "after a pause of 0.5 s and one of 1.5 s")
        for status, times in ((500, 3), (429, 3), (403, 1)):
            with self.subTest(status=status):
                self.upstream.table.clear()
                self.upstream.table["World_Imagery"] = status
                before = len(self.upstream.asked)
                failed = self.tile(z=4 + times + status % 7)
                self.assertEqual(failed.status, 502)
                self.assertIn(f"HTTP {status}", failed.json()["error"])
                self.assertEqual(len(self.upstream.asked) - before, times)

    def test_one_service_gets_at_most_its_own_number_of_fetches_at_once(self):
        running, most, lock = [0], [0], threading.Lock()

        def slow(asked):
            with lock:
                running[0] += 1
                most[0] = max(most[0], running[0])
            time.sleep(0.05)
            with lock:
                running[0] -= 1
            return Answer(b"jpeg!", "image/jpeg")

        self.upstream.table.update({"s2cloudless": slow})
        threads = [threading.Thread(target=self.tile, args=("earth-s2-2025", 5, x, 3)) for x in range(20)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertLessEqual(most[0], 6, "EOX resets a dozen connections at once")
        self.assertGreater(most[0], 1, "the fetches still run side by side")

    def test_a_missing_tile_is_remembered_for_a_day(self):
        self.upstream.table.update({"World_Imagery": 404})
        for _ in range(3):
            self.assertEqual(self.tile(z=19).status, 404)
        self.assertEqual(len(self.upstream.asked), 1)
        missing = self.data / "cache/tiles/earth-photo/19/1/2.missing"
        self.assertEqual(missing.read_bytes(), b"")
        two_days_ago = time.time() - 2 * 86400
        os.utime(missing, (two_days_ago, two_days_ago))
        self.assertEqual(self.tile(z=19).status, 404)
        self.assertEqual(len(self.upstream.asked), 2, "asked again after a day")

    def test_an_error_page_is_not_kept_as_a_tile(self):
        self.upstream.table.update({"World_Imagery": Answer(b"<html>", "text/html")})
        answer = self.tile()
        self.assertEqual(answer.status, 502)
        self.assertIn("not a picture", answer.json()["error"])
        self.assertFalse((self.data / "cache/tiles/earth-photo/3/1/2.jpg").exists())

    @unittest.skipIf(os.geteuid() == 0, "root writes where the test forbids it")
    def test_a_store_that_cannot_be_written_still_serves_the_tile(self):
        self.upstream.table.update({"terrarium": Answer(b"t", "image/png")})
        (self.data / "cache").mkdir()
        (self.data / "cache").chmod(0o500)
        try:
            tile = self.tile("earth-heights", 5, 1, 1)
            self.assertEqual((tile.status, tile.data), (200, b"t"))
            again = self.tile("earth-heights", 5, 1, 2)
            self.assertEqual(again.status, 200)
            self.assertEqual(self.server.log().count("cannot be written"), 1, "said once")
        finally:
            (self.data / "cache").chmod(0o700)

    def test_the_store_is_trimmed_past_its_size_the_tiles_served_longest_ago_first(self):
        self.upstream.table.update({"terrarium": Answer(b"t", "image/png")})
        tiles = self.data / "cache/tiles/earth-heights/5/0"
        tiles.mkdir(parents=True)
        for y in range(5):
            path = tiles / f"{y}.png"
            path.write_bytes(b"x" * (300 * 1024))
            os.utime(path, (1000 + y, 1000 + y))
        server = self.new_server(env={"TILE_CACHE_MB": "1"})
        self.assertEqual(server.get("/api/tile/earth-heights/5/9/9").status, 200)
        for _ in range(100):
            if not (tiles / "1.png").exists():
                break
            time.sleep(0.05)
        self.assertEqual(sorted(p.name for p in tiles.iterdir()), ["2.png", "3.png", "4.png"], "to under 90% of the limit")


class OpenTopographyTest(ServerCase):
    GRID = "ncols 2\nnrows 2\nxllcorner 41.5\nyllcorner 41.5\ncellsize 0.001\nNODATA_value -9999\n10 20\n30 40\n"
    BOX = "south=41.5&north=41.6&west=41.5&east=41.6"

    def heights(self, box=BOX, more=""):
        return self.server.get(f"/api/earth/heights?{box}{more}")

    def with_key(self, answer):
        self.upstream.table["opentopography"] = answer
        self.server.put("/api/settings/opentopo-key", {"key": KEY})

    def test_no_key_no_request(self):
        answer = self.heights()
        self.assertEqual((answer.status, answer.json()["key_needed"]), (403, True))
        self.assertEqual(self.upstream.asked, [])

    def test_a_grid_comes_back_and_the_key_is_in_the_request_only(self):
        self.with_key(Answer(self.GRID.encode(), "text/plain"))
        grid = self.heights()
        self.assertEqual(floats(grid.data), [10, 20, 30, 40])
        self.assertEqual(self.upstream.asked, [
            f"https://portal.opentopography.org/API/globaldem?demtype=COP30&south=41.5&north=41.6&west=41.5&east=41.6&outputFormat=AAIGrid&API_Key={KEY}"])
        self.assertEqual(grid.headers["X-Grid-Source"], "Copernicus DEM 30 m (ESA), via OpenTopography")

    def test_refused_keys_and_quota_say_the_key_is_needed(self):
        for answer, words in ((401, "refused the key"), (403, "refused the key"), (429, "used up"),
                              (Answer(b"Error: invalid API key " + KEY.encode(), "text/plain"), "refused the key")):
            with self.subTest(answer=answer):
                self.with_key(answer)
                refused = self.heights()
                self.assertEqual((refused.status, refused.json()["key_needed"]), (403, True))
                self.assertIn(words, refused.json()["error"])
                self.assertNotIn(KEY, refused.data.decode())

    def test_no_grid_is_a_failure_that_names_no_key(self):
        self.with_key(Answer(b"busy, see " + KEY.encode(), "text/plain"))
        failed = self.heights()
        self.assertEqual(failed.status, 502)
        self.assertNotIn(KEY, failed.data.decode())
        self.assertIn("[key]", failed.json()["error"])
        self.with_key(500)
        failed = self.heights()
        self.assertEqual(failed.status, 502)
        self.assertIn("HTTP 500", failed.json()["error"])
        self.with_key(Answer(b"", "text/plain"))
        self.assertIn("an empty answer", self.heights().json()["error"])

    def test_a_grid_that_cannot_be_read(self):
        for text in ("ncols 3\nnrows 3\nxllcorner 0\nyllcorner 0\ncellsize 1\n1 2 3\n", "ncols x\nnrows 3\n", "ncols 2\nnrows 2\nxllcorner 0\nyllcorner 0\ncellsize 1\na b c d\n",
                     "ncols 1\nnrows 5\nxllcorner 0\nyllcorner 0\ncellsize 1\n1 2 3 4 5\n"):
            with self.subTest(text=text):
                self.with_key(Answer(text.encode(), "text/plain"))
                failed = self.heights()
                self.assertEqual(failed.status, 502)
                self.assertIn("cannot be read", failed.json()["error"])

    def test_a_grid_by_its_corner_and_by_its_centre_with_its_no_data(self):
        for text, box in (("ncols 3\nnrows 2\nxllcorner 10.0\nyllcorner 40.0\ncellsize 0.5\nNODATA_value -9999\n1 2 3\n4 -9999 6\n", "40.25,40.75,10.25,11.25"),
                          ("ncols 3\nnrows 2\nxllcenter 1\nyllcenter 2\ncellsize 1\n1 2 3 4 -9999 6\n", "2.0,3.0,1.0,3.0")):
            with self.subTest(box=box):
                self.with_key(Answer(text.encode(), "text/plain"))
                grid = self.heights()
                self.assertEqual((grid.headers["X-Grid-Cols"], grid.headers["X-Grid-Rows"]), ("3", "2"))
                self.assertEqual(grid.headers["X-Grid-Box"], box)
                values = floats(grid.data)
                self.assertTrue(math.isnan(values[4]))
                self.assertEqual(values[5], 6)

    def test_a_grid_is_made_smaller_keeping_its_corners(self):
        text = "ncols 9\nnrows 9\nxllcenter 20\nyllcenter 10\ncellsize 0.125\n" + "\n".join(" ".join(str(c) for c in range(9)) for _ in range(9)) + "\n"
        self.with_key(Answer(text.encode(), "text/plain"))
        grid = self.heights(more="&cells=5")
        self.assertEqual((grid.headers["X-Grid-Cols"], grid.headers["X-Grid-Rows"]), ("5", "5"))
        self.assertEqual(grid.headers["X-Grid-Box"], "10.0,11.0,20.0,21.0")
        self.assertEqual(floats(grid.data)[:5], [0.5, 2.0, 4.0, 6.0, 7.5])

    def test_a_grid_made_smaller_leaves_out_cells_without_height(self):
        text = "ncols 3\nnrows 3\nxllcenter 0\nyllcenter 0\ncellsize 1\n-9999 -9999 -9999\n-9999 5 -9999\n-9999 -9999 -9999\n"
        self.with_key(Answer(text.encode(), "text/plain"))
        grid = self.heights(more="&cells=2")
        self.assertEqual(floats(grid.data), [5.0] * 4)

    def test_big_regions_take_the_90_m_model(self):
        self.with_key(Answer(self.GRID.encode(), "text/plain"))
        self.assertEqual(self.heights("south=40&north=40.3&west=40&east=40.3").status, 200)
        self.assertIn("demtype=COP30", self.upstream.asked[-1])
        answer = self.heights("south=40&north=41&west=40&east=41")
        self.assertIn("demtype=COP90", self.upstream.asked[-1])
        self.assertEqual(answer.headers["X-Grid-Source"], "Copernicus DEM 90 m (ESA), via OpenTopography")

    def test_the_page_gives_a_key_and_never_reads_it_back(self):
        path = self.data / "keys" / "opentopo"
        self.assertEqual(self.server.get("/api/settings").json()["opentopo_key"], None)
        self.assertEqual(self.server.put("/api/settings/opentopo-key", {"key": f"  {KEY}\n"}).status, 204)
        self.assertEqual(path.read_text(), KEY)
        self.assertEqual(oct(path.stat().st_mode & 0o777), "0o600")
        self.assertEqual(self.server.get("/api/settings").json()["opentopo_key"], "page")
        for bad in ("short", "a" * 129, "has a space in the middle", "გასაღებიგასაღებიგასაღები"):
            with self.subTest(bad=bad):
                self.assertEqual(self.server.put("/api/settings/opentopo-key", {"key": bad}).status, 400)
        self.assertEqual(path.read_text(), KEY)
        self.assertEqual(self.server.delete("/api/settings/opentopo-key").status, 204)
        self.assertEqual(self.server.delete("/api/settings/opentopo-key").status, 204, "there was none: the same")
        self.assertFalse(path.exists())

    def test_the_key_of_the_environment(self):
        server = self.new_server(env={"OPENTOPO_KEY": KEY})
        self.assertEqual(server.get("/api/settings").json()["opentopo_key"], "environment")
        self.upstream.table["opentopography"] = Answer(self.GRID.encode(), "text/plain")
        self.assertEqual(server.get(f"/api/earth/heights?{self.BOX}").status, 200)
        self.assertIn(KEY, self.upstream.asked[0])
        other_key = "f" * 32
        server.put("/api/settings/opentopo-key", {"key": other_key})
        self.assertEqual(server.get("/api/settings").json()["opentopo_key"], "page")
        server.get(f"/api/earth/heights?{self.BOX}")
        self.assertIn(other_key, self.upstream.asked[1], "the page's key first")
        server.delete("/api/settings/opentopo-key")
        self.assertEqual(server.get("/api/settings").json()["opentopo_key"], "environment")


class PlanetTest(ServerCase):
    def trek_heights(self, code: str, value):
        def answer(asked):
            cols, rows = size_asked(asked)
            return Answer(struct.pack(f"<{cols * rows}{code}", *([value] * (cols * rows))) + b"mask", "image/bsq")
        return answer

    def test_the_regions_that_are_refused(self):
        for query in ("south=10&north=5&west=0&east=1", "south=0&north=1&west=170&east=190", "south=0&north=1&east=1", "south=-91&north=0&west=0&east=1"):
            with self.subTest(query=query):
                self.assertEqual(self.server.get(f"/api/planet/heights?world=moon&{query}").status, 400)
        self.assertEqual(self.upstream.asked, [])

    def test_heights_are_read_as_float32_with_no_data(self):
        def answer(asked):
            cols, rows = size_asked(asked)
            values = [100.0, NODATA, 2.5, float("nan"), 2e6] + [1.0] * (cols * rows - 5)
            return Answer(struct.pack(f"<{cols * rows}f", *values) + b"mask", "image/bsq")
        self.upstream.table["LRO_LOLA"] = answer
        grid = self.server.get("/api/planet/heights?world=moon&source=trek&south=0&north=1&west=0&east=1&cells=64")
        self.assertEqual(grid.status, 200)
        self.assertEqual((grid.headers["X-Grid-Cols"], grid.headers["X-Grid-Rows"]), ("64", "64"))
        self.assertEqual(grid.headers["X-Grid-Source"], "LRO LOLA 118 m (NASA/GSFC)")
        self.assertEqual(grid.headers["X-Grid-Box"], "0.0,1.0,0.0,1.0")
        values = floats(grid.data)
        self.assertEqual(values[0], 100.0)
        self.assertTrue(all(math.isnan(v) for v in (values[1], values[3], values[4])))
        self.assertEqual(values[2], 2.5)

    def test_what_is_asked_of_trek(self):
        self.upstream.table["LRO_LOLA"] = self.trek_heights("f", 1.0)
        self.server.get("/api/planet/heights?world=moon&source=trek&south=-0.5&north=0.25&west=23.5&east=24.75")
        self.assertEqual(self.upstream.asked[0],
                         "https://trek.nasa.gov/moon/trekarcgis/rest/services/LRO_LOLA_DEM_Global_256ppd_v06/ImageServer/exportImage"
                         "?bbox=23.5%2C-0.5%2C24.75%2C0.25&size=320%2C192&f=image&format=bsq&pixelType=F32&noData=-32768"
                         "&interpolation=RSP_BilinearInterpolation")

    def test_the_size_asked_keeps_the_shape_within_its_limits(self):
        self.upstream.table["Mars_MOLA"] = self.trek_heights("h", 5)
        for box, cells, want in (("south=10&north=10.5&west=20&east=20.5", 1024, (148, 148)), ("south=10&north=10.1&west=20&east=20.5", 1024, (480, 96)),
                                 ("south=0&north=10&west=0&east=40", 1024, (1024, 256)), ("south=0&north=10&west=0&east=40", 512, (512, 128))):
            with self.subTest(box=box, cells=cells):
                grid = self.server.get(f"/api/planet/heights?world=mars&{box}&cells={cells}")
                self.assertEqual(grid.status, 200)
                self.assertEqual((int(grid.headers["X-Grid-Cols"]), int(grid.headers["X-Grid-Rows"])), want)

    def test_a_planet_grid_through_trek(self):
        self.upstream.table["Mars_MOLA"] = self.trek_heights("h", -1000)
        grid = self.server.get("/api/planet/heights?world=mars&south=10&north=10.5&west=20&east=20.5")
        self.assertEqual(floats(grid.data)[0], -1000)
        self.assertIn("pixelType=S16", self.upstream.asked[0])
        self.assertIn("HRSC-MOLA", grid.headers["X-Grid-Source"])

    def test_an_answer_cut_short_or_with_no_heights(self):
        self.upstream.table["Venus_Magellan"] = self.trek_heights("f", NODATA)
        none = self.server.get("/api/planet/heights?world=venus&south=0&north=5&west=0&east=5")
        self.assertEqual(none.status, 502)
        self.assertIn("no heights of venus", none.json()["error"])
        self.upstream.table["Venus_Magellan"] = Answer(b"\0" * 16, "image/bsq")
        cut = self.server.get("/api/planet/heights?world=venus&south=0&north=5&west=0&east=5")
        self.assertEqual(cut.status, 502)
        self.assertIn("bytes of heights", cut.json()["error"])
        self.upstream.table["Venus_Magellan"] = 500
        self.assertIn("HTTP 500", self.server.get("/api/planet/heights?world=venus&south=0&north=5&west=0&east=5").json()["error"])

    def test_venus_has_no_one_picture_imagery(self):
        answer = self.server.get("/api/planet/image?world=venus&south=0&north=1&west=0&east=1&width=100&height=100")
        self.assertEqual(answer.status, 400)
        self.assertEqual(self.upstream.asked, [])

    def test_a_picture_of_a_region(self):
        self.upstream.table["LRO_WAC"] = Answer(b"jpeg", "image/jpeg")
        answer = self.server.get("/api/planet/image?world=moon&south=0&north=1&west=0&east=1&width=100&height=50.9")
        self.assertEqual((answer.status, answer.data, answer.mimetype), (200, b"jpeg", "image/jpeg"))
        self.assertEqual(self.upstream.asked[0], "https://trek.nasa.gov/moon/trekarcgis/rest/services/LRO_WAC_Mosaic_Global_303ppd_v02/ImageServer/exportImage"
                                                 "?bbox=0.0%2C0.0%2C1.0%2C1.0&size=100%2C50&f=image&format=jpg")
        for query in ("width=1&height=50", "width=4097&height=50", "height=50", "width=a&height=50"):
            with self.subTest(query=query):
                self.assertEqual(self.server.get(f"/api/planet/image?world=moon&south=0&north=1&west=0&east=1&{query}").status, 400)
        self.upstream.table["LRO_WAC"] = Answer(b"<html>", "text/html")
        refused = self.server.get("/api/planet/image?world=moon&south=0&north=1&west=0&east=1&width=100&height=50")
        self.assertEqual(refused.status, 502)
        self.assertIn("no picture", refused.json()["error"])


class SldemTest(ServerCase):
    """The Moon's finer heights: a USGS file, int16, one range request a row."""
    PX = 59.2252938
    X0, Y0 = -5458203.076347, 1819401.025449
    FIRST_ROW = 984003
    WIDTH = 184320
    RADIUS = 1737400.0

    def row_of(self, lat):
        return (self.Y0 - self.RADIUS * math.radians(lat)) / self.PX - 0.5

    def col_of(self, lon):
        return (self.RADIUS * math.radians(lon) - self.X0) / self.PX - 0.5

    def file(self, asked):
        """A file whose every cell is its row plus its column, in half-metres, kept small by a remainder."""
        start, end = (int(v) for v in asked.headers["Range"].removeprefix("bytes=").split("-"))
        row = (start - self.FIRST_ROW) // (self.WIDTH * 2)
        col = (start - self.FIRST_ROW) % (self.WIDTH * 2) // 2
        width = (end - start + 1) // 2
        cells = [((row + col + i) % 20000) for i in range(width)]
        return Answer(struct.pack(f"<{width}h", *cells), "image/tiff", 206)

    def heights(self, more=""):
        return self.server.get(f"/api/planet/heights?world=moon&south=0.1&north=0.2&west=24.1&east=24.2{more}")

    def test_a_small_region_comes_from_the_finer_file(self):
        self.upstream.table["LolaKaguya"] = self.file
        grid = self.heights()
        self.assertEqual(grid.status, 200)
        self.assertEqual(grid.headers["X-Grid-Source"], "SLDEM2015 59 m (NASA/GSFC, JAXA)")
        cols, rows = int(grid.headers["X-Grid-Cols"]), int(grid.headers["X-Grid-Rows"])
        self.assertGreaterEqual(min(cols, rows), 96)
        values = floats(grid.data)
        self.assertEqual(len(values), cols * rows)
        first = (self.row_of(0.2) + self.col_of(24.1)) * 0.5
        self.assertLess(abs(values[0] - (first % 10000)), 0.6, "the north-west corner")
        self.assertEqual(self.upstream.requests[0].headers["User-Agent"], "planet-terrain-maker/1.0")
        self.assertTrue(all(r.url.startswith("https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/LolaKaguya_Topo/") for r in self.upstream.requests))

    def test_no_data_in_the_file_is_nan_and_left_out_between_cells(self):
        def file(asked):
            start, end = (int(v) for v in asked.headers["Range"].removeprefix("bytes=").split("-"))
            return Answer(struct.pack("<h", -32768) * ((end - start + 1) // 2), "image/tiff", 206)
        self.upstream.table["LolaKaguya"] = file
        values = floats(self.heights().data)
        self.assertTrue(all(math.isnan(v) for v in values))

    def test_trek_answers_when_the_file_fails_or_when_trek_is_asked(self):
        def trek(asked):
            cols, rows = size_asked(asked)
            return Answer(struct.pack(f"<{cols * rows}f", *([5.0] * (cols * rows))), "image/bsq")
        self.upstream.table.update({"LolaKaguya": 500, "LRO_LOLA": trek})
        self.assertEqual(self.heights().headers["X-Grid-Source"], "LRO LOLA 118 m (NASA/GSFC)")
        self.assertIn("SLDEM2015 failed", self.server.log())
        before = len([u for u in self.upstream.asked if "LolaKaguya" in u])
        self.assertEqual(self.heights("&source=trek").headers["X-Grid-Source"], "LRO LOLA 118 m (NASA/GSFC)")
        self.assertEqual(len([u for u in self.upstream.asked if "LolaKaguya" in u]), before, "asked for Trek: the file is not asked")
        self.upstream.table["LolaKaguya"] = Answer(b"\0\0", "image/tiff", 200)
        self.assertEqual(self.heights().headers["X-Grid-Source"], "LRO LOLA 118 m (NASA/GSFC)", "a whole file, not its range")

    def test_a_big_region_or_one_past_the_file_goes_to_trek(self):
        def trek(asked):
            cols, rows = size_asked(asked)
            return Answer(struct.pack(f"<{cols * rows}f", *([5.0] * (cols * rows))), "image/bsq")
        self.upstream.table["LRO_LOLA"] = trek
        for box in ("south=0&north=2&west=24&east=25", "south=59.8&north=60.1&west=24&east=24.1"):
            with self.subTest(box=box):
                grid = self.server.get(f"/api/planet/heights?world=moon&{box}")
                self.assertEqual(grid.headers["X-Grid-Source"], "LRO LOLA 118 m (NASA/GSFC)")


class NominatimTest(ServerCase):
    FOUND = [{"lat": "41.64", "lon": "41.63", "name": "Batumi", "display_name": "Batumi, Adjara, Georgia",
              "type": "city", "boundingbox": ["41.6", "41.7", "41.5", "41.7"]}]

    def test_search_reads_names_and_keeps_answers(self):
        self.upstream.table["/search"] = Answer(json.dumps(self.FOUND).encode(), "application/json")
        first = self.server.get("/api/search?q=%20%20Batumi%20&lang=ru").json()
        self.assertEqual(first, [{"name": "Batumi", "detail": "Adjara, Georgia", "lat": 41.64, "lon": 41.63,
                                  "kind": "city", "box": [41.6, 41.7, 41.5, 41.7]}])
        self.assertEqual(self.server.get("/api/search?q=batumi&lang=ru").json(), first)
        self.assertEqual(len(self.upstream.asked), 1, "the second answer was kept")
        self.assertEqual(self.upstream.asked[0], "https://nominatim.openstreetmap.org/search?format=jsonv2&q=Batumi&limit=8&addressdetails=0")
        self.assertEqual(self.upstream.requests[0].headers["Accept-Language"], "ru")
        self.assertEqual(self.server.get("/api/search?q=&lang=ru").json(), [])
        self.assertEqual(self.server.get("/api/search").json(), [])

    def test_what_nominatim_leaves_out(self):
        found = [{"lat": "1", "lon": "2", "display_name": "Sea, Coast, Land, Earth, Far"},
                 {"lat": "x", "lon": "2", "name": "no point"},
                 {"name": "no point at all"},
                 {"lat": "3", "lon": "4", "category": "place", "name": "Only", "boundingbox": ["1", "x", "2", "3"]},
                 {"lat": "5", "lon": "6", "name": "Short box", "boundingbox": ["1", "2"]}]
        self.upstream.table["/search"] = Answer(json.dumps(found).encode(), "application/json")
        self.assertEqual(self.server.get("/api/search?q=a").json(), [
            {"name": "Sea", "detail": "Coast, Land, Earth", "lat": 1.0, "lon": 2.0, "kind": None},
            {"name": "Only", "detail": "", "lat": 3.0, "lon": 4.0, "kind": "place"},
            {"name": "Short box", "detail": "", "lat": 5.0, "lon": 6.0, "kind": None}])
        self.upstream.table["/search"] = Answer(b'{"not": "a list"}', "application/json")
        self.assertEqual(self.server.get("/api/search?q=b").json(), [])

    def test_a_language_there_is_no_answer_in_is_english(self):
        self.upstream.table["/search"] = Answer(b"[]", "application/json")
        self.server.get("/api/search?q=a&lang=fr")
        self.assertEqual(self.upstream.requests[0].headers["Accept-Language"], "en")

    def test_one_request_a_second(self):
        self.upstream.table["/search"] = Answer(b"[]", "application/json")
        started = time.monotonic()
        for query in ("a", "b", "c"):
            self.server.get(f"/api/search?q={query}")
        self.assertGreaterEqual(time.monotonic() - started, 2.0)

    def test_the_place_at_a_point(self):
        self.upstream.table["/reverse"] = Answer(json.dumps({"name": "Batumi", "display_name": "Batumi, Adjara, Georgia"}).encode(), "application/json")
        self.assertEqual(self.server.get("/api/place?lat=41.64&lon=41.63&lang=ru").json(), {"name": "Batumi", "detail": "Adjara, Georgia"})
        self.assertEqual(self.upstream.asked[0], "https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=41.64000&lon=41.63000&zoom=10&addressdetails=0")
        self.server.get("/api/place?lat=41.6401&lon=41.6299&lang=ru")
        self.assertEqual(len(self.upstream.asked), 1, "the same place to within a thousandth of a degree")

    def test_reverse_at_sea_is_null(self):
        self.upstream.table["/reverse"] = Answer(b'{"error": "Unable to geocode"}', "application/json")
        answer = self.server.get("/api/place?lat=0&lon=-30")
        self.assertEqual((answer.status, answer.data), (200, b"null\n"))

    def test_a_failure_is_a_bad_gateway(self):
        self.upstream.table.update({"/search": 500, "/reverse": Answer(b"<html>", "text/html")})
        failed = self.server.get("/api/search?q=a")
        self.assertEqual(failed.status, 502)
        self.assertEqual(failed.json()["error"], "Nominatim: HTTP 500")
        failed = self.server.get("/api/place?lat=0&lon=0")
        self.assertEqual(failed.status, 502)
        self.assertIn("Nominatim", failed.json()["error"])


class BuildingsTest(ServerCase):
    ANSWER = {"elements": [
        {"type": "way", "tags": {"building": "yes", "height": "12 m"},
         "geometry": [{"lat": 0, "lon": 0}, {"lat": 0, "lon": 1}, {"lat": 1, "lon": 1}, {"lat": 0, "lon": 0}]},
        {"type": "relation", "tags": {"building": "yes", "building:levels": "4"}, "members": [
            {"role": "outer", "geometry": [{"lat": 2, "lon": 2}, {"lat": 2, "lon": 3}, {"lat": 3, "lon": 3}, {"lat": 2, "lon": 2}]},
            {"role": "inner", "geometry": [{"lat": 2.1, "lon": 2.1}, {"lat": 2.1, "lon": 2.2}, {"lat": 2.2, "lon": 2.2}, {"lat": 2.1, "lon": 2.1}]}]},
        {"type": "way", "tags": {"highway": "path"}, "geometry": []},
        {"type": "way", "tags": {"building": "no"}, "geometry": [{"lat": 0, "lon": 0}, {"lat": 0, "lon": 1}, {"lat": 1, "lon": 1}, {"lat": 0, "lon": 0}]},
        {"type": "way", "tags": {"building": "yes"}, "geometry": [{"lat": 0, "lon": 0}, {"lat": 0, "lon": 1}]},
    ]}
    BOX = "south=41.6&north=41.61&west=41.6&east=41.61"

    def overpass_says(self, data):
        self.upstream.table["overpass-api.de"] = Answer(json.dumps(data).encode(), "application/json")

    def test_heights_from_tags(self):
        square = [{"lat": 0, "lon": 0}, {"lat": 0, "lon": 1}, {"lat": 1, "lon": 1}, {"lat": 0, "lon": 0}]
        cases = [({"height": "12"}, 12), ({"height": "30'"}, 9.1), ({"height": "100 ft"}, 30.5), ({"height": "12,5 m"}, 12.5), ({"height": " 7 M "}, 7),
                 ({"building:levels": "4"}, 13), ({"building:levels": "2,5"}, 8.5), ({"height": "tall"}, 6), ({}, 6), ({"height": "0"}, 6),
                 ({"height": "1000"}, 6), ({"building:levels": "300"}, 6), ({"height": "tall", "building:levels": "1"}, 4), ({"height": 12}, 12)]
        self.overpass_says({"elements": [{"type": "way", "tags": {"building": "yes", **tags}, "geometry": square} for tags, _ in cases]})
        heights = [b["height"] for b in self.server.get(f"/api/buildings?{self.BOX}").json()["buildings"]]
        self.assertEqual(heights, [want for _, want in cases])

    def test_outer_rings_only_and_open_lines_left_out(self):
        self.overpass_says(self.ANSWER)
        answer = self.server.get(f"/api/buildings?{self.BOX}").json()
        self.assertEqual(answer["buildings"], [{"ring": [[0, 0], [1, 0], [1, 1]], "height": 12.0},
                                               {"ring": [[2, 2], [3, 2], [3, 3]], "height": 13.0}])
        self.assertIs(answer["cut"], False)
        self.assertEqual(answer["credit"], "© OpenStreetMap contributors (Overpass API)")

    def test_what_is_asked_of_overpass(self):
        self.overpass_says(self.ANSWER)
        self.server.get(f"/api/buildings?{self.BOX}")
        asked = self.upstream.requests[0]
        self.assertEqual((asked.method, asked.url), ("POST", "https://overpass-api.de/api/interpreter"))
        self.assertEqual(asked.headers["Content-Type"], "application/x-www-form-urlencoded")
        self.assertEqual(parse_qs(asked.body.decode())["data"], [
            '[out:json][timeout:40];(way["building"](41.60000,41.60000,41.61000,41.61000);'
            'relation["building"]["type"="multipolygon"](41.60000,41.60000,41.61000,41.61000););out tags geom;'])

    def test_the_next_server_when_one_fails_and_the_answer_is_kept(self):
        self.upstream.table.update({"overpass-api.de": 504, "kumi": Answer(json.dumps(self.ANSWER).encode(), "application/json")})
        first = self.server.get(f"/api/buildings?{self.BOX}")
        self.assertEqual(len(first.json()["buildings"]), 2)
        self.assertEqual(self.server.get(f"/api/buildings?{self.BOX}").data, first.data)
        self.assertEqual(len(self.upstream.asked), 2)
        kept = list((self.data / "cache" / "buildings").iterdir())
        self.assertEqual(len(kept), 1)
        self.assertRegex(kept[0].name, r"^[0-9a-f]{20}\.json$")
        self.assertEqual(kept[0].name, "4485baf900b37fbed6ad.json", "a name another version of this server finds too")

    def test_a_kept_answer_goes_old(self):
        self.overpass_says(self.ANSWER)
        self.server.get(f"/api/buildings?{self.BOX}")
        kept = next((self.data / "cache" / "buildings").iterdir())
        long_ago = time.time() - 31 * 86400
        os.utime(kept, (long_ago, long_ago))
        self.server.get(f"/api/buildings?{self.BOX}")
        self.assertEqual(len(self.upstream.asked), 2)

    def test_a_remark_of_an_error_or_something_that_is_not_json_goes_to_the_next(self):
        for answer in (Answer(json.dumps({"remark": "runtime error: Query timed out", "elements": []}).encode(), "application/json"),
                       Answer(b"<html>busy</html>", "text/html")):
            with self.subTest(answer=answer.body):
                self.upstream.table.clear()
                self.upstream.table.update({"overpass-api.de": answer, "kumi": Answer(b'{"elements": []}', "application/json")})
                box = f"south=41.6&north=41.61&west=41.6&east={41.61 + len(self.upstream.asked) / 1000}"
                self.assertEqual(self.server.get(f"/api/buildings?{box}").json()["buildings"], [])

    def test_no_server_answers(self):
        self.upstream.table[""] = Upstream.DROP
        answer = self.server.get(f"/api/buildings?{self.BOX}")
        self.assertEqual(answer.status, 502)
        self.assertRegex(answer.json()["error"], r"^No Overpass server answered: overpass-api\.de: .*; overpass\.kumi\.systems: .*; overpass\.private\.coffee: .*; maps\.mail\.ru: ")
        self.assertEqual(len(self.upstream.asked), 4)

    def test_big_regions_are_refused(self):
        answer = self.server.get("/api/buildings?south=40&north=41&west=40&east=41")
        self.assertEqual(answer.status, 400)
        self.assertIn("about 10 km", answer.json()["error"])
        self.assertEqual(self.server.get("/api/buildings?south=40&north=40.1&west=40&east=40.3").status, 400)
        self.assertEqual(self.upstream.asked, [])

    @unittest.skipIf(os.geteuid() == 0, "root writes where the test forbids it")
    def test_a_store_that_cannot_be_written_still_answers(self):
        self.overpass_says(self.ANSWER)
        (self.data / "cache").mkdir()
        (self.data / "cache").chmod(0o500)
        try:
            self.assertEqual(self.server.get(f"/api/buildings?{self.BOX}").status, 200)
            self.assertIn("not kept", self.server.log())
        finally:
            (self.data / "cache").chmod(0o700)


if __name__ == "__main__":
    unittest.main()
