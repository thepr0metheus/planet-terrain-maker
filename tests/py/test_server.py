"""The routes and the library on disk, over HTTP."""
import io
import json
import os
import re
import struct
import time
import unittest
from pathlib import Path

from helpers import Answer, ServerCase, Upstream
from PIL import Image

KEY = "0123456789abcdef0123456789abcdef"
GRID = "ncols 2\nnrows 2\nxllcorner 41.5\nyllcorner 41.5\ncellsize 0.001\nNODATA_value -9999\n10 20\n30 -9999\n"
TRASH_DAYS = 30


def picture(kind, size=(1200, 800)):
    out = io.BytesIO()
    Image.new("RGB", size, (40, 120, 60)).save(out, kind)
    return out.getvalue()


class LibraryTest(ServerCase):
    def test_save_list_open(self):
        answer = self.server.post("/api/models", form={"meta": json.dumps({
            "name": "  Batumi  and   Elbrus ", "worlds": ["earth"], "places": [{"name": "Batumi", "world": "earth"}]})},
            files={"place-0.bin": b"\0" * 16, "thumb.jpg": b"jpg"})
        self.assertEqual(answer.status, 201)
        meta = answer.json()
        self.assertRegex(meta["id"], r"^[0-9a-f]{12}$")
        self.assertEqual(meta["name"], "Batumi and Elbrus")
        self.assertEqual(meta["files"], {"place-0.bin": 16, "thumb.jpg": 3})
        listed = self.server.get("/api/models").json()
        self.assertEqual([m["id"] for m in listed], [meta["id"]])
        self.assertEqual(listed[0]["places"], [{"name": "Batumi", "world": "earth"}])
        self.assertEqual(listed[0]["files"], ["place-0.bin", "thumb.jpg"])
        self.assertEqual(self.server.get(f"/api/models/{meta['id']}/files/thumb.jpg").data, b"jpg")
        self.assertEqual(self.server.get(f"/api/models/{meta['id']}").json(), meta)

    def test_what_cannot_be_kept(self):
        for name in ("../evil.bin", "Place.BIN", "a.exe", "-a.bin", "a" * 42 + ".bin"):
            with self.subTest(file=name):
                answer = self.server.post("/api/models", form={"meta": json.dumps({"name": "x"})}, files={name: b""})
                self.assertEqual(answer.status, 400)
                self.assertIn("may not be called", answer.json()["error"])
        self.assertEqual(self.server.post("/api/models", form={"meta": json.dumps({"name": "   "})}).status, 400)
        self.assertEqual(self.server.post("/api/models", form={"meta": json.dumps(["not", "an", "object"])}).status, 400)
        self.assertEqual(self.server.post("/api/models", form={"meta": "{not json"}).status, 400)
        self.assertEqual(self.server.post("/api/models", form={}).status, 400)
        many = {f"p-{i}.bin": b"" for i in range(17)}
        self.assertIn("At most 16", self.server.post("/api/models", form={"meta": json.dumps({"name": "x"})}, files=many).json()["error"])
        for bad in ("..%2F..%2Fetc", "ABCDEF123456", "x"):
            with self.subTest(id=bad):
                self.assertEqual(self.server.get(f"/api/models/{bad}").status, 404)
        self.assertEqual(self.server.get("/api/models").json(), [])

    def test_save_again_keeps_the_id_and_the_day_it_was_made(self):
        first = self.server.save_model({"name": "a"}, {"place-0.bin": b"1"})
        again = self.server.put(f"/api/models/{first['id']}", form={"meta": json.dumps({"name": "b"})},
                                files={"place-0.bin": b"22", "place-1.bin": b"3"}).json()
        self.assertEqual((again["id"], again["created"], again["name"]), (first["id"], first["created"], "b"))
        self.assertEqual(self.server.get(f"/api/models/{first['id']}/files/place-0.bin").data, b"22")
        self.assertEqual(sorted(p.name for p in (self.data / "models").iterdir()), [first["id"]], "no half-written folders left behind")
        self.assertEqual(self.server.put("/api/models/0123456789ab", form={"meta": json.dumps({"name": "b"})}).status, 404)

    def test_rename_and_remove_to_the_trash(self):
        meta = self.server.save_model({"name": "a"})
        self.assertEqual(self.server.patch(f"/api/models/{meta['id']}", {"name": "new name"}).json()["name"], "new name")
        self.assertEqual(self.server.delete(f"/api/models/{meta['id']}").status, 204)
        self.assertEqual(self.server.get("/api/models").json(), [])
        self.assertEqual(self.server.delete(f"/api/models/{meta['id']}").status, 404)
        kept = list((self.data / "trash").iterdir())
        self.assertEqual(len(kept), 1)
        self.assertRegex(kept[0].name, rf"^{meta['id']}-\d+$")

    def test_the_trash_is_emptied_of_what_lies_there_too_long(self):
        trash = self.data / "trash"
        now = int(time.time())
        for name in (f"aaaaaaaaaaaa-{now - (TRASH_DAYS + 1) * 86400}", f"bbbbbbbbbbbb-{now - (TRASH_DAYS - 1) * 86400}", "not-a-stamp"):
            (trash / name).mkdir(parents=True)
            (trash / name / "meta.json").write_text("{}")
        meta = self.server.save_model({"name": "a"})
        self.server.delete(f"/api/models/{meta['id']}")
        left = sorted(p.name.rpartition("-")[0] for p in trash.iterdir())
        self.assertEqual(left, sorted([meta["id"], "bbbbbbbbbbbb", "not-a"]))

    def test_a_folder_that_is_not_a_model_is_left_out_and_the_last_changed_comes_first(self):
        older = self.server.save_model({"name": "older"})
        newer = self.server.save_model({"name": "newer"})
        meta_of = self.data / "models" / older["id"] / "meta.json"
        written = json.loads(meta_of.read_text())
        written["updated"] = "2020-01-01T00:00:00+00:00"
        meta_of.write_text(json.dumps(written))
        (self.data / "models" / "not-a-model").mkdir()
        (self.data / "models" / "0123456789ab").mkdir()
        (self.data / "models" / "ffffffffffff").mkdir()
        (self.data / "models" / "ffffffffffff" / "meta.json").write_text("{broken")
        self.assertEqual([m["id"] for m in self.server.get("/api/models").json()], [newer["id"], older["id"]])

    def test_a_file_that_is_not_in_the_model(self):
        meta = self.server.save_model({"name": "a"}, {"place-0.bin": b"1"})
        for name in ("place-1.bin", "meta.json", "..%2Fmeta.json"):
            with self.subTest(name=name):
                self.assertEqual(self.server.get(f"/api/models/{meta['id']}/files/{name}").status, 404)
        self.assertEqual(self.server.get("/api/models/0123456789ab/files/place-0.bin").status, 404)

    def test_what_a_model_says_is_kept_with_fields_nobody_here_knows(self):
        meta = self.server.save_model({"name": "a", "settings": {"sizeMm": 120, "ratio": 1.5, "note": "ბათუმი"}, "z": None, "b": [1, 2.0]})
        written = json.loads((self.data / "models" / meta["id"] / "meta.json").read_text())
        self.assertEqual(written["settings"], {"sizeMm": 120, "ratio": 1.5, "note": "ბათუმი"})
        self.assertEqual(list(written), ["name", "settings", "z", "b", "files", "id", "created", "updated"], "in the order they came")
        self.assertIn("ბათუმი", (self.data / "models" / meta["id"] / "meta.json").read_text(), "letters as they are")
        renamed = self.server.patch(f"/api/models/{meta['id']}", {"name": "c"}).json()
        self.assertEqual(renamed["settings"]["note"], "ბათუმი")
        self.assertEqual(renamed["b"], [1, 2.0])

    def test_the_limits_of_a_name_and_of_meta(self):
        meta = self.server.save_model({"name": "ა" * 200})
        self.assertEqual(meta["name"], "ა" * 120, "in letters, not in bytes")
        far = self.server.post("/api/models", form={"meta": json.dumps({"name": "x", "big": "a" * (513 * 1024)})})
        self.assertIn(far.status, (400, 413), "over the limit, one way or the other")


class ServerTest(ServerCase):
    SERVICES = {"World_Imagery": Answer(b"jpeg", "image/jpeg"), "opentopography": Answer(GRID.encode(), "text/plain")}

    def test_health_and_the_page(self):
        health = self.server.get("/healthz").json()
        self.assertEqual(health["status"], "ok")
        self.assertIn("version", health)
        page = self.server.get("/")
        self.assertEqual(page.status, 200)
        self.assertIn("default-src 'self'", page.headers["Content-Security-Policy"])
        self.assertEqual(self.server.get("/../app/server.py").status, 404)
        self.assertEqual(self.server.get("/%2e%2e/app/server.py").status, 404)
        self.assertEqual(self.server.get("/../Cargo.toml").status, 404)

    def test_tiles(self):
        ok = self.server.get("/api/tile/earth-photo/3/1/2")
        self.assertEqual((ok.status, ok.data, ok.mimetype), (200, b"jpeg", "image/jpeg"))
        self.assertIn("immutable", ok.headers["Cache-Control"])
        self.assertEqual(self.server.get("/api/tile/nowhere/3/1/2").status, 404)
        self.assertEqual(self.server.get("/api/tile/earth-photo/3/9/2").status, 404)

    def test_earth_heights_need_the_key_then_come_as_float32(self):
        self.assertEqual(self.server.get("/api/settings").json()["opentopo_key"], None)
        box = "south=41.5&north=41.6&west=41.5&east=41.6"
        refused = self.server.get(f"/api/earth/heights?{box}")
        self.assertEqual((refused.status, refused.json()["key_needed"]), (403, True))
        self.assertEqual(self.server.put("/api/settings/opentopo-key", {"key": "x"}).status, 400)
        self.assertEqual(self.server.put("/api/settings/opentopo-key", {"key": KEY}).status, 204)
        self.assertEqual(self.server.get("/api/settings").json()["opentopo_key"], "page")
        grid = self.server.get(f"/api/earth/heights?{box}")
        self.assertEqual(grid.status, 200)
        self.assertEqual(grid.mimetype, "application/octet-stream")
        self.assertEqual((grid.headers["X-Grid-Cols"], grid.headers["X-Grid-Rows"]), ("2", "2"))
        self.assertEqual(grid.headers["X-Grid-Box"], "41.5005,41.5015,41.5005,41.5015")
        self.assertIn("OpenTopography", grid.headers["X-Grid-Source"])
        values = struct.unpack("<4f", grid.data)
        self.assertEqual(values[:3], (10.0, 20.0, 30.0))
        self.assertNotEqual(values[3], values[3])
        self.assertNotIn(KEY, self.server.get("/openapi.json").data.decode())
        self.assertNotIn(KEY, self.server.get("/api/settings").data.decode())
        self.assertNotIn(KEY, self.server.log())
        self.assertEqual(self.server.delete("/api/settings/opentopo-key").status, 204)
        self.assertEqual(self.server.get("/api/settings").json()["opentopo_key"], None)

    def test_each_world_s_map_can_open_where_it_was_set(self):
        self.assertEqual(self.server.get("/api/settings").json()["starts"], {})
        kept = self.server.put("/api/settings/start/moon", {"lat": -0.598, "lon": 24.205, "zoom": 9.5})
        self.assertEqual(kept.json(), {"lat": -0.598, "lon": 24.205, "zoom": 9.5})
        self.assertEqual(self.server.get("/api/settings").json()["starts"], {"moon": {"lat": -0.598, "lon": 24.205, "zoom": 9.5}})
        rounded = self.server.put("/api/settings/start/earth", {"lat": 41.123456789, "lon": 5, "zoom": 3.14159}).json()
        self.assertEqual(rounded, {"lat": 41.123457, "lon": 5.0, "zoom": 3.14})
        self.assertIn(b'"lon":5.0', self.server.put("/api/settings/start/earth", {"lat": 41, "lon": 5, "zoom": 3}).data)
        for world, body in (("pluto", {"lat": 0, "lon": 0, "zoom": 3}), ("earth", {"lat": 95, "lon": 0, "zoom": 3}),
                            ("earth", {"lat": "x", "lon": 0, "zoom": 3}), ("earth", {}), ("earth", {"lat": 0, "lon": 181, "zoom": 3}),
                            ("earth", {"lat": 0, "lon": 0, "zoom": 23})):
            with self.subTest(world=world, body=body):
                self.assertEqual(self.server.put(f"/api/settings/start/{world}", body).status, 400)
        self.assertEqual(self.server.delete("/api/settings/start/moon").status, 204)
        self.assertEqual(list(self.server.get("/api/settings").json()["starts"]), ["earth"])
        self.assertEqual(self.server.delete("/api/settings/start/pluto").status, 400)

    def test_a_setting_nobody_here_knows_stays_in_the_file(self):
        (self.data / "settings.json").write_text(json.dumps({"later": {"a": 1}, "starts": {"pluto": {"lat": 1}}}))
        self.assertEqual(self.server.get("/api/settings").json()["starts"], {}, "a world there is not is not shown")
        self.server.put("/api/settings/start/moon", {"lat": 1, "lon": 2, "zoom": 3})
        written = json.loads((self.data / "settings.json").read_text())
        self.assertEqual(written["later"], {"a": 1})
        self.assertEqual(written["starts"]["pluto"], {"lat": 1})

    def test_a_set_of_flight_speeds_is_kept_for_every_device(self):
        self.assertIsNone(self.server.get("/api/settings").json()["fly_preset"])
        rates = {"move": 0.05, "slide": 0.05, "climb": 0.01, "turn": 0.16, "tilt": 0.1, "bank": 0.5}
        self.assertEqual(self.server.put("/api/settings/fly-preset", rates).json(), rates)
        self.assertEqual(self.server.get("/api/settings").json()["fly_preset"], rates)
        for wrong in ({**rates, "turn": 2}, {**rates, "tilt": 0}, {"move": 0.5}, [1, 2]):
            with self.subTest(wrong=wrong):
                self.assertEqual(self.server.put("/api/settings/fly-preset", wrong).status, 400)
        self.assertEqual(self.server.put("/api/settings/fly-preset", data=b"nope", content_type="text/plain").status, 400)
        self.assertEqual(self.server.get("/api/settings").json()["fly_preset"], rates, "a wrong set changes nothing")

    def test_wrong_regions_are_400(self):
        for query in ("south=1&north=0&west=0&east=1", "south=a&north=1&west=0&east=1", "north=1&west=0&east=1",
                      "south=0&north=1&west=0&east=1&cells=1", "south=0&north=1&west=0&east=181",
                      "south=0&north=1&west=0&east=1&cells=a", "south=0&north=1&west=0&east=1&cells=1025",
                      "south=nan&north=1&west=0&east=1", "south=-inf&north=1&west=0&east=1"):
            with self.subTest(query=query):
                self.assertEqual(self.server.get(f"/api/earth/heights?{query}").status, 400)
        self.assertEqual(self.server.get("/api/planet/heights?world=pluto&south=0&north=1&west=0&east=1").status, 400)
        self.assertEqual(self.server.get("/api/planet/heights?world=moon&south=0&north=1&west=0&east=1&source=sldem").status, 400)
        self.assertEqual(self.server.get("/api/buildings?south=0&north=1&west=0&east=1").status, 400)
        self.assertEqual(self.server.get("/api/place?lat=91&lon=0").status, 400)

    def test_models(self):
        meta = {"name": "Batumi", "worlds": ["earth"], "places": [{"name": "Batumi", "world": "earth"}]}
        created = self.server.post("/api/models", form={"meta": json.dumps(meta)}, files={"place-0.bin": b"\0" * 8, "thumb.jpg": b"jpg"})
        self.assertEqual(created.status, 201)
        model_id = created.json()["id"]
        self.assertEqual([m["id"] for m in self.server.get("/api/models").json()], [model_id])
        self.assertEqual(self.server.get(f"/api/models/{model_id}/files/thumb.jpg").data, b"jpg")
        self.assertEqual(self.server.patch(f"/api/models/{model_id}", {"name": "Zürich"}).json()["name"], "Zürich")
        replaced = self.server.put(f"/api/models/{model_id}", form={"meta": json.dumps({**meta, "name": "B2"})})
        self.assertEqual(replaced.json()["files"], {})
        self.assertEqual(self.server.post("/api/models", form={"meta": "{not json"}).status, 400)
        self.assertEqual(self.server.delete(f"/api/models/{model_id}").status, 204)
        self.assertEqual(self.server.get(f"/api/models/{model_id}").status, 404)

    def test_a_model_is_copied_with_its_files_under_a_new_id(self):
        meta = {"name": "Kobuleti and Sabine", "worlds": ["earth", "moon"], "settings": {"sizeMm": 120}}
        made = self.server.save_model(meta, {"place-0.bin": b"\1" * 8, "place-1.jpg": b"jpeg"})
        copy = self.server.post(f"/api/models/{made['id']}/copy", {"name": "Kobuleti and Moltke"})
        self.assertEqual(copy.status, 201)
        copied = copy.json()
        self.assertNotEqual(copied["id"], made["id"])
        self.assertEqual((copied["name"], copied["settings"], copied["files"]), ("Kobuleti and Moltke", {"sizeMm": 120}, made["files"]))
        self.assertEqual(self.server.get(f"/api/models/{copied['id']}/files/place-1.jpg").data, b"jpeg")
        self.assertEqual(self.server.get(f"/api/models/{made['id']}").json()["name"], "Kobuleti and Sabine", "the model copied stays")
        self.assertEqual(len(self.server.get("/api/models").json()), 2)
        same_name = self.server.post(f"/api/models/{made['id']}/copy").json()
        self.assertEqual(same_name["name"], "Kobuleti and Sabine", "no name sent: the copy keeps the name")
        self.assertEqual(self.server.post(f"/api/models/{made['id']}/copy", {"name": "  "}).status, 400)
        self.assertEqual(self.server.post("/api/models/0123456789ab/copy").status, 404)
        self.assertEqual(sorted(p.name for p in (self.data / "models").iterdir() if p.name.startswith(".")), [], "nothing half-written")

    def test_a_model_and_its_places_are_renamed(self):
        meta = {"name": "Onsky and Sabine", "places": [{"name": "Oni Municipality", "world": "earth"}, {"name": "Sabine", "world": "moon"}]}
        made = self.server.save_model(meta)
        renamed = self.server.patch(f"/api/models/{made['id']}", {"name": "Batumi and Sabine", "places": ["Bāt'umi", "Sabine"]}).json()
        self.assertEqual((renamed["name"], [p["name"] for p in renamed["places"]]), ("Batumi and Sabine", ["Bāt'umi", "Sabine"]))
        self.assertEqual(self.server.get("/api/models").json()[0]["places"][0]["name"], "Bāt'umi")
        for wrong in (["one"], ["a", " "], "Batumi"):
            with self.subTest(wrong=wrong):
                self.assertEqual(self.server.patch(f"/api/models/{made['id']}", {"name": "x", "places": wrong}).status, 400)
        self.assertEqual(self.server.get(f"/api/models/{made['id']}").json()["name"], "Batumi and Sabine", "a refused rename changes nothing")
        self.assertEqual(self.server.patch(f"/api/models/{made['id']}", {}).status, 400)
        self.assertEqual(self.server.patch("/api/models/0123456789ab", {"name": "x"}).status, 404)

    def test_a_big_picture_comes_smaller_to_a_device_that_asks(self):
        body = picture("JPEG")
        made = self.server.save_model({"name": "Big"}, {"place-0.jpg": body, "place-0.bin": b"\0" * 8})
        url = f"/api/models/{made['id']}/files/place-0.jpg"
        self.assertEqual(self.server.get(url).data, body, "asked for nothing: the picture as it is")
        small = self.server.get(f"{url}?most=300")
        self.assertEqual((small.status, small.mimetype), (200, "image/jpeg"))
        with Image.open(io.BytesIO(small.data)) as image:
            self.assertEqual((image.format, image.size), ("JPEG", (300, 200)))
        self.assertEqual(self.server.get(f"{url}?most=300").data, small.data, "made once, kept")
        kept = self.data / "cache" / "pictures" / f"{made['id']}-place-0-300.jpg"
        kept.write_bytes(b"the kept copy")
        self.assertEqual(self.server.get(f"{url}?most=300").data, b"the kept copy", "the kept copy is what comes, not a new one")
        self.assertEqual(self.server.get(f"{url}?most=2000").data, body, "already small enough")
        for most in ("10", "16385", "a"):
            with self.subTest(most=most):
                self.assertEqual(self.server.get(f"{url}?most={most}").status, 400)
        self.assertEqual(self.server.get(f"/api/models/{made['id']}/files/place-0.bin?most=300").data, b"\0" * 8, "only pictures shrink")

    def test_a_copy_older_than_its_picture_is_made_anew(self):
        made = self.server.save_model({"name": "Big"}, {"place-0.jpg": picture("JPEG")})
        url = f"/api/models/{made['id']}/files/place-0.jpg"
        fresh = self.server.get(f"{url}?most=300").data
        kept = self.data / "cache" / "pictures" / f"{made['id']}-place-0-300.jpg"
        kept.write_bytes(b"the kept copy")
        os.utime(kept, (1000, 1000))
        self.assertEqual(self.server.get(f"{url}?most=300").data, fresh)

    def test_a_picture_keeps_its_shape_and_its_colour_whatever_kind_it_is(self):
        for kind, size, most, want in (("PNG", (800, 1200), 300, (200, 300)), ("PNG", (1000, 1000), 64, (64, 64)),
                                       ("JPEG", (4000, 100), 100, (100, 3)), ("JPEG", (100, 4000), 100, (3, 100))):
            with self.subTest(kind=kind, size=size):
                made = self.server.save_model({"name": "p"}, {"place-0.jpg": picture(kind, size)})
                small = self.server.get(f"/api/models/{made['id']}/files/place-0.jpg?most={most}")
                self.assertEqual(small.status, 200)
                with Image.open(io.BytesIO(small.data)) as image:
                    self.assertEqual(image.size, want)
                    red, green, blue = image.convert("RGB").getpixel((want[0] // 2, want[1] // 2))
                self.assertLess(abs(red - 40) + abs(green - 120) + abs(blue - 60), 12)

    def test_the_kinds_of_jpeg_and_png_a_browser_or_a_camera_makes(self):
        def saved(image, kind, **options):
            out = io.BytesIO()
            image.save(out, kind, **options)
            return out.getvalue()
        base = Image.new("RGB", (640, 480), (200, 100, 50))
        grey = base.convert("L").getpixel((0, 0))
        kinds = {"plain jpeg": (saved(base, "JPEG"), (200, 100, 50)), "progressive": (saved(base, "JPEG", progressive=True), (200, 100, 50)),
                 "smallest tables": (saved(base, "JPEG", optimize=True), (200, 100, 50)),
                 "grey jpeg": (saved(base.convert("L"), "JPEG"), (grey, grey, grey)), "cmyk jpeg": (saved(base.convert("CMYK"), "JPEG"), (200, 100, 50)),
                 "rgba png": (saved(base.convert("RGBA"), "PNG"), (200, 100, 50)), "grey png": (saved(base.convert("L"), "PNG"), (grey, grey, grey)),
                 "palette png": (saved(base.convert("P"), "PNG"), None), "grey and alpha png": (saved(base.convert("LA"), "PNG"), (grey, grey, grey)),
                 "16 bit png": (saved(Image.new("I;16", (640, 480), 30000), "PNG"), None)}
        for what, (body, colour) in kinds.items():
            with self.subTest(what):
                made = self.server.save_model({"name": what}, {"place-0.png": body})
                small = self.server.get(f"/api/models/{made['id']}/files/place-0.png?most=64")
                self.assertEqual((small.status, small.mimetype), (200, "image/jpeg"))
                with Image.open(io.BytesIO(small.data)) as image:
                    self.assertEqual(image.size, (64, 48))
                    got = image.convert("RGB").getpixel((32, 24))
                if colour:
                    self.assertLess(sum(abs(a - b) for a, b in zip(got, colour)), 15, got)

    def test_a_file_that_is_not_a_readable_jpeg_or_png_does_not_come_smaller(self):
        # Pillow reads TIFF, GIF, BMP and more whatever a file's name says, and the holes are found in
        # those readers: a picture of a model is read as JPEG or PNG, or not at all.
        files = {"a TIFF": picture("TIFF"), "a GIF": picture("GIF"), "a BMP": picture("BMP"), "a PPM": picture("PPM"),
                 "a TGA": picture("TGA"), "a PCX": picture("PCX"), "a JPEG cut short": picture("JPEG")[:3000],
                 "a PNG cut short": picture("PNG")[:300], "not a picture": b"hello" * 100}
        for what, body in files.items():
            with self.subTest(what):
                made = self.server.save_model({"name": what}, {"place-0.jpg": body})
                url = f"/api/models/{made['id']}/files/place-0.jpg"
                answer = self.server.get(f"{url}?most=300")
                self.assertEqual(answer.status, 415)
                self.assertIn("JPEG or PNG", answer.json()["error"])
                self.assertEqual(self.server.get(url).data, body, "the file itself is there as it was")
                self.assertEqual(list((self.data / "cache" / "pictures").glob(f"{made['id']}-*")), [], "no copy made")

    def test_a_picture_of_too_many_points_is_not_opened(self):
        # the head of a PNG that says 20000 by 20000: 400 million points, past what the server agrees to decode
        head = b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" + struct.pack(">IIBBBBB", 20000, 20000, 8, 2, 0, 0, 0)
        import zlib
        body = head + struct.pack(">I", zlib.crc32(head[12:])) + b"\0" * 64
        made = self.server.save_model({"name": "bomb"}, {"place-0.png": body})
        self.assertEqual(self.server.get(f"/api/models/{made['id']}/files/place-0.png?most=300").status, 415)

    def test_the_page_s_errors_are_kept_for_reading_from_another_device(self):
        self.server.post("/api/client-error", {"message": "the picture of the model came out blank", "where": "picture",
                                               "details": {"width": 8192, "touch": True}, "agent": "iPad"})
        kept = self.server.get("/api/client-errors?last=5").json()["errors"]
        self.assertEqual(kept[-1]["message"], "the picture of the model came out blank")
        self.assertEqual(json.loads(kept[-1]["details"]), {"width": 8192, "touch": True})
        self.assertEqual(kept[-1]["agent"], "iPad")
        self.assertRegex(kept[-1]["time"], r"^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$")
        self.assertIs(kept[-1]["automated"], False, "a person's browser")
        self.assertEqual(sorted(kept[-1]), ["agent", "automated", "details", "message", "page", "stack", "time", "version", "where"])
        self.server.post("/api/client-error", {"message": "a test run", "agent": "HeadlessChrome", "automated": True})
        self.server.post("/api/client-error", {"message": "not quite", "automated": "yes"})
        kept = self.server.get("/api/client-errors?last=2").json()["errors"]
        self.assertEqual([e["automated"] for e in kept], [True, False], "told apart: true only when the page says true")
        self.assertIn("the picture of the model came out blank", self.server.log())
        self.assertEqual(self.server.get("/api/client-errors?last=a").status, 400)
        self.assertEqual(len(self.server.get("/api/client-errors?last=-5").json()["errors"]), 1, "at least one")
        self.assertEqual(len(self.server.get("/api/client-errors?last=9999").json()["errors"]), 3, "at most what there is")
        written = (self.data / "client-errors.jsonl").read_text().splitlines()
        self.assertEqual(len(written), 3)
        self.assertEqual(list(json.loads(written[0])), ["time", "message", "where", "page", "version", "details", "agent", "automated", "stack"])

    def test_a_field_of_a_report_is_cut_and_a_line_that_breaks_does_not_stop_the_reading(self):
        self.server.post("/api/client-error", {"message": "m" * 700, "stack": "s" * 3000, "details": {"a": "d" * 3000}})
        kept = self.server.get("/api/client-errors").json()["errors"]
        self.assertEqual((len(kept[0]["message"]), len(kept[0]["stack"]), len(kept[0]["details"])), (600, 2400, 2400))
        with (self.data / "client-errors.jsonl").open("a") as file:
            file.write("{broken\n")
        self.server.post("/api/client-error", {"message": "after"})
        self.assertEqual([e["message"][:5] for e in self.server.get("/api/client-errors").json()["errors"]], ["m" * 5, "after"])

    def test_clearing_the_cache_is_said_only_to_the_browser_that_asks(self):
        answer = self.server.post("/api/clear-cache")
        self.assertEqual(answer.status, 204)
        self.assertEqual(answer.headers["Clear-Site-Data"], '"cache"', "the cache only: not the choices kept")
        self.assertIsNone(self.server.get("/api/settings").headers["Clear-Site-Data"])

    @unittest.skipIf(os.geteuid() == 0, "root writes where the test forbids it")
    def test_a_folder_that_cannot_be_written_is_said_plainly(self):
        locked = self.data / "models"
        locked.mkdir()
        locked.chmod(0o500)
        try:
            answer = self.server.post("/api/models", form={"meta": json.dumps({"name": "x"})})
            self.assertEqual(answer.status, 503)
            self.assertTrue(answer.json()["cannot_write"])
            self.assertIn("data/", answer.json()["error"])
        finally:
            locked.chmod(0o700)

    def _routes_that_read_a_json_body(self):
        made = self.server.save_model({"name": "n"})
        return [("put", "/api/settings/opentopo-key"), ("put", "/api/settings/start/moon"), ("post", "/api/client-error"),
                ("post", f"/api/models/{made['id']}/copy"), ("patch", f"/api/models/{made['id']}")]

    def test_a_body_that_is_json_but_not_an_object_is_refused(self):
        # a list, a string, a number: each used to reach `.get` and end in a crash, a 500
        for method, url in self._routes_that_read_a_json_body():
            for body in ([1, 2, 3], "text", 7, True, [], 0, ""):
                with self.subTest(route=f"{method} {url}", body=body):
                    answer = getattr(self.server, method)(url, body)
                    self.assertEqual(answer.status, 400)
                    self.assertIn("JSON object", answer.json()["error"])

    def test_nothing_sent_or_something_that_is_not_json_is_still_nothing_sent(self):
        # what each route answers to a request with no fields: the same whether the body is missing,
        # is not JSON at all, or is JSON that does not parse
        answers = {"/api/settings/opentopo-key": 400, "/api/settings/start/moon": 400, "/api/client-error": 204, "copy": 201, "rename": 400}
        for method, url in self._routes_that_read_a_json_body():
            expected = answers.get(url) or answers["copy" if url.endswith("/copy") else "rename"]
            for kwargs in ({}, {"data": b"nope", "content_type": "text/plain"}, {"data": b"{broken", "content_type": "application/json"},
                           {"data": b'{"name": "a body of another type"}', "content_type": "text/plain"}):
                with self.subTest(route=f"{method} {url}", sent=kwargs):
                    answer = getattr(self.server, method)(url, **kwargs)
                    self.assertEqual(answer.status, expected)
                    if expected == 400:
                        self.assertNotIn("JSON object", answer.json()["error"], "it asks for the fields, it does not call nothing a wrong body")

    def test_json_of_a_type_of_its_own_counts_as_json(self):
        answer = self.server.put("/api/settings/start/moon", data=json.dumps({"lat": 1, "lon": 2, "zoom": 3}).encode(),
                                 content_type="application/vnd.ptm+json; charset=utf-8")
        self.assertEqual(answer.status, 200)

    def test_a_refused_body_changes_nothing(self):
        made = self.server.save_model({"name": "Before"})
        self.server.patch(f"/api/models/{made['id']}", ["After"])
        self.server.post(f"/api/models/{made['id']}/copy", ["After"])
        self.server.put("/api/settings/start/moon", [1, 2])
        self.assertEqual([m["name"] for m in self.server.get("/api/models").json()], ["Before"], "no rename, no copy")
        self.assertEqual(self.server.get("/api/settings").json()["starts"], {})
        self.assertEqual(self.server.get("/api/client-errors").json()["errors"], [])

    def test_a_damaged_copernicus_file_is_a_bad_gateway_not_a_crash(self):
        box = "south=43.3&north=43.6&west=42.3&east=42.6&cells=16&source=aws"
        for what, body in (("cut short", b"II*\x00\x08\x00\x00\x00"), ("a page", b"<html>try again</html>")):
            with self.subTest(what):
                data = self.home / re.sub(r"\W", "-", what)
                data.mkdir()
                upstream = Upstream({"copernicus-dem": Answer(body, "image/tiff")})
                self.addCleanup(upstream.close)
                answer = self.new_server(upstream, data).get(f"/api/earth/heights?{box}")
                self.assertEqual(answer.status, 502)
                self.assertIn("Copernicus on AWS", answer.json()["error"])

    def test_page_errors_go_to_the_log_at_most_30_a_minute(self):
        codes = [self.server.post("/api/client-error", {"message": "boom"}).status for _ in range(31)]
        self.assertEqual(codes[:30], [204] * 30)
        self.assertEqual(codes[30], 429)


class ShapeFilesTest(ServerCase):
    """The shapes of asteroids, comets and spacecraft: only their lists can be asked for; each file is fetched once."""

    SERVICES = {
        "Bennu_1_1.glb": Answer(b"glTF\x02\x00\x00\x00 a model", "model/gltf-binary"),
        "4769castalia.tab": Answer(b"v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n", "text/plain"),
        "AsteroidModel/101/shape.obj": Answer(b"v 1 2 3\nv 2 3 4\nv 3 4 5\nf 1 2 3\n", "text/plain"),
        "AsteroidModel/102/shape.obj": Answer(b"<html>not a shape</html>", "text/html"),
        "AsteroidModel/103/shape.obj": 500,
        "hartley2_2012_cart.obj": Answer(b"v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n", "text/plain"),
        "cg_mspcd_shap2_024k_cart.wrl": Answer(b"#VRML V2.0 utf8\nShape { coord Coordinate { point [ 0 0 0 ] } }", "text/plain"),
        "1682q1halley.tab": Answer(b"  360  -90      8.800000\n  360  -85      8.800000\n", "text/plain"),
        "tempel1_2012_cart.obj": Answer(b"#VRML V2.0 utf8\nnot what the list says", "text/plain"),
        "Saturn%20V.glb": Answer(b"glTF\x02\x00\x00\x00 a rocket", "model/gltf-binary"),
    }

    def kept(self, name) -> Path:
        return self.data / "cache" / "asteroids" / name

    def test_a_shape_of_the_top_list_is_fetched_once_and_kept(self):
        for _ in range(2):
            answer = self.server.get("/api/asteroids/top/bennu")
            self.assertEqual((answer.status, answer.mimetype), (200, "model/gltf-binary"))
            self.assertTrue(answer.data.startswith(b"glTF"))
        self.assertEqual(sum("Bennu" in url for url in self.upstream.asked), 1, "the second time from the disk")
        self.assertIn("immutable", answer.headers["Cache-Control"])
        castalia = self.server.get("/api/asteroids/top/castalia")
        self.assertEqual((castalia.status, castalia.mimetype), (200, "text/plain"))
        self.assertEqual(castalia.headers["Content-Type"], "text/plain; charset=utf-8")

    def test_a_shape_of_damit_by_its_number(self):
        answer = self.server.get("/api/asteroids/damit/101")
        self.assertEqual(answer.status, 200)
        self.assertIn(b"v 1 2 3", answer.data)
        self.assertTrue(self.kept("damit-101.obj").is_file())

    def test_nothing_else_is_fetched_and_a_bad_file_is_not_kept(self):
        self.assertEqual(self.server.get("/api/asteroids/top/moon").status, 404)
        self.assertIn("'moon'", self.server.get("/api/asteroids/top/moon").json()["error"])
        self.assertEqual(self.server.get("/api/asteroids/top/..%2Fsecret").status, 404)
        self.assertEqual(self.server.get("/api/asteroids/damit/0").status, 404)
        self.assertEqual(self.server.get("/api/asteroids/damit/10000000").status, 404)
        self.assertEqual(self.server.get("/api/asteroids/damit/102").status, 502, "a page, not a shape")
        self.assertFalse(self.kept("damit-102.obj").exists())
        failed = self.server.get("/api/asteroids/damit/103")
        self.assertEqual(failed.status, 502)
        self.assertIn("HTTP 500", failed.json()["error"])

    def test_comets_in_their_three_kinds_of_file(self):
        for comet, kept in (("hartley-2", "comet-hartley-2.obj"), ("67p", "comet-67p.wrl"), ("halley", "comet-halley.grid")):
            with self.subTest(comet=comet):
                answer = self.server.get(f"/api/comets/{comet}")
                self.assertEqual((answer.status, answer.mimetype), (200, "text/plain"))
                self.assertTrue(self.kept(kept).is_file())
        self.assertEqual(self.server.get("/api/comets/tempel-1").status, 502, "VRML where the list says OBJ")
        self.assertEqual(self.server.get("/api/comets/bennu").status, 404, "an asteroid is no comet")

    def test_nasa_s_spacecraft_and_none_the_page_draws_itself(self):
        answer = self.server.get("/api/vehicles/saturn-v")
        self.assertEqual((answer.status, answer.mimetype), (200, "model/gltf-binary"))
        self.assertTrue(self.kept("vehicle-saturn-v.glb").is_file())
        self.assertEqual(self.server.get("/api/vehicles/falcon-9").status, 404, "drawn by the page: no file")
        self.assertEqual(self.server.get("/api/vehicles/..%2Fsecret").status, 404)


if __name__ == "__main__":
    import unittest
    unittest.main()
