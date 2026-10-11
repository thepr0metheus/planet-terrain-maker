import io
import tempfile
import unittest
from pathlib import Path
from fakes import FakeFetcher
from PIL import Image
from app.server import create_app


class DetailTilesTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.fetcher = FakeFetcher()
        self.client = create_app(self.root, fetcher=self.fetcher).test_client()
        source = self.client.post('/api/picture-sources', json={'url': 'https://tiles.example.org/{z}/{x}/{y}.png'}).get_json()[0]
        self.key = source['key']
        self.path = f'/api/picture-sources/{self.key}/tiles/19/322903/195236'

    def tearDown(self):
        self.directory.cleanup()

    @staticmethod
    def picture(size=(256, 256)):
        output = io.BytesIO()
        Image.new('RGB', size, (40, 120, 70)).save(output, 'JPEG')
        return output.getvalue()

    def test_saved_tile_reopens_after_a_new_app_without_upstream_fetches(self):
        self.assertEqual(self.client.get(self.path).status_code, 404)
        body = self.picture()
        self.assertEqual(self.client.put(self.path, data=body).status_code, 204)
        reopened = create_app(self.root, fetcher=self.fetcher).test_client().get(self.path)
        self.assertEqual(reopened.status_code, 200)
        self.assertEqual(reopened.data, body)
        self.assertEqual(reopened.mimetype, 'image/jpeg')
        self.assertEqual(self.fetcher.asked, [])

    def test_invalid_image_or_address_does_not_become_a_saved_tile(self):
        self.assertEqual(self.client.put(self.path, data=b'<html>not an image</html>').status_code, 400)
        self.assertEqual(self.client.put(self.path, data=self.picture((1024, 1024))).status_code, 400)
        self.assertEqual(self.client.put(f'/api/picture-sources/{self.key}/tiles/1/99/0', data=self.picture()).status_code, 400)
        self.assertEqual(self.client.put('/api/picture-sources/' + 'a' * 64 + '/tiles/1/0/0', data=self.picture()).status_code, 404)
        self.assertEqual(self.client.get(self.path).status_code, 404)
