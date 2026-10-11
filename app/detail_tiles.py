"""Detailed picture tiles uploaded by browsers, persisted in mounted data for reopening models.

The server never fetches the source URL. Keys identify saved sources, and every uploaded tile is
decoded and checked before it is stored. Requests and filenames contain no user URL or query key.
"""
from __future__ import annotations

import io
import re
from pathlib import Path

from PIL import Image, UnidentifiedImageError

from .tiles import TileRelay


class InvalidDetail(ValueError):
    """An invalid source key, tile coordinate or image."""


class DetailTiles:
    MOST_BYTES = 1024 * 1024

    def __init__(self, root: Path):
        self.root = Path(root)

    def path(self, key, z, x, y):
        if not re.fullmatch(r"[a-f0-9]{64}", key) or not 0 <= z <= 22 or not (0 <= x < 2 ** z and 0 <= y < 2 ** z):
            raise InvalidDetail("Invalid detail tile address.")
        return self.root / key / str(z) / str(x) / f"{y}.tile"

    @staticmethod
    def content_type(body):
        if body.startswith(b"\xff\xd8"):
            return "image/jpeg"
        if body.startswith(b"\x89PNG\r\n\x1a\n"):
            return "image/png"
        raise InvalidDetail("Detail tiles must be PNG or JPEG images.")

    def keep(self, key, z, x, y, body):
        path = self.path(key, z, x, y)
        if not 0 < len(body) <= self.MOST_BYTES:
            raise InvalidDetail("The detail tile is too large.")
        self.content_type(body)
        try:
            with Image.open(io.BytesIO(body)) as image:
                if image.size != (256, 256):
                    raise InvalidDetail("Detail tiles must be 256 by 256 pixels.")
                image.verify()
        except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as error:
            raise InvalidDetail("The detail tile is not a readable image.") from error
        TileRelay._write(path, body)
        return path
