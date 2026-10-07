"""The saved models, on the server: one folder a model under data/models, so that a model saved on
a computer opens on a phone too.

A folder holds meta.json (the name, the places, the settings) and the model's files: the heights of
each place (float32), its picture (JPEG) and a small picture for the list. The server checks names
and sizes, and nothing else: what a model means is the page's business.

A model removed goes to data/trash first, and leaves it after TRASH_DAYS.
"""
from __future__ import annotations

import json
import re
import secrets
import shutil
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

ID = re.compile(r"^[0-9a-f]{12}$")
FILE = re.compile(r"^[a-z0-9][a-z0-9-]{0,40}\.(bin|jpg|png)$")
MAX_FILE = 96 * 1024 * 1024
MAX_TOTAL = 320 * 1024 * 1024
MAX_FILES = 16
MAX_META = 512 * 1024
MAX_NAME = 120
TRASH_DAYS = 30


class NotFound(Exception):
    """No model with that id, or no such file in it."""


class Refused(ValueError):
    """What was sent cannot be kept: a wrong name, a size over the limits, meta that is not an object."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Library:
    def __init__(self, root: Path, trash: Path, clock=time.time):
        self.root = Path(root)
        self.trash = Path(trash)
        self.clock = clock
        self._lock = threading.Lock()

    # ---------- reading ----------

    def list(self) -> list:
        """Every model, the last changed first: id, name, created, updated, worlds, places (name and
        world of each), and the files it has."""
        out = []
        if not self.root.is_dir():
            return out
        for folder in self.root.iterdir():
            if not ID.match(folder.name):
                continue
            try:
                meta = json.loads((folder / "meta.json").read_text())
            except (FileNotFoundError, ValueError):
                continue
            out.append({
                "id": meta["id"], "name": meta.get("name", ""), "created": meta.get("created"),
                "updated": meta.get("updated"), "worlds": meta.get("worlds", []),
                "places": [{"name": p.get("name", ""), "world": p.get("world")} for p in meta.get("places", [])],
                "files": sorted(meta.get("files", {})),
            })
        out.sort(key=lambda m: m.get("updated") or "", reverse=True)
        return out

    def get(self, model_id: str) -> dict:
        try:
            return json.loads((self._folder(model_id) / "meta.json").read_text())
        except FileNotFoundError:
            raise NotFound(model_id) from None

    def file(self, model_id: str, name: str) -> Path:
        if not FILE.match(name):
            raise NotFound(name)
        path = self._folder(model_id) / name
        if not path.is_file():
            raise NotFound(f"{model_id}/{name}")
        return path

    # ---------- writing ----------

    def create(self, meta: dict, files: dict) -> dict:
        model_id = secrets.token_hex(6)
        stamp = _now()
        meta = self._checked(meta, files)
        meta.update({"id": model_id, "created": stamp, "updated": stamp})
        with self._lock:
            self._write_folder(model_id, meta, files)
        return meta

    def replace(self, model_id: str, meta: dict, files: dict) -> dict:
        """Everything of a model anew: meta and files. Kept from before: the id and when it was made."""
        before = self.get(model_id)
        meta = self._checked(meta, files)
        meta.update({"id": model_id, "created": before.get("created"), "updated": _now()})
        with self._lock:
            self._write_folder(model_id, meta, files)
        return meta

    def copy(self, model_id: str, name=None) -> dict:
        """A new model with all of this one, its files and settings: a new id, a name (this one's when
        none is given), made now. The copy is written beside the others and then takes its place."""
        source = self._folder(model_id)
        meta = self.get(model_id)
        new_id = secrets.token_hex(6)
        stamp = _now()
        meta.update({"id": new_id, "name": self._name(meta.get("name") if name is None else name),
                     "created": stamp, "updated": stamp})
        with self._lock:
            fresh = self.root / f".new-{new_id}-{secrets.token_hex(3)}"
            try:
                shutil.copytree(source, fresh)
                self._write_json(fresh / "meta.json", meta)
                fresh.rename(self.root / new_id)
            except BaseException:
                shutil.rmtree(fresh, ignore_errors=True)
                raise
        return meta

    def rename(self, model_id: str, name: str, places=None) -> dict:
        """A new name for the model, and with places ([name, ...], one for each place) for its places too."""
        with self._lock:
            meta = self.get(model_id)
            meta["name"] = self._name(name)
            if places is not None:
                if not isinstance(places, list) or len(places) != len(meta.get("places", [])):
                    raise Refused("places must give a name for each place of the model.")
                for place, new in zip(meta["places"], places):
                    place["name"] = self._name(new)
            meta["updated"] = _now()
            self._write_json(self._folder(model_id) / "meta.json", meta)
        return meta

    def remove(self, model_id: str):
        with self._lock:
            folder = self._folder(model_id)
            if not folder.is_dir():
                raise NotFound(model_id)
            self.trash.mkdir(parents=True, exist_ok=True)
            folder.rename(self.trash / f"{model_id}-{int(self.clock())}")
        self.empty_trash()

    def empty_trash(self) -> int:
        """Removes what lies in the trash longer than TRASH_DAYS. Returns how many models went."""
        if not self.trash.is_dir():
            return 0
        gone = 0
        for folder in self.trash.iterdir():
            stamp = folder.name.rpartition("-")[2]
            if stamp.isdigit() and self.clock() - int(stamp) > TRASH_DAYS * 86400:
                shutil.rmtree(folder, ignore_errors=True)
                gone += 1
        return gone

    # ---------- inside ----------

    def _folder(self, model_id: str) -> Path:
        if not ID.match(model_id or ""):
            raise NotFound(model_id)
        return self.root / model_id

    @staticmethod
    def _name(name) -> str:
        name = " ".join(str(name or "").split())
        if not name:
            raise Refused("A model needs a name.")
        return name[:MAX_NAME]

    def _checked(self, meta, files: dict) -> dict:
        if not isinstance(meta, dict):
            raise Refused("meta must be a JSON object.")
        if len(json.dumps(meta)) > MAX_META:
            raise Refused(f"meta is over {MAX_META // 1024} KB.")
        if len(files) > MAX_FILES:
            raise Refused(f"At most {MAX_FILES} files a model.")
        total = 0
        for name, body in files.items():
            if not FILE.match(name):
                raise Refused(f"A file may not be called {name!r}.")
            if len(body) > MAX_FILE:
                raise Refused(f"{name} is over {MAX_FILE // (1024 * 1024)} MB.")
            total += len(body)
        if total > MAX_TOTAL:
            raise Refused(f"The files are over {MAX_TOTAL // (1024 * 1024)} MB together.")
        meta = dict(meta)
        meta["name"] = self._name(meta.get("name"))
        meta["files"] = {name: len(body) for name, body in sorted(files.items())}
        return meta

    def _write_folder(self, model_id: str, meta: dict, files: dict):
        """The new folder is written beside the old one and then takes its place: a reader sees the
        old model or the new one, never half of each."""
        self.root.mkdir(parents=True, exist_ok=True)
        final = self.root / model_id
        fresh = self.root / f".new-{model_id}-{secrets.token_hex(3)}"
        fresh.mkdir()
        try:
            for name, body in files.items():
                (fresh / name).write_bytes(body)
            self._write_json(fresh / "meta.json", meta)
            if final.exists():
                old = self.root / f".old-{model_id}-{secrets.token_hex(3)}"
                final.rename(old)
                fresh.rename(final)
                shutil.rmtree(old, ignore_errors=True)
            else:
                fresh.rename(final)
        except BaseException:
            shutil.rmtree(fresh, ignore_errors=True)
            raise

    @staticmethod
    def _write_json(path: Path, data: dict):
        tmp = path.with_suffix(".part")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1))
        tmp.replace(path)
