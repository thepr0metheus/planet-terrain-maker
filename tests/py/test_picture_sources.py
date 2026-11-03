"""The picture sources a person enters, kept in the data folder for every device."""
import hashlib
import json
import stat
import unittest

from helpers import ROOT, ServerCase


class PictureSourcesTest(ServerCase):
    def setUp(self):
        super().setUp()
        self.path = self.data / "picture-sources.json"

    def keep(self, source):
        return self.server.post("/api/picture-sources", source)

    def test_shared_validation_cases(self):
        for case in json.loads((ROOT / "tests/fixtures/picture-sources.json").read_text()):
            with self.subTest(source=case["source"]):
                self.assertEqual(self.keep(case["source"]).status, 200 if case["valid"] else 400)

    def test_what_is_kept_of_a_source(self):
        url = "https://tiles.example.org/{z}/{x}/{y}.png"
        entry = self.keep({"url": f" {url} ", "name": " Example ", "credit": " Agency ", "maxZoom": "16", "more": "left out"}).json()[0]
        self.assertEqual(entry, {"url": url, "maxZoom": 16, "name": "Example", "credit": "Agency", "key": hashlib.sha256(url.encode()).hexdigest()})
        written = json.loads(self.path.read_text())
        self.assertEqual(list(written[0]), ["url", "maxZoom", "name", "credit", "key"])
        cut = self.keep({"url": url, "name": "ა" * 200, "credit": "c" * 700}).json()[0]
        self.assertEqual((len(cut["name"]), len(cut["credit"])), (120, 600))
        for zoom in (None, "", "auto"):
            with self.subTest(zoom=zoom):
                self.assertIsNone(self.keep({"url": url, "maxZoom": zoom}).json()[0]["maxZoom"])
        self.assertEqual(self.keep({"url": url, "maxZoom": 7.0}).json()[0]["maxZoom"], 7)
        self.assertEqual(self.keep({"url": url, "maxZoom": "7.0"}).json()[0]["maxZoom"], 7)

    def test_the_addresses_that_cannot_be_used(self):
        good = "https://tiles.example.org/{z}/{x}/{y}.png"
        for bad, words in (({"url": 5}, "XYZ"), ({"url": "https://a.org/{z}/{x}/{y}{w}"}, "XYZ"), ({"url": "https://a.org/{z}/{x}/{y}}"}, "XYZ"),
                           ({"url": "https://a.org/" + "a" * 4096 + "/{z}/{x}/{y}"}, "XYZ"), ({}, "XYZ"),
                           ({"url": "ftp://a.org/{z}/{x}/{y}"}, "HTTPS"), ({"url": "//a.org/{z}/{x}/{y}"}, "HTTPS"), ({"url": "https:///{z}/{x}/{y}"}, "HTTPS"),
                           ({"url": "https://user@a.org/{z}/{x}/{y}"}, "HTTPS"), ({"url": "https://a.org:99999/{z}/{x}/{y}"}, "valid"),
                           ({"url": "https://a.org:x/{z}/{x}/{y}"}, "valid"), ({"url": "https://[a.org/{z}/{x}/{y}"}, "valid"),
                           ({"url": good, "name": 5}, "text"), ({"url": good, "credit": None}, "text"),
                           ({"url": good, "maxZoom": "x"}, "whole number"), ({"url": good, "maxZoom": [1]}, "whole number"), ({"url": good, "maxZoom": True}, "whole number")):
            with self.subTest(bad=bad):
                answer = self.keep(bad)
                self.assertEqual(answer.status, 400)
                self.assertIn(words, answer.json()["error"])
        for good_one in ("HTTPS://a.org/{z}/{x}/{y}", "https://a.org:8443/{z}/{x}/{y}", "https://[::1]:8443/{z}/{x}/{y}", "https://a.org/{z}/{x}/{y}?key=abc"):
            with self.subTest(good=good_one):
                self.assertEqual(self.keep({"url": good_one}).status, 200)
        for not_an_object in ([1], "text", 5):
            self.assertEqual(self.keep(not_an_object).status, 400)
        self.assertEqual(self.server.post("/api/picture-sources", data=b"nope", content_type="text/plain").status, 400)

    def test_history_survives_a_restart_and_is_not_in_code(self):
        a = {"url": "https://tiles.example.org/photo/{z}/{x}/{y}.png", "maxZoom": None}
        b = {"url": "https://tiles.example.org/topo/{z}/{x}/{y}.png", "name": "Topo", "maxZoom": 16}
        self.assertEqual(self.keep(a).status, 200)
        self.keep(b)
        self.keep({**a, "name": "Photo"})
        self.server.restart()
        answer = self.server.get("/api/picture-sources")
        entries = answer.json()
        self.assertEqual([e["url"] for e in entries], [a["url"], b["url"]])
        self.assertEqual(entries[0]["name"], "Photo")
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        self.assertEqual(answer.headers["Cache-Control"], "no-store")
        self.assertEqual(self.server.post("/api/clear-cache").status, 204)
        self.assertEqual(self.server.get("/api/picture-sources").json(), entries)
        compose = (ROOT / "compose.yaml").read_text()
        # data/ comes from outside the image: a folder here (./data), a named volume in the public copy
        self.assertRegex(compose, r"(?m)^\s*-\s*[\w./-]+:/app/data\s*$")
        self.assertIn("/data/", (ROOT / ".gitignore").read_text())

    def test_forget_only_the_selected_source(self):
        a = {"url": "https://tiles.example.org/photo/{z}/{x}/{y}.png"}
        b = {"url": "https://tiles.example.org/topo/{z}/{x}/{y}.png"}
        self.keep(a)
        self.keep(b)
        self.assertEqual([e["url"] for e in self.server.delete("/api/picture-sources", {"url": a["url"]}).json()], [b["url"]])

    def test_corrupt_data_is_reported_and_not_overwritten(self):
        for corrupt in ("{broken", '{"not": "a list"}', '[{"url": "http://not-https/{z}/{x}/{y}"}]', '[5]'):
            with self.subTest(corrupt=corrupt):
                self.path.write_text(corrupt)
                self.assertEqual(self.server.get("/api/picture-sources").status, 503)
                self.assertEqual(self.keep({"url": "https://tiles.example.org/{z}/{x}/{y}.png"}).status, 503)
                self.assertEqual(self.path.read_text(), corrupt)

    def test_invalid_input_does_not_create_the_data_file(self):
        self.assertEqual(self.keep({"url": "invalid"}).status, 400)
        self.assertEqual(self.server.delete("/api/picture-sources", {}).status, 400)
        self.assertEqual(self.server.delete("/api/picture-sources").status, 400)
        self.assertFalse(self.path.exists())

    def test_nothing_is_asked_of_the_address(self):
        self.keep({"url": "https://tiles.example.org/{z}/{x}/{y}.png"})
        self.assertEqual(self.upstream.asked, [])

    def test_no_file_left_behind(self):
        self.keep({"url": "https://tiles.example.org/{z}/{x}/{y}.png"})
        self.assertEqual([p.name for p in self.data.iterdir() if p.name.startswith(".")], [])


if __name__ == "__main__":
    unittest.main()
