"""Names of places on Earth: a search by name, and the name of the place at a point. Both come from
Nominatim (OpenStreetMap). Names on the Moon, Mars and Venus need no server: the page carries the
IAU's lists (web/data/*-names.json).

Nominatim asks for at most one request a second from an application, and for answers to be kept:
the server waits its turn and remembers the last answers.
"""
from __future__ import annotations

import json
import threading
import time
import urllib.parse
from collections import OrderedDict

from .fetch import Fetcher

BASE = "https://nominatim.openstreetmap.org"
LANGUAGES = ("ru", "en")


class Nominatim:
    GAP = 1.0             # seconds between two requests
    KEEP = 256            # answers remembered

    def __init__(self, fetcher: Fetcher, clock=time.monotonic, sleep=time.sleep):
        self.fetcher = fetcher
        self.clock = clock
        self.sleep = sleep
        self._next = 0.0
        self._turn = threading.Lock()
        self._kept: OrderedDict = OrderedDict()
        self._kept_lock = threading.Lock()

    def search(self, query: str, language: str) -> list:
        """Up to 8 places whose names match: name, detail (the rest of the address), lat, lon, and
        box (south, north, west, east) when Nominatim gives one."""
        query = " ".join(query.split())[:200]
        if not query:
            return []
        language = language if language in LANGUAGES else "en"
        params = {"format": "jsonv2", "q": query, "limit": 8, "addressdetails": 0}
        return self._ask(("search", query.lower(), language), "/search", params, language, _places)

    def reverse(self, lat: float, lon: float, language: str) -> dict | None:
        """The place at a point, at about the size of a town: name and detail; None at sea."""
        language = language if language in LANGUAGES else "en"
        params = {"format": "jsonv2", "lat": f"{lat:.5f}", "lon": f"{lon:.5f}", "zoom": 10, "addressdetails": 0}
        key = ("reverse", round(lat, 3), round(lon, 3), language)
        return self._ask(key, "/reverse", params, language, _place_at)

    def _ask(self, key, path, params, language, read):
        with self._kept_lock:
            if key in self._kept:
                self._kept.move_to_end(key)
                return self._kept[key]
        self._wait_turn()
        answer = self.fetcher.get(f"{BASE}{path}?{urllib.parse.urlencode(params)}",
                                  headers={"Accept-Language": language}, timeout=20)
        result = read(json.loads(answer.body.decode("utf-8")))
        with self._kept_lock:
            self._kept[key] = result
            while len(self._kept) > self.KEEP:
                self._kept.popitem(last=False)
        return result

    def _wait_turn(self):
        with self._turn:
            wait = self._next - self.clock()
            if wait > 0:
                self.sleep(wait)
            self._next = self.clock() + self.GAP


def _split_name(display: str, name: str | None):
    parts = [p.strip() for p in (display or "").split(",") if p.strip()]
    first = name or (parts[0] if parts else "")
    rest = [p for p in parts if p != first]
    return first, ", ".join(rest[:3])


def _places(found) -> list:
    out = []
    for item in found if isinstance(found, list) else []:
        try:
            lat, lon = float(item["lat"]), float(item["lon"])
        except (KeyError, TypeError, ValueError):
            continue
        name, detail = _split_name(item.get("display_name", ""), item.get("name"))
        place = {"name": name, "detail": detail, "lat": lat, "lon": lon, "kind": item.get("type") or item.get("category")}
        box = item.get("boundingbox")
        if isinstance(box, list) and len(box) == 4:
            try:
                place["box"] = [float(v) for v in box]       # south, north, west, east
            except ValueError:
                pass
        out.append(place)
    return out


def _place_at(found) -> dict | None:
    if not isinstance(found, dict) or "error" in found or not found.get("display_name"):
        return None
    name, detail = _split_name(found.get("display_name", ""), found.get("name"))
    return {"name": name, "detail": detail}
