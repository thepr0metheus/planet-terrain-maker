"""Buildings of a region from OpenStreetMap, through the Overpass API: each one's outline and height.

Overpass is run by volunteers on a few servers; one of them is often busy. The server asks them in
turn, takes the first proper answer, and keeps it on disk: buildings change slowly, and a region is
looked at again and again while its model is made.
"""
from __future__ import annotations

import hashlib
import json
import re
import time
import urllib.parse
from pathlib import Path

from .fetch import Fetcher, FetchError

MIRRORS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
)
MAX_SIDE_DEG = 0.1          # about 11 km of latitude: more is too much for Overpass and for a model
MAX_BUILDINGS = 40000
KEEP_SECONDS = 30 * 24 * 3600
LEVEL_M = 3.0               # a storey
UNKNOWN_M = 6.0             # a building that says nothing about its height
CREDIT = "© OpenStreetMap contributors (Overpass API)"


class BuildingsUnavailable(Exception):
    """No Overpass server gave a proper answer."""


def height_of(tags: dict) -> float:
    """Metres from the ground to the roof, from what the building's tags say."""
    raw = str(tags.get("height", "")).strip().lower().replace(",", ".")
    match = re.match(r"^([0-9]+(?:\.[0-9]+)?)\s*(m|ft|')?$", raw)
    if match:
        value = float(match.group(1))
        if match.group(2) in ("ft", "'"):
            value *= 0.3048
        if 0 < value < 1000:
            return value
    try:
        levels = float(str(tags.get("building:levels", "")).replace(",", "."))
        if 0 < levels < 300:
            return levels * LEVEL_M + 1.0
    except ValueError:
        pass
    return UNKNOWN_M


def _rings(element: dict) -> list:
    """The closed outer rings of a way or a multipolygon, as [[lon, lat], ...]."""
    if element.get("type") == "way":
        lines = [element.get("geometry") or []]
    else:
        lines = [m.get("geometry") or [] for m in element.get("members", []) if m.get("role") == "outer"]
    rings = []
    for line in lines:
        points = [[p["lon"], p["lat"]] for p in line if "lat" in p and "lon" in p]
        if len(points) >= 4 and points[0] == points[-1]:
            rings.append(points[:-1])
    return rings


def read_answer(data: dict) -> list:
    """The buildings in an Overpass answer: [{"ring": [[lon, lat], ...], "height": metres}]."""
    remark = str(data.get("remark", ""))
    if "error" in remark.lower():
        raise ValueError(f"Overpass: {remark[:200]}")
    out = []
    for element in data.get("elements", []):
        tags = element.get("tags") or {}
        if "building" not in tags or tags.get("building") == "no":
            continue
        height = height_of(tags)
        for ring in _rings(element):
            out.append({"ring": ring, "height": round(height, 1)})
    return out


class Overpass:
    def __init__(self, fetcher: Fetcher, cache_dir: Path, clock=time.time, log=print):
        self.fetcher = fetcher
        self.cache_dir = Path(cache_dir)
        self.clock = clock
        self.log = log

    @staticmethod
    def check_region(south, north, west, east):
        if not (-90 <= south < north <= 90 and -180 <= west < east <= 180):
            raise ValueError("The region needs south < north and west < east, in degrees.")
        if north - south > MAX_SIDE_DEG or east - west > MAX_SIDE_DEG * 2:
            raise ValueError("Buildings are shown for regions up to about 10 km across.")

    def buildings(self, south, north, west, east) -> dict:
        self.check_region(south, north, west, east)
        box = ",".join(f"{v:.5f}" for v in (south, west, north, east))
        path = self.cache_dir / (hashlib.sha1(box.encode()).hexdigest()[:20] + ".json")
        try:
            if self.clock() - path.stat().st_mtime < KEEP_SECONDS:
                return json.loads(path.read_text())
        except (FileNotFoundError, ValueError):
            pass
        query = (f'[out:json][timeout:40];(way["building"]({box});'
                 f'relation["building"]["type"="multipolygon"]({box}););out tags geom;')
        failures = []
        for mirror in MIRRORS:
            try:
                answer = self.fetcher.post(mirror, urllib.parse.urlencode({"data": query}).encode(),
                                           headers={"Content-Type": "application/x-www-form-urlencoded"}, timeout=60)
                found = read_answer(json.loads(answer.body.decode("utf-8")))
            except (FetchError, ValueError) as e:
                failures.append(f"{urllib.parse.urlparse(mirror).netloc}: {e}")
                continue
            result = {"buildings": found[:MAX_BUILDINGS], "cut": len(found) > MAX_BUILDINGS, "credit": CREDIT}
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                tmp = path.with_suffix(".part")
                tmp.write_text(json.dumps(result, separators=(",", ":")))
                tmp.replace(path)
            except OSError as e:
                self.log(f"buildings: the answer is not kept, {self.cache_dir} cannot be written: {e}")
            return result
        self.log("buildings: no Overpass server answered: " + "; ".join(failures))
        raise BuildingsUnavailable("No Overpass server answered: " + "; ".join(failures))
