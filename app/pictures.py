"""Smaller copies of a model's pictures, for devices that cannot hold the big ones.

A picture of 8192 points a side is 67 million points: Safari on an iPad makes no canvas past 16.7
million, and decoding such a picture there gives a blank one, so the model comes out black. The
page on a touch device asks for the picture at most 4096 a side (GET .../files/<name>?most=4096),
and gets a copy made here once and kept in data/cache/pictures. A JPEG is decoded already smaller
(Pillow's draft: the decoder skips what it would only throw away), then made exactly the size.
"""
from __future__ import annotations

import io
import os
import tempfile
from pathlib import Path

from PIL import Image

LEAST, MOST = 64, 16384           # the sizes a copy may be asked for, a side
QUALITY = 88


class PictureSizes:
    def __init__(self, cache_dir: Path, log=print):
        self.cache_dir = Path(cache_dir)
        self.log = log
        self._unwritable = False

    def at_most(self, path: Path, most: int, key: str):
        """The picture at `path`, or a copy of it at most `most` points a side when it is bigger: a
        Path to serve, or the copy's JPEG bytes when the cache cannot be written. key names the copy
        in the cache (the model's id and the file's name)."""
        if not LEAST <= most <= MOST:
            raise ValueError(f"most must lie within {LEAST}..{MOST}")
        with Image.open(path) as image:
            if max(image.size) <= most:
                return path
            copy = self.cache_dir / f"{key}-{most}.jpg"
            if copy.is_file() and copy.stat().st_mtime >= path.stat().st_mtime:
                return copy
            image.draft("RGB", (most, most))
            small = image.convert("RGB")
            small.thumbnail((most, most), Image.Resampling.LANCZOS)
        body = io.BytesIO()
        small.save(body, "JPEG", quality=QUALITY, optimize=True)
        return self._keep(copy, body.getvalue()) or body.getvalue()

    def _keep(self, copy: Path, body: bytes) -> Path | None:
        if self._unwritable:
            return None
        try:
            copy.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=copy.parent, prefix=".part-", suffix=".jpg")
            with os.fdopen(fd, "wb") as f:
                f.write(body)
            os.replace(tmp, copy)
            return copy
        except OSError as e:
            self._unwritable = True
            self.log(f"pictures: smaller copies are not kept, {self.cache_dir} cannot be written: {e}")
            return None
