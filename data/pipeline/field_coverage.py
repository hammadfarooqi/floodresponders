"""Uniform field coverage: every number is a share of ALL buildings in the area (one denominator).

For each candidate model field: % of buildings with a value. For yes/no fields: % yes, % no, % unknown.
Run: python3 data/pipeline/field_coverage.py hollywood   -> prints a Markdown table
"""
import json
import sys
from pathlib import Path

DATA = Path(__file__).resolve().parents[1]
name = (sys.argv[1:] or ["hollywood"])[0]
structs = json.loads((DATA / "processed" / f"area_{name}_structures.json").read_text())
assessor = json.loads((DATA / "processed" / f"area_{name}_assessor.json").read_text())
hb = json.loads((DATA / "processed" / "buildings_hollywood.json").read_text())
cid = {s["id"]: s.get("costar_id") for s in hb["structures"]}
costar = hb["costar"]
N = len(structs)


def vx(k):
    return lambda s: s.get(k)


def asr(k):
    return lambda s: (assessor.get(s["id"]) or {}).get(k)


def cs(k):
    return lambda s: (costar.get(cid.get(s["id"])) or {}).get(k) if cid.get(s["id"]) else None


ROWS = [  # (field, source, kind, getter)   kind: v = value, b = yes/no
    ("building_type", "Vexcel", "v", vx("building-type.class")),
    ("footprint_m2", "Vexcel", "v", vx("footprint.area")),
    ("ground_elevation_m", "Vexcel", "v", vx("ground-elevation.value")),
    ("roof_material", "Vexcel", "v", vx("roof-characteristics.material.class")),
    ("roof_condition", "Vexcel", "v", vx("roof-characteristics.condition")),
    ("roof_tree_cover_pct", "Vexcel", "v", vx("roof-characteristics.tree-cover.percent")),
    ("tree_cover_zone1_pct", "Vexcel", "v", vx("defensible-space.zone1-tree")),
    ("tree_cover_zone2_pct", "Vexcel", "v", vx("defensible-space.zone2-tree")),
    ("roof_structural_damage", "Vexcel", "b", vx("roof-defects.structural-damage.detected")),
    ("use_type", "Assessor", "v", asr("use_type")),
    ("units", "Assessor", "v", asr("units")),
    ("bedrooms", "Assessor", "v", asr("bedrooms")),
    ("floor_area_sqft", "Assessor", "v", asr("floor_area_sqft")),
    ("year_built", "Assessor", "v", asr("year_built")),
    ("stories", "CoStar", "v", cs("stories")),
    ("construction_material", "CoStar", "v", cs("construction_material")),
    ("units", "CoStar", "v", cs("units")),
    ("is_walkup", "CoStar", "b", cs("is_walkup")),
    ("elevators", "CoStar", "v", cs("elevators")),
    ("is_senior", "CoStar", "b", lambda s: (costar.get(cid.get(s["id"])) or {}).get("is_senior") if cid.get(s["id"]) else None),
    ("manager_phone", "CoStar", "v", lambda s: ((costar.get(cid.get(s["id"])) or {}).get("manager") or {}).get("phone") if cid.get(s["id"]) else None),
    ("staircases > 0", "Matterport", "b", lambda s: ((costar[cid[s["id"]]].get("mp_staircases") or 0) > 0) if cid.get(s["id"]) else None),
    ("windows > 0", "Matterport", "b", lambda s: ((costar[cid[s["id"]]].get("mp_windows") or 0) > 0) if cid.get(s["id"]) else None),
]


def pct(n):
    return f"{100 * n / N:.1f}%" if n * 1000 >= N else (f"{100 * n / N:.2f}%" if n else "0%")


print(f"Denominator: {N:,} buildings (all Vexcel outlines in the area). Assessor matched {len(assessor):,}.\n")
print("| Field | Source | Has a value | Yes | No | Unknown |")
print("|---|---|---|---|---|---|")
for field, src, kind, get in ROWS:
    vals = [get(s) for s in structs]
    has = sum(v not in (None, "", "NULL") for v in vals)
    if kind == "b":
        yes = sum(v is True for v in vals)
        no = sum(v is False for v in vals)
        print(f"| {field} | {src} | {pct(yes + no)} | {pct(yes)} | {pct(no)} | {pct(N - yes - no)} |")
    else:
        print(f"| {field} | {src} | {pct(has)} | | | {pct(N - has)} |")
