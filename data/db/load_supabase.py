"""Load the Hollywood buildings into Supabase.

    python3 data/db/load_supabase.py --apply-schema     # create the tables (safe to repeat), then load
    python3 data/db/load_supabase.py                    # load only
    python3 data/db/load_supabase.py --dry-run          # build the rows and print counts, send nothing

Needs the root .env (see .env.example) and the CoStar kit at data/costar-kit/. Standard library only.
Vexcel answers are cached in data/cache/vexcel_hollywood/, so only the first run calls Vexcel (about 4 minutes).
County Assessor lots are public and need no key. They are cached in data/cache/assessor_hollywood/ (about 1 minute).
The load is an upsert on the row id: running it again updates rows and never makes duplicates.
Read DATABASE.md before you change anything here.
"""
import argparse
import gzip
import hashlib
import json
import os
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_rows as br
import risk_score as rs

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
VEXCEL_URL = "https://api.vexcelgroup.com/v2/property/extract"
ASSESSOR_URL = "https://public.gis.lacounty.gov/public/rest/services/LACounty_Cache/LACounty_Parcel/MapServer/0/query"
ASSESSOR_FIELDS = ["AIN", "UseType", "UseDescription"] + [f"{name}{n}" for n in range(1, 6)
                                                         for name in ("Units", "YearBuilt", "Bedrooms")]
ASSESSOR_TILES_PER_SIDE = 6
ASSESSOR_PAGE_SIZE = 1000               # the most the service returns in one answer
USER_AGENT = "rollcall-loader"
TILES_PER_SIDE = 4
PAGE_SIZE = 500
BATCH_ROWS = 500


def load_env():
    env = dict(os.environ)
    path = os.path.join(ROOT, ".env")
    if os.path.exists(path):
        with open(path) as f:
            for line in f:
                if "=" in line and not line.lstrip().startswith("#"):
                    key, value = line.strip().split("=", 1)
                    env.setdefault(key, value)
    return env


def request(method, url, headers, body=None, timeout=300):
    """One HTTP call. Waits and retries on 429 (too many requests) and on 5xx."""
    data = json.dumps(body).encode() if body is not None else None
    headers = {"User-Agent": USER_AGENT, "Content-Type": "application/json", **headers}
    for attempt in range(6):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, data, headers, method=method), timeout=timeout) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            if e.code != 429 and e.code < 500 or attempt == 5:
                return e.code, e.read()
            time.sleep(min(2 ** attempt, 30) + random.random())


# ---------------------------------------------------------------- Vexcel

def fetch_vexcel(boundary, cache_dir, key):
    """Every Vexcel parcel whose center is inside the boundary, newest survey only. One cache file per tile.

    Do not pass the `layer` parameter: with it, Vexcel returns each parcel once per survey year.
    """
    os.makedirs(cache_dir, exist_ok=True)
    west, south, east, north = br.bounds(boundary)
    seen = set()
    for i in range(TILES_PER_SIDE):
        for j in range(TILES_PER_SIDE):
            w = west + (east - west) * i / TILES_PER_SIDE
            e = west + (east - west) * (i + 1) / TILES_PER_SIDE
            s = south + (north - south) * j / TILES_PER_SIDE
            n = south + (north - south) * (j + 1) / TILES_PER_SIDE
            wkt = f"POLYGON(({w} {s},{e} {s},{e} {n},{w} {n},{w} {s}))"
            kept, page = [], 1
            while True:
                query = urllib.parse.urlencode({"wkt": wkt, "srid": 4326, "unit-system": "metric", "latest": "true",
                                                "include": "precomputed,calculated", "page": page,
                                                "page-size": PAGE_SIZE})
                status, raw = request("GET", f"{VEXCEL_URL}?{query}", {"X-API-KEY": key})
                if status == 404:                       # no parcels in this tile
                    break
                if status != 200:
                    sys.exit(f"Vexcel answered {status} for tile {i},{j} page {page}: {raw[:300]!r}")
                features = json.loads(raw)["features"]
                for feature in features:
                    digest = hashlib.md5(json.dumps(feature["geometry"], sort_keys=True).encode()).hexdigest()
                    if digest in seen:
                        continue
                    seen.add(digest)
                    lng, lat = br.center(br.geojson_polygons(feature["geometry"]))
                    if br.point_in_polygons(lng, lat, boundary):
                        kept.append(feature)
                if len(features) < PAGE_SIZE:
                    break
                page += 1
            with gzip.open(os.path.join(cache_dir, f"tile_{i}_{j}.json.gz"), "wt") as f:
                json.dump({"type": "FeatureCollection", "features": kept}, f)
            print(f"  Vexcel tile {i},{j}: {len(kept)} parcels", flush=True)


def read_vexcel(cache_dir):
    features = []
    for name in sorted(os.listdir(cache_dir)):
        if name.endswith(".json.gz"):
            with gzip.open(os.path.join(cache_dir, name), "rt") as f:
                features.extend(json.load(f)["features"])
    return features


# ---------------------------------------------------------------- County Assessor

def fetch_assessor(boundary, cache_dir):
    """Every Los Angeles County lot that touches the box around the boundary. One cache file per tile.

    A lot on a tile edge is in two files; build_rows keeps it once. Lots outside the boundary do no harm.
    """
    os.makedirs(cache_dir, exist_ok=True)
    west, south, east, north = br.bounds(boundary)
    side = ASSESSOR_TILES_PER_SIDE
    for i in range(side):
        for j in range(side):
            box = (west + (east - west) * i / side, south + (north - south) * j / side,
                   west + (east - west) * (i + 1) / side, south + (north - south) * (j + 1) / side)
            lots = []
            while True:
                query = urllib.parse.urlencode({
                    "where": "1=1", "geometry": ",".join(str(v) for v in box), "geometryType": "esriGeometryEnvelope",
                    "inSR": 4326, "outSR": 4326, "spatialRel": "esriSpatialRelIntersects",
                    "outFields": ",".join(ASSESSOR_FIELDS), "returnGeometry": "true", "geometryPrecision": 6,
                    "orderByFields": "OBJECTID", "resultOffset": len(lots), "resultRecordCount": ASSESSOR_PAGE_SIZE,
                    "f": "json"})
                status, raw = request("GET", f"{ASSESSOR_URL}?{query}", {"User-Agent": "generic-client"})
                page = json.loads(raw) if status == 200 else {}
                if "features" not in page:              # the service reports errors inside a 200 answer
                    sys.exit(f"County Assessor answered {status} for tile {i},{j}: {raw[:300]!r}")
                lots.extend(page["features"])
                if len(page["features"]) < ASSESSOR_PAGE_SIZE and not page.get("exceededTransferLimit"):
                    break
            with gzip.open(os.path.join(cache_dir, f"tile_{i}_{j}.json.gz"), "wt") as f:
                json.dump(lots, f)
            print(f"  Assessor tile {i},{j}: {len(lots)} lots", flush=True)


def read_assessor(cache_dir):
    """Lots that have an outline. A few records in the layer have none."""
    lots = []
    for name in sorted(os.listdir(cache_dir)):
        if name.endswith(".json.gz"):
            with gzip.open(os.path.join(cache_dir, name), "rt") as f:
                lots.extend(lot for lot in json.load(f) if (lot.get("geometry") or {}).get("rings"))
    return lots


# ---------------------------------------------------------------- CoStar

def read_jsonl(path):
    with open(path) as f:
        for line in f:
            yield json.loads(line)


def read_costar(kit, boundary):
    """(costar_properties rows, contacts rows) for the records inside the boundary."""
    data = os.path.join(kit, "data")
    commercial = [r for r in read_jsonl(os.path.join(data, "commercial-property.jsonl"))
                  if br.point_in_polygons(r["primaryAddress"]["longitude"], r["primaryAddress"]["latitude"], boundary)]
    wanted = {c.get("locationId") for r in commercial for c in r.get("contacts") or [] if c.get("contactRole") == 4}
    company_names = {c["id"]: c.get("name") for c in read_jsonl(os.path.join(data, "company-detail.jsonl"))
                     if c["id"] in wanted}
    ids = {r["id"] for r in commercial}
    listings = {a["propertyId"]: a for a in read_jsonl(os.path.join(data, "apartment-listing.jsonl"))
                if a["propertyId"] in ids}
    apartment_managers = {i: a.get("propertyManagementCompanyName") for i, a in listings.items()}
    properties = {}
    contacts = []
    for record in commercial:
        row = br.commercial_property(record, (listings.get(record["id"]) or {}).get("totalNumUnits"))
        properties[row["costar_id"]] = row
        contacts.extend(br.contacts_for(record, company_names, apartment_managers.get(record["id"])))
    for record in read_jsonl(os.path.join(data, "residential-listings.jsonl")):
        row = br.residential_property(record)
        if row and br.point_in_polygons(row["lng"], row["lat"], boundary):
            properties.setdefault(row["costar_id"], row)
    return list(properties.values()), contacts


# ---------------------------------------------------------------- Supabase

def apply_schema(env):
    for name in ("SUPABASE_PROJECT_REF", "SUPABASE_ACCESS_TOKEN"):
        if not env.get(name):
            sys.exit(f"{name} is not set in .env. It is needed for --apply-schema only. "
                     "Or paste data/db/schema.sql into the Supabase SQL editor.")
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "schema.sql")) as f:
        sql = f.read()
    status, raw = request("POST", f"https://api.supabase.com/v1/projects/{env['SUPABASE_PROJECT_REF']}/database/query",
                          {"Authorization": f"Bearer {env['SUPABASE_ACCESS_TOKEN']}"}, {"query": sql})
    if status >= 300:
        sys.exit(f"Schema failed ({status}): {raw[:500]!r}")
    print("Schema applied.")
    time.sleep(3)                                       # the REST API needs a moment to see new tables


def upsert(env, table, rows):
    headers = {"apikey": env["SUPABASE_SECRET_KEY"], "Authorization": f"Bearer {env['SUPABASE_SECRET_KEY']}",
               "Prefer": "resolution=merge-duplicates,return=minimal"}
    key = "costar_id" if table == "costar_properties" else "id"
    url = f"{env['SUPABASE_URL']}/rest/v1/{table}?on_conflict={key}"
    for start in range(0, len(rows), BATCH_ROWS):
        status, raw = request("POST", url, headers, rows[start:start + BATCH_ROWS])
        if status >= 300:
            sys.exit(f"Upload to {table} failed at row {start} ({status}): {raw[:500]!r}")
        print(f"  {table}: {min(start + BATCH_ROWS, len(rows))}/{len(rows)}", flush=True)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--apply-schema", action="store_true", help="run schema.sql first")
    parser.add_argument("--dry-run", action="store_true", help="build rows and print counts, send nothing")
    parser.add_argument("--costar-kit", default=os.path.join(ROOT, "data", "costar-kit"))
    parser.add_argument("--cache", default=os.path.join(ROOT, "data", "cache", "vexcel_hollywood"))
    parser.add_argument("--assessor-cache", default=os.path.join(ROOT, "data", "cache", "assessor_hollywood"))
    parser.add_argument("--boundary", default=os.path.join(here, "hollywood_boundary.geojson"),
                        help="GeoJSON file; its first feature is the area to load")
    args = parser.parse_args()
    env = load_env()
    if not os.path.isdir(os.path.join(args.costar_kit, "data")):
        sys.exit(f"CoStar kit not found at {args.costar_kit}. Unzip it there or pass --costar-kit.")
    if not args.dry_run:
        for name in ("SUPABASE_URL", "SUPABASE_SECRET_KEY"):
            if not env.get(name):
                sys.exit(f"{name} is not set in .env (ask Rasul for the value).")

    with open(args.boundary) as f:
        boundary = br.geojson_polygons(json.load(f)["features"][0]["geometry"])
    if not os.path.isdir(args.cache) or not os.listdir(args.cache):
        if not env.get("VEXCEL_API_KEY"):
            sys.exit("VEXCEL_API_KEY is not set in .env and there is no Vexcel cache.")
        print("Fetching Vexcel parcels (first run only)...")
        fetch_vexcel(boundary, args.cache, env["VEXCEL_API_KEY"])
    parcels = read_vexcel(args.cache)
    if not os.path.isdir(args.assessor_cache) or not os.listdir(args.assessor_cache):
        print("Fetching County Assessor lots (first run only)...")
        fetch_assessor(boundary, args.assessor_cache)
    lots = read_assessor(args.assessor_cache)
    properties, contacts = read_costar(args.costar_kit, boundary)
    buildings = br.build(parcels, properties, lots)
    rs.score_rows(buildings, {p["costar_id"] for p in properties if p.get("is_senior_housing")})

    by_source = {}
    for b in buildings:
        by_source[b["units_source"]] = by_source.get(b["units_source"], 0) + 1
    print(f"{len(parcels)} parcels -> {len(buildings)} buildings, {len(properties)} CoStar properties, "
          f"{len(contacts)} contacts")
    print(f"  with CoStar data: {sum(1 for b in buildings if b['costar_id'])}, "
          f"CoStar-only (no footprint): {sum(1 for b in buildings if b['footprint'] is None)}, "
          f"accessory: {sum(1 for b in buildings if b['is_accessory'])}, "
          f"height suspect: {sum(1 for b in buildings if b['height_suspect'])}")
    print(f"  units source: {by_source}")
    print(f"  on a County Assessor lot: {sum(1 for b in buildings if b['assessor_ain'])}")
    scored = [b["risk_score"] for b in buildings if b["risk_score"]]
    print(f"  risk score: {len(scored)} above 0 (highest {max(scored, default=0)}), "
          f"{sum(1 for b in buildings if b['risk_score'] == 0)} at 0, "
          f"{sum(1 for b in buildings if b['risk_score'] is None)} not known")
    if args.dry_run:
        return
    if args.apply_schema:
        apply_schema(env)
    upsert(env, "costar_properties", properties)
    upsert(env, "buildings", buildings)
    upsert(env, "contacts", contacts)
    print("Done.")


if __name__ == "__main__":
    main()
