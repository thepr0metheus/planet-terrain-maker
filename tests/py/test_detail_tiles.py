"""Detailed picture tiles: a browser uploads them, the server checks and keeps them, and asks nobody."""
import io
import os
import unittest

from helpers import ServerCase
from PIL import Image


class DetailTilesTest(ServerCase):
    def setUp(self):
        super().setUp()
        source = self.server.post("/api/picture-sources", {"url": "https://tiles.example.org/{z}/{x}/{y}.png"}).json()[0]
        self.key = source["key"]
        self.path = f"/api/picture-sources/{self.key}/tiles/19/322903/195236"

    @staticmethod
    def picture(size=(256, 256), kind="JPEG"):
        output = io.BytesIO()
        Image.new("RGB", size, (40, 120, 70)).save(output, kind)
        return output.getvalue()

    def test_saved_tile_reopens_after_a_restart_without_upstream_fetches(self):
        self.assertEqual(self.server.get(self.path).status, 404)
        body = self.picture()
        self.assertEqual(self.server.put(self.path, data=body).status, 204)
        self.server.restart()
        reopened = self.server.get(self.path)
        self.assertEqual(reopened.status, 200)
        self.assertEqual(reopened.data, body)
        self.assertEqual(reopened.mimetype, "image/jpeg")
        self.assertEqual(reopened.headers["Cache-Control"], "private, max-age=86400")
        self.assertEqual(self.upstream.asked, [])
        self.assertEqual((self.data / "picture-tiles" / self.key / "19" / "322903" / "195236.tile").read_bytes(), body)

    def test_a_png_tile(self):
        body = self.picture(kind="PNG")
        self.assertEqual(self.server.put(self.path, data=body).status, 204)
        self.assertEqual(self.server.get(self.path).mimetype, "image/png")

    def test_invalid_image_or_address_does_not_become_a_saved_tile(self):
        self.assertEqual(self.server.put(self.path, data=b"<html>not an image</html>").status, 400)
        self.assertEqual(self.server.put(self.path, data=self.picture((1024, 1024))).status, 400)
        self.assertEqual(self.server.put(self.path, data=self.picture((256, 255))).status, 400)
        self.assertEqual(self.server.put(self.path, data=b"").status, 400)
        self.assertEqual(self.server.put(self.path, data=b"\xff\xd8 a JPEG in its first bytes alone").status, 400)
        self.assertEqual(self.server.put(self.path, data=self.picture(kind="PNG")[:100]).status, 400)
        self.assertEqual(self.server.put(self.path, data=self.picture(kind="GIF")).status, 400)
        self.assertEqual(self.server.put(self.path, data=b"\xff" * (1024 * 1024 + 1)).status, 400)
        self.assertEqual(self.server.put(f"/api/picture-sources/{self.key}/tiles/1/99/0", data=self.picture()).status, 400)
        self.assertEqual(self.server.put(f"/api/picture-sources/{self.key}/tiles/23/0/0", data=self.picture()).status, 400)
        self.assertEqual(self.server.put("/api/picture-sources/" + "a" * 64 + "/tiles/1/0/0", data=self.picture()).status, 404)
        self.assertEqual(self.server.get(self.path).status, 404)

    def test_an_address_that_cannot_be_is_refused_when_read_too(self):
        self.assertEqual(self.server.get("/api/picture-sources/nothex/tiles/1/0/0").status, 400)
        self.assertEqual(self.server.get(f"/api/picture-sources/{self.key}/tiles/1/2/0").status, 400)
        self.assertEqual(self.server.get(f"/api/picture-sources/{self.key}/tiles/1/0/2").status, 400)

    def test_what_lies_there_and_is_no_picture(self):
        path = self.data / "picture-tiles" / self.key / "1" / "0" / "0.tile"
        path.parent.mkdir(parents=True)
        path.write_bytes(b"not a picture")
        self.assertEqual(self.server.get(f"/api/picture-sources/{self.key}/tiles/1/0/0").status, 400)

    @unittest.skipIf(os.geteuid() == 0, "root writes where the test forbids it")
    def test_a_folder_that_cannot_be_written(self):
        (self.data / "picture-tiles").mkdir()
        (self.data / "picture-tiles").chmod(0o500)
        try:
            self.assertEqual(self.server.put(self.path, data=self.picture()).status, 503)
        finally:
            (self.data / "picture-tiles").chmod(0o700)


if __name__ == "__main__":
    unittest.main()
