"""Build the lists of asteroid and comet shapes the model screen offers (asteroid-search.js).

    python3 tools/asteroids.py [--from-dir DIR] [--lists top,damit,comets]

writes three files into web/data:

- asteroids-top.json: the best known shapes, from spacecraft and radar, each
  {id, name, number, kind, url, metresPerUnit, lengthM, credit}. kind is "glb" (a model of NASA's
  3D resources, its units metres divided by the scale in its name) or "obj" (vertices and facets,
  in km). lengthM is measured from the file itself: its longest extent, in metres.
- asteroids-damit.json: the DAMIT catalogue (Durech et al., https://damit.cuni.cz, CC BY 4.0):
  shapes found from light curves, convex mostly, [number, name, diameterKm, modelId] for each
  asteroid whose size is known: DAMIT's own calibrated size, else the diameter in JPL's Small-Body
  Database (public domain). An asteroid of the top list is left out: its own shape is better.
- comets.json: the comets seen up close, from the PDS Small Bodies Node, {id, name, kind, url,
  metresPerUnit, lengthM, credit}: kind "obj", "wrl" (VRML, as Rosetta's 67P comes) or "grid"
  (Halley: radii by longitude and latitude).

The models themselves are not kept here: the server fetches one when it is asked for, and keeps it
(app/asteroids.py). Without --from-dir everything is downloaded (about 25 MB); with it, a file whose
name is the last part of its address is read from DIR instead. Standard library only.
"""

import argparse
import csv
import io
import json
import math
import os
import re
import struct
import urllib.request

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "web", "data")
NASA = "https://assets.science.nasa.gov/content/dam/science/psd/solar/2023/09/"
RADAR = "https://sbnarchive.psi.edu/pds4/non_mission/compil.ast.radar.shape-models/data/"
SBN_SHAPES = "https://sbn.psi.edu/pds/shape-models/files/"
ROSETTA = "https://pdssbn.astro.umd.edu/holdings/ro-c-multi-5-67p-shape-v2.0/data/triplate/mspcd_lam/shap2/"
STOOKE = "https://sbnarchive.psi.edu/pds3/non_mission/EAR_A_5_DDR_STOOKE_SHAPE_MODELS_V2_0/data/"
DAMIT_TABLES = "https://damit.cuni.cz/projects/damit/exports/table/"
SBDB = ("https://ssd-api.jpl.nasa.gov/sbdb_query.api?fields=pdes,name,diameter&sb-kind=a&sb-ns=n"
        "&sb-cdata=%7B%22AND%22%3A%5B%22diameter%7CDF%22%5D%7D")
USER_AGENT = "planet-terrain-maker/1.0 (tools/asteroids.py)"

# The best known shapes, smallest first: (id, name, IAU number, kind, address, metres a unit, credit).
TOP = [
    ("itokawa", "Itokawa", 25143, "glb", NASA + "i/Itokawa_1_1.glb", 1, "NASA 3D Resources (Hayabusa, JAXA)"),
    ("bennu", "Bennu", 101955, "glb", NASA + "b/Bennu_1_1.glb", 1, "NASA 3D Resources (OSIRIS-REx)"),
    ("ryugu", "Ryugu", 162173, "obj",
     "https://data.darts.isas.jaxa.jp/pub/hayabusa2/paper/Watanabe_2019/SHAPE_SFM_49k_v20180804.obj", 1000,
     "JAXA, Hayabusa2 (Watanabe et al. 2019)"),
    ("castalia", "Castalia", 4769, "obj", RADAR + "4769castalia.tab", 1000, "PDS radar shape models (Hudson, Ostro)"),
    ("toutatis", "Toutatis", 4179, "obj", RADAR + "4179toutatis.tab", 1000, "PDS radar shape models (Hudson, Ostro)"),
    ("geographos", "Geographos", 1620, "obj", RADAR + "1620geographos.tab", 1000, "PDS radar shape models (Hudson, Ostro)"),
    ("eros", "Eros", 433, "glb", NASA + "e/Eros_1_10.glb", 10, "NASA 3D Resources (NEAR Shoemaker)"),
    ("kleopatra", "Kleopatra", 216, "obj", RADAR + "216kleopatra.tab", 1000, "PDS radar shape models (Ostro et al.)"),
    ("vesta", "Vesta", 4, "glb", NASA + "v/Vesta_1_100.glb", 100, "NASA 3D Resources (Dawn)"),
    ("ceres", "Ceres", 1, "glb", NASA + "c/Ceres_1_1000.glb", 1000, "NASA 3D Resources (Dawn)"),
]

# Comets seen up close: (id, name, kind, address, metres a unit, credit). Wild 2's file is in metres,
# the others in km; 67P is the decimated model of 24,000 facets (the full one is 49 MB).
COMETS = [
    ("hartley-2", "103P/Hartley 2", "obj", SBN_SHAPES + "hartley2/hartley2_2012_cart.obj", 1000,
     "PDS SBN: Deep Impact/EPOXI (Thomas et al. 2013)"),
    ("67p", "67P/Churyumov–Gerasimenko", "wrl", ROSETTA + "cg_mspcd_shap2_024k_cart.wrl", 1000,
     "PDS SBN: ESA Rosetta (Jorda et al. 2016)"),
    ("wild-2", "81P/Wild 2", "obj", SBN_SHAPES + "wild2/wild2_cart_full.tab.obj", 1, "PDS SBN: Stardust"),
    ("tempel-1", "9P/Tempel 1", "obj", SBN_SHAPES + "tempel1/tempel1_2012_cart.obj", 1000,
     "PDS SBN: Deep Impact (Thomas et al. 2013)"),
    ("halley", "1P/Halley", "grid", STOOKE + "1682q1halley.tab", 1000, "PDS SBN: Giotto and Vega (Stooke)"),
]


def fetch(url, from_dir):
    if from_dir:
        with open(os.path.join(from_dir, url.rsplit("/", 1)[-1].split("?")[0]), "rb") as f:
            return f.read()
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=300) as resp:
        return resp.read()


# ---------- the extent of a shape ----------

def obj_vertices(data):
    """The vertices of an OBJ (or of the radar models' "v x y z" lines)."""
    out = []
    for line in data.decode("ascii", errors="replace").splitlines():
        if line.startswith("v "):
            x, y, z = (float(n) for n in line.split()[1:4])
            out.append((x, y, z))
    return out


def wrl_vertices(data):
    """The vertices of a VRML IndexedFaceSet: the numbers of its "point [ ... ]", three by three."""
    text = re.sub(r"#[^\n]*", " ", data.decode("ascii", errors="replace"))
    start = text.index("[", text.index("point"))
    numbers = [float(n) for n in re.split(r"[\s,]+", text[start + 1:text.index("]", start)]) if n]
    return list(zip(numbers[0::3], numbers[1::3], numbers[2::3]))


def grid_vertices(data):
    """The points of a table of "longitude latitude radius" lines (degrees, longitude positive west)."""
    out = []
    for line in data.decode("ascii", errors="replace").splitlines():
        parts = line.split()
        if len(parts) == 3:
            lon, lat, r = (math.radians(float(parts[0])), math.radians(float(parts[1])), float(parts[2]))
            out.append((r * math.cos(lat) * math.cos(-lon), r * math.cos(lat) * math.sin(-lon), r * math.sin(lat)))
    return out


def node_matrix(node):
    """A glTF node's transform, as a 4x4 list of rows."""
    if "matrix" in node:
        m = node["matrix"]
        return [[m[c * 4 + r] for c in range(4)] for r in range(4)]
    x, y, z, w = node.get("rotation", [0, 0, 0, 1])
    sx, sy, sz = node.get("scale", [1, 1, 1])
    tx, ty, tz = node.get("translation", [0, 0, 0])
    rot = [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
           [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
           [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]]
    scale, move = (sx, sy, sz), (tx, ty, tz)
    return [[rot[r][0] * scale[0], rot[r][1] * scale[1], rot[r][2] * scale[2], move[r]] for r in range(3)] + [[0, 0, 0, 1]]


def multiply(a, b):
    return [[sum(a[r][k] * b[k][c] for k in range(4)) for c in range(4)] for r in range(4)]


def glb_vertices(data):
    """The vertices of every mesh of a GLB, moved by its nodes' transforms."""
    if data[:4] != b"glTF":
        raise ValueError("not a GLB")
    pos, doc, blob = 12, None, b""
    while pos < len(data):
        length, kind = struct.unpack_from("<I4s", data, pos)
        chunk = data[pos + 8:pos + 8 + length]
        if kind == b"JSON":
            doc = json.loads(chunk)
        elif kind == b"BIN\x00":
            blob = chunk
        pos += 8 + length
    out = []

    def positions(index):
        accessor = doc["accessors"][index]
        view = doc["bufferViews"][accessor["bufferView"]]
        start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
        stride = view.get("byteStride", 12)
        return [struct.unpack_from("<3f", blob, start + k * stride) for k in range(accessor["count"])]

    def walk(index, parent):
        node = doc["nodes"][index]
        matrix = multiply(parent, node_matrix(node))
        for primitive in doc["meshes"][node["mesh"]]["primitives"] if "mesh" in node else []:
            for x, y, z in positions(primitive["attributes"]["POSITION"]):
                out.append(tuple(matrix[r][0] * x + matrix[r][1] * y + matrix[r][2] * z + matrix[r][3] for r in range(3)))
        for child in node.get("children", []):
            walk(child, matrix)

    identity = [[float(r == c) for c in range(4)] for r in range(4)]
    for index in doc["scenes"][doc.get("scene", 0)]["nodes"]:
        walk(index, identity)
    return out


def longest_extent(vertices):
    return max(max(v[k] for v in vertices) - min(v[k] for v in vertices) for k in range(3))


def top_list(from_dir):
    out = []
    for asteroid_id, name, number, kind, url, metres, credit in TOP:
        data = fetch(url, from_dir)
        vertices = glb_vertices(data) if kind == "glb" else obj_vertices(data)
        length = longest_extent(vertices) * metres
        print(f"{name}: {len(vertices)} vertices, {length:.0f} m long, {len(data) / 1e6:.1f} MB")
        out.append({"id": asteroid_id, "name": name, "number": number, "kind": kind, "url": url,
                    "metresPerUnit": metres, "lengthM": round(length), "credit": credit})
    return out


VERTICES = {"glb": glb_vertices, "obj": obj_vertices, "wrl": wrl_vertices, "grid": grid_vertices}


def comet_list(from_dir):
    out = []
    for comet_id, name, kind, url, metres, credit in COMETS:
        data = fetch(url, from_dir)
        vertices = VERTICES[kind](data)
        length = longest_extent(vertices) * metres
        print(f"{name}: {len(vertices)} vertices, {length:.0f} m long, {len(data) / 1e6:.1f} MB")
        out.append({"id": comet_id, "name": name, "kind": kind, "url": url, "metresPerUnit": metres,
                    "lengthM": round(length), "credit": credit})
    return sorted(out, key=lambda c: c["lengthM"])


# ---------- the DAMIT catalogue ----------

def table(name, from_dir):
    return list(csv.DictReader(io.StringIO(fetch(DAMIT_TABLES + name, from_dir).decode("utf-8-sig"))))


def damit_list(from_dir, top_numbers):
    asteroids = table("asteroids", from_dir)
    models = table("asteroid_models", from_dir)
    sbdb = json.loads(fetch(SBDB, from_dir))
    diameters = {int(row[0]): float(row[2]) for row in sbdb["data"] if row[0].isdigit() and row[2]}
    # each asteroid's model: one with a calibrated size first, else the first one made
    chosen = {}
    for model in sorted(models, key=lambda m: (m["calibrated_size"] != "1" or not m["equiv_diameter"], int(m["id"]))):
        chosen.setdefault(model["asteroid_id"], model)
    out = []
    for asteroid in asteroids:
        model = chosen.get(asteroid["id"])
        if not model or not asteroid["number"] or int(asteroid["number"]) in top_numbers:
            continue
        number = int(asteroid["number"])
        own = float(model["equiv_diameter"]) if model["calibrated_size"] == "1" and model["equiv_diameter"] else None
        diameter = own or diameters.get(number)
        if not diameter:
            continue
        out.append([number, asteroid["name"] or asteroid["designation"] or "", round(diameter, 3), int(model["id"])])
    out.sort()
    print(f"DAMIT: {len(asteroids)} asteroids, {len(out)} with a known size")
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--from-dir", help="read the files from here instead of downloading them")
    parser.add_argument("--lists", default="top,damit,comets", help="which lists to make, by comma")
    args = parser.parse_args()
    wanted = set(args.lists.split(","))
    lists = []
    if wanted & {"top", "damit"}:
        top = top_list(args.from_dir)
        lists.append(("asteroids-top.json", top))
        if "damit" in wanted:
            lists.append(("asteroids-damit.json", damit_list(args.from_dir, {a["number"] for a in top})))
    if "comets" in wanted:
        lists.append(("comets.json", comet_list(args.from_dir)))
    for name, value in lists:
        with open(os.path.join(OUT_DIR, name), "w", encoding="utf-8") as f:
            json.dump(value, f, ensure_ascii=False, separators=(",", ":"))
            f.write("\n")


if __name__ == "__main__":
    main()
