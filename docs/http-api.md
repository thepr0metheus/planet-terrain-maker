# Planet Terrain Maker: HTTP API

Made from `/openapi.json` by `python3 -m app.apispec`; do not edit by hand.

No sign-in: every route is open to whoever reaches the server, as the page itself is. Run it in a private network, or behind a proxy of your own that signs people in.

## GET `/`

The page of the app.

- 200: The page.

## GET `/{path}`

A file of the page: scripts, styles, pictures, the names of places on other worlds.

- `path` (path, string, required)
- 200: The file.
- 404: There is no such file.

## GET `/api/asteroids/damit/{model_id}`

A shape of the DAMIT catalogue, by its model's number in web/data/asteroids-damit.json, fetched once and kept on disk.

- `model_id` (path, integer, required)
- 200: The shape: vertices and facets as OBJ text, in no particular unit (the page sizes it).
- 404: No such model.
- 502: DAMIT did not give it, or gave something else.

## GET `/api/asteroids/top/{asteroid_id}`

One of the best known shapes of asteroids, by its id in web/data/asteroids-top.json, fetched once and kept on disk.

- `asteroid_id` (path, string, required)
- 200: The shape: a GLB model (NASA's) or vertices and facets as OBJ text (JAXA's, the radar models).
- 404: No such asteroid in the list.
- 502: Where the shape lives did not give it, or gave something else.

## GET `/api/buildings`

Buildings of a region on Earth from OpenStreetMap (Overpass API): outlines and heights.

- `south` (query, number, required): South edge of the region, degrees.
- `north` (query, number, required): North edge of the region, degrees.
- `west` (query, number, required): West edge of the region, degrees (-180..180).
- `east` (query, number, required): East edge of the region, degrees (-180..180).
- 200: {buildings: [{ring: [[lon, lat], ...], height: metres}], cut: whether there were more, credit}.
- 400: The region is wrong or bigger than about 10 km.
- 502: No Overpass server answered.

## POST `/api/clear-cache`

Clear this site's cache in the browser that asks, on that device only.

The browser drops the map tiles, pictures and page files it keeps. The server's own cache, the models and the other devices stay as they are, and so do the choices the page keeps there.

- 204: Cleared: the answer says Clear-Site-Data: "cache" to the browser that asked.

## POST `/api/client-error`

An error that happened in the page, for the server's log.

- body: {message, where, stack, page, version, details, agent} as JSON.
- 204: Written to the log.
- 429: More than 30 a minute: not written.

## GET `/api/client-errors`

The errors the page reported lately, from any device.

- `last` (query, integer, optional): How many, the newest last; 50 when left out, at most 300.
- 200: {errors: [{time, message, where, page, version, details, agent, stack}]}.

## GET `/api/earth/heights`

Heights of a region on Earth from Copernicus DEM: 30 m (90 m where 30 m is not released, or big regions).

source=aws reads the model's files on AWS Open Data, no key, and keeps what it read on disk. Without it, OpenTopography answers, with its key (PUT /api/settings/opentopo-key). AWS Terrain heights need no server: they are the earth-heights tiles.

- `south` (query, number, required): South edge of the region, degrees.
- `north` (query, number, required): North edge of the region, degrees.
- `west` (query, number, required): West edge of the region, degrees (-180..180).
- `east` (query, number, required): East edge of the region, degrees (-180..180).
- `cells` (query, integer, optional): Cells a side at most (default and limit 1024).
- `source` (query, string, optional): aws: Copernicus DEM read from AWS Open Data, no key; opentopography (the default): the same model through OpenTopography, with its key.
- 200: The heights as float32 numbers, little-endian, row by row from the north-west corner, NaN where there is no height. Headers: X-Grid-Cols, X-Grid-Rows, X-Grid-Box (south,north,west,east of the corner cells' centres), X-Grid-Source.
- 400: The region is missing or wrong.
- 403: There is no OpenTopography key, or OpenTopography refused it: {error, key_needed: true}.
- 502: AWS or OpenTopography failed or sent no heights.

## GET `/api/models`

The saved models.

- 200: [{id, name, created, updated, worlds, places: [{name, world}], files}], the last changed first.

## POST `/api/models`

Save a new model.

- body: multipart/form-data: meta (JSON) and the model's files (heights .bin, pictures .jpg or .png).
- 201: The model's meta, with its id.
- 400: Something sent cannot be kept: the error says what.

## GET `/api/models/{model_id}`

One saved model: its meta (name, places, settings, files).

- `model_id` (path, string, required)
- 200: The model's meta.
- 404: No such model.

## PUT `/api/models/{model_id}`

Save a model again, all of it: meta and files.

- `model_id` (path, string, required)
- body: As for POST /api/models.
- 200: The model's meta.
- 400: Something sent cannot be kept.
- 404: No such model.

## PATCH `/api/models/{model_id}`

Rename a saved model, and its places.

- `model_id` (path, string, required)
- body: {"name": "...", "places": ["...", ...]} as JSON; places, a name for each place, may be left out.
- 200: The model's meta.
- 400: No name, or not a name for each place.
- 404: No such model.

## DELETE `/api/models/{model_id}`

Remove a saved model.

- `model_id` (path, string, required)
- 204: Moved to the trash (emptied after 30 days).
- 404: No such model.

## POST `/api/models/{model_id}/copy`

Copy a saved model: all its files and settings, under a new id (to change one place of it and

keep the model as it was).

- `model_id` (path, string, required)
- body: {"name": "..."} as JSON, or nothing: the copy keeps the name.
- 201: The copy's meta, with its own id.
- 400: An empty name.
- 404: No such model.

## GET `/api/models/{model_id}/files/{name}`

One file of a saved model.

- `model_id` (path, string, required)
- `name` (path, string, required)
- `most` (query, integer, optional): For a picture: at most this many points a side (64..16384); a bigger one comes as a smaller JPEG copy, made once and kept. A device whose browser holds no bigger canvas (an iPad) asks for 4096.
- 200: The file.
- 400: most is out of range.
- 404: No such model or file.

## GET `/api/packages`

What this copy runs on: its libraries, the page's, and the system's, to check for known vulnerabilities.

- 200: {version: the commit, runtime: {name, version}, os: {name, version, listed} or null, packages: [{ecosystem, name, version}]}. Each package is named as osv.dev names it; os.listed false: the system's packages are not in the list.

## GET `/api/picture-sources`

List user-entered sources shared by devices, from the mounted data directory.

- 200: Saved user-entered sources, newest first: [{key, url, name, credit, maxZoom}].
- 503: The data file could not be read.

## POST `/api/picture-sources`

Remember a source as runtime data only; no upstream request is made.

- body: {url, name, credit, maxZoom} as JSON. maxZoom is null for automatic detail.
- 200: The updated source list, newest first; the same URL is stored once.
- 400: Invalid source.
- 503: The data file could not be read or written.

## DELETE `/api/picture-sources`

Forget a saved URL without changing any model's captured picture.

- body: {url} as JSON. Only this saved source is forgotten.
- 200: The remaining source list.
- 400: Invalid URL.
- 503: The data file could not be read or written.

## GET `/api/picture-sources/{key}/tiles/{z}/{x}/{y}`

A detailed tile that a browser has already downloaded and saved.

- `key` (path, string, required)
- `z` (path, integer, required)
- `x` (path, integer, required)
- `y` (path, integer, required)
- 200: A persisted detailed PNG/JPEG tile.
- 400: Invalid tile address.
- 404: Not downloaded yet.
- 503: Data could not be read.

## PUT `/api/picture-sources/{key}/tiles/{z}/{x}/{y}`

Persist a browser-fetched tile without making an upstream request.

- `key` (path, string, required)
- `z` (path, integer, required)
- `x` (path, integer, required)
- `y` (path, integer, required)
- body: A 256 by 256 PNG/JPEG tile, at most 1 MiB, as raw bytes.
- 204: Saved in mounted data.
- 400: Invalid tile address or image.
- 404: Unknown source key.
- 503: Data could not be written.

## GET `/api/place`

The name of the place on Earth at a point, at about the size of a town (Nominatim).

- `lat` (query, number, required): Latitude.
- `lon` (query, number, required): Longitude.
- `lang` (query, string, optional): Language of the names: ru or en (default en).
- 200: {name, detail}, or null at sea.
- 400: lat or lon is wrong.
- 502: Nominatim failed.

## GET `/api/planet/heights`

Heights of a region on the Moon, Mars or Venus, from NASA Trek (and SLDEM2015 for small Moon regions).

Metres from each body's reference sphere: the Moon 1737.4 km, Mars 3396.19 km, Venus 6051.8 km.

- `world` (query, string, required): moon, mars or venus.
- `south` (query, number, required): South edge of the region, degrees.
- `north` (query, number, required): North edge of the region, degrees.
- `west` (query, number, required): West edge of the region, degrees (-180..180).
- `east` (query, number, required): East edge of the region, degrees (-180..180).
- `cells` (query, integer, optional): Cells a side at most (default and limit 1024).
- `source` (query, string, optional): trek: Trek's own heights only (on the Moon LRO LOLA 118 m, never SLDEM2015); the finest there is when left out.
- 200: The heights as float32 numbers, little-endian, row by row from the north-west corner, NaN where there is no height. Headers: X-Grid-Cols, X-Grid-Rows, X-Grid-Box (south,north,west,east of the corner cells' centres), X-Grid-Source.
- 400: The world, the region or the source is wrong.
- 502: Trek failed, or has no heights there.

## GET `/api/planet/image`

The imagery of a region on the Moon or Mars as one picture, from NASA Trek.

- `world` (query, string, required): moon, mars or venus.
- `south` (query, number, required): South edge of the region, degrees.
- `north` (query, number, required): North edge of the region, degrees.
- `west` (query, number, required): West edge of the region, degrees (-180..180).
- `east` (query, number, required): East edge of the region, degrees (-180..180).
- `width` (query, integer, required): Pixels across, at most 4096.
- `height` (query, integer, required): Pixels down, at most 4096.
- 200: A JPEG of exactly the region, north up.
- 400: The world has no one-picture imagery (Venus: its tiles are stitched), or the region or size is wrong.
- 502: Trek failed.

## GET `/api/search`

Places on Earth whose names match (Nominatim, OpenStreetMap).

- `q` (query, string, required): What to look for: a name.
- `lang` (query, string, optional): Language of the names: ru or en (default en).
- 200: [{name, detail, lat, lon, kind, box: [south, north, west, east]}], at most 8.
- 502: Nominatim failed.

## GET `/api/settings`

What the server knows that the page may ask about.

- 200: {opentopo_key: "page" | "environment" | null, starts: {world: {lat, lon, zoom}}, fly_preset: {move, slide, climb, turn, tilt, bank} | null}: where the key in use comes from (the key itself is never sent), where each world's map opens, your own set of flight speeds.

## PUT `/api/settings/fly-preset`

Keep a set of free-flight speeds of your own, the same on every device.

- body: {"move": ..., "slide": ..., "climb": ..., "turn": ..., "tilt": ..., "bank": ...} as JSON: each a share of its full speed, 0.001 to 1.
- 200: The set kept.
- 400: A speed missing or out of range.

## PUT `/api/settings/opentopo-key`

Keep the OpenTopography key on the server, for every device.

- body: {"key": "..."} as JSON.
- 204: Kept.
- 400: That is not a key.

## DELETE `/api/settings/opentopo-key`

Remove the OpenTopography key the page gave.

- 204: Removed (or there was none).

## PUT `/api/settings/start/{world}`

Where a world's map opens from now on, on every device.

- `world` (path, string, required)
- body: {"lat": ..., "lon": ..., "zoom": ...} as JSON.
- 200: The start kept: {lat, lon, zoom}.
- 400: An unknown world, or a point off the map.

## DELETE `/api/settings/start/{world}`

Forget the start set for a world's map.

- `world` (path, string, required)
- 204: The world's map opens at the page's own start again.
- 400: An unknown world.

## GET `/api/tile/{source}/{z}/{x}/{y}`

A map tile of one of the layers the page shows or captures, fetched once and kept on disk.

Layers: earth-photo (Esri World Imagery), earth-s2-2025 (Sentinel-2 cloudless 2025 by EOX), earth-usgs (USGS orthoimagery, the USA only), earth-labels (Esri reference layer), earth-heights (AWS Terrain Tiles, terrarium coding), moon-wac, moon-kaguya, mars-mdim, mars-themis, venus-c3, venus-sar (NASA Trek), mars-ctx (the CTX mosaic of Mars by Esri: tiles of 512 points).

- `source` (path, string, required)
- `z` (path, integer, required)
- `x` (path, integer, required)
- `y` (path, integer, required)
- 200: The tile (JPEG or PNG).
- 404: No such layer, or the layer has no such tile.
- 502: The layer's service failed, also when asked again twice.

## GET `/healthz`

Whether the app is up, and which commit it runs.

- 200: {status: ok, version: the commit, or null for a working copy}

## GET `/openapi.json`

The description of this API, made from its routes.

- 200: This description, OpenAPI 3.1.
