"""Turn public lists of care homes, hospitals, housing projects and schools into rows for the facilities table.

Pure functions, standard library only. No network and no file access here: load_facilities.py does that.
The rules are described in DATABASE.md. Change a rule in both places.
"""
import itertools
import math
import uuid

import build_rows as br

LINK_MAX_M = 50.0                       # a point this far from every outline gets no building
GRID_DEG = 0.001                        # cell of the building lookup grid, about 100 m

# California Department of Social Services, licence type -> our kind. Types that are not here are left out:
# family homes that take foster children (403) and agency offices (400, 430).
CDSS_KIND = {740: "elderly_care", 735: "adult_care", 736: "adult_care", 730: "children_home", 726: "children_home",
             775: "adult_day_care", 850: "child_care", 860: "child_care", 830: "child_care", 840: "child_care"}
# California Department of Public Health, facility type -> our kind. Clinics and agency offices are left out.
CDPH_KIND = {"SNF": "nursing_home", "CLHF": "nursing_home", "GACH": "hospital", "ADHC": "adult_day_care"}
LAHD_KIND = {"SENIORS": "senior_housing", "SPECIAL NEEDS": "special_needs_housing"}     # other types: affordable
HUD_KIND = {"Elderly": "senior_housing", "Disabled": "special_needs_housing"}           # other groups: affordable


def _text(value):
    return str(value).strip() or None if value is not None else None


def _count(value):
    """A whole number above zero, or None. The lists use 0 for 'not known'."""
    try:
        number = int(float(value))
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def _row(source, source_id, kind, name, address, capacity, unit, lat, lng, status=None):
    try:
        lat, lng = float(lat), float(lng)
    except (TypeError, ValueError):
        return None
    return {"id": str(uuid.uuid5(br._NAMESPACE, f"facility:{source}:{source_id}")),
            "source": source, "source_id": str(source_id), "kind": kind,
            "name": _text(name), "address": _text(address),
            "capacity": _count(capacity), "capacity_unit": unit,
            "lat": lat, "lng": lng, "location": br.point_ewkt(lng, lat),
            "source_status": _text(status), "building_id": None, "building_distance_m": None}


def cdss_row(a):
    """One care facility licensed by the state Department of Social Services, or None when we do not keep it."""
    kind = CDSS_KIND.get(a.get("TYPE"))
    if not kind:
        return None
    return _row("cdss", a["FAC_NBR"], kind, a.get("NAME"), a.get("RES_STREET_ADDR"), a.get("CAPACITY"), "people",
                a.get("FAC_LATITUDE"), a.get("FAC_LONGITUDE"), a.get("STATUS"))


def cdph_row(r):
    """One healthcare facility licensed by the state Department of Public Health, or None."""
    kind = CDPH_KIND.get(r.get("FAC_TYPE_CODE"))
    if not kind:
        return None
    return _row("cdph", r["FACID"], kind, r.get("FACNAME"), r.get("ADDRESS"), r.get("CAPACITY"), "beds",
                r.get("LATITUDE"), r.get("LONGITUDE"), r.get("FAC_STATUS_TYPE_CODE"))


def lahd_row(r):
    """One site of a housing project funded by the Los Angeles Housing Department."""
    kind = LAHD_KIND.get(r.get("housing_type"), "affordable_housing")
    return _row("lahd", f"{r['project_number']}:{r.get('site_cd')}", kind, r.get("name"), r.get("address"),
                r.get("site_units"), "units", r.get("latitude"), r.get("longitude"), r.get("development_stage"))


def hud_row(a):
    """One apartment property with federal (HUD) rent assistance."""
    kind = HUD_KIND.get(a.get("CLIENT_GROUP_TYPE"), "affordable_housing")
    return _row("hud", a["PROPERTY_ID"], kind, a.get("PROPERTY_NAME_TEXT"), a.get("STD_ADDR"),
                a.get("TOTAL_UNIT_COUNT"), "units", a.get("LAT"), a.get("LON"))


def school_row(a):
    """One public school that is open and has students on site, or None."""
    if a.get("Status") != "Active" or a.get("Virtual") == "F":             # F = full-time online
        return None
    return _row("cde", a["CDSCode"], "school", a.get("SchoolName"), a.get("Street"), a.get("EnrollTotal"),
                "students", a.get("Latitude"), a.get("Longitude"), a.get("Status"))


# ---------------------------------------------------------------- link to a building

def _meters_to_ring(lng, lat, ring):
    """Distance in meters from a point to the nearest edge of a ring."""
    kx, ky = 111320 * math.cos(math.radians(lat)), 110540
    best = math.inf
    for (x1, y1), (x2, y2) in itertools.pairwise(ring):
        ax, ay, bx, by = (x1 - lng) * kx, (y1 - lat) * ky, (x2 - lng) * kx, (y2 - lat) * ky
        dx, dy = bx - ax, by - ay
        t = max(0.0, min(1.0, -(ax * dx + ay * dy) / (dx * dx + dy * dy))) if dx or dy else 0.0
        best = min(best, math.hypot(ax + t * dx, ay + t * dy))
    return best


def link_buildings(rows, buildings):
    """Fill building_id and building_distance_m of each row.

    buildings: [{"id", "polygons", "is_accessory"}], polygons as in build_rows.parse_wkt_polygons.
    A point inside an outline gets that building, at 0 m. Else it gets the nearest building that is not a shed or
    garage, when its outline is within LINK_MAX_M. Else it gets none.
    """
    grid = {}
    for b in buildings:
        west, south, east, north = br.bounds(b["polygons"])
        for i in range(int(west // GRID_DEG), int(east // GRID_DEG) + 1):
            for j in range(int(south // GRID_DEG), int(north // GRID_DEG) + 1):
                grid.setdefault((i, j), []).append(b)
    for row in rows:
        lng, lat = row["lng"], row["lat"]
        ci, cj = int(lng // GRID_DEG), int(lat // GRID_DEG)
        near = {b["id"]: b for i in (ci - 1, ci, ci + 1) for j in (cj - 1, cj, cj + 1) for b in grid.get((i, j), ())}
        inside = next((b for b in near.values() if br.point_in_polygons(lng, lat, b["polygons"])), None)
        if inside:
            row["building_id"], row["building_distance_m"] = inside["id"], 0
            continue
        best, best_m = None, LINK_MAX_M
        for b in near.values():
            if b["is_accessory"]:
                continue
            meters = min(_meters_to_ring(lng, lat, rings[0]) for rings in b["polygons"])
            if meters <= best_m:
                best, best_m = b, meters
        row["building_id"] = best["id"] if best else None
        row["building_distance_m"] = round(best_m, 1) if best else None
    return rows
