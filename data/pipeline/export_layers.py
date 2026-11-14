"""Export map layers for the live explorer app (explore/).

Writes data/processed/layers/<id>.geojson and data/processed/layers/manifest.json. The explorer watches that folder:
when a file changes, the open page reloads that layer. To add a layer: write a GeoJSON file and add an entry to
LAYERS below (or call add_layer() from another script), then run this script.

Every file is written atomically (temp file + rename), so the app never reads a half-written file.

Run: python3 data/pipeline/export_layers.py            (all layers)
     python3 data/pipeline/export_layers.py hollywood  (only layers whose id contains "hollywood")
"""
from __future__ import annotations

import collections
import datetime
import json
import os
import sys
from pathlib import Path

DATA = Path(__file__).resolve().parents[1]
PROC, BOUNDS = DATA / "processed", DATA / "boundaries"
OUT = PROC / "layers"

TIER_COLORS = {"4": "#008300", "3": "#2a78d6", "2": "#eda100", "1": "#e87ba4"}
TIER_LEGEND = [{"label": "Tier 4: complete (CoStar core + Vexcel + Matterport stairs/windows)", "color": "#008300"},
               {"label": "Tier 3: CoStar core + Vexcel, no stairs/windows", "color": "#2a78d6"},
               {"label": "Tier 2: Vexcel + partial CoStar", "color": "#eda100"},
               {"label": "Tier 1: CoStar only", "color": "#e87ba4"}]
FOCUS = [("focus_core", "Focus: Core (Wilshire, Hollywood, Downtown) — decided", ["Wilshire", "Hollywood", "Downtown"], "#6250d6", True),
         ("focus_westlake", "Focus: + Westlake — decided", ["Westlake"], "#9085e9", True),
         ("focus_east", "Focus: + East (Silver Lake–Echo Park, NE LA) — not now",
          ["Silver Lake - Echo Park - Elysian Valley", "Northeast Los Angeles"], "#eb6834", False),
         ("focus_west", "Focus: + Westside — maybe later",
          ["West Los Angeles", "Westwood", "Palms - Mar Vista - Del Rey", "Brentwood - Pacific Palisades"], "#5c5b57", False)]


def write_json(path: Path, obj) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, separators=(",", ":")))
    os.replace(tmp, path)


def fc(features):
    return {"type": "FeatureCollection", "features": features}


def load(p: Path):
    return json.loads(p.read_text()) if p.exists() else None


# ------------------------------------------------------------------ layer builders
def costar_points(city):
    rows = load(PROC / f"buildings_{city}.json")
    if rows is None:
        return None
    feats = []
    for b in rows:
        if not b["lat"]:
            continue
        props = {k: b.get(k) for k in (
            "name", "address", "tier", "property_type", "apartment_style", "lifestyle", "stories",
            "construction_material", "year_built", "units", "vacancy_pct", "is_walkup", "elevators", "rent_type",
            "is_senior", "has_sprinklers", "ground_elevation_m", "roof_material", "roof_condition",
            "mp_staircases", "mp_windows", "mp_doorways", "plan_area", "neighborhood")}
        props["costar_id"] = b["id"]
        props["manager"] = " · ".join(x for x in ((b.get("manager") or {}).get("company"),
                                                    (b.get("manager") or {}).get("phone")) if x) or None
        props["matterport_scans"] = len(b.get("matterport_ids") or [])
        feats.append({"type": "Feature", "properties": props,
                      "geometry": {"type": "Point", "coordinates": [b["lng"], b["lat"]]}})
    return fc(feats)


def boundary(fname, name_keys, keep=None):
    d = load(BOUNDS / fname)
    if d is None:
        return None
    feats = []
    for f in d["features"]:
        p = f["properties"]
        name = next((str(p[k]).strip() for k in name_keys if p.get(k)), "")
        if keep and name not in keep:
            continue
        feats.append({"type": "Feature", "properties": {"name": name}, "geometry": f["geometry"]})
    return fc(feats)


def fire_perimeters():
    feats = []
    for fname, ykey in (("la_calfire_perimeters.geojson", "YEAR_"), ("la_recent_fire_perimeters.geojson", None)):
        d = load(BOUNDS / fname) or {"features": []}
        for f in d["features"]:
            p = f["properties"]
            if ykey:
                year, name, acres = int(p.get(ykey) or 0), p.get("FIRE_NAME"), p.get("GIS_ACRES")
            else:
                t = p.get("attr_FireDiscoveryDateTime")
                year = datetime.datetime.utcfromtimestamp(t / 1000).year if t else 0
                name, acres = p.get("poly_IncidentName"), p.get("poly_GISAcres")
                if year < 2024:
                    continue
            if f.get("geometry"):
                feats.append({"type": "Feature", "geometry": f["geometry"], "properties": {
                    "name": f"{(name or 'Unnamed').title()} {year}", "year": year, "acres": round(acres or 0),
                    "era": "2000+" if year >= 2000 else "before 2000"}})
    return fc(feats)


def evac_zone(prefix):
    d = load(BOUNDS / "sunset_fire_2025_evacuation.geojson")
    if d is None:
        return None
    return fc([f for f in d["features"] if f["properties"]["name"].startswith(prefix)])


def simplify(ring, tol_m=0.5):
    """Douglas-Peucker on a [lng, lat] ring, tolerance in meters. Keeps the ring closed."""
    if len(ring) <= 5:
        return ring
    k = 111_320 * 0.83  # cos(34 deg): meters per degree of longitude in LA
    pts = [(x * k, y * 110_540) for x, y in ring]
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (ax, ay), (bx, by) = pts[a], pts[b]
        dx, dy = bx - ax, by - ay
        n2 = dx * dx + dy * dy
        best, idx = 0.0, -1
        for i in range(a + 1, b):
            px, py = pts[i]
            if n2 == 0:
                d = ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
            else:
                t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / n2))
                d = ((px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2) ** 0.5
            if d > best:
                best, idx = d, i
        if best > tol_m:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    out = [p for p, k_ in zip(ring, keep) if k_]
    return out if len(out) >= 4 else ring


def hollywood_structures():
    d = load(PROC / "buildings_hollywood.json")
    if d is None:
        return None
    cs = d["costar"]
    feats = []
    for s in d["structures"]:
        c = cs.get(s["costar_id"]) if s.get("costar_id") else None
        props = {k: v for k, v in {"source": f"CoStar tier {c['tier']}" if c else "Vexcel only",
                 "evacuation": {"order": "mandatory order", "warning": "warning"}.get(s.get("zone"), "outside"),
                 "vexcel_building_type": s.get("building-type.class"),
                 "footprint_m2": round(s.get("footprint.area") or 0),
                 "ground_elevation_m": s.get("ground-elevation.value"),
                 "roof_material": s.get("roof-characteristics.material.class"),
                 "roof_condition": s.get("roof-characteristics.condition")}.items() if v is not None}
        if c:
            props |= {"name": c["name"], "address": c["address"], "costar_id": c["id"], "stories": c["stories"],
                      "construction_material": c["construction_material"], "units": c["units"],
                      "is_walkup": c["is_walkup"], "is_senior": c["is_senior"], "year_built": c["year_built"],
                      "mp_staircases": c["mp_staircases"], "mp_windows": c["mp_windows"]}
        rings = [simplify([[round(pt[1], 6), round(pt[0], 6)] for pt in r]) for r in s["rings"]]  # stored as [lat, lng]
        geom = {"type": "Polygon", "coordinates": [rings[0]]} if len(rings) == 1 else \
            {"type": "MultiPolygon", "coordinates": [[r] for r in rings]}
        feats.append({"type": "Feature", "properties": props, "geometry": geom})
    return fc(feats)


# ------------------------------------------------------------------ manifest
def layer_specs():
    pop_costar = ["name", "address", "tier", "property_type", "apartment_style", "lifestyle", "stories",
                  "construction_material", "year_built", "units", "vacancy_pct", "is_walkup", "elevators",
                  "rent_type", "is_senior", "ground_elevation_m", "roof_material", "roof_condition",
                  "matterport_scans", "mp_staircases", "mp_windows", "mp_doorways", "manager", "plan_area",
                  "costar_id"]
    specs = [
        {"id": "la_city", "title": "LA City limit", "group": "LA boundaries", "build": lambda: boundary(
            "la_city_boundary.geojson", ["CITY_NAME"]), "pane": "regions", "defaultOn": True,
         "style": {"color": "#1d1d1b", "weight": 3, "fill": False}},
        {"id": "la_plan_areas", "title": "Community Plan Areas (35)", "group": "LA boundaries", "build": lambda: boundary(
            "la_community_plan_areas.geojson", ["NAME_ALF"]), "pane": "regions", "defaultOn": True,
         "labelField": "name", "style": {"color": "#5c5b57", "weight": 1.5, "dashArray": "5 4", "fillOpacity": 0}},
        {"id": "la_neighborhoods", "title": "Neighborhoods & cities (348)", "group": "LA boundaries",
         "build": lambda: boundary("la_county_csa.geojson", ["LABEL"]), "pane": "regions", "defaultOn": False,
         "style": {"color": "#8a8984", "weight": 0.7, "fillOpacity": 0}},
    ]
    for lid, title, areas, color, on in FOCUS:
        specs.append({"id": lid, "title": title, "group": "LA focus area", "pane": "regions", "defaultOn": on,
                      "build": (lambda a=areas: boundary("la_community_plan_areas.geojson", ["NAME_ALF"], keep=a)),
                      "style": {"color": color, "weight": 3, "fillColor": color, "fillOpacity": 0.18},
                      "legend": [{"label": title.split(" — ")[0], "color": color, "shape": "area"}]})
    specs += [
        {"id": "fires", "title": "Real fire perimeters (CAL FIRE + NIFC)", "group": "Fire",
         "build": fire_perimeters, "pane": "regions", "defaultOn": False, "labelField": "name",
         "labelFilter": {"field": "year", "min": 1990}, "popup": ["name", "acres"],
         "style": {"color": "#c2261d", "weight": 1.5, "fillColor": "#c2261d", "fillOpacity": 0.15}},
        {"id": "sunset_warning", "title": "Sunset Fire 2025: evacuation warning", "group": "Fire",
         "build": lambda: evac_zone("Evacuation warning"), "pane": "regions", "defaultOn": True, "popup": ["name", "note"],
         "style": {"color": "#eb6834", "weight": 3, "dashArray": "8 6", "fillColor": "#eb6834", "fillOpacity": 0.05}},
        {"id": "sunset_order", "title": "Sunset Fire 2025: mandatory evacuation order", "group": "Fire",
         "build": lambda: evac_zone("Mandatory"), "pane": "regions", "defaultOn": True, "popup": ["name", "note"],
         "style": {"color": "#c2261d", "weight": 3.5, "dashArray": "8 6", "fillColor": "#c2261d", "fillOpacity": 0.08}},
        {"id": "hollywood_structures", "title": "Hollywood: every building (Vexcel)", "group": "Buildings",
         "build": hollywood_structures, "pane": "features", "defaultOn": True,
         "colorBy": {"field": "source", "colors": {"Vexcel only": "#b9b7b1", "CoStar tier 4": "#008300",
                                                   "CoStar tier 3": "#2a78d6", "CoStar tier 2": "#eda100",
                                                   "CoStar tier 1": "#e87ba4"}},
         "style": {"color": "#8a8984", "weight": 0.5, "fillOpacity": 0.8},
         "strokeBy": {"field": "costar_id", "present": {"color": "#1d1d1b", "weight": 1.2}},
         "legend": [{"label": "Vexcel only (no CoStar)", "color": "#b9b7b1"}] + [
             {"label": f"CoStar tier {t}", "color": TIER_COLORS[str(t)]} for t in (4, 3, 2, 1)],
         "popup": ["name", "address", "source", "evacuation", "stories", "construction_material", "units",
                   "is_walkup", "is_senior", "year_built", "mp_staircases", "mp_windows", "vexcel_building_type",
                   "footprint_m2", "ground_elevation_m", "roof_material", "roof_condition", "costar_id"]},
    ]
    for city, title, on in (("la", "LA: CoStar buildings (dots)", True), ("houston", "Houston: CoStar buildings (dots)", False)):
        specs.append({"id": f"costar_{city}", "title": title, "group": "Buildings", "pane": "features",
                      "build": (lambda c=city: costar_points(c)), "defaultOn": on, "kind": "points",
                      "colorBy": {"field": "tier", "colors": TIER_COLORS},
                      "radiusBy": {"field": "units", "min": 3.5, "max": 11, "sqrtDiv": 2.2, "base": 2},
                      "ringWhen": {"field": "is_senior", "value": True, "color": "#1d1d1b", "weight": 3.5},
                      "style": {"color": "#fcfcfb", "weight": 1, "fillOpacity": 0.9},
                      "legend": TIER_LEGEND + [{"label": "Black ring = senior housing", "color": "#fcfcfb",
                                                "ring": "#1d1d1b"}],
                      "popup": pop_costar})
    return specs


def panels():
    out = []
    la = load(PROC / "buildings_la.json")
    if la:
        rows = []
        for lid, title, areas, color, _ in FOCUS:
            s = [b for b in la if b.get("plan_area") in areas]
            rows.append([title.split(":")[1].split("—")[0].strip(), len(s), sum(b["tier"] == 4 for b in s),
                         sum(b["units"] or 0 for b in s), sum(b["is_senior"] for b in s)])
        rows.append(["Whole LA", len(la), sum(b["tier"] == 4 for b in la), sum(b["units"] or 0 for b in la),
                     sum(b["is_senior"] for b in la)])
        out.append({"title": "LA focus options (CoStar)", "columns": ["Area", "Bldgs", "Tier 4", "Units", "Senior"],
                    "rows": rows})
    h = load(PROC / "buildings_hollywood.json")
    if h:
        cs = list(h["costar"].values())
        rows = []
        for name, zs in (("Mandatory order", {"order"}), ("Warning only", {"warning"}), ("Rest of Hollywood", {None})):
            ss = [s for s in h["structures"] if s.get("zone") in zs]
            cb = [c for c in cs if c.get("zone") in zs]
            rows.append([name, len(ss), len(cb), sum(c["tier"] == 4 for c in cb), sum(c["units"] or 0 for c in cb)])
        out.append({"title": "Hollywood: Sunset Fire evacuation areas",
                    "columns": ["Area", "Outlines", "CoStar bldgs", "Tier 4", "CoStar units"], "rows": rows})
    return out


def main():
    only = sys.argv[1] if len(sys.argv) > 1 else None
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = {"updated": datetime.datetime.now().isoformat(timespec="seconds"), "layers": [], "panels": panels()}
    old = load(OUT / "manifest.json") or {"layers": []}
    old_by_id = {lay["id"]: lay for lay in old["layers"]}
    for spec in layer_specs():
        spec = dict(spec)
        build = spec.pop("build")
        path = OUT / f"{spec['id']}.geojson"
        if only and only not in spec["id"]:
            if spec["id"] in old_by_id:
                manifest["layers"].append(old_by_id[spec["id"]])
            continue
        data = build()
        if data is None:
            print(f"  skip {spec['id']}: input missing")
            continue
        write_json(path, data)
        spec["file"] = path.name
        spec["count"] = len(data["features"])
        spec["version"] = int(path.stat().st_mtime)
        manifest["layers"].append(spec)
        print(f"  {spec['id']}: {spec['count']} features")
    write_json(OUT / "manifest.json", manifest)
    print("manifest ->", OUT / "manifest.json")


if __name__ == "__main__":
    main()
