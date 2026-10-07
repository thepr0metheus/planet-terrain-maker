"""The shapes of asteroids, put on a model at their real size (the page's asteroid-on-model.js).

The page asks for a shape by the list it comes from: one of the best known shapes (web/data/
asteroids-top.json, made by tools/asteroids.py: NASA's 3D resources as GLB, JAXA's and the radar
models as vertices and facets) or a model of the DAMIT catalogue by its number. The server fetches
the file from where it lives the first time, keeps it in data/cache/asteroids, and gives it from
there afterwards: a shape does not change. Only these two lists can be asked for, so the server
fetches nothing anyone names.
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

from .fetch import Fetcher

DAMIT_SHAPE = "https://damit.cuni.cz/projects/damit/generated_files/open/AsteroidModel/{id}/shape.obj"
MOST_BYTES = 30 * 1024 * 1024        # the largest of the top list, Ceres's, is 9.5 MB
TYPES = {"glb": "model/gltf-binary", "obj": "text/plain"}         # Flask adds the charset to text


class UnknownShape(Exception):
    """No such shape in the lists."""


class BadShape(Exception):
    """The file that came is not the shape it should be."""


class AsteroidShapes:
    def __init__(self, fetcher: Fetcher, cache_dir: Path, top_file: Path, log=print):
        self.fetcher = fetcher
        self.cache_dir = Path(cache_dir)
        self.log = log
        self._top = {a["id"]: a for a in json.loads(Path(top_file).read_text(encoding="utf-8"))}
        self._unwritable = False

    def top(self, asteroid_id: str) -> tuple[bytes, str]:
        """One of the best known shapes, by its id: (the file, its content type)."""
        asteroid = self._top.get(asteroid_id)
        if not asteroid:
            raise UnknownShape(f"no shape called {asteroid_id!r} in the list")
        return self._kept(f"top-{asteroid_id}.{asteroid['kind']}", asteroid["url"], asteroid["kind"]), TYPES[asteroid["kind"]]

    def damit(self, model_id: int) -> tuple[bytes, str]:
        """A shape of the DAMIT catalogue, by its model's number: vertices and facets."""
        if not 0 < model_id < 10_000_000:
            raise UnknownShape(f"no DAMIT model {model_id}")
        return self._kept(f"damit-{model_id}.obj", DAMIT_SHAPE.format(id=model_id), "obj"), TYPES["obj"]

    def _kept(self, name: str, url: str, kind: str) -> bytes:
        path = self.cache_dir / name
        try:
            return path.read_bytes()
        except FileNotFoundError:
            pass
        body = self.fetcher.get(url, timeout=120).body
        self._check(body, kind)
        if not self._unwritable:
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".part-")
                with os.fdopen(fd, "wb") as f:
                    f.write(body)
                os.replace(tmp, path)
            except OSError as e:
                self._unwritable = True
                self.log(f"asteroids: shapes are not kept, {self.cache_dir} cannot be written: {e}")
        return body

    @staticmethod
    def _check(body: bytes, kind: str):
        if len(body) > MOST_BYTES:
            raise BadShape(f"the shape is {len(body) // 1_000_000} MB, more than the {MOST_BYTES // 1_000_000} MB a shape may be")
        if kind == "glb" and body[:4] != b"glTF":
            raise BadShape("the file is not a GLB model")
        if kind == "obj" and b"\nv " not in b"\n" + body[:4096] and b"\nv\t" not in b"\n" + body[:4096]:
            raise BadShape("the file holds no vertices")
