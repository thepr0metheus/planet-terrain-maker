import json
import stat
import tempfile
import unittest
from pathlib import Path

from fakes import FakeFetcher
from app.picture_sources import InvalidSource, PictureSources, SourceStoreError
from app.server import create_app

ROOT = Path(__file__).resolve().parents[2]


class PictureSourcesTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.path = self.root / "picture-sources.json"
        self.store = PictureSources(self.path)

    def tearDown(self):
        self.directory.cleanup()

    def test_shared_validation_cases(self):
        for case in json.loads((ROOT / "tests/fixtures/picture-sources.json").read_text()):
            with self.subTest(source=case["source"]):
                if case["valid"]:
                    self.store.validate(case["source"])
                else:
                    with self.assertRaises(InvalidSource):
                        self.store.validate(case["source"])

    def test_history_survives_a_new_app_instance_and_is_not_in_code(self):
        first = create_app(self.root, fetcher=FakeFetcher()).test_client()
        a = {"url": "https://tiles.example.org/photo/{z}/{x}/{y}.png", "maxZoom": None}
        b = {"url": "https://tiles.example.org/topo/{z}/{x}/{y}.png", "name": "Topo", "maxZoom": 16}
        self.assertEqual(first.post("/api/picture-sources", json=a).status_code, 200)
        first.post("/api/picture-sources", json=b)
        first.post("/api/picture-sources", json={**a, "name": "Photo"})
        restarted = create_app(self.root, fetcher=FakeFetcher()).test_client()
        entries = restarted.get("/api/picture-sources").get_json()
        self.assertEqual([e["url"] for e in entries], [a["url"], b["url"]])
        self.assertEqual(entries[0]["name"], "Photo")
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        self.assertEqual(restarted.get("/api/picture-sources").headers["Cache-Control"], "no-store")
        self.assertEqual(restarted.post("/api/clear-cache").status_code, 204)
        self.assertEqual(restarted.get("/api/picture-sources").get_json(), entries)
        compose = (ROOT / "compose.yaml").read_text()
        # data/ comes from outside the image: a folder here (./data), a named volume in the public copy
        self.assertRegex(compose, r"(?m)^\s*-\s*[\w./-]+:/app/data\s*$")
        self.assertIn("/data/", (ROOT / ".gitignore").read_text())

    def test_forget_only_the_selected_source(self):
        a = {"url": "https://tiles.example.org/photo/{z}/{x}/{y}.png"}
        b = {"url": "https://tiles.example.org/topo/{z}/{x}/{y}.png"}
        self.store.keep(a)
        self.store.keep(b)
        self.assertEqual([e["url"] for e in self.store.forget(a["url"])], [b["url"]])

    def test_corrupt_data_is_reported_and_not_overwritten(self):
        self.path.write_text("{broken")
        with self.assertRaises(SourceStoreError):
            self.store.list()
        with self.assertRaises(SourceStoreError):
            self.store.keep({"url": "https://tiles.example.org/{z}/{x}/{y}.png"})
        self.assertEqual(self.path.read_text(), "{broken")
        client = create_app(self.root, fetcher=FakeFetcher()).test_client()
        self.assertEqual(client.get("/api/picture-sources").status_code, 503)

    def test_invalid_input_does_not_create_the_data_file(self):
        client = create_app(self.root, fetcher=FakeFetcher()).test_client()
        self.assertEqual(client.post("/api/picture-sources", json={"url": "invalid"}).status_code, 400)
        self.assertEqual(client.delete("/api/picture-sources", json={}).status_code, 400)
        self.assertFalse(self.path.exists())
