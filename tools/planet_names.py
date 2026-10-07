"""Build the place-name lists the map searches on the Moon, Mars and Venus.

Nominatim knows only Earth. For the Moon, Mars and Venus the page searches these
lists instead: every name the IAU has adopted (craters, mountains, maria,
valleys...), from the USGS Gazetteer of Planetary Nomenclature
(https://planetarynames.wr.usgs.gov/GIS_Downloads, public domain).

    python3 tools/planet_names.py [--from-dir DIR]

writes web/data/moon-names.json, mars-names.json and venus-names.json, each
a list of [name, lat, lon, diameter_km, code] with lon in -180..180 (east
positive), the order the map uses. Without --from-dir it downloads the three
shapefile archives (about 24 MB, 6 MB and 5 MB); with it, it reads
<BODY>_nomenclature_center_pts.zip from DIR. Standard library only.
"""

import argparse
import io
import json
import os
import struct
import sys
import urllib.request
import zipfile

SOURCE = "https://asc-planetarynames-data.s3.us-west-2.amazonaws.com/{body}_nomenclature_center_pts.zip"
BODIES = {"moon": "MOON", "mars": "MARS", "venus": "VENUS"}
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "web", "data")


def read_dbf(data):
    """The records of a dBase III table, as dicts of stripped strings."""
    count, header_len, record_len = struct.unpack("<IHH", data[4:12])
    fields, pos = [], 32
    while data[pos] != 0x0D:
        name = data[pos:pos + 11].split(b"\0")[0].decode("ascii")
        fields.append((name, data[pos + 16]))
        pos += 32
    records = []
    for i in range(count):
        rec = data[header_len + i * record_len: header_len + (i + 1) * record_len]
        if rec[:1] == b"*":       # deleted
            continue
        values, at = {}, 1
        for name, length in fields:
            values[name] = rec[at:at + length].decode("utf-8", "replace").strip()
            at += length
        records.append(values)
    return records


def names_of(records):
    """[name, lat, lon, diameter_km, code] for every adopted name, biggest first."""
    out = []
    for r in records:
        if r.get("approval") != "Adopted by IAU":
            continue
        try:
            lat = float(r["center_lat"])
            lon = float(r["center_lon"])
            diameter = float(r["diameter"] or 0)
        except (KeyError, ValueError):
            continue
        if lon > 180:
            lon -= 360
        out.append([r["clean_name"] or r["name"], round(lat, 4), round(lon, 4), round(diameter, 2), r.get("code", "")])
    out.sort(key=lambda n: (-n[3], n[0]))
    return out


def archive(body, from_dir):
    file_name = f"{BODIES[body]}_nomenclature_center_pts.zip"
    if from_dir:
        with open(os.path.join(from_dir, file_name), "rb") as f:
            return f.read()
    with urllib.request.urlopen(SOURCE.format(body=BODIES[body]), timeout=120) as resp:
        return resp.read()


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--from-dir", help="read the archives from this folder instead of downloading them")
    args = parser.parse_args()
    os.makedirs(OUT_DIR, exist_ok=True)
    for body in BODIES:
        with zipfile.ZipFile(io.BytesIO(archive(body, args.from_dir))) as z:
            dbf = next(n for n in z.namelist() if n.lower().endswith(".dbf"))
            names = names_of(read_dbf(z.read(dbf)))
        path = os.path.join(OUT_DIR, f"{body}-names.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(names, f, ensure_ascii=False, separators=(",", ":"))
        print(f"{body}: {len(names)} names -> {os.path.relpath(path)}", file=sys.stderr)


if __name__ == "__main__":
    main()
