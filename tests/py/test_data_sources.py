"""Heights grids, map tiles, OpenTopography, Trek, Nominatim and Overpass, with the services faked."""
import dataclasses
import json
import math
import os
import struct
import tempfile
import threading
import time
import unittest
from pathlib import Path

from fakes import Clock, FakeFetcher

from app.buildings import BuildingsUnavailable, Overpass, height_of, read_answer
from app.earth import COARSE, FINE, Copernicus, KeyNeeded, SourceFailed
from app.fetch import Answer, FetchError
from app.grids import Grid, parse_aaigrid
from app.keys import KeyStore
from app.places import Nominatim
from app.planets import PLANETS, NoHeights, PlanetSource, RegionError, check_region
from app.tiles import SOURCES, TileMissing, TileRelay

KEY = "0123456789abcdef0123456789abcdef"


def png(body=b"tile"):
    return Answer(body, "image/png")


class GridTest(unittest.TestCase):
    def test_bytes_are_float32_with_nan_for_no_height(self):
        grid = Grid(2, 2, [1.5, None, -3.0, 4.0], (0, 1, 0, 1), "test")
        values = struct.unpack("<4f", grid.to_bytes())
        self.assertEqual(values[0], 1.5)
        self.assertTrue(math.isnan(values[1]))
        self.assertEqual(grid.known, 3)
        self.assertEqual(grid.headers()["X-Grid-Cols"], "2")
        self.assertEqual(grid.headers()["X-Grid-Box"], "0,1,0,1")

    def test_a_grid_needs_its_values(self):
        with self.assertRaises(ValueError):
            Grid(2, 2, [1, 2, 3], (0, 1, 0, 1), "test")
        with self.assertRaises(ValueError):
            Grid(1, 5, [1] * 5, (0, 1, 0, 1), "test")

    def test_reduced_keeps_the_corners_and_averages(self):
        cols = rows = 9
        values = [float(c) for r in range(rows) for c in range(cols)]
        grid = Grid(cols, rows, values, (10, 11, 20, 21), "test").reduced(5)
        self.assertEqual((grid.cols, grid.rows), (5, 5))
        self.assertEqual(grid.box, (10, 11, 20, 21))
        row = list(grid.values[:5])
        self.assertEqual(row[0], 0.5)          # cells 0 and 1 (within half a step of 0)
        self.assertEqual(row[2], 4.0)          # cells 3, 4, 5
        self.assertEqual(row[4], 7.5)          # cells 7 and 8

    def test_reduced_leaves_out_cells_without_height(self):
        grid = Grid(3, 3, [None, None, None, None, 5.0, None, None, None, None], (0, 1, 0, 1), "t").reduced(2)
        self.assertEqual((grid.cols, grid.rows), (2, 2))
        self.assertTrue(all(v == 5.0 for v in grid.values))

    def test_reduced_does_nothing_within_the_limit(self):
        grid = Grid(3, 3, [0.0] * 9, (0, 1, 0, 1), "t")
        self.assertIs(grid.reduced(3), grid)

    def test_ascii_grid_by_its_corner_and_by_its_centre(self):
        text = "ncols 3\nnrows 2\nxllcorner 10.0\nyllcorner 40.0\ncellsize 0.5\nNODATA_value -9999\n1 2 3\n4 -9999 6\n"
        grid = parse_aaigrid(text, "src")
        self.assertEqual((grid.cols, grid.rows), (3, 2))
        self.assertEqual(grid.box, (40.25, 40.75, 10.25, 11.25))
        self.assertTrue(math.isnan(grid.values[4]))
        centre = parse_aaigrid("ncols 2\nnrows 2\nxllcenter 1\nyllcenter 2\ncellsize 1\n1 2 3 4\n", "src")
        self.assertEqual(centre.box, (2.0, 3.0, 1.0, 2.0))

    def test_ascii_grid_cut_short_or_without_a_header(self):
        with self.assertRaises(ValueError):
            parse_aaigrid("ncols 3\nnrows 3\nxllcorner 0\nyllcorner 0\ncellsize 1\n1 2 3\n", "src")
        with self.assertRaises(ValueError):
            parse_aaigrid("<html>Server busy</html>", "src")


class TileTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.root = Path(self.dir.name)

    def tearDown(self):
        self.dir.cleanup()

    def test_which_tiles_a_layer_has(self):
        earth, moon = SOURCES["earth-photo"], SOURCES["moon-wac"]
        self.assertTrue(earth.has(2, 3, 3))
        self.assertFalse(earth.has(2, 4, 0))
        self.assertTrue(moon.has(2, 7, 3), "plain degrees: twice as many columns as rows")
        self.assertFalse(moon.has(2, 8, 0))
        self.assertFalse(earth.has(20, 0, 0))
        self.assertFalse(earth.has(-1, 0, 0))
        self.assertIn("/3/5/2", SOURCES["earth-heights"].url_of(3, 5, 2), "terrarium is z/x/y")
        self.assertIn("/3/2/5", earth.url_of(3, 5, 2), "Esri is z/y/x")

    def test_a_tile_is_fetched_once_then_read_from_disk(self):
        fetcher = FakeFetcher({"World_Imagery": Answer(b"jpeg!", "image/jpeg")})
        relay = TileRelay(self.root, fetcher, 10 ** 9)
        first = relay.get(SOURCES["earth-photo"], 3, 1, 2)
        second = relay.get(SOURCES["earth-photo"], 3, 1, 2)
        self.assertEqual((first.body, first.cached, second.body, second.cached), (b"jpeg!", False, b"jpeg!", True))
        self.assertEqual(len(fetcher.asked), 1)

    def test_a_busy_service_is_asked_again_and_a_refusal_is_not(self):
        answers = [FetchError("HTTP 503", 503), FetchError("no answer: timed out"), Answer(b"jpeg!", "image/jpeg")]
        fetcher = FakeFetcher({"World_Imagery": lambda url: answers.pop(0)})
        pauses = []
        relay = TileRelay(self.root, fetcher, 10 ** 9, sleep=pauses.append)
        self.assertEqual(relay.get(SOURCES["earth-photo"], 3, 1, 2).body, b"jpeg!")
        self.assertEqual(pauses, list(TileRelay.REPEAT_AFTER))
        for error, asked in ((FetchError("HTTP 500", 500), 3), (FetchError("HTTP 403", 403), 1)):
            fetcher = FakeFetcher({"World_Imagery": error})
            relay = TileRelay(self.root, fetcher, 10 ** 9, sleep=lambda s: None)
            with self.assertRaises(FetchError):
                relay.get(SOURCES["earth-photo"], 4, 1, 2)
            self.assertEqual(len(fetcher.asked), asked, error)

    def test_one_service_gets_at_most_its_own_number_of_fetches_at_once(self):
        running, most, lock = [0], [0], threading.Lock()

        def slow(url):
            with lock:
                running[0] += 1
                most[0] = max(most[0], running[0])
            time.sleep(0.02)
            with lock:
                running[0] -= 1
            return Answer(b"jpeg!", "image/jpeg")

        relay = TileRelay(self.root, FakeFetcher({"World_Imagery": slow}), 10 ** 9)
        three = dataclasses.replace(SOURCES["earth-photo"], at_once=3)
        threads = [threading.Thread(target=relay.get, args=(three, 5, x, 3)) for x in range(20)]
        for th in threads:
            th.start()
        for th in threads:
            th.join()
        self.assertLessEqual(most[0], 3)
        self.assertGreater(most[0], 1, "the fetches still run side by side")

    def test_a_missing_tile_is_remembered_for_a_day(self):
        clock = Clock()
        fetcher = FakeFetcher({"World_Imagery": FetchError("HTTP 404", 404)})
        relay = TileRelay(self.root, fetcher, 10 ** 9, clock=clock)
        for _ in range(3):
            with self.assertRaises(TileMissing):
                relay.get(SOURCES["earth-photo"], 19, 1, 2)
        self.assertEqual(len(fetcher.asked), 1)
        missing = relay.path_of(SOURCES["earth-photo"], 19, 1, 2).with_suffix(".missing")
        os.utime(missing, (clock.now - 2 * 86400, clock.now - 2 * 86400))
        with self.assertRaises(TileMissing):
            relay.get(SOURCES["earth-photo"], 19, 1, 2)
        self.assertEqual(len(fetcher.asked), 2, "asked again after a day")

    def test_an_error_page_is_not_kept_as_a_tile(self):
        relay = TileRelay(self.root, FakeFetcher({"World_Imagery": Answer(b"<html>", "text/html")}), 10 ** 9)
        with self.assertRaises(FetchError):
            relay.get(SOURCES["earth-photo"], 3, 1, 2)
        self.assertFalse(relay.path_of(SOURCES["earth-photo"], 3, 1, 2).exists())

    def test_a_store_that_cannot_be_written_still_serves_the_tile(self):
        locked = self.root / "locked"
        locked.mkdir()
        locked.chmod(0o500)
        try:
            relay = TileRelay(locked / "tiles", FakeFetcher({"terrarium": png(b"t")}), 10 ** 9)
            tile = relay.get(SOURCES["earth-heights"], 5, 1, 1)
            self.assertEqual((tile.body, tile.cached), (b"t", False))
            self.assertIsNotNone(relay.unwritable)
        finally:
            locked.chmod(0o700)

    def test_trim_takes_the_tiles_served_longest_ago(self):
        relay = TileRelay(self.root, FakeFetcher({"terrarium": png(b"x" * 100)}), 250)
        layer = SOURCES["earth-heights"]
        for x in range(4):
            relay.get(layer, 5, x, 0)
            os.utime(relay.path_of(layer, 5, x, 0), (1000 + x, 1000 + x))
        self.assertEqual(relay.trim(), 2)
        self.assertFalse(relay.path_of(layer, 5, 0, 0).exists())
        self.assertTrue(relay.path_of(layer, 5, 3, 0).exists())


class CopernicusTest(unittest.TestCase):
    GRID = "ncols 2\nnrows 2\nxllcorner 41.5\nyllcorner 41.5\ncellsize 0.001\nNODATA_value -9999\n10 20\n30 40\n"

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.keys = KeyStore(Path(self.dir.name) / "keys" / "opentopo")

    def tearDown(self):
        self.dir.cleanup()

    def test_no_key_no_request(self):
        fetcher = FakeFetcher()
        with self.assertRaises(KeyNeeded):
            Copernicus(fetcher, self.keys).grid(41.5, 41.6, 41.5, 41.6, 500)
        self.assertEqual(fetcher.asked, [])

    def test_a_grid_comes_back_and_the_key_is_in_the_request_only(self):
        self.keys.set(KEY)
        fetcher = FakeFetcher({"opentopography": Answer(self.GRID.encode(), "text/plain")})
        grid = Copernicus(fetcher, self.keys).grid(41.5, 41.6, 41.5, 41.6, 500)
        self.assertEqual(list(grid.values), [10, 20, 30, 40])
        self.assertIn("demtype=COP30", fetcher.asked[0])
        self.assertIn(KEY, fetcher.asked[0])

    def test_refused_keys_and_quota_say_the_key_is_needed(self):
        self.keys.set(KEY)
        for answer in (FetchError("HTTP 401", 401), FetchError("HTTP 429", 429),
                       Answer(b"Error: invalid API key " + KEY.encode(), "text/plain")):
            with self.subTest(answer=answer), self.assertRaises(KeyNeeded) as caught:
                Copernicus(FakeFetcher({"opentopography": answer}), self.keys).grid(41.5, 41.6, 41.5, 41.6, 500)
            self.assertNotIn(KEY, str(caught.exception))

    def test_no_grid_is_a_failure_that_names_no_key(self):
        self.keys.set(KEY)
        with self.assertRaises(SourceFailed) as caught:
            Copernicus(FakeFetcher({"opentopography": Answer(b"busy, see " + KEY.encode(), "text/plain")}),
                       self.keys).grid(41.5, 41.6, 41.5, 41.6, 500)
        self.assertNotIn(KEY, str(caught.exception))

    def test_big_regions_take_the_90_m_model(self):
        self.assertIs(Copernicus.pick(40, 40.3, 40, 40.3), FINE)
        self.assertIs(Copernicus.pick(40, 41, 40, 41), COARSE)

    def test_the_page_gives_a_key_and_never_reads_it_back(self):
        self.assertIsNone(self.keys.where)
        self.keys.set(KEY)
        self.assertEqual(self.keys.where, "page")
        self.assertEqual(oct(self.keys.path.stat().st_mode & 0o777), "0o600")
        with self.assertRaises(ValueError):
            self.keys.set("short")
        self.keys.clear()
        self.assertEqual(KeyStore(self.keys.path, fallback=KEY).where, "environment")


class PlanetTest(unittest.TestCase):
    def test_regions_trek_cannot_answer_are_refused(self):
        for box in ((10, 5, 0, 1), (0, 1, 170, 190), (0, 1, None, 1), (-91, 0, 0, 1)):
            with self.subTest(box=box), self.assertRaises(RegionError):
                check_region(*box)

    def test_heights_are_read_as_float32_with_no_data(self):
        moon = PLANETS["moon"]
        cols, rows = moon.heights_size(0, 1, 0, 1, 64)
        self.assertEqual((cols, rows), (64, 64))
        values = [100.0, -32768.0, 2.5, float("nan")]
        parsed = moon.parse_heights(struct.pack("<4f", *values) + b"mask", (2, 2))
        self.assertEqual(parsed[0], 100.0)
        self.assertIsNone(parsed[1])
        self.assertIsNone(parsed[3])

    def test_a_planet_grid_through_trek(self):
        mars = PLANETS["mars"]
        size = mars.heights_size(10, 10.5, 20, 20.5, 1024)
        body = struct.pack(f"<{size[0] * size[1]}h", *([-1000] * (size[0] * size[1])))
        fetcher = FakeFetcher({"Mars_MOLA": Answer(body, "image/bsq")})
        grid = mars.grid(fetcher, 10, 10.5, 20, 20.5, 1024)
        self.assertEqual((grid.cols, grid.rows), size)
        self.assertEqual(grid.values[0], -1000)
        self.assertIn("pixelType=S16", fetcher.asked[0])

    def test_the_moon_s_finer_heights_can_be_left_out(self):
        class Fine:
            def covers(self, *box):
                return True

            def grid(self, south, north, west, east, max_cells):
                return Grid(2, 2, [1.0] * 4, (south, north, west, east), "SLDEM")

        moon = PlanetSource("moon", "LRO_LOLA_DEM", "F32", 1 / 256, None, "LOLA", "WAC", fine=Fine())
        size = moon.heights_size(0, 0.2, 0, 0.2, 64)
        cells = size[0] * size[1]
        fetcher = FakeFetcher({"LRO_LOLA_DEM": Answer(struct.pack(f"<{cells}f", *([5.0] * cells)), "image/bsq")})
        self.assertEqual(moon.grid(fetcher, 0, 0.2, 0, 0.2, 64).source, "SLDEM")
        self.assertEqual(fetcher.asked, [], "the finer source answered")
        self.assertEqual(moon.grid(fetcher, 0, 0.2, 0, 0.2, 64, finest=False).source, "LOLA")
        self.assertEqual(len(fetcher.asked), 1)

    def test_all_empty_is_no_heights(self):
        venus = PLANETS["venus"]
        size = venus.heights_size(0, 5, 0, 5, 1024)
        body = struct.pack(f"<{size[0] * size[1]}f", *([-32768.0] * (size[0] * size[1])))
        with self.assertRaises(NoHeights):
            venus.grid(FakeFetcher({"Venus_Magellan": Answer(body, "image/bsq")}), 0, 5, 0, 5, 1024)

    def test_venus_has_no_one_picture_imagery(self):
        self.assertFalse(PLANETS["venus"].has_image_service)
        with self.assertRaises(RegionError):
            PLANETS["venus"].image(FakeFetcher(), 0, 1, 0, 1, 100, 100)


class NominatimTest(unittest.TestCase):
    def test_search_reads_names_and_keeps_answers(self):
        found = [{"lat": "41.64", "lon": "41.63", "name": "Batumi", "display_name": "Batumi, Adjara, Georgia",
                  "type": "city", "boundingbox": ["41.6", "41.7", "41.5", "41.7"]}]
        fetcher = FakeFetcher({"/search": Answer(json.dumps(found).encode(), "application/json")})
        clock = Clock()
        places = Nominatim(fetcher, clock=clock, sleep=clock.sleep)
        first = places.search("  Batumi ", "ru")
        self.assertEqual(first, [{"name": "Batumi", "detail": "Adjara, Georgia", "lat": 41.64, "lon": 41.63,
                                  "kind": "city", "box": [41.6, 41.7, 41.5, 41.7]}])
        self.assertEqual(places.search("batumi", "ru"), first)
        self.assertEqual(len(fetcher.asked), 1, "the second answer was kept")
        self.assertEqual(places.search("", "ru"), [])

    def test_one_request_a_second(self):
        fetcher = FakeFetcher({"/search": Answer(b"[]", "application/json")})
        clock = Clock()
        places = Nominatim(fetcher, clock=clock, sleep=clock.sleep)
        start = clock.now
        places.search("a", "en")
        places.search("b", "en")
        places.search("c", "en")
        self.assertGreaterEqual(clock.now - start, 2.0)

    def test_reverse_at_sea_is_none(self):
        fetcher = FakeFetcher({"/reverse": Answer(b'{"error": "Unable to geocode"}', "application/json")})
        self.assertIsNone(Nominatim(fetcher, clock=Clock(), sleep=lambda s: None).reverse(0, -30, "en"))


class BuildingsTest(unittest.TestCase):
    ANSWER = {"elements": [
        {"type": "way", "tags": {"building": "yes", "height": "12 m"},
         "geometry": [{"lat": 0, "lon": 0}, {"lat": 0, "lon": 1}, {"lat": 1, "lon": 1}, {"lat": 0, "lon": 0}]},
        {"type": "relation", "tags": {"building": "yes", "building:levels": "4"}, "members": [
            {"role": "outer", "geometry": [{"lat": 2, "lon": 2}, {"lat": 2, "lon": 3}, {"lat": 3, "lon": 3}, {"lat": 2, "lon": 2}]},
            {"role": "inner", "geometry": [{"lat": 2.1, "lon": 2.1}, {"lat": 2.1, "lon": 2.2}, {"lat": 2.2, "lon": 2.2}, {"lat": 2.1, "lon": 2.1}]}]},
        {"type": "way", "tags": {"highway": "path"}, "geometry": []},
        {"type": "way", "tags": {"building": "yes"}, "geometry": [{"lat": 0, "lon": 0}, {"lat": 0, "lon": 1}]},
    ]}

    def test_heights_from_tags(self):
        self.assertEqual(height_of({"height": "12"}), 12)
        self.assertAlmostEqual(height_of({"height": "30'"}), 9.144)
        self.assertEqual(height_of({"building:levels": "4"}), 13)
        self.assertEqual(height_of({"height": "tall"}), 6.0)

    def test_outer_rings_only_and_open_lines_left_out(self):
        found = read_answer(self.ANSWER)
        self.assertEqual(found, [{"ring": [[0, 0], [1, 0], [1, 1]], "height": 12.0},
                                 {"ring": [[2, 2], [3, 2], [3, 3]], "height": 13.0}])
        with self.assertRaises(ValueError):
            read_answer({"remark": "runtime error: Query timed out", "elements": []})

    def test_the_next_server_when_one_fails_and_the_answer_is_kept(self):
        with tempfile.TemporaryDirectory() as tmp:
            fetcher = FakeFetcher({"overpass-api.de": FetchError("HTTP 504", 504),
                                   "kumi": Answer(json.dumps(self.ANSWER).encode(), "application/json")})
            overpass = Overpass(fetcher, Path(tmp), log=lambda *a: None)
            first = overpass.buildings(41.6, 41.61, 41.6, 41.61)
            self.assertEqual(len(first["buildings"]), 2)
            self.assertEqual(overpass.buildings(41.6, 41.61, 41.6, 41.61), first)
            self.assertEqual(len(fetcher.asked), 2)

    def test_no_server_answers(self):
        with tempfile.TemporaryDirectory() as tmp:
            overpass = Overpass(FakeFetcher({"": FetchError("no answer")}), Path(tmp), log=lambda *a: None)
            with self.assertRaises(BuildingsUnavailable):
                overpass.buildings(41.6, 41.61, 41.6, 41.61)

    def test_big_regions_are_refused(self):
        with self.assertRaises(ValueError):
            Overpass.check_region(40, 41, 40, 41)


if __name__ == "__main__":
    unittest.main()
