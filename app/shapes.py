"""The shapes of what the page puts on a model at its real size (asteroid-on-model.js): asteroids,
comets and NASA's spacecraft.

The page asks for a shape by the list it comes from: the best known asteroid shapes (web/data/
asteroids-top.json, made by tools/asteroids.py: NASA's 3D resources as GLB, JAXA's and the radar
models as vertices and facets), the comets seen up close (comets.json, by the same tool: vertices and
facets as OBJ or VRML, Halley's as a table of radii), NASA's models of spacecraft (the entries of
vehicles.json with an address; the others the page draws itself), or a model of the DAMIT catalogue
by its number. The server fetches the file from where it lives the first time, keeps it in
data/cache/asteroids, and gives it from there afterwards: a shape does not change. Only these lists
can be asked for, so the server fetches nothing anyone names.
"""
from __future__ import annotations

import json
import os
import re
import tempfile
from pathlib import Path

from .fetch import Fetcher

DAMIT_SHAPE = "https://damit.cuni.cz/projects/damit/generated_files/open/AsteroidModel/{id}/shape.obj"
MOST_BYTES = 30 * 1024 * 1024        # the largest, Ceres's, is 9.5 MB
# Each kind of file: its content type (Flask adds the charset to text) and what it must hold.
KINDS = {
    "glb": ("model/gltf-binary", lambda head: head[:4] == b"glTF", "the file is not a GLB model"),
    "obj": ("text/plain", lambda head: b"\nv " in b"\n" + head or b"\nv\t" in b"\n" + head, "the file holds no vertices"),
    "wrl": ("text/plain", lambda head: b"point" in head and head.startswith(b"#VRML"), "the file is no VRML shape"),
    "grid": ("text/plain", lambda head: re.match(rb"\s*[-\d.]+\s+[-\d.]+\s+[-\d.]+\s*\n", head) is not None,
             "the file is no table of radii"),
}
PREFIXES = {"top": "top", "comets": "comet", "vehicles": "vehicle"}      # of the files kept, by list


class UnknownShape(Exception):
    """No such shape in the lists."""


class BadShape(Exception):
    """The file that came is not the shape it should be."""


class ShapeFiles:
    # lists: {"top": path, "comets": path, "vehicles": path} of the page's lists; an entry without an
    # address (a vehicle the page draws itself) is none the server gives.
    def __init__(self, fetcher: Fetcher, cache_dir: Path, lists: dict, log=print):
        self.fetcher = fetcher
        self.cache_dir = Path(cache_dir)
        self.log = log
        self._lists = {name: {e["id"]: e for e in json.loads(Path(path).read_text(encoding="utf-8")) if e.get("url")}
                       for name, path in lists.items()}
        self._unwritable = False

    def listed(self, list_name: str, item_id: str) -> tuple[bytes, str]:
        """A shape of one of the lists, by its id: (the file, its content type)."""
        entry = self._lists[list_name].get(item_id)
        if not entry:
            raise UnknownShape(f"no shape called {item_id!r} in the list")
        kind = entry["kind"]
        return self._kept(f"{PREFIXES[list_name]}-{item_id}.{kind}", entry["url"], kind), KINDS[kind][0]

    def damit(self, model_id: int) -> tuple[bytes, str]:
        """A shape of the DAMIT catalogue, by its model's number: vertices and facets."""
        if not 0 < model_id < 10_000_000:
            raise UnknownShape(f"no DAMIT model {model_id}")
        return self._kept(f"damit-{model_id}.obj", DAMIT_SHAPE.format(id=model_id), "obj"), KINDS["obj"][0]

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
                self.log(f"shapes: not kept, {self.cache_dir} cannot be written: {e}")
        return body

    @staticmethod
    def _check(body: bytes, kind: str):
        if len(body) > MOST_BYTES:
            raise BadShape(f"the shape is {len(body) // 1_000_000} MB, more than the {MOST_BYTES // 1_000_000} MB a shape may be")
        _, holds, says = KINDS[kind]
        if not holds(body[:4096]):
            raise BadShape(says)
