"""What is set once for every device: where each world's map opens, and a set of free-flight speeds
of your own.

Kept in data/settings.json. A world without its own start opens where the page itself says
(web/js/worlds.js: Elbrus, Tranquility Base, Olympus Mons, Maat Mons).
"""
from __future__ import annotations

import json
import math
import threading
from pathlib import Path

WORLDS = ("earth", "moon", "mars", "venus")
# The actions of free flight whose speeds a set holds (web/js/fly-camera.js RATES), and their range.
FLY_RATES = ("move", "slide", "climb", "turn", "tilt", "bank")
FLY_LEAST, FLY_MOST = 0.001, 1.0


class Refused(ValueError):
    """A setting that cannot be: an unknown world, a point off the map."""


class Settings:
    def __init__(self, path: Path):
        self.path = Path(path)
        self._lock = threading.Lock()

    def _read(self) -> dict:
        try:
            data = json.loads(self.path.read_text())
        except (FileNotFoundError, ValueError):
            return {}
        return data if isinstance(data, dict) else {}

    def _write(self, data: dict):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".part")
        tmp.write_text(json.dumps(data, indent=1))
        tmp.replace(self.path)

    def starts(self) -> dict:
        """{world: {lat, lon, zoom}} for the worlds that have their own start."""
        starts = self._read().get("starts", {})
        return {w: s for w, s in starts.items() if w in WORLDS and isinstance(s, dict)}

    def set_start(self, world: str, lat, lon, zoom) -> dict:
        if world not in WORLDS:
            raise Refused(f"world must be one of: {', '.join(WORLDS)}")
        try:
            lat, lon, zoom = float(lat), float(lon), float(zoom)
        except (TypeError, ValueError):
            raise Refused("lat, lon and zoom must be numbers") from None
        if not all(math.isfinite(v) for v in (lat, lon, zoom)):
            raise Refused("lat, lon and zoom must be numbers")
        if not (-89 <= lat <= 89 and -180 <= lon <= 180 and 0 <= zoom <= 22):
            raise Refused("the start must lie on the map: lat within -89..89, lon within -180..180, zoom within 0..22")
        start = {"lat": round(lat, 6), "lon": round(lon, 6), "zoom": round(zoom, 2)}
        with self._lock:
            data = self._read()
            data.setdefault("starts", {})[world] = start
            self._write(data)
        return start

    def fly_preset(self):
        """The set of flight speeds of your own: {action: share of its full speed}, or None."""
        preset = self._read().get("fly_preset")
        return preset if isinstance(preset, dict) else None

    def set_fly_preset(self, rates) -> dict:
        if not isinstance(rates, dict):
            raise Refused("the set must be a JSON object of speeds")
        preset = {}
        for name in FLY_RATES:
            try:
                value = float(rates[name])
            except (KeyError, TypeError, ValueError):
                raise Refused(f"the set needs a number for each of: {', '.join(FLY_RATES)}") from None
            if not (math.isfinite(value) and FLY_LEAST <= value <= FLY_MOST):
                raise Refused(f"{name} must lie within {FLY_LEAST}..{FLY_MOST}")
            preset[name] = round(value, 6)
        with self._lock:
            data = self._read()
            data["fly_preset"] = preset
            self._write(data)
        return preset

    def clear_start(self, world: str):
        if world not in WORLDS:
            raise Refused(f"world must be one of: {', '.join(WORLDS)}")
        with self._lock:
            data = self._read()
            if world in data.get("starts", {}):
                del data["starts"][world]
                self._write(data)
