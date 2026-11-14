"""Step 3b: Hollywood detail map. Every Vexcel structure in the area, with CoStar buildings marked.

Needs: area_fetch.py hollywood, build_map.py (for buildings_la.json), evac_zones.py.
Writes data/processed/buildings_hollywood.json and data/processed/hollywood_map.html (gitignored).

Run: python3 data/pipeline/build_hollywood_map.py
"""
import collections
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_map import TIERS, _in_ring, _rings  # noqa: E402

DATA = Path(__file__).resolve().parents[1]
PROC, BOUNDS, CACHE = DATA / "processed", DATA / "boundaries", DATA / "cache"


def in_geom(lng, lat, geom):
    return any(_in_ring(lng, lat, p[0]) and not any(_in_ring(lng, lat, h) for h in p[1:]) for p in _rings(geom))


def bbox(geom):
    xs = [pt[0] for p in _rings(geom) for pt in p[0]]
    ys = [pt[1] for p in _rings(geom) for pt in p[0]]
    return min(xs), min(ys), max(xs), max(ys)


def main():
    structs = json.loads((PROC / "area_hollywood_structures.json").read_text())
    zones = json.loads((BOUNDS / "sunset_fire_2025_evacuation.geojson").read_text())["features"]
    order = next(z["geometry"] for z in zones if z["properties"]["name"].startswith("Mandatory"))
    warn = next(z["geometry"] for z in zones if z["properties"]["name"].startswith("Evacuation warning"))
    plan = next(f for f in json.loads((BOUNDS / "la_community_plan_areas.geojson").read_text())["features"]
                if f["properties"]["NAME_ALF"] == "Hollywood")

    # CoStar buildings near the area, each with its Vexcel parcel polygon (from the point lookup cache)
    costar = []
    x0, y0, x1, y1 = bbox(warn)
    px0, py0, px1, py1 = bbox(plan["geometry"])
    x0, y0, x1, y1 = min(x0, px0), min(y0, py0), max(x1, px1), max(y1, py1)
    for b in json.loads((PROC / "buildings_la.json").read_text()):
        if not b["lat"] or not (x0 <= b["lng"] <= x1 and y0 <= b["lat"] <= y1):
            continue
        vx = json.loads((CACHE / "vexcel" / f"{b['id']}.json").read_text()) if (CACHE / "vexcel" / f"{b['id']}.json").exists() else {}
        b["_parcel"] = vx.get("parcel_geometry")
        b["_pbox"] = bbox(b["_parcel"]) if b["_parcel"] else None
        costar.append(b)

    matched = collections.Counter()
    for s in structs:
        s["zone"] = "order" if in_geom(s["lng"], s["lat"], order) else ("warning" if in_geom(s["lng"], s["lat"], warn) else None)
        s["costar_id"] = None
        for b in costar:
            bb = b["_pbox"]
            if bb and bb[0] <= s["lng"] <= bb[2] and bb[1] <= s["lat"] <= bb[3] and in_geom(s["lng"], s["lat"], b["_parcel"]):
                s["costar_id"] = b["id"]
                matched[b["id"]] += 1
                break

    keep = ("id", "name", "address", "property_type", "stories", "construction_material", "year_built", "units",
            "vacancy_pct", "lifestyle", "is_senior", "is_walkup", "elevators", "rent_type", "apartment_style",
            "ground_elevation_m", "roof_material", "mp_staircases", "mp_windows", "mp_doorways", "n_scans",
            "tier", "manager", "plan_area")
    cs = {}
    for b in costar:
        if matched[b["id"]] or (in_geom(b["lng"], b["lat"], warn) or in_geom(b["lng"], b["lat"], plan["geometry"])):
            cs[b["id"]] = {k: b.get(k) for k in keep} | {"lat": b["lat"], "lng": b["lng"], "fp": b.get("footprints") or [],
                                                         "n_structures": matched[b["id"]],
                                                         "zone": "order" if in_geom(b["lng"], b["lat"], order) else (
                                                             "warning" if in_geom(b["lng"], b["lat"], warn) else None)}
            if "n_scans" not in b:
                cs[b["id"]]["n_scans"] = len(b.get("matterport_ids") or [])

    (PROC / "buildings_hollywood.json").write_text(json.dumps({"structures": structs, "costar": cs}))

    def summary(zone_names):
        ss = [s for s in structs if s["zone"] in zone_names]
        cb = [c for c in cs.values() if c["zone"] in zone_names]
        return (f"structures={len(ss)} (with CoStar={sum(1 for s in ss if s['costar_id'])}) "
                f"costar buildings={len(cb)} tiers={dict(sorted(collections.Counter(c['tier'] for c in cb).items(), reverse=True))} "
                f"units={sum(c['units'] or 0 for c in cb)}")
    print(f"all area: {len(structs)} Vexcel structures, {sum(1 for s in structs if s['costar_id'])} on CoStar parcels, "
          f"{len(cs)} CoStar buildings")
    print("mandatory order:", summary({"order"}))
    print("order + warning:", summary({"order", "warning"}))

    payload = {
        "structures": [[s["id"], s["rings"], s["costar_id"], s["zone"], s.get("building-type.class"),
                        s.get("roof-characteristics.material.class"), s.get("roof-characteristics.condition"),
                        s.get("ground-elevation.value"), round(s.get("footprint.area") or 0)] for s in structs],
        "costar": cs,
        "zones": json.loads((BOUNDS / "sunset_fire_2025_evacuation.geojson").read_text()),
        "plan": {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {"name": "Hollywood"},
                                                            "geometry": plan["geometry"]}]},
        "tiers": TIERS,
    }
    html = (Path(__file__).parent / "hollywood_map.template.html").read_text().replace(
        "/*__DATA__*/null", json.dumps(payload, separators=(",", ":")))
    (PROC / "hollywood_map.html").write_text(html)
    print("map ->", PROC / "hollywood_map.html")


if __name__ == "__main__":
    main()
