"""Which real LA fires came near our buildings? For each fire perimeter: buildings inside, within 1 km and 3 km.

Inputs (public, in data/boundaries/):
  la_county_fire_perimeters.geojson   LA County Fire historic perimeters (to 2023)
  la_recent_fire_perimeters.geojson   NIFC WFIGS interagency perimeters, LA County, 2024 on
  la_calfire_perimeters.geojson       CAL FIRE FRAP historic perimeters, LA basin box (has LA City fires, to 2025)
Writes data/processed/fire_overlap_la.json and prints a ranking.

Run: python3 data/pipeline/fire_overlap.py
"""
import datetime
import json
import math
from pathlib import Path

DATA = Path(__file__).resolve().parents[1]
BOUNDS = DATA / "boundaries"
FOCUS = {"Wilshire", "Hollywood", "Downtown", "Westlake"}  # decided LA focus area


def fires():
    out = []
    for f in json.loads((BOUNDS / "la_county_fire_perimeters.geojson").read_text())["features"]:
        p = f["properties"]
        out.append({"name": (p.get("FIRE_NAME") or "?").title(), "year": int(p.get("YEAR") or 0),
                    "acres": p.get("GIS_ACRES") or 0, "geometry": f["geometry"], "source": "LACoFD"})
    for f in json.loads((BOUNDS / "la_recent_fire_perimeters.geojson").read_text())["features"]:
        p = f["properties"]
        t = p.get("attr_FireDiscoveryDateTime")
        out.append({"name": (p.get("poly_IncidentName") or "?").title(),
                    "year": datetime.datetime.utcfromtimestamp(t / 1000).year if t else 0,
                    "acres": p.get("poly_GISAcres") or 0, "geometry": f["geometry"], "source": "NIFC"})
    for f in json.loads((BOUNDS / "la_calfire_perimeters.geojson").read_text())["features"]:
        p = f["properties"]
        out.append({"name": (p.get("FIRE_NAME") or "?").title(), "year": int(p.get("YEAR_") or 0),
                    "acres": p.get("GIS_ACRES") or 0, "geometry": f["geometry"], "source": "CAL FIRE"})
    return [f for f in out if f["geometry"]]


def polys(geom):
    return geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]


def in_ring(x, y, ring):
    inside, j = False, len(ring) - 1
    for i in range(len(ring)):
        xi, yi, xj, yj = ring[i][0], ring[i][1], ring[j][0], ring[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def dist_m(lng, lat, geom):
    """0 if inside, else meters to the nearest perimeter edge (local flat approximation)."""
    kx, ky = 111_320 * math.cos(math.radians(lat)), 110_540
    best = float("inf")
    for poly in polys(geom):
        if in_ring(lng, lat, poly[0]) and not any(in_ring(lng, lat, h) for h in poly[1:]):
            return 0.0
        for ring in poly:
            for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
                ax, ay = (x1 - lng) * kx, (y1 - lat) * ky
                bx, by = (x2 - lng) * kx, (y2 - lat) * ky
                dx, dy = bx - ax, by - ay
                t = max(0.0, min(1.0, -(ax * dx + ay * dy) / (dx * dx + dy * dy or 1)))
                best = min(best, math.hypot(ax + t * dx, ay + t * dy))
    return best


def bbox(geom, pad_deg):
    xs = [pt[0] for poly in polys(geom) for ring in poly for pt in ring]
    ys = [pt[1] for poly in polys(geom) for ring in poly for pt in ring]
    return min(xs) - pad_deg, min(ys) - pad_deg, max(xs) + pad_deg, max(ys) + pad_deg


def main():
    blds = [b for b in json.loads((DATA / "processed" / "buildings_la.json").read_text()) if b["lat"]]
    results = []
    for f in fires():
        x0, y0, x1, y1 = bbox(f["geometry"], 0.035)  # ~3 km
        near = [b for b in blds if x0 <= b["lng"] <= x1 and y0 <= b["lat"] <= y1]
        rows = []
        for b in near:
            d = dist_m(b["lng"], b["lat"], f["geometry"])
            if d <= 3000:
                rows.append({"id": b["id"], "dist_m": round(d), "tier": b["tier"], "focus": b.get("plan_area") in FOCUS,
                             "senior": b["is_senior"], "units": b["units"] or 0})
        if rows:
            results.append({k: f[k] for k in ("name", "year", "acres", "source")} | {
                "inside": sum(r["dist_m"] == 0 for r in rows),
                "within_1km": sum(r["dist_m"] <= 1000 for r in rows),
                "within_3km": len(rows),
                "within_1km_focus": sum(r["dist_m"] <= 1000 and r["focus"] for r in rows),
                "within_1km_complete": sum(r["dist_m"] <= 1000 and r["tier"] == 4 for r in rows),
                "within_1km_units": sum(r["units"] for r in rows if r["dist_m"] <= 1000),
                "buildings": rows})
    results.sort(key=lambda r: (-r["inside"], -r["within_1km"], -r["within_3km"]))
    (DATA / "processed" / "fire_overlap_la.json").write_text(json.dumps(results, indent=1))
    print(f"{len(results)} fires came within 3 km of at least one of our {len(blds)} LA buildings\n")
    print(f"{'fire':24s} {'year':>4s} {'acres':>7s} {'in':>3s} {'1km':>4s} {'3km':>4s} {'1km focus':>9s} {'1km tier4':>9s} {'1km units':>9s}")
    for r in results[:25]:
        print(f"{r['name'][:24]:24s} {r['year']:4d} {r['acres']:7.0f} {r['inside']:3d} {r['within_1km']:4d} {r['within_3km']:4d} "
              f"{r['within_1km_focus']:9d} {r['within_1km_complete']:9d} {r['within_1km_units']:9d}")


if __name__ == "__main__":
    main()
