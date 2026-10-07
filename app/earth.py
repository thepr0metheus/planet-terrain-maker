"""Heights of a region on Earth from Copernicus DEM, through OpenTopography's API (a key is needed).

The other Earth heights, AWS Terrain Tiles, need no server work: they are map tiles, which the page
fetches through the tile relay and reads itself.
"""
from __future__ import annotations

import urllib.parse

from .fetch import Fetcher, FetchError
from .grids import Grid, parse_aaigrid
from .keys import KeyStore

URL = "https://portal.opentopography.org/API/globaldem"
# (demtype, degrees a cell, name). The finer one while the region fits in REQUEST_CELLS a side.
FINE = ("COP30", 1 / 3600, "Copernicus DEM 30 m (ESA), via OpenTopography")
COARSE = ("COP90", 3 / 3600, "Copernicus DEM 90 m (ESA), via OpenTopography")
REQUEST_CELLS = 1600


class KeyNeeded(Exception):
    """There is no key, or OpenTopography refused it (wrong, or out of its daily quota)."""


class SourceFailed(Exception):
    """OpenTopography did not send a grid."""


class Copernicus:
    def __init__(self, fetcher: Fetcher, keys: KeyStore):
        self.fetcher = fetcher
        self.keys = keys

    @staticmethod
    def pick(south: float, north: float, west: float, east: float):
        """The DEM to ask for: 30 m while the region is at most REQUEST_CELLS of it a side."""
        cells = max(north - south, east - west) / FINE[1]
        return FINE if cells <= REQUEST_CELLS else COARSE

    def grid(self, south: float, north: float, west: float, east: float, max_cells: int) -> Grid:
        key = self.keys.get()
        if not key:
            raise KeyNeeded("Copernicus heights need an OpenTopography key.")
        demtype, _, name = self.pick(south, north, west, east)
        query = {"demtype": demtype, "south": south, "north": north, "west": west, "east": east,
                 "outputFormat": "AAIGrid", "API_Key": key}
        try:
            answer = self.fetcher.get(URL + "?" + urllib.parse.urlencode(query), timeout=120)
        except FetchError as e:
            if e.status in (401, 403):
                raise KeyNeeded("OpenTopography refused the key.") from None
            if e.status == 429:
                raise KeyNeeded("OpenTopography says the key has used up its requests for today.") from None
            raise SourceFailed(self.keys.scrub(f"OpenTopography: {e}")) from None
        text = answer.body.decode("utf-8", errors="replace")
        if "ncols" not in text[:200].lower():
            said = self.keys.scrub(text.strip())[:300]
            if any(word in said.lower() for word in ("api_key", "api key", "invalid key", "unauthorized")):
                raise KeyNeeded(f"OpenTopography refused the key: {said}")
            raise SourceFailed(f"OpenTopography sent no heights here: {said or 'an empty answer'}")
        try:
            return parse_aaigrid(text, name).reduced(max_cells)
        except ValueError as e:
            raise SourceFailed(f"OpenTopography sent a grid that cannot be read: {e}") from None
