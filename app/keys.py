"""The OpenTopography key: the one secret the app has. Copernicus heights need it.

It is given once on the page; the server keeps it in data/keys/opentopo (mode 600) and uses it
for every device. The page can set it, replace it and remove it, and asks only whether there is
one: the key itself never goes back out. Without a file the server takes OPENTOPO_KEY from its
environment, if there is one.
"""
from __future__ import annotations

import os
import re
from pathlib import Path

# OpenTopography's keys are 32 hex digits; a little room either way, nothing that could break a URL.
KEY_PATTERN = re.compile(r"^[A-Za-z0-9_-]{16,128}$")


class KeyStore:
    def __init__(self, path: Path, fallback: str | None = None):
        self.path = Path(path)
        self.fallback = fallback or None

    def get(self) -> str | None:
        try:
            key = self.path.read_text().strip()
        except FileNotFoundError:
            key = ""
        return key or self.fallback

    @property
    def where(self) -> str | None:
        """Where the key in use comes from: "page", "environment" or None (no key)."""
        if self.path.is_file() and self.path.read_text().strip():
            return "page"
        return "environment" if self.fallback else None

    def set(self, key: str):
        key = key.strip()
        if not KEY_PATTERN.match(key):
            raise ValueError("A key is 16 to 128 letters, digits, '-' or '_'.")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".part")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(key)
        os.replace(tmp, self.path)

    def clear(self):
        self.path.unlink(missing_ok=True)

    def scrub(self, text: str) -> str:
        """`text` without the key in it: what a service says back may quote the request."""
        key = self.get()
        return text.replace(key, "[key]") if key else text
