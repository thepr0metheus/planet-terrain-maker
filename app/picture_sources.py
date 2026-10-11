"""User-entered picture sources in the mounted data directory, never in the source checkout.

URLs may contain a viewer's query key. They are stored as data only, not logged or fetched here.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import tempfile
import threading
from pathlib import Path
from urllib.parse import urlsplit


class InvalidSource(ValueError):
    """A source cannot be used as a 256-pixel HTTPS XYZ template."""


class SourceStoreError(OSError):
    """The persisted source list could not be read or written."""


class PictureSources:
    def __init__(self, path: Path):
        self.path = Path(path)
        self._lock = threading.Lock()

    @staticmethod
    def validate(data):
        if not isinstance(data, dict):
            raise InvalidSource("A picture source must be a JSON object.")
        url = data.get("url")
        if not isinstance(url, str):
            raise InvalidSource("Use an XYZ tile URL with {z}, {x} and {y}.")
        url = url.strip()
        if len(url) > 4096 or not all(key in url for key in ("{z}", "{x}", "{y}")) or re.search(r"[{}]", re.sub(r"\{[zxy]\}", "", url)):
            raise InvalidSource("Use an XYZ tile URL with {z}, {x} and {y}.")
        try:
            parsed = urlsplit(re.sub(r"\{[zxy]\}", "0", url))
            port = parsed.port
        except ValueError:
            raise InvalidSource("The tile URL must be a valid HTTPS address.") from None
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.fragment or "{" in "/".join(url.split("/")[:3]):
            raise InvalidSource("Use HTTPS without a login, password or fragment in the tile URL.")
        zoom = data.get("maxZoom")
        if zoom in (None, "", "auto"):
            zoom = None
        else:
            try:
                value = float(zoom)
                if isinstance(zoom, bool) or not math.isfinite(value) or value != int(value) or not 0 <= value <= 22:
                    raise ValueError
                zoom = int(value)
            except (ValueError, TypeError):
                raise InvalidSource("The last tile zoom must be a whole number from 0 to 22.") from None
        result = {"url": url, "maxZoom": zoom}
        for key, most in (("name", 120), ("credit", 600)):
            value = data.get(key, "")
            if not isinstance(value, str):
                raise InvalidSource("Source name and credit must be text.")
            result[key] = value.strip()[:most]
        result["key"] = hashlib.sha256(url.encode()).hexdigest()
        return result

    def _read(self):
        try:
            raw = json.loads(self.path.read_text())
            if not isinstance(raw, list):
                raise ValueError
            return [self.validate(entry) for entry in raw]
        except FileNotFoundError:
            return []
        except (OSError, ValueError, TypeError) as error:
            raise SourceStoreError("The saved picture sources could not be read.") from error

    def list(self):
        with self._lock:
            return self._read()

    def _write(self, entries):
        temporary = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd, name = tempfile.mkstemp(prefix=".picture-sources-", dir=self.path.parent)
            temporary = Path(name)
            with os.fdopen(fd, "w") as file:
                json.dump(entries, file, ensure_ascii=False, indent=1)
                file.flush()
                os.fsync(file.fileno())
            temporary.replace(self.path)
        except OSError as error:
            raise SourceStoreError("The picture sources could not be saved.") from error
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)

    def keep(self, data):
        source = self.validate(data)
        with self._lock:
            entries = [source, *(entry for entry in self._read() if entry["url"] != source["url"])]
            self._write(entries)
        return entries

    def forget(self, url):
        url = self.validate({"url": url})["url"]
        with self._lock:
            entries = [entry for entry in self._read() if entry["url"] != url]
            self._write(entries)
        return entries
