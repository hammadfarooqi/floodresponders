"""Step 3: merge CoStar + Matterport + Vexcel per building, give each a data-completeness tier, draw a map.

Writes data/processed/buildings_{city}.json and data/processed/coverage_map.html (both gitignored).
Run after costar_extract.py and enrich.py:  python3 data/pipeline/build_map.py
"""
import collections
import json
from pathlib import Path

DATA = Path(__file__).resolve().parents[1]
PROC = DATA / "processed"
CACHE = DATA / "cache"
CITIES = ["la", "houston"]

TIERS = {
    4: "Complete: CoStar core + Vexcel + Matterport stairs/windows",
    3: "CoStar core + Vexcel, no stairs/windows in scans",
    2: "Vexcel + partial CoStar (material or units missing)",
    1: "CoStar only (no Vexcel parcel at this point)",
}


BOUNDS = DATA / "boundaries"
# Region layers per city: (key in building record, geojson file, property holding the name)
REGION_LAYERS = {
    "la": [("plan_area", "la_community_plan_areas.geojson", "NAME_ALF"),
           ("neighborhood", "la_county_csa.geojson", "LABEL")],
}


def _rings(geom):
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    return polys


def _in_ring(x, y, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def region_of(lng, lat, features, name_key):
    for f in features:
        g = f.get("geometry")
        if not g:
            continue
        for poly in _rings(g):
            if _in_ring(lng, lat, poly[0]) and not any(_in_ring(lng, lat, h) for h in poly[1:]):
                return (f["properties"].get(name_key) or "").strip() or None
    return None


def wkt_rings(wkt: str) -> list:
    """POLYGON/MULTIPOLYGON WKT -> list of outer rings as [[lat, lng], ...] (holes dropped; fine for drawing)."""
    import re
    out = []
    for poly in re.findall(r"\(\(([^()]*)\)", wkt):  # first ring of each polygon = outer ring
        ring = []
        for pt in poly.split(","):
            x, y = pt.split()[:2]
            ring.append([round(float(y), 6), round(float(x), 6)])
        out.append(ring)
    return out


def load(path: Path):
    return json.loads(path.read_text()) if path.exists() else None


def merge(b: dict) -> dict:
    scans = [s for s in (load(CACHE / "matterport" / f"{m}.json") for m in b["matterport_ids"]) if s and s.get("ok")]
    stairs = sum(s["staircases"] for s in scans)
    windows = sum(s["windows"] for s in scans)
    doorways = sum(s["doorways"] for s in scans)

    vx = load(CACHE / "vexcel" / f"{b['id']}.json") or {}
    structs = vx.get("structures") or []
    primary = next((s for s in structs if s.get("primary-structure")), structs[0] if structs else {})

    fp = load(CACHE / "vexcel_fp" / f"{b['id']}.json") or {}
    b = dict(b)
    b["footprints"] = [r for w in fp.get("wkts", []) for r in wkt_rings(w)]
    b.update({
        "scans_fetched": len(scans),
        "mp_staircases": stairs,
        "mp_windows": windows,
        "mp_doorways": doorways,
        "vexcel_status": vx.get("status"),
        "ground_elevation_m": primary.get("ground-elevation.value"),
        "roof_material": primary.get("roof-characteristics.material.class"),
        "roof_condition": primary.get("roof-characteristics.condition"),
        "footprint_m2": primary.get("footprint.area"),
        "vexcel_structures": len(structs),
        "parcel": vx.get("parcel_geometry"),
    })

    has = {
        "location": b["lat"] is not None,
        "stories": b["stories"] is not None,
        "material": b["construction_material"] is not None,
        "units": (b["units"] is not None) or not b["is_apartment"],
        "manager_phone": bool(b["manager"] and b["manager"].get("phone")),
        "elevation": b["ground_elevation_m"] is not None,
        "egress": stairs > 0 or windows > 0,
        "scan": len(b["matterport_ids"]) > 0,
    }
    core = has["stories"] and has["material"] and has["units"]
    if not has["elevation"]:
        tier = 1
    elif not core:
        tier = 2
    elif not has["egress"]:
        tier = 3
    else:
        tier = 4
    b["has"] = has
    b["tier"] = tier
    return b


def main():
    payload = {}
    for city in CITIES:
        src = PROC / f"costar_{city}.json"
        if not src.exists():
            continue
        rows = [merge(b) for b in json.loads(src.read_text())]
        for key, fname, name_key in REGION_LAYERS.get(city, []):
            feats = json.loads((BOUNDS / fname).read_text())["features"]
            for r in rows:
                r[key] = region_of(r["lng"], r["lat"], feats, name_key) if r["lat"] else None
            print(f"   {key}: {sum(1 for r in rows if r[key])}/{len(rows)} buildings placed")
        (PROC / f"buildings_{city}.json").write_text(json.dumps(rows, indent=1))
        tiers = collections.Counter(r["tier"] for r in rows)
        fields = {k: sum(r["has"][k] for r in rows) for k in rows[0]["has"]}
        print(f"{city}: {len(rows)} buildings  tiers={dict(sorted(tiers.items(), reverse=True))}")
        print(f"   field coverage: {fields}")
        print(f"   footprints: {sum(1 for r in rows if r['footprints'])} buildings with outlines")
        print(f"   senior: {sum(r['is_senior'] for r in rows)}  vexcel 404: "
              f"{sum(r['vexcel_status'] == 404 for r in rows)}  vexcel missing: "
              f"{sum(r['vexcel_status'] is None for r in rows)}")
        payload[city] = [{k: r[k] for k in (
            "id", "name", "address", "lat", "lng", "property_type", "stories", "construction_material",
            "year_built", "units", "vacancy_pct", "lifestyle", "is_senior", "is_walkup", "elevators", "rent_type",
            "apartment_style", "has_sprinklers", "ground_elevation_m", "roof_material", "roof_condition",
            "mp_staircases", "mp_windows", "mp_doorways", "scans_fetched", "tier", "has")}
            | {"plan_area": r.get("plan_area"), "neighborhood": r.get("neighborhood"), "fp": r["footprints"]}
            | {"manager": r["manager"], "n_scans": len(r["matterport_ids"])} for r in rows if r["lat"]]

    template = (Path(__file__).parent / "coverage_map.template.html").read_text()
    regions = {"la": {
        "city": json.loads((BOUNDS / "la_city_boundary.geojson").read_text()),
        "plan_area": json.loads((BOUNDS / "la_community_plan_areas.geojson").read_text()),
        "neighborhood": json.loads((BOUNDS / "la_county_csa.geojson").read_text()),
    }}
    fires = []
    for fname, ykey in (("la_calfire_perimeters.geojson", "YEAR_"), ("la_recent_fire_perimeters.geojson", None)):
        for f in json.loads((BOUNDS / fname).read_text())["features"]:
            p = f["properties"]
            if ykey:
                year = int(p.get(ykey) or 0)
                name, acres = p.get("FIRE_NAME"), p.get("GIS_ACRES")
            else:
                t = p.get("attr_FireDiscoveryDateTime")
                year = __import__("datetime").datetime.utcfromtimestamp(t / 1000).year if t else 0
                name, acres = p.get("poly_IncidentName"), p.get("poly_GISAcres")
                if year < 2024:
                    continue
            if f.get("geometry"):
                f["properties"] = {"name": f"{(name or 'Unnamed').title()} {year}", "year": year, "acres": round(acres or 0)}
                fires.append(f)
    regions["la"]["fires"] = {"type": "FeatureCollection", "features": fires}
    for key, layer in regions["la"].items():  # keep only the name properties the map needs
        if key == "fires":
            continue
        for f in layer["features"]:
            p = f["properties"]
            f["properties"] = {"name": (p.get("NAME_ALF") or p.get("LABEL") or p.get("CITY_NAME") or "").strip()}
    html = template.replace("/*__REGIONS__*/null", json.dumps(regions)).replace(
        "/*__DATA__*/null", json.dumps(payload)).replace(
        "/*__TIERS__*/null", json.dumps(TIERS))
    out = PROC / "coverage_map.html"
    out.write_text(html)
    print("map ->", out)


if __name__ == "__main__":
    main()
