"""What the running app is made of, named as osv.dev names it (GET /api/packages).

A check of known vulnerabilities must see what is installed, not what the project's files ask for:
pip brings Flask's own libraries (Jinja2, MarkupSafe, itsdangerous, click, blinker) at versions
nobody pinned, the image brings Alpine's packages, on which Python itself runs, and the page carries
three.js and Leaflet (web/vendor/VERSIONS.json). Each entry is a query osv.dev answers as it is,
{ecosystem, name, version}, so whoever checks needs to know nothing of this app.

Alpine's packages are named by their origin, the source package: libcrypto3 and libssl3 both come
from openssl, and osv.dev knows only that name. Asked by the installed names it finds nothing, which
would read as "no vulnerabilities".
"""
from __future__ import annotations

import importlib.metadata
import json
import platform
import re
from pathlib import Path

APK_DB = "lib/apk/db/installed"


class InstalledPackages:
    """The packages of this copy of the app, read once: a running container does not change."""

    def __init__(self, root: Path = Path("/"), vendor_versions: Path | None = None,
                 distributions=importlib.metadata.distributions, python_version=platform.python_version):
        self.root = Path(root)
        self.vendor_versions = Path(vendor_versions) if vendor_versions else None
        self._distributions = distributions
        self._python_version = python_version
        self._listing = None

    def listing(self) -> dict:
        """{runtime, os, packages}. os is None when the system cannot be told, and os.listed is False
        when its packages cannot be read: then a check must say it did not see them."""
        if self._listing is None:
            system = self._system()
            packages = self._python() + self._page()
            if system and system["listed"]:
                packages += self._alpine(system["version"])
            self._listing = {"runtime": {"name": "python", "version": self._python_version()},
                             "os": system, "packages": packages}
        return self._listing

    def _system(self) -> dict | None:
        try:
            text = (self.root / "etc" / "os-release").read_text(encoding="utf-8")
        except OSError:
            return None
        fields = {}
        for line in text.splitlines():
            key, sep, value = line.partition("=")
            if sep:
                fields[key.strip()] = value.strip().strip('"\'')
        name, version = fields.get("ID"), fields.get("VERSION_ID", "")
        if not name:
            return None
        listed = name == "alpine" and bool(re.match(r"\d+\.\d+", version)) and (self.root / APK_DB).is_file()
        return {"name": name, "version": version, "listed": listed}

    def _python(self) -> list[dict]:
        found = {}
        for dist in self._distributions():
            if not dist.name:
                continue
            name = re.sub(r"[-_.]+", "-", dist.name).lower()       # as PyPI compares names
            found[(name, dist.version)] = {"ecosystem": "PyPI", "name": name, "version": dist.version}
        return sorted(found.values(), key=lambda p: (p["name"], p["version"]))

    def _page(self) -> list[dict]:
        # no file is no listing, not an empty one: the error goes out, and the check fails aloud
        if not self.vendor_versions:
            return []
        versions = json.loads(self.vendor_versions.read_text(encoding="utf-8"))
        return [{"ecosystem": "npm", "name": name, "version": version} for name, version in sorted(versions.items())]

    def _alpine(self, os_version: str) -> list[dict]:
        ecosystem = "Alpine:v" + ".".join(os_version.split(".")[:2])
        found = {}
        for record in (self.root / APK_DB).read_text(encoding="utf-8", errors="replace").split("\n\n"):
            fields = {}
            for line in record.splitlines():
                if len(line) > 2 and line[1] == ":":
                    fields.setdefault(line[0], line[2:])
            name, version = fields.get("o") or fields.get("P"), fields.get("V")
            if name and version:
                found[(name, version)] = {"ecosystem": ecosystem, "name": name, "version": version}
        return sorted(found.values(), key=lambda p: (p["name"], p["version"]))
