"""The routes, the library on disk, and the description of the API."""
import io
import json
import struct
import tempfile
import unittest
from pathlib import Path

from fakes import Clock, FakeFetcher

from app.apispec import build, markdown
from app.fetch import Answer
from app.library import TRASH_DAYS, Library, NotFound, Refused
from app.server import CSP, create_app

ROOT = Path(__file__).resolve().parents[2]
KEY = "0123456789abcdef0123456789abcdef"


class LibraryTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.clock = Clock(2_000_000_000)
        self.library = Library(Path(self.dir.name) / "models", Path(self.dir.name) / "trash", clock=self.clock)

    def tearDown(self):
        self.dir.cleanup()

    def test_save_list_open(self):
        meta = self.library.create({"name": "  Batumi  and   Elbrus ", "worlds": ["earth"],
                                    "places": [{"name": "Batumi", "world": "earth"}]},
                                   {"place-0.bin": b"\0" * 16, "thumb.jpg": b"jpg"})
        self.assertRegex(meta["id"], r"^[0-9a-f]{12}$")
        self.assertEqual(meta["name"], "Batumi and Elbrus")
        self.assertEqual(meta["files"], {"place-0.bin": 16, "thumb.jpg": 3})
        listed = self.library.list()
        self.assertEqual([m["id"] for m in listed], [meta["id"]])
        self.assertEqual(listed[0]["places"], [{"name": "Batumi", "world": "earth"}])
        self.assertEqual(self.library.file(meta["id"], "thumb.jpg").read_bytes(), b"jpg")

    def test_what_cannot_be_kept(self):
        for files in ({"../evil.bin": b""}, {"Place.BIN": b""}, {"a.exe": b""}):
            with self.subTest(files=files), self.assertRaises(Refused):
                self.library.create({"name": "x"}, files)
        with self.assertRaises(Refused):
            self.library.create({"name": "   "}, {})
        with self.assertRaises(Refused):
            self.library.create(["not", "an", "object"], {})
        for bad in ("../../etc", "ABCDEF123456", "x"):
            with self.subTest(id=bad), self.assertRaises(NotFound):
                self.library.get(bad)

    def test_save_again_keeps_the_id_and_the_day_it_was_made(self):
        first = self.library.create({"name": "a"}, {"place-0.bin": b"1"})
        again = self.library.replace(first["id"], {"name": "b"}, {"place-0.bin": b"22", "place-1.bin": b"3"})
        self.assertEqual((again["id"], again["created"], again["name"]), (first["id"], first["created"], "b"))
        self.assertEqual(self.library.file(first["id"], "place-0.bin").read_bytes(), b"22")
        self.assertEqual(sorted(p.name for p in (Path(self.dir.name) / "models").iterdir()), [first["id"]],
                         "no half-written folders left behind")

    def test_rename_and_remove_to_the_trash(self):
        meta = self.library.create({"name": "a"}, {})
        self.assertEqual(self.library.rename(meta["id"], "new name")["name"], "new name")
        self.library.remove(meta["id"])
        self.assertEqual(self.library.list(), [])
        trash = Path(self.dir.name) / "trash"
        self.assertEqual(len(list(trash.iterdir())), 1)
        self.clock.now += (TRASH_DAYS + 1) * 86400
        self.assertEqual(self.library.empty_trash(), 1)
        with self.assertRaises(NotFound):
            self.library.remove(meta["id"])


class ServerTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        grid = "ncols 2\nnrows 2\nxllcorner 41.5\nyllcorner 41.5\ncellsize 0.001\nNODATA_value -9999\n10 20\n30 -9999\n"
        self.fetcher = FakeFetcher({
            "World_Imagery": Answer(b"jpeg", "image/jpeg"),
            "opentopography": Answer(grid.encode(), "text/plain"),
        })
        self.app = create_app(Path(self.dir.name), fetcher=self.fetcher)
        self.client = self.app.test_client()

    def tearDown(self):
        self.dir.cleanup()

    def test_health_and_the_page(self):
        self.assertEqual(self.client.get("/healthz").get_json()["status"], "ok")
        page = self.client.get("/")
        self.assertEqual(page.status_code, 200)
        self.assertEqual(page.headers["Content-Security-Policy"], CSP)
        self.assertEqual(self.client.get("/../app/server.py").status_code, 404)
        self.assertEqual(self.client.get("/%2e%2e/app/server.py").status_code, 404)

    def test_tiles(self):
        ok = self.client.get("/api/tile/earth-photo/3/1/2")
        self.assertEqual((ok.status_code, ok.data, ok.mimetype), (200, b"jpeg", "image/jpeg"))
        self.assertIn("immutable", ok.headers["Cache-Control"])
        self.assertEqual(self.client.get("/api/tile/nowhere/3/1/2").status_code, 404)
        self.assertEqual(self.client.get("/api/tile/earth-photo/3/9/2").status_code, 404)

    def test_earth_heights_need_the_key_then_come_as_float32(self):
        self.assertEqual(self.client.get("/api/settings").get_json()["opentopo_key"], None)
        box = "south=41.5&north=41.6&west=41.5&east=41.6"
        refused = self.client.get(f"/api/earth/heights?{box}")
        self.assertEqual((refused.status_code, refused.get_json()["key_needed"]), (403, True))
        self.assertEqual(self.client.put("/api/settings/opentopo-key", json={"key": "x"}).status_code, 400)
        self.assertEqual(self.client.put("/api/settings/opentopo-key", json={"key": KEY}).status_code, 204)
        self.assertEqual(self.client.get("/api/settings").get_json()["opentopo_key"], "page")
        grid = self.client.get(f"/api/earth/heights?{box}")
        self.assertEqual(grid.status_code, 200)
        self.assertEqual((grid.headers["X-Grid-Cols"], grid.headers["X-Grid-Rows"]), ("2", "2"))
        values = struct.unpack("<4f", grid.data)
        self.assertEqual(values[:3], (10.0, 20.0, 30.0))
        self.assertNotEqual(values[3], values[3])
        self.assertNotIn(KEY, json.dumps(self.client.get("/openapi.json").get_json()))
        self.assertEqual(self.client.delete("/api/settings/opentopo-key").status_code, 204)
        self.assertEqual(self.client.get("/api/settings").get_json()["opentopo_key"], None)

    def test_each_world_s_map_can_open_where_it_was_set(self):
        self.assertEqual(self.client.get("/api/settings").get_json()["starts"], {})
        kept = self.client.put("/api/settings/start/moon", json={"lat": -0.598, "lon": 24.205, "zoom": 9.5})
        self.assertEqual(kept.get_json(), {"lat": -0.598, "lon": 24.205, "zoom": 9.5})
        self.assertEqual(self.client.get("/api/settings").get_json()["starts"], {"moon": {"lat": -0.598, "lon": 24.205, "zoom": 9.5}})
        for world, body in (("pluto", {"lat": 0, "lon": 0, "zoom": 3}), ("earth", {"lat": 95, "lon": 0, "zoom": 3}),
                            ("earth", {"lat": "x", "lon": 0, "zoom": 3}), ("earth", {})):
            with self.subTest(world=world, body=body):
                self.assertEqual(self.client.put(f"/api/settings/start/{world}", json=body).status_code, 400)
        self.assertEqual(self.client.delete("/api/settings/start/moon").status_code, 204)
        self.assertEqual(self.client.get("/api/settings").get_json()["starts"], {})
        self.assertEqual(self.client.delete("/api/settings/start/pluto").status_code, 400)

    def test_a_set_of_flight_speeds_is_kept_for_every_device(self):
        self.assertIsNone(self.client.get("/api/settings").get_json()["fly_preset"])
        rates = {"move": 0.05, "slide": 0.05, "climb": 0.01, "turn": 0.16, "tilt": 0.1, "bank": 0.5}
        self.assertEqual(self.client.put("/api/settings/fly-preset", json=rates).get_json(), rates)
        self.assertEqual(self.client.get("/api/settings").get_json()["fly_preset"], rates)
        for wrong in ({**rates, "turn": 2}, {**rates, "tilt": 0}, {"move": 0.5}, [1, 2]):
            with self.subTest(wrong=wrong):
                self.assertEqual(self.client.put("/api/settings/fly-preset", json=wrong).status_code, 400)
        self.assertEqual(self.client.get("/api/settings").get_json()["fly_preset"], rates, "a wrong set changes nothing")

    def test_wrong_regions_are_400(self):
        for query in ("south=1&north=0&west=0&east=1", "south=a&north=1&west=0&east=1", "north=1&west=0&east=1",
                      "south=0&north=1&west=0&east=1&cells=1", "south=0&north=1&west=0&east=181"):
            with self.subTest(query=query):
                self.assertEqual(self.client.get(f"/api/earth/heights?{query}").status_code, 400)
        self.assertEqual(self.client.get("/api/planet/heights?world=pluto&south=0&north=1&west=0&east=1").status_code, 400)
        self.assertEqual(self.client.get("/api/planet/heights?world=moon&south=0&north=1&west=0&east=1&source=sldem").status_code, 400)

    def test_models(self):
        meta = {"name": "Batumi", "worlds": ["earth"], "places": [{"name": "Batumi", "world": "earth"}]}
        created = self.client.post("/api/models", data={
            "meta": json.dumps(meta), "place-0.bin": (io.BytesIO(b"\0" * 8), "place-0.bin"),
            "thumb.jpg": (io.BytesIO(b"jpg"), "thumb.jpg")}, content_type="multipart/form-data")
        self.assertEqual(created.status_code, 201)
        model_id = created.get_json()["id"]
        self.assertEqual([m["id"] for m in self.client.get("/api/models").get_json()], [model_id])
        self.assertEqual(self.client.get(f"/api/models/{model_id}/files/thumb.jpg").data, b"jpg")
        self.assertEqual(self.client.patch(f"/api/models/{model_id}", json={"name": "Zürich"}).get_json()["name"], "Zürich")
        replaced = self.client.put(f"/api/models/{model_id}", data={"meta": json.dumps({**meta, "name": "B2"})},
                                   content_type="multipart/form-data")
        self.assertEqual(replaced.get_json()["files"], {})
        self.assertEqual(self.client.post("/api/models", data={"meta": "{not json"},
                                          content_type="multipart/form-data").status_code, 400)
        self.assertEqual(self.client.delete(f"/api/models/{model_id}").status_code, 204)
        self.assertEqual(self.client.get(f"/api/models/{model_id}").status_code, 404)

    def test_a_model_is_copied_with_its_files_under_a_new_id(self):
        meta = {"name": "Kobuleti and Sabine", "worlds": ["earth", "moon"], "settings": {"sizeMm": 120}}
        made = self.client.post("/api/models", data={
            "meta": json.dumps(meta), "place-0.bin": (io.BytesIO(b"\1" * 8), "place-0.bin"),
            "place-1.jpg": (io.BytesIO(b"jpeg"), "place-1.jpg")}, content_type="multipart/form-data").get_json()
        copy = self.client.post(f"/api/models/{made['id']}/copy", json={"name": "Kobuleti and Moltke"})
        self.assertEqual(copy.status_code, 201)
        copied = copy.get_json()
        self.assertNotEqual(copied["id"], made["id"])
        self.assertEqual((copied["name"], copied["settings"], copied["files"]), ("Kobuleti and Moltke", {"sizeMm": 120}, made["files"]))
        self.assertEqual(self.client.get(f"/api/models/{copied['id']}/files/place-1.jpg").data, b"jpeg")
        self.assertEqual(self.client.get(f"/api/models/{made['id']}").get_json()["name"], "Kobuleti and Sabine", "the model copied stays")
        self.assertEqual(len(self.client.get("/api/models").get_json()), 2)
        same_name = self.client.post(f"/api/models/{made['id']}/copy").get_json()
        self.assertEqual(same_name["name"], "Kobuleti and Sabine", "no name sent: the copy keeps the name")
        self.assertEqual(self.client.post(f"/api/models/{made['id']}/copy", json={"name": "  "}).status_code, 400)
        self.assertEqual(self.client.post("/api/models/0123456789ab/copy").status_code, 404)

    def test_a_model_and_its_places_are_renamed(self):
        meta = {"name": "Onsky and Sabine", "places": [{"name": "Oni Municipality", "world": "earth"}, {"name": "Sabine", "world": "moon"}]}
        made = self.client.post("/api/models", data={"meta": json.dumps(meta)}, content_type="multipart/form-data").get_json()
        renamed = self.client.patch(f"/api/models/{made['id']}", json={"name": "Batumi and Sabine", "places": ["Bāt'umi", "Sabine"]}).get_json()
        self.assertEqual((renamed["name"], [p["name"] for p in renamed["places"]]), ("Batumi and Sabine", ["Bāt'umi", "Sabine"]))
        self.assertEqual(self.client.get("/api/models").get_json()[0]["places"][0]["name"], "Bāt'umi")
        for wrong in (["one"], ["a", " "], "Batumi"):
            with self.subTest(wrong=wrong):
                self.assertEqual(self.client.patch(f"/api/models/{made['id']}", json={"name": "x", "places": wrong}).status_code, 400)
        self.assertEqual(self.client.get(f"/api/models/{made['id']}").get_json()["name"], "Batumi and Sabine", "a refused rename changes nothing")

    def test_a_big_picture_comes_smaller_to_a_device_that_asks(self):
        from PIL import Image
        picture = io.BytesIO()
        Image.new("RGB", (1200, 800), (40, 120, 60)).save(picture, "JPEG", quality=90)
        made = self.client.post("/api/models", data={
            "meta": json.dumps({"name": "Big"}), "place-0.jpg": (io.BytesIO(picture.getvalue()), "place-0.jpg"),
            "place-0.bin": (io.BytesIO(b"\0" * 8), "place-0.bin")}, content_type="multipart/form-data").get_json()
        url = f"/api/models/{made['id']}/files/place-0.jpg"
        self.assertEqual(self.client.get(url).data, picture.getvalue(), "asked for nothing: the picture as it is")
        small = self.client.get(f"{url}?most=300")
        self.assertEqual((small.status_code, small.mimetype), (200, "image/jpeg"))
        self.assertEqual(Image.open(io.BytesIO(small.data)).size, (300, 200))
        self.assertEqual(self.client.get(f"{url}?most=300").data, small.data, "made once, kept")
        self.assertEqual(self.client.get(f"{url}?most=2000").data, picture.getvalue(), "already small enough")
        self.assertEqual(self.client.get(f"{url}?most=10").status_code, 400)
        self.assertEqual(self.client.get(f"/api/models/{made['id']}/files/place-0.bin?most=300").data, b"\0" * 8, "only pictures shrink")

    def test_the_page_s_errors_are_kept_for_reading_from_another_device(self):
        self.client.post("/api/client-error", json={"message": "the picture of the model came out blank", "where": "picture",
                                                    "details": {"width": 8192, "touch": True}, "agent": "iPad"})
        kept = self.client.get("/api/client-errors?last=5").get_json()["errors"]
        self.assertEqual(kept[-1]["message"], "the picture of the model came out blank")
        self.assertEqual(json.loads(kept[-1]["details"]), {"width": 8192, "touch": True})
        self.assertEqual(kept[-1]["agent"], "iPad")

    def test_clearing_the_cache_is_said_only_to_the_browser_that_asks(self):
        answer = self.client.post("/api/clear-cache")
        self.assertEqual(answer.status_code, 204)
        self.assertEqual(answer.headers["Clear-Site-Data"], '"cache"', "the cache only: not the choices kept")
        self.assertNotIn("Clear-Site-Data", self.client.get("/api/settings").headers)

    def test_a_folder_that_cannot_be_written_is_said_plainly(self):
        locked = Path(self.dir.name) / "models"
        locked.mkdir()
        locked.chmod(0o500)
        try:
            answer = self.client.post("/api/models", data={"meta": json.dumps({"name": "x"})}, content_type="multipart/form-data")
            self.assertEqual(answer.status_code, 503)
            self.assertTrue(answer.get_json()["cannot_write"])
        finally:
            locked.chmod(0o700)

    def test_page_errors_go_to_the_log_at_most_30_a_minute(self):
        codes = [self.client.post("/api/client-error", json={"message": "boom"}).status_code for _ in range(31)]
        self.assertEqual(codes[:30], [204] * 30)
        self.assertEqual(codes[30], 429)


class ApiDescriptionTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.app = create_app(Path(self.dir.name), fetcher=FakeFetcher())
        self.spec = build(self.app, "abc1234")

    def tearDown(self):
        self.dir.cleanup()

    def test_every_route_is_described_with_a_summary(self):
        operations = [(path, method, op) for path, ops in self.spec["paths"].items() for method, op in ops.items()]
        routes = [(rule.rule, m) for rule in self.app.url_map.iter_rules() for m in rule.methods - {"HEAD", "OPTIONS"}]
        self.assertEqual(len(operations), len(routes))
        for path, method, op in operations:
            with self.subTest(route=f"{method} {path}"):
                self.assertTrue(op["summary"], "a summary")
                self.assertEqual(op["security"], [], "open, as the app is")
        self.assertEqual(self.spec["openapi"], "3.1.0")
        self.assertEqual(self.spec["info"]["version"], "abc1234")

    def test_query_parameters_are_named(self):
        names = [p["name"] for p in self.spec["paths"]["/api/earth/heights"]["get"]["parameters"]]
        self.assertEqual(names, ["south", "north", "west", "east", "cells", "source"])
        path_params = [p["name"] for p in self.spec["paths"]["/api/tile/{source}/{z}/{x}/{y}"]["get"]["parameters"]]
        self.assertEqual(path_params, ["source", "z", "x", "y"])

    def test_the_page_for_people_is_made_from_the_description(self):
        made = markdown(build(self.app, None))
        written = (ROOT / "docs" / "http-api.md").read_text()
        self.assertEqual(written, made, "run: python3 -m app.apispec > docs/http-api.md")


if __name__ == "__main__":
    unittest.main()
