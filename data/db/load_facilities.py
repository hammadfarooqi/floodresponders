"""Load care homes, hospitals, housing projects and schools into the Supabase table `facilities`.

    python3 data/db/load_facilities.py --dry-run        # build the rows and print counts, send nothing
    python3 data/db/load_facilities.py                  # load
    python3 data/db/load_facilities.py --apply-schema   # run schema.sql first, then load

Run load_supabase.py first: each facility is linked to a buildings row, and it needs the same Vexcel cache.
The five public lists need no key. Their answers are cached in data/cache/facilities/; delete that folder to
fetch them again. The load is an upsert on the row id. Standard library only. Read DATABASE.md first.
"""
import argparse
import json
import os
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_rows as br
import facilities as fc
import load_supabase as ls

ARCGIS = {
    "cdss": "https://services.arcgis.com/XLPEppdz2H9dOiqp/arcgis/rest/services/CDSS_CCL_Facilities/FeatureServer/0",
    "hud": "https://services.arcgis.com/VTyQ9soqVukalItT/arcgis/rest/services/MULTIFAMILY_PROPERTIES_ASSISTED/FeatureServer/0",
    "cde": "https://services3.arcgis.com/fdvHcZVgB2QSRNkL/arcgis/rest/services/SchoolSites2526/FeatureServer/0",
}
LAHD_URL = "https://data.lacity.org/resource/mymu-zi3s.json"
CDPH_URL = "https://data.chhs.ca.gov/api/3/action/datastore_search_sql"
CDPH_TABLE = "f0ae5731-fef8-417f-839d-54a0ed3a126e"
ROW_OF = {"cdss": fc.cdss_row, "cdph": fc.cdph_row, "lahd": fc.lahd_row, "hud": fc.hud_row, "cde": fc.school_row}


def get_json(url, query):
    status, raw = ls.request("GET", f"{url}?{urllib.parse.urlencode(query)}", {"User-Agent": "data-loader"})
    if status != 200:
        sys.exit(f"{url} answered {status}: {raw[:300]!r}")
    return json.loads(raw)


def fetch(source, box):
    """Every record of one list inside the box (west, south, east, north), as the publisher sends it."""
    west, south, east, north = box
    if source == "lahd":
        return get_json(LAHD_URL, {"$limit": 50000, "$where": f"latitude > {south} AND latitude < {north} "
                                                              f"AND longitude > {west} AND longitude < {east}"})
    if source == "cdph":
        sql = (f'SELECT * FROM "{CDPH_TABLE}" WHERE "LATITUDE" > {south} AND "LATITUDE" < {north} '
               f'AND "LONGITUDE" > {west} AND "LONGITUDE" < {east}')
        return get_json(CDPH_URL, {"sql": sql})["result"]["records"]
    records = []
    while True:
        page = get_json(ARCGIS[source] + "/query", {
            "where": "1=1", "geometry": f"{west},{south},{east},{north}", "geometryType": "esriGeometryEnvelope",
            "inSR": 4326, "spatialRel": "esriSpatialRelIntersects", "outFields": "*", "returnGeometry": "false",
            "resultOffset": len(records), "f": "json"})
        if "features" not in page:
            sys.exit(f"{ARCGIS[source]} answered {str(page)[:300]}")
        records.extend(f["attributes"] for f in page["features"])
        if not page.get("exceededTransferLimit"):
            return records


def read_lists(cache_dir, box):
    """{source: records}, from the cache when it has the list, else from the publisher."""
    os.makedirs(cache_dir, exist_ok=True)
    lists = {}
    for source in ROW_OF:
        path = os.path.join(cache_dir, f"{source}.json")
        if not os.path.exists(path):
            print(f"Fetching {source}...", flush=True)
            with open(path, "w") as f:
                json.dump(fetch(source, box), f)
        with open(path) as f:
            lists[source] = json.load(f)
    return lists


def read_buildings(vexcel_cache):
    """The outline of every Vexcel structure, with the same id as its buildings row."""
    buildings = []
    for feature in ls.read_vexcel(vexcel_cache):
        for structure in feature["properties"].get("structures") or []:
            row = br.vexcel_structure(feature, structure)
            buildings.append({"id": row["id"], "polygons": br.parse_wkt_polygons(structure["footprint.wkt"]),
                              "is_accessory": row["vexcel_building_type"] in br.ACCESSORY_TYPES})
    return buildings


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--apply-schema", action="store_true", help="run schema.sql first")
    parser.add_argument("--dry-run", action="store_true", help="build rows and print counts, send nothing")
    parser.add_argument("--cache", default=os.path.join(ls.ROOT, "data", "cache", "facilities"))
    parser.add_argument("--vexcel-cache", default=os.path.join(ls.ROOT, "data", "cache", "vexcel_hollywood"))
    parser.add_argument("--boundary", default=os.path.join(here, "hollywood_boundary.geojson"),
                        help="GeoJSON file; its first feature is the area to load")
    args = parser.parse_args()
    env = ls.load_env()
    if not args.dry_run:
        for name in ("SUPABASE_URL", "SUPABASE_SECRET_KEY"):
            if not env.get(name):
                sys.exit(f"{name} is not set in .env (ask Rasul for the value).")
    if not os.path.isdir(args.vexcel_cache) or not os.listdir(args.vexcel_cache):
        sys.exit(f"No Vexcel cache at {args.vexcel_cache}. Run load_supabase.py first, or pass --vexcel-cache.")

    with open(args.boundary) as f:
        boundary = br.geojson_polygons(json.load(f)["features"][0]["geometry"])
    rows = {}
    for source, records in read_lists(args.cache, br.bounds(boundary)).items():
        for record in records:
            row = ROW_OF[source](record)
            if row and br.point_in_polygons(row["lng"], row["lat"], boundary):
                rows[row["id"]] = row
    rows = fc.link_buildings(list(rows.values()), read_buildings(args.vexcel_cache))

    by_kind = {}
    for row in rows:
        by_kind[row["kind"]] = by_kind.get(row["kind"], 0) + 1
    print(f"{len(rows)} facilities: {dict(sorted(by_kind.items()))}")
    print(f"  inside a building outline: {sum(1 for r in rows if r['building_distance_m'] == 0)}, "
          f"linked to the nearest building: {sum(1 for r in rows if r['building_distance_m'])}, "
          f"no building: {sum(1 for r in rows if r['building_id'] is None)}")
    if args.dry_run:
        return
    if args.apply_schema:
        ls.apply_schema(env)
    ls.upsert(env, "facilities", rows)
    print("Done.")


if __name__ == "__main__":
    main()
