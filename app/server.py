"""The web server: the page itself (web/), and the API the page works through.

Everything the page needs from other services goes through here: map tiles (kept on disk), heights,
names, buildings. The saved models live here too, in data/models.
"""
from __future__ import annotations

import json
import math
import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, Response, jsonify, request, send_from_directory

from .apispec import Param, api, build
from .asteroids import AsteroidShapes, BadShape, UnknownShape
from .buildings import BuildingsUnavailable, Overpass
from .copdem import CopError, CopernicusAws
from .earth import Copernicus, KeyNeeded, SourceFailed
from .fetch import Fetcher, FetchError
from .grids import Grid
from .keys import KeyStore
from .library import Library, NotFound, Refused
from .pictures import PictureSizes
from .places import Nominatim
from .settings import Refused as SettingRefused, Settings
from .planets import PLANETS, NoHeights, RegionError
from .tiles import SOURCES, TileMissing, TileRelay

HERE = Path(__file__).resolve().parent
WEB = HERE.parent / "web"
VERSION_FILE = HERE.parent / "VERSION"

MAX_CELLS = 1024                 # a heights grid a side, at most
MAX_IMAGE = 4096                 # a planet picture a side, at most
TILE_CACHE_BYTES = int(os.environ.get("TILE_CACHE_MB", "4096")) * 1024 * 1024

# The page loads nothing from other sites: tiles, heights and names come through this server.
# connect-src blob: lets the page read what it made itself: GLTFLoader reads a model's pictures from blobs
CSP = ("default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self' blob:; "
       "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")

SOUTH = Param("south", "number", "South edge of the region, degrees.", True)
NORTH = Param("north", "number", "North edge of the region, degrees.", True)
WEST = Param("west", "number", "West edge of the region, degrees (-180..180).", True)
EAST = Param("east", "number", "East edge of the region, degrees (-180..180).", True)
BOX = (SOUTH, NORTH, WEST, EAST)
CELLS = Param("cells", "integer", f"Cells a side at most (default and limit {MAX_CELLS}).")
WORLD = Param("world", "string", "moon, mars or venus.", True)
LANG = Param("lang", "string", "Language of the names: ru or en (default en).")
GRID_ANSWER = ("The heights as float32 numbers, little-endian, row by row from the north-west corner, NaN where "
               "there is no height. Headers: X-Grid-Cols, X-Grid-Rows, X-Grid-Box (south,north,west,east of the "
               "corner cells' centres), X-Grid-Source.")


def version() -> str | None:
    """The commit this copy was made from (git archive writes it into VERSION), or None for a working copy."""
    try:
        text = VERSION_FILE.read_text().strip()
    except FileNotFoundError:
        return None
    return None if not text or text.startswith("$Format") else text


def log(*parts):
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print(stamp, *parts, flush=True)


class BadRequest(Exception):
    """The request asks for something that is not there or cannot be: answered with 400."""


def _number(name: str, low: float | None = None, high: float | None = None) -> float:
    raw = request.args.get(name)
    try:
        value = float(raw)
    except (TypeError, ValueError):
        raise BadRequest(f"{name} must be a number") from None
    if not math.isfinite(value) or (low is not None and value < low) or (high is not None and value > high):
        raise BadRequest(f"{name} is out of range")
    return value


def _box() -> tuple:
    south, north = _number("south", -90, 90), _number("north", -90, 90)
    west, east = _number("west", -180, 180), _number("east", -180, 180)
    if not (south < north and west < east):
        raise BadRequest("the region needs south < north and west < east")
    return south, north, west, east


def _cells() -> int:
    raw = request.args.get("cells")
    if raw is None:
        return MAX_CELLS
    try:
        cells = int(raw)
    except ValueError:
        raise BadRequest("cells must be a whole number") from None
    if not 2 <= cells <= MAX_CELLS:
        raise BadRequest(f"cells must be within 2..{MAX_CELLS}")
    return cells


def _grid_response(grid: Grid) -> Response:
    return Response(grid.to_bytes(), mimetype="application/octet-stream", headers=grid.headers())


def _error(status: int, message: str, **more) -> Response:
    response = jsonify({"error": message, **more})
    response.status_code = status
    return response


class ClientErrors:
    """Errors the page reports: written to the log, at most PER_MINUTE a minute, and the last KEEP of
    them kept in data/client-errors.jsonl, so that what went wrong on another device (an iPad) can be
    read without the container's log (GET /api/client-errors)."""
    PER_MINUTE = 30
    FIELD = 600
    KEEP = 300

    def __init__(self, path: Path | None = None, clock=time.time):
        self.path = Path(path) if path else None
        self.clock = clock
        self._times: list = []
        self._lock = threading.Lock()

    def take(self, report: dict) -> bool:
        now = self.clock()
        self._times = [t for t in self._times if now - t < 60]
        if len(self._times) >= self.PER_MINUTE:
            return False
        self._times.append(now)
        cut = {k: str(report.get(k, ""))[: self.FIELD] for k in ("message", "where", "page", "version")}
        stack = str(report.get("stack", ""))[: self.FIELD * 4]
        details = report.get("details")
        details = json.dumps(details, ensure_ascii=False)[: self.FIELD * 4] if isinstance(details, dict) else ""
        log(f"client error: {cut['message']} [{cut['where']}] page {cut['page']} version {cut['version']}")
        if details:
            log(f"  details: {details}")
        if stack:
            log("  " + stack.replace("\n", "\n  "))
        self._keep({"time": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(now)), **cut, "details": details,
                    "agent": str(report.get("agent", ""))[: self.FIELD], "stack": stack})
        return True

    def recent(self, count: int) -> list:
        """The last `count` reports kept, the newest last."""
        if not self.path:
            return []
        try:
            lines = self.path.read_text().splitlines()
        except FileNotFoundError:
            return []
        out = []
        for line in lines[-count:]:
            try:
                out.append(json.loads(line))
            except ValueError:
                continue
        return out

    def _keep(self, entry: dict):
        if not self.path:
            return
        with self._lock:
            try:
                lines = self.path.read_text().splitlines() if self.path.exists() else []
                lines = (lines + [json.dumps(entry, ensure_ascii=False)])[-self.KEEP:]
                self.path.parent.mkdir(parents=True, exist_ok=True)
                tmp = self.path.with_suffix(".part")
                tmp.write_text("\n".join(lines) + "\n")
                tmp.replace(self.path)
            except OSError as e:
                log(f"client errors are not kept: {e}")


def create_app(data_dir: Path, fetcher: Fetcher | None = None, opentopo_key: str | None = None) -> Flask:
    data_dir = Path(data_dir)
    fetcher = fetcher or Fetcher()
    app = Flask(__name__, static_folder=None)
    app.config["MAX_CONTENT_LENGTH"] = 340 * 1024 * 1024
    app.json.ensure_ascii = False

    tiles = TileRelay(data_dir / "cache" / "tiles", fetcher, TILE_CACHE_BYTES)
    keys = KeyStore(data_dir / "keys" / "opentopo", fallback=opentopo_key)
    copernicus = Copernicus(fetcher, keys)
    copernicus_aws = CopernicusAws(fetcher, data_dir / "cache" / "copernicus", log=log)
    nominatim = Nominatim(fetcher)
    overpass = Overpass(fetcher, data_dir / "cache" / "buildings", log=log)
    library = Library(data_dir / "models", data_dir / "trash")
    settings_store = Settings(data_dir / "settings.json")
    client_errors = ClientErrors(data_dir / "client-errors.jsonl")
    pictures = PictureSizes(data_dir / "cache" / "pictures", log=log)
    asteroids = AsteroidShapes(fetcher, data_dir / "cache" / "asteroids", WEB / "data" / "asteroids-top.json", log=log)

    @app.errorhandler(BadRequest)
    def bad_request(e):
        return _error(400, str(e))

    @app.errorhandler(PermissionError)
    def cannot_write(e):
        log(f"cannot write: {e}")
        return _error(503, "The app cannot write its folder data/: give it the right to write there.",
                      cannot_write=True)

    @app.after_request
    def headers(response):
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        if response.mimetype == "text/html":
            response.headers["Content-Security-Policy"] = CSP
        return response

    # ---------- the page ----------

    @app.get("/")
    @api(responses={200: "The page."})
    def index():
        """The page of the app."""
        response = send_from_directory(WEB, "index.html", max_age=0)
        response.headers["Cache-Control"] = "no-cache"
        return response

    @app.get("/<path:path>")
    @api(responses={200: "The file.", 404: "There is no such file."})
    def page_file(path):
        """A file of the page: scripts, styles, pictures, the names of places on other worlds."""
        response = send_from_directory(WEB, path, max_age=0)
        response.headers["Cache-Control"] = "no-cache"
        return response

    @app.get("/healthz")
    @api(responses={200: "{status: ok, version: the commit, or null for a working copy}"})
    def healthz():
        """Whether the app is up, and which commit it runs."""
        return jsonify({"status": "ok", "version": version()})

    @app.get("/openapi.json")
    @api(responses={200: "This description, OpenAPI 3.1."})
    def openapi():
        """The description of this API, made from its routes."""
        return jsonify(build(app, version()))

    # ---------- maps and data ----------

    @app.get("/api/tile/<source>/<int:z>/<int:x>/<int:y>")
    @api(responses={200: "The tile (JPEG or PNG).", 404: "No such layer, or the layer has no such tile.",
                    502: "The layer's service failed, also when asked again twice."})
    def tile(source, z, x, y):
        """A map tile of one of the layers the page shows or captures, fetched once and kept on disk.

        Layers: earth-photo (Esri World Imagery), earth-s2-2025 (Sentinel-2 cloudless 2025 by EOX), earth-usgs (USGS
        orthoimagery, the USA only), earth-labels (Esri reference layer), earth-heights (AWS Terrain Tiles, terrarium
        coding), moon-wac, moon-kaguya, mars-mdim, mars-themis, venus-c3, venus-sar (NASA Trek), mars-ctx (the CTX
        mosaic of Mars by Esri: tiles of 512 points)."""
        layer = SOURCES.get(source)
        if layer is None or not layer.has(z, x, y):
            return _error(404, "no such tile")
        try:
            found = tiles.get(layer, z, x, y)
        except TileMissing:
            return _error(404, "the layer has no such tile")
        except FetchError as e:
            log(f"tile {source} {z}/{x}/{y}: {e}")
            return _error(502, f"{source}: {e}")
        response = Response(found.body, mimetype=found.content_type)
        response.headers["Cache-Control"] = "public, max-age=2592000, immutable"
        return response

    # A shape of an asteroid, from one of its two lists; it does not change, so it is kept long.
    def shape(get, what):
        try:
            body, content_type = get()
        except UnknownShape as e:
            return _error(404, str(e))
        except (FetchError, BadShape) as e:
            log(f"asteroid {what}: {e}")
            return _error(502, f"{what}: {e}")
        response = Response(body, mimetype=content_type)
        response.headers["Cache-Control"] = "public, max-age=2592000, immutable"
        return response

    @app.get("/api/asteroids/top/<asteroid_id>")
    @api(responses={200: "The shape: a GLB model (NASA's) or vertices and facets as OBJ text (JAXA's, the radar models).",
                    404: "No such asteroid in the list.", 502: "Where the shape lives did not give it, or gave something else."})
    def asteroid_top(asteroid_id):
        """One of the best known shapes of asteroids, by its id in web/data/asteroids-top.json, fetched once and kept on disk."""
        return shape(lambda: asteroids.top(asteroid_id), asteroid_id)

    @app.get("/api/asteroids/damit/<int:model_id>")
    @api(responses={200: "The shape: vertices and facets as OBJ text, in no particular unit (the page sizes it).",
                    404: "No such model.", 502: "DAMIT did not give it, or gave something else."})
    def asteroid_damit(model_id):
        """A shape of the DAMIT catalogue, by its model's number in web/data/asteroids-damit.json, fetched once and kept on disk."""
        return shape(lambda: asteroids.damit(model_id), f"DAMIT {model_id}")

    @app.get("/api/earth/heights")
    @api(*BOX, CELLS, Param("source", "string", "aws: Copernicus DEM read from AWS Open Data, no key; opentopography "
                                              "(the default): the same model through OpenTopography, with its key."),
         responses={
        200: GRID_ANSWER,
        400: "The region is missing or wrong.",
        403: "There is no OpenTopography key, or OpenTopography refused it: {error, key_needed: true}.",
        502: "AWS or OpenTopography failed or sent no heights."})
    def earth_heights():
        """Heights of a region on Earth from Copernicus DEM: 30 m (90 m where 30 m is not released, or big regions).

        source=aws reads the model's files on AWS Open Data, no key, and keeps what it read on disk. Without it,
        OpenTopography answers, with its key (PUT /api/settings/opentopo-key). AWS Terrain heights need no server:
        they are the earth-heights tiles."""
        south, north, west, east = _box()
        if request.args.get("source") == "aws":
            try:
                grid = copernicus_aws.grid(south, north, west, east, _cells())
            except (FetchError, CopError, ValueError) as e:
                log(f"earth heights (aws): {e}")
                return _error(502, f"Copernicus on AWS: {e}")
            log(f"earth heights {grid.cols}x{grid.rows} from {grid.source}")
            return _grid_response(grid)
        try:
            grid = copernicus.grid(south, north, west, east, _cells())
        except KeyNeeded as e:
            return _error(403, str(e), key_needed=True)
        except SourceFailed as e:
            log(f"earth heights: {e}")
            return _error(502, str(e))
        log(f"earth heights {grid.cols}x{grid.rows} from {grid.source}")
        return _grid_response(grid)

    def _planet():
        world = request.args.get("world", "")
        if world not in PLANETS:
            raise BadRequest(f"world must be one of: {', '.join(PLANETS)}")
        return PLANETS[world]

    @app.get("/api/planet/heights")
    @api(WORLD, *BOX, CELLS, Param("source", "string", "trek: Trek's own heights only (on the Moon LRO LOLA 118 m, "
                                                     "never SLDEM2015); the finest there is when left out."),
         responses={200: GRID_ANSWER, 400: "The world, the region or the source is wrong.",
                    502: "Trek failed, or has no heights there."})
    def planet_heights():
        """Heights of a region on the Moon, Mars or Venus, from NASA Trek (and SLDEM2015 for small Moon regions).

        Metres from each body's reference sphere: the Moon 1737.4 km, Mars 3396.19 km, Venus 6051.8 km."""
        planet = _planet()
        south, north, west, east = _box()
        source = request.args.get("source")
        if source not in (None, "trek"):
            return _error(400, "source must be trek, or left out")
        try:
            grid = planet.grid(fetcher, south, north, west, east, _cells(), log=log, finest=source is None)
        except RegionError as e:
            return _error(400, str(e))
        except (FetchError, NoHeights, ValueError) as e:
            log(f"{planet.body} heights: {e}")
            return _error(502, str(e))
        log(f"{planet.body} heights {grid.cols}x{grid.rows} from {grid.source}")
        return _grid_response(grid)

    @app.get("/api/planet/image")
    @api(WORLD, *BOX, Param("width", "integer", f"Pixels across, at most {MAX_IMAGE}.", True),
         Param("height", "integer", f"Pixels down, at most {MAX_IMAGE}.", True),
         responses={200: "A JPEG of exactly the region, north up.",
                    400: "The world has no one-picture imagery (Venus: its tiles are stitched), or the region or size is wrong.",
                    502: "Trek failed."})
    def planet_image():
        """The imagery of a region on the Moon or Mars as one picture, from NASA Trek."""
        planet = _planet()
        south, north, west, east = _box()
        width = int(_number("width", 2, MAX_IMAGE))
        height = int(_number("height", 2, MAX_IMAGE))
        try:
            body = planet.image(fetcher, south, north, west, east, width, height)
        except RegionError as e:
            return _error(400, str(e))
        except FetchError as e:
            log(f"{planet.body} image: {e}")
            return _error(502, str(e))
        return Response(body, mimetype="image/jpeg")

    @app.get("/api/search")
    @api(Param("q", "string", "What to look for: a name.", True), LANG,
         responses={200: "[{name, detail, lat, lon, kind, box: [south, north, west, east]}], at most 8.",
                    502: "Nominatim failed."})
    def search():
        """Places on Earth whose names match (Nominatim, OpenStreetMap)."""
        try:
            return jsonify(nominatim.search(request.args.get("q", ""), request.args.get("lang", "en")))
        except (FetchError, ValueError) as e:
            log(f"search: {e}")
            return _error(502, f"Nominatim: {e}")

    @app.get("/api/place")
    @api(Param("lat", "number", "Latitude.", True), Param("lon", "number", "Longitude.", True), LANG,
         responses={200: "{name, detail}, or null at sea.", 400: "lat or lon is wrong.", 502: "Nominatim failed."})
    def place():
        """The name of the place on Earth at a point, at about the size of a town (Nominatim)."""
        lat, lon = _number("lat", -90, 90), _number("lon", -180, 180)
        try:
            return jsonify(nominatim.reverse(lat, lon, request.args.get("lang", "en")))
        except (FetchError, ValueError) as e:
            log(f"place: {e}")
            return _error(502, f"Nominatim: {e}")

    @app.get("/api/buildings")
    @api(*BOX, responses={
        200: "{buildings: [{ring: [[lon, lat], ...], height: metres}], cut: whether there were more, credit}.",
        400: "The region is wrong or bigger than about 10 km.", 502: "No Overpass server answered."})
    def buildings():
        """Buildings of a region on Earth from OpenStreetMap (Overpass API): outlines and heights."""
        south, north, west, east = _box()
        try:
            return jsonify(overpass.buildings(south, north, west, east))
        except ValueError as e:
            return _error(400, str(e))
        except BuildingsUnavailable as e:
            return _error(502, str(e))

    # ---------- settings ----------

    @app.get("/api/settings")
    @api(responses={200: '{opentopo_key: "page" | "environment" | null, starts: {world: {lat, lon, zoom}}, '
                         "fly_preset: {move, slide, climb, turn, tilt, bank} | null}: where the key in use comes from "
                         "(the key itself is never sent), where each world's map opens, your own set of flight speeds."})
    def settings():
        """What the server knows that the page may ask about."""
        return jsonify({"opentopo_key": keys.where, "starts": settings_store.starts(), "fly_preset": settings_store.fly_preset()})

    @app.put("/api/settings/fly-preset")
    @api(body='{"move": ..., "slide": ..., "climb": ..., "turn": ..., "tilt": ..., "bank": ...} as JSON: each a share '
              "of its full speed, 0.001 to 1.",
         responses={200: "The set kept.", 400: "A speed missing or out of range."})
    def set_fly_preset():
        """Keep a set of free-flight speeds of your own, the same on every device."""
        try:
            return jsonify(settings_store.set_fly_preset(request.get_json(silent=True)))
        except SettingRefused as e:
            return _error(400, str(e))

    @app.put("/api/settings/start/<world>")
    @api(body='{"lat": ..., "lon": ..., "zoom": ...} as JSON.',
         responses={200: "The start kept: {lat, lon, zoom}.", 400: "An unknown world, or a point off the map."})
    def set_start(world):
        """Where a world's map opens from now on, on every device."""
        data = request.get_json(silent=True) or {}
        try:
            return jsonify(settings_store.set_start(world, data.get("lat"), data.get("lon"), data.get("zoom")))
        except SettingRefused as e:
            return _error(400, str(e))

    @app.delete("/api/settings/start/<world>")
    @api(responses={204: "The world's map opens at the page's own start again.", 400: "An unknown world."})
    def clear_start(world):
        """Forget the start set for a world's map."""
        try:
            settings_store.clear_start(world)
        except SettingRefused as e:
            return _error(400, str(e))
        return Response(status=204)

    @app.put("/api/settings/opentopo-key")
    @api(body='{"key": "..."} as JSON.', responses={204: "Kept.", 400: "That is not a key."})
    def set_key():
        """Keep the OpenTopography key on the server, for every device."""
        data = request.get_json(silent=True) or {}
        try:
            keys.set(str(data.get("key", "")))
        except ValueError as e:
            return _error(400, str(e))
        log("opentopography key: set from the page")
        return Response(status=204)

    @app.delete("/api/settings/opentopo-key")
    @api(responses={204: "Removed (or there was none)."})
    def clear_key():
        """Remove the OpenTopography key the page gave."""
        keys.clear()
        log("opentopography key: removed from the page")
        return Response(status=204)

    # ---------- the library ----------

    def _upload():
        try:
            meta = json.loads(request.form.get("meta", ""))
        except ValueError:
            raise BadRequest("meta must be JSON") from None
        files = {name: storage.read() for name, storage in request.files.items()}
        return meta, files

    @app.get("/api/models")
    @api(responses={200: "[{id, name, created, updated, worlds, places: [{name, world}], files}], the last changed first."})
    def models():
        """The saved models."""
        return jsonify(library.list())

    @app.post("/api/models")
    @api(body="multipart/form-data: meta (JSON) and the model's files (heights .bin, pictures .jpg or .png).",
         responses={201: "The model's meta, with its id.", 400: "Something sent cannot be kept: the error says what."})
    def create_model():
        """Save a new model."""
        meta, files = _upload()
        try:
            saved = library.create(meta, files)
        except Refused as e:
            return _error(400, str(e))
        log(f"model {saved['id']} saved: {saved['name']!r}, {sum(saved['files'].values()) // 1024} KB")
        return jsonify(saved), 201

    @app.get("/api/models/<model_id>")
    @api(responses={200: "The model's meta.", 404: "No such model."})
    def get_model(model_id):
        """One saved model: its meta (name, places, settings, files)."""
        try:
            return jsonify(library.get(model_id))
        except NotFound:
            return _error(404, "no such model")

    @app.put("/api/models/<model_id>")
    @api(body="As for POST /api/models.", responses={200: "The model's meta.", 400: "Something sent cannot be kept.",
                                                    404: "No such model."})
    def replace_model(model_id):
        """Save a model again, all of it: meta and files."""
        meta, files = _upload()
        try:
            saved = library.replace(model_id, meta, files)
        except NotFound:
            return _error(404, "no such model")
        except Refused as e:
            return _error(400, str(e))
        log(f"model {model_id} saved again: {saved['name']!r}")
        return jsonify(saved)

    @app.post("/api/models/<model_id>/copy")
    @api(body='{"name": "..."} as JSON, or nothing: the copy keeps the name.',
         responses={201: "The copy's meta, with its own id.", 400: "An empty name.", 404: "No such model."})
    def copy_model(model_id):
        """Copy a saved model: all its files and settings, under a new id (to change one place of it and
        keep the model as it was)."""
        data = request.get_json(silent=True) or {}
        try:
            saved = library.copy(model_id, data.get("name"))
        except NotFound:
            return _error(404, "no such model")
        except Refused as e:
            return _error(400, str(e))
        log(f"model {model_id} copied to {saved['id']}: {saved['name']!r}")
        return jsonify(saved), 201

    @app.patch("/api/models/<model_id>")
    @api(body='{"name": "...", "places": ["...", ...]} as JSON; places, a name for each place, may be left out.',
         responses={200: "The model's meta.", 400: "No name, or not a name for each place.", 404: "No such model."})
    def rename_model(model_id):
        """Rename a saved model, and its places."""
        data = request.get_json(silent=True) or {}
        try:
            return jsonify(library.rename(model_id, data.get("name", ""), data.get("places")))
        except NotFound:
            return _error(404, "no such model")
        except Refused as e:
            return _error(400, str(e))

    @app.delete("/api/models/<model_id>")
    @api(responses={204: "Moved to the trash (emptied after 30 days).", 404: "No such model."})
    def remove_model(model_id):
        """Remove a saved model."""
        try:
            library.remove(model_id)
        except NotFound:
            return _error(404, "no such model")
        log(f"model {model_id} removed")
        return Response(status=204)

    @app.get("/api/models/<model_id>/files/<name>")
    @api(Param("most", "integer", "For a picture: at most this many points a side (64..16384); a bigger one comes as "
                                  "a smaller JPEG copy, made once and kept. A device whose browser holds no bigger canvas (an iPad) asks for 4096."),
         responses={200: "The file.", 400: "most is out of range.", 404: "No such model or file."})
    def model_file(model_id, name):
        """One file of a saved model."""
        try:
            path = library.file(model_id, name)
        except NotFound:
            return _error(404, "no such file")
        most = request.args.get("most")
        if most is not None and path.suffix in (".jpg", ".png"):
            try:
                found = pictures.at_most(path, int(most), f"{model_id}-{path.stem}")
            except ValueError as e:
                return _error(400, str(e))
            if isinstance(found, bytes):
                return Response(found, mimetype="image/jpeg", headers={"Cache-Control": "no-cache"})
            path = found
        response = send_from_directory(path.parent, path.name, max_age=0)
        response.headers["Cache-Control"] = "no-cache"
        return response

    # ---------- the page's own errors ----------

    @app.get("/api/client-errors")
    @api(Param("last", "integer", "How many, the newest last; 50 when left out, at most 300."),
         responses={200: "{errors: [{time, message, where, page, version, details, agent, stack}]}."})
    def client_errors_kept():
        """The errors the page reported lately, from any device."""
        try:
            last = max(1, min(ClientErrors.KEEP, int(request.args.get("last", 50))))
        except ValueError:
            return _error(400, "last must be a number")
        return jsonify({"errors": client_errors.recent(last)})

    @app.post("/api/client-error")
    @api(body="{message, where, stack, page, version, details, agent} as JSON.",
         responses={204: "Written to the log.", 429: "More than 30 a minute: not written."})
    def client_error():
        """An error that happened in the page, for the server's log."""
        if not client_errors.take(request.get_json(silent=True) or {}):
            return Response(status=429)
        return Response(status=204)

    # ---------- the cache of one device ----------

    @app.post("/api/clear-cache")
    @api(responses={204: 'Cleared: the answer says Clear-Site-Data: "cache" to the browser that asked.'})
    def clear_cache():
        """Clear this site's cache in the browser that asks, on that device only.

        The browser drops the map tiles, pictures and page files it keeps. The server's own cache, the
        models and the other devices stay as they are, and so do the choices the page keeps there."""
        return Response(status=204, headers={"Clear-Site-Data": '"cache"'})

    return app
