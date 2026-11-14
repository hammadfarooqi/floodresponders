"""Step 2b: every Vexcel parcel and structure in an area (not only CoStar buildings).

Area "hollywood" = the Hollywood Community Plan Area plus the Sunset Fire evacuation areas.
The area is cut into small tiles; each tile is paged (500 parcels per page) and cached in data/cache/vexcel_area/.
Structures are de-duplicated across tiles by their footprint.

Run:  python3 data/pipeline/area_fetch.py hollywood
      python3 data/pipeline/area_fetch.py hollywood --merge-only   # combine cached tiles, no API calls
Writes data/processed/area_hollywood_structures.json
"""
from __future__ import annotations

import collections
import hashlib
import json
import re
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "probe"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from vexcel import LAYERS, send  # noqa: E402
from build_map import _in_ring, _rings, wkt_rings  # noqa: E402

DATA = Path(__file__).resolve().parents[1]
BOUNDS = DATA / "boundaries"
CACHE = DATA / "cache" / "vexcel_area"
TILE = 0.004  # degrees, about 400 m
KEEP = ["footprint.area", "ground-elevation.value", "building-type.class", "primary-structure",
        "roof-characteristics.material.class", "roof-characteristics.shape.value",
        "roof-characteristics.condition", "roof-defects.structural-damage.detected",
        "roof-characteristics.tree-cover.percent", "defensible-space.zone1-tree", "defensible-space.zone2-tree"]


def area_polys(name):
    if name != "hollywood":
        raise SystemExit("only 'hollywood' is defined")
    polys = []
    for f in json.loads((BOUNDS / "la_community_plan_areas.geojson").read_text())["features"]:
        if f["properties"].get("NAME_ALF") == "Hollywood":
            polys += _rings(f["geometry"])
    for f in json.loads((BOUNDS / "sunset_fire_2025_evacuation.geojson").read_text())["features"]:
        polys += _rings(f["geometry"])
    return polys


def inside(lng, lat, polys):
    return any(_in_ring(lng, lat, p[0]) for p in polys)


def tiles(polys):
    xs = [pt[0] for p in polys for pt in p[0]]
    ys = [pt[1] for p in polys for pt in p[0]]
    out = []
    x = min(xs)
    while x < max(xs):
        y = min(ys)
        while y < max(ys):
            samples = [(x + dx * TILE, y + dy * TILE) for dx in (0, .5, 1) for dy in (0, .5, 1)]
            if any(inside(sx, sy, polys) for sx, sy in samples):
                out.append((round(x, 5), round(y, 5)))
            y += TILE
        x += TILE
    return out


lock = threading.Lock()
done = [0]


def fetch_tile(t, total):
    path = CACHE / f"{t[0]}_{t[1]}.json"
    if path.exists():
        return
    x, y = t
    wkt = f"POLYGON(({x} {y},{x + TILE} {y},{x + TILE} {y + TILE},{x} {y + TILE},{x} {y}))"
    parcels, page = [], 1
    while True:
        st, d = send("GET", "property/extract", params={
            "wkt": wkt, "srid": 4326, "layer": LAYERS, "latest": "true", "include": "precomputed,footprint-wkt",
            "page-size": 500, "page": page, "unit-system": "metric"})
        if st == 404:
            break
        if st != 200 or not isinstance(d, dict):
            print(f"  tile {t} page {page}: HTTP {st} {str(d)[:120]}", flush=True)
            return  # not cached; retried next run
        fs = d.get("features") or []
        for f in fs:
            a = f["properties"]
            parcels.append({
                "collection": a.get("metadata.collection"),
                "structures": [{k: s.get(k) for k in KEEP} | {"wkt": s.get("footprint.wkt")}
                               for s in a.get("structures") or [] if s.get("footprint.wkt")]})
        if len(fs) < 500:
            break
        page += 1
    path.write_text(json.dumps(parcels))
    with lock:
        done[0] += 1
        if done[0] % 25 == 0 or done[0] == total:
            print(f"  tiles: {done[0]}/{total}", flush=True)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    name = args[0] if args else "hollywood"
    CACHE.mkdir(parents=True, exist_ok=True)
    polys = area_polys(name)
    ts = tiles(polys)
    todo = [t for t in ts if not (CACHE / f"{t[0]}_{t[1]}.json").exists()]
    print(f"{name}: {len(ts)} tiles, {len(todo)} to fetch")
    if "--merge-only" not in sys.argv:
        with ThreadPoolExecutor(3) as ex:
            list(ex.map(lambda t: fetch_tile(t, len(todo)), todo))

    # An area query returns every parcel once per image collection (one per year flown, plus reprocessed sets),
    # so each building comes back several times with slightly different outlines. Per tile, keep only the newest
    # collection, and keep a structure only in the tile that holds its center (no duplicates at tile edges).
    def year(c):
        m = re.search(r"(\d{4})$", c or "")
        return int(m.group(1)) if m else 0

    out, picked = [], collections.Counter()
    for t in ts:
        p = CACHE / f"{t[0]}_{t[1]}.json"
        if not p.exists():
            continue
        parcels = json.loads(p.read_text())
        counts = collections.Counter(pc["collection"] for pc in parcels)
        if not counts:
            continue
        best = max(counts, key=lambda c: (year(c), counts[c]))
        picked[best] += 1
        for parcel in parcels:
            if parcel["collection"] != best:
                continue
            for s in parcel["structures"]:
                rings = wkt_rings(s["wkt"])
                if not rings:
                    continue
                lat = sum(pt[0] for pt in rings[0]) / len(rings[0])
                lng = sum(pt[1] for pt in rings[0]) / len(rings[0])
                if not (t[0] <= lng < t[0] + TILE and t[1] <= lat < t[1] + TILE) or not inside(lng, lat, polys):
                    continue
                h = hashlib.md5(s["wkt"].encode()).hexdigest()
                out.append({k: x for k, x in s.items() if k != "wkt"} | {
                    "id": h[:12], "collection": best, "lat": round(lat, 6), "lng": round(lng, 6), "rings": rings})
    print("collections used (tiles):", dict(picked.most_common()))
    dest = DATA / "processed" / f"area_{name}_structures.json"
    dest.write_text(json.dumps(out))
    print(f"{len(out)} structures inside the area -> {dest}")


if __name__ == "__main__":
    main()
