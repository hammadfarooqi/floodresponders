"""Step 2c: join LA County Assessor parcels to every Vexcel building in an area.

Fetches assessor parcels (public layer) on the same tile grid as area_fetch.py, caches them per tile in
data/cache/assessor/, then gives each Vexcel structure the fields of the parcel that contains its center.

Run:  python3 data/pipeline/assessor_join.py hollywood
Writes data/processed/area_hollywood_assessor.json  ({structure_id: {assessor fields}})
"""
from __future__ import annotations

import json
import sys
import threading
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from area_fetch import TILE, area_polys, tiles  # noqa: E402
from build_map import _in_ring  # noqa: E402

DATA = Path(__file__).resolve().parents[1]
CACHE = DATA / "cache" / "assessor"
URL = "https://public.gis.lacounty.gov/public/rest/services/LACounty_Cache/LACounty_Parcel/MapServer/0/query"
FIELDS = ["AIN", "SitusFullAddress", "UseType", "UseDescription", "UseCode"] + [
    f"{k}{i}" for i in range(1, 6) for k in ("Units", "YearBuilt", "Bedrooms", "SQFTmain")]
lock, done = threading.Lock(), [0]


def fetch_tile(t, total):
    path = CACHE / f"{t[0]}_{t[1]}.json"
    if path.exists():
        return
    x, y = t
    out, offset = [], 0
    while True:
        q = urllib.parse.urlencode({
            "geometry": f"{x},{y},{x + TILE},{y + TILE}", "geometryType": "esriGeometryEnvelope", "inSR": 4326,
            "spatialRel": "esriSpatialRelIntersects", "outFields": ",".join(FIELDS), "outSR": 4326,
            "returnGeometry": "true", "geometryPrecision": 6, "f": "json",
            "resultOffset": offset, "resultRecordCount": 1000})
        try:
            with urllib.request.urlopen(URL + "?" + q, timeout=120) as r:
                d = json.load(r)
        except Exception as e:  # not cached; retried next run
            print(f"  tile {t}: {e}", flush=True)
            return
        fs = d.get("features") or []
        for f in fs:
            rings = (f.get("geometry") or {}).get("rings")
            if rings:
                out.append({"a": f["attributes"], "rings": rings})
        if not d.get("exceededTransferLimit") and len(fs) < 1000:
            break
        offset += len(fs)
    path.write_text(json.dumps(out))
    with lock:
        done[0] += 1
        if done[0] % 50 == 0 or done[0] == total:
            print(f"  tiles: {done[0]}/{total}", flush=True)


def summarize(a: dict) -> dict:
    units = sum(a.get(f"Units{i}") or 0 for i in range(1, 6))
    beds = sum(a.get(f"Bedrooms{i}") or 0 for i in range(1, 6))
    sqft = sum(a.get(f"SQFTmain{i}") or 0 for i in range(1, 6))
    years = [int(a[f"YearBuilt{i}"]) for i in range(1, 6) if str(a.get(f"YearBuilt{i}") or "").strip().isdigit()
             and int(a[f"YearBuilt{i}"]) > 1800]
    return {"ain": a.get("AIN"), "address": (a.get("SitusFullAddress") or "").strip() or None,
            "use_type": a.get("UseType"), "use_description": a.get("UseDescription"),
            "units": units or None, "bedrooms": beds or None, "floor_area_sqft": sqft or None,
            "year_built": min(years) if years else None}


def main():
    name = (sys.argv[1:] or ["hollywood"])[0]
    CACHE.mkdir(parents=True, exist_ok=True)
    ts = tiles(area_polys(name))
    todo = [t for t in ts if not (CACHE / f"{t[0]}_{t[1]}.json").exists()]
    print(f"assessor {name}: {len(ts)} tiles, {len(todo)} to fetch")
    with ThreadPoolExecutor(4) as ex:
        list(ex.map(lambda t: fetch_tile(t, len(todo)), todo))

    # index parcels by tile
    parcels = {}
    for t in ts:
        p = CACHE / f"{t[0]}_{t[1]}.json"
        if p.exists():
            parcels[t] = json.loads(p.read_text())
    structs = json.loads((DATA / "processed" / f"area_{name}_structures.json").read_text())
    joined = {}
    for s in structs:
        tx = round(s["lng"] - ((s["lng"] - ts[0][0]) % TILE), 5)
        ty = round(s["lat"] - ((s["lat"] - ts[0][1]) % TILE), 5)
        for pc in parcels.get((tx, ty), []):
            if _in_ring(s["lng"], s["lat"], pc["rings"][0]):
                joined[s["id"]] = summarize(pc["a"])
                break
    out = DATA / "processed" / f"area_{name}_assessor.json"
    out.write_text(json.dumps(joined))
    print(f"{len(joined)}/{len(structs)} buildings matched to an assessor parcel -> {out}")


if __name__ == "__main__":
    main()
