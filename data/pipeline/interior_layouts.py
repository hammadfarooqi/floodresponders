"""Interior layouts: the floor plan of each Matterport scan, for the "See interior layout" panel in explore/.

For every CoStar property in Supabase that has Matterport scans, this reads rooms, walls, doors, windows and the
walking positions of each scan from the Matterport API. It writes two files to data/demo/ (gitignored: sponsor data,
never commit them):

  interiors_index.json   small: which property has which usable scans. The console loads it at the start.
  interiors.json         the layouts of the usable scans. Loaded when a layout is opened.

A scan is "usable" when Matterport labels at least one room "Bedroom" and a walking position in that room is linked
to another position. The route itself is computed in the browser (explore/lib/interior/route.ts).

Needs in the root .env: MATTERPORT_API_KEY, MATTERPORT_API_TOKEN, SUPABASE_URL, SUPABASE_SECRET_KEY.
Each API answer is cached in data/cache/matterport_layout/, so a second run only fetches new scans.

Run: python3 data/pipeline/interior_layouts.py
"""
from __future__ import annotations

import json
import math
import os
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "probe"))

DATA = Path(__file__).resolve().parents[1]
CACHE = DATA / "cache" / "matterport_layout"
DEMO = DATA / "demo"
BATCH = 10  # scans for each API call

# Geometry is in meters. A position and a wall corner use the same x, y frame (checked on real scans).
FIELDS = """name
  floors { id label sequence
    vertices { id position { x y } }
    edges { id type vertices { id } openings { type label width relativeCenter } }
    rooms { id classifications { label confidence } boundary { edges { id } } } }
  locations { id position { x y } neighbors room { id } floor { id } }"""


def _r(value: float) -> float:
    return round(value, 3)


def _outline(edge_ids: list[str], ends: dict[str, tuple[str, str]], at: dict[str, list[float]]) -> list[list[float]]:
    """Chain the boundary walls of a room into one closed outline. Returns [] when they do not form one loop."""
    walls = [ends[e] for e in edge_ids if e in ends]
    if len(walls) < 3:
        return []
    by_corner: dict[str, list[int]] = {}
    for i, (a, b) in enumerate(walls):
        by_corner.setdefault(a, []).append(i)
        by_corner.setdefault(b, []).append(i)
    start, corner = walls[0]
    loop, used = [start], {0}
    while corner != start:
        loop.append(corner)
        nxt = [i for i in by_corner[corner] if i not in used]
        if not nxt:
            return []
        used.add(nxt[0])
        a, b = walls[nxt[0]]
        corner = b if a == corner else a
    if len(used) != len(walls):
        return []
    return [at[c] for c in loop]


def _mean(points: list[list[float]]) -> list[float] | None:
    if not points:
        return None
    return [_r(sum(p[0] for p in points) / len(points)), _r(sum(p[1] for p in points) / len(points))]


def layout_from_model(scan_id: str, model: dict) -> dict:
    """Turn one Matterport model (the FIELDS above) into the layout the web app draws."""
    floors, room_index, floor_index, corners = [], {}, {}, {}
    for fi, f in enumerate(sorted(model.get("floors") or [], key=lambda x: x.get("sequence") or 0)):
        floor_index[f["id"]] = fi
        at = {v["id"]: [_r(v["position"]["x"]), _r(v["position"]["y"])] for v in f.get("vertices") or []}
        ends = {}
        for e in f.get("edges") or []:
            ids = [v["id"] for v in e.get("vertices") or []]
            if len(ids) == 2 and ids[0] in at and ids[1] in at:
                ends[e["id"]] = (ids[0], ids[1])

        rooms, rooms_of_edge = [], {}
        for room in f.get("rooms") or []:
            labels = [c["label"] for c in room.get("classifications") or []]
            if labels == ["Void"]:      # a shaft or a gap between rooms, not a place a person can be
                continue
            edge_ids = [e["id"] for e in (room.get("boundary") or {}).get("edges") or []]
            polygon = _outline(edge_ids, ends, at)
            for e in edge_ids:
                rooms_of_edge[e] = rooms_of_edge.get(e, 0) + 1
            room_index[room["id"]] = len(rooms)
            corners[(fi, len(rooms))] = [at[v] for e in edge_ids if e in ends for v in ends[e]]
            rooms.append({"labels": labels, "polygon": polygon, "center": None})

        walls, openings = [], []
        for e in f.get("edges") or []:
            if e["id"] not in ends:
                continue
            (x1, y1), (x2, y2) = at[ends[e["id"]][0]], at[ends[e["id"]][1]]
            if e.get("type") == "wall":
                walls.append([x1, y1, x2, y2])
            length = math.hypot(x2 - x1, y2 - y1)
            for o in e.get("openings") or []:
                if o.get("type") not in ("doorway", "window") or not length:
                    continue
                mid, half = o.get("relativeCenter") or 0.5, (o.get("width") or 0) / 2 / length
                lo, hi = max(0.0, mid - half), min(1.0, mid + half)
                openings.append({"type": o["type"], "label": o.get("label"),
                                 "a": [_r(x1 + (x2 - x1) * lo), _r(y1 + (y2 - y1) * lo)],
                                 "b": [_r(x1 + (x2 - x1) * hi), _r(y1 + (y2 - y1) * hi)],
                                 # A wall that belongs to one room only is an outside wall of the scan.
                                 "exterior": rooms_of_edge.get(e["id"], 0) <= 1})
        floors.append({"label": f.get("label") or f"Floor {fi + 1}", "rooms": rooms, "walls": walls, "openings": openings})

    locations = [loc for loc in model.get("locations") or [] if (loc.get("floor") or {}).get("id") in floor_index]
    index = {loc["id"]: i for i, loc in enumerate(locations)}
    positions = [{"x": _r(loc["position"]["x"]), "y": _r(loc["position"]["y"]),
                  "floor": floor_index[loc["floor"]["id"]],
                  "room": room_index.get((loc.get("room") or {}).get("id")),
                  "next": [index[n] for n in loc.get("neighbors") or [] if n in index]} for loc in locations]
    # Where to write the room name. About 1 room in 8 has walls that do not close into an outline (a wall runs on
    # past the room), so the middle of its positions, or of its wall corners, is used for all rooms.
    for (fi, ri), points in corners.items():
        inside = [[p["x"], p["y"]] for p in positions if p["floor"] == fi and p["room"] == ri]
        floors[fi]["rooms"][ri]["center"] = _mean(floors[fi]["rooms"][ri]["polygon"]) or _mean(inside) or _mean(points)
    return {"id": scan_id, "name": model.get("name") or "", "url": f"https://my.matterport.com/show/?m={scan_id}",
            "floors": floors, "positions": positions}


def summary(layout: dict) -> dict:
    """The index entry of one scan: sizes, and if the route to a bedroom can work."""
    rooms = [(fi, ri, r) for fi, f in enumerate(layout["floors"]) for ri, r in enumerate(f["rooms"])]
    linked = {(p["floor"], p["room"]) for p in layout["positions"] if p["next"] and p["room"] is not None}
    bedrooms = sum(1 for fi, ri, r in rooms if "Bedroom" in r["labels"] and (fi, ri) in linked)
    return {"id": layout["id"], "name": layout["name"], "floors": len(layout["floors"]), "rooms": len(rooms),
            "bedrooms": bedrooms, "positions": len(layout["positions"]), "usable": bedrooms > 0}


# ---------------------------------------------------------------- network
def properties_with_scans() -> list[dict]:
    """CoStar properties of the Hollywood area that have at least one scan id (Supabase, table costar_properties)."""
    url = (os.environ["SUPABASE_URL"] + "/rest/v1/costar_properties"
           "?select=costar_id,name,address,matterport_model_ids&matterport_model_ids=neq.%7B%7D&order=costar_id")
    key = os.environ["SUPABASE_SECRET_KEY"]
    req = urllib.request.Request(url, headers={"apikey": key, "Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def fetch(ids: list[str]) -> None:
    from matterport import gql
    query = "{ " + " ".join(f'm{i}: model(id:"{mid}") {{ {FIELDS} }}' for i, mid in enumerate(ids)) + " }"
    data = gql(query).get("data") or {}
    for i, mid in enumerate(ids):
        if data.get(f"m{i}"):       # a failed id has no cache file, so the next run tries it again
            (CACHE / f"{mid}.json").write_text(json.dumps(data[f"m{i}"]))


def write_atomic(path: Path, obj) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, separators=(",", ":")))
    tmp.replace(path)


def main() -> None:
    from _env import load_env
    load_env()
    CACHE.mkdir(parents=True, exist_ok=True)
    DEMO.mkdir(parents=True, exist_ok=True)
    props = properties_with_scans()
    ids = sorted({m for p in props for m in p["matterport_model_ids"]})
    todo = [m for m in ids if not (CACHE / f"{m}.json").exists()]
    print(f"{len(props)} properties, {len(ids)} scans, {len(todo)} to fetch")
    with ThreadPoolExecutor(4) as ex:
        list(ex.map(fetch, [todo[i:i + BATCH] for i in range(0, len(todo), BATCH)]))

    scans, index, missing = {}, {}, 0
    for p in props:
        usable = []
        for mid in p["matterport_model_ids"]:
            path = CACHE / f"{mid}.json"
            if not path.exists():
                missing += 1
                continue
            layout = layout_from_model(mid, json.loads(path.read_text()))
            s = summary(layout)
            if s.pop("usable"):
                scans[mid] = layout
                usable.append(s)
        if usable:
            index[p["costar_id"]] = {"name": p["name"], "address": p["address"], "scans": usable}
    write_atomic(DEMO / "interiors_index.json", {"properties": index})
    write_atomic(DEMO / "interiors.json", {"scans": scans})
    print(f"usable: {len(scans)} scans on {len(index)} properties; {missing} scans had no API answer")
    print(f"wrote {DEMO / 'interiors_index.json'} and {DEMO / 'interiors.json'}"
          f" ({(DEMO / 'interiors.json').stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
