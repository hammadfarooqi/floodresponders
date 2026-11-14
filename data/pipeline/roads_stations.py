"""Issue #46: road graph and fire stations for truck routing (public data: OpenStreetMap).

- Roads: drivable OSM streets in the demo area, as an undirected graph (trucks ignore one-way rules and traffic).
- Each edge gets `fire_min`: the first minute the fire reaches either end (the road is closed from then on), or null.
- Stations: LAFD fire stations from OSM (amenity=fire_station), each snapped to its nearest road node.
- Buildings: every DemoBuilding snapped to its nearest road node (for routing a truck to a building).

Writes data/demo/roads.json (RoadGraph + extras) and data/demo/stations.json (Station + node).
Needs network access with modern SSL: run with python3.12.   python3.12 data/pipeline/roads_stations.py
"""
from __future__ import annotations

import heapq
import json
import math
import os
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

DATA = Path(__file__).resolve().parents[1]
DEMO, CACHE = DATA / "demo", DATA / "cache"
BBOX = (34.070, -118.420, 34.150, -118.260)  # south, west, north, east: fire area + margin for stations
DRIVABLE = ("motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|"
            "tertiary_link|residential|unclassified|living_street|service")
KX = 111_320 * math.cos(math.radians(34.1))
KY = 110_540


def overpass(query: str, cache_name: str) -> dict:
    path = CACHE / cache_name
    if path.exists():
        return json.loads(path.read_text())
    req = urllib.request.Request("https://overpass-api.de/api/interpreter",
                                 data=urllib.parse.urlencode({"data": query}).encode(),
                                 headers={"User-Agent": "rollcall-hackathon/0.1"})
    with urllib.request.urlopen(req, timeout=180) as r:
        d = json.load(r)
    CACHE.mkdir(exist_ok=True)
    path.write_text(json.dumps(d))
    return d


def meters(a, b):
    return math.hypot((a[0] - b[0]) * KX, (a[1] - b[1]) * KY)


def write_atomic(path: Path, obj):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, separators=(",", ":")))
    os.replace(tmp, path)


class Grid:
    """Nearest-node lookup on a coarse grid."""
    def __init__(self, pts, cell=0.002):
        self.pts, self.cell, self.g = pts, cell, defaultdict(list)
        for i, (x, y) in enumerate(pts):
            self.g[(int(x / cell), int(y / cell))].append(i)

    def nearest(self, x, y):
        cx, cy = int(x / self.cell), int(y / self.cell)
        best, bi = float("inf"), None
        for r in range(0, 6):
            for a in range(cx - r, cx + r + 1):
                for b in range(cy - r, cy + r + 1):
                    if max(abs(a - cx), abs(b - cy)) != r:
                        continue
                    for i in self.g.get((a, b), ()):
                        d = meters((x, y), self.pts[i])
                        if d < best:
                            best, bi = d, i
            if bi is not None and best < r * self.cell * KY:
                break
        return bi, best


def main():
    s, w, n, e = BBOX
    roads = overpass(f'[out:json][timeout:120];way["highway"~"^({DRIVABLE})$"]["access"!~"^(private|no)$"]'
                     f'({s},{w},{n},{e});out body;>;out skel qt;', "osm_roads_hollywood.json")
    st = overpass(f'[out:json][timeout:60];nwr["amenity"="fire_station"]({s},{w},{n},{e});out center tags;',
                  "osm_fire_stations_hollywood.json")

    # --- graph: keep only nodes used by drivable ways; undirected edges between consecutive nodes
    osm_nodes = {el["id"]: (el["lon"], el["lat"]) for el in roads["elements"] if el["type"] == "node"}
    idx, nodes, edges, seen = {}, [], [], set()
    for el in roads["elements"]:
        if el["type"] != "way":
            continue
        ids = [i for i in el["nodes"] if i in osm_nodes]
        for a, b in zip(ids, ids[1:]):
            for nid in (a, b):
                if nid not in idx:
                    idx[nid] = len(nodes)
                    nodes.append([round(osm_nodes[nid][0], 6), round(osm_nodes[nid][1], 6)])
            ia, ib = idx[a], idx[b]
            key = (min(ia, ib), max(ia, ib))
            if ia != ib and key not in seen:
                seen.add(key)
                edges.append([ia, ib, round(meters(nodes[ia], nodes[ib]), 1)])

    # keep the largest connected component (drop isolated driveways and fragments at the box edge)
    adj = defaultdict(list)
    for a, b, m in edges:
        adj[a].append(b)
        adj[b].append(a)
    comp, best = {}, None
    for start in range(len(nodes)):
        if start in comp or start not in adj:
            continue
        stack, members = [start], []
        comp[start] = start
        while stack:
            u = stack.pop()
            members.append(u)
            for v in adj[u]:
                if v not in comp:
                    comp[v] = start
                    stack.append(v)
        if best is None or len(members) > len(best):
            best = members
    keep = set(best)
    remap = {old: i for i, old in enumerate(sorted(keep))}
    nodes = [nodes[old] for old in sorted(keep)]
    edges = [[remap[a], remap[b], m] for a, b, m in edges if a in keep and b in keep]
    print(f"roads: {len(nodes):,} nodes, {len(edges):,} edges, {sum(m for _, _, m in edges) / 1000:,.0f} km of street")

    # --- fire closure per edge, from the fire arrival grid
    ft = json.loads((DEMO / "fire_timeline.json").read_text())
    g = ft["grid"]
    gx0, gy0, gx1, gy1 = g["bbox"]
    dx, dy = (gx1 - gx0) / g["nx"], (gy1 - gy0) / g["ny"]
    rows = g["arrival_min_rows"]

    def fire_at(p):
        i, j = int((p[0] - gx0) / dx), int((p[1] - gy0) / dy)
        if 0 <= i < g["nx"] and 0 <= j < g["ny"]:
            return rows[j][i]
        return None

    node_fire = [fire_at(p) for p in nodes]
    closed = 0
    for ed in edges:
        fa, fb = node_fire[ed[0]], node_fire[ed[1]]
        f = min(x for x in (fa, fb) if x is not None) if (fa is not None or fb is not None) else None
        ed.append(f)
        closed += f is not None
    print(f"edges closed by the fire within {ft['duration_min']} min: {closed:,}")

    grid = Grid(nodes)

    # --- stations
    stations = []
    for el in st["elements"]:
        t = el.get("tags", {})
        lon = el.get("lon") or (el.get("center") or {}).get("lon")
        lat = el.get("lat") or (el.get("center") or {}).get("lat")
        if lon is None:
            continue
        name = t.get("name") or t.get("official_name") or "Fire station"
        op = (t.get("operator") or "") + " " + name
        if "Los Angeles County" in op or "County" in t.get("operator", ""):
            agency = "LACoFD"
        elif "Los Angeles Fire" in op or "LAFD" in op or "Los Angeles City" in op:
            agency = "LAFD"
        else:
            agency = t.get("operator") or "unknown"
        node, d = grid.nearest(lon, lat)
        stations.append({"id": f"st_{el['type'][0]}{el['id']}", "name": name, "agency": agency,
                         "ref": t.get("ref"), "lat": round(lat, 6), "lng": round(lon, 6), "node": node,
                         "snap_m": round(d)})
    # Demo trucks start at LAFD engine stations only (Hollywood is LAFD). Drop helispots; one entry per station
    # number (OSM has e.g. Station 82 twice: the old building and the current one; the newer OSM element wins).
    import re
    lafd = {}
    for x in stations:
        m = re.search(r"(?:Station|No\.)\s*#?\s*(\d+)", x["name"])
        if x["agency"] != "LAFD" or "helispot" in x["name"].lower() or not m:
            continue
        num = int(m.group(1))
        x["number"] = num
        x["name"] = f"LAFD Station {num}"
        osm_id = int(re.sub(r"\D", "", x["id"]))
        if num not in lafd or osm_id > int(re.sub(r"\D", "", lafd[num]["id"])):
            lafd[num] = x
    # Trucks come from the city below the hills: the fire starts in the hills and runs south, so stations in
    # the hills (Mulholland) or north of them (the Valley) are not used. Rule: south of the Hollywood Hills.
    HILLS_SOUTH_EDGE_LAT = 34.115
    for x in lafd.values():
        x["excluded"] = "north of or in the Hollywood Hills" if x["lat"] > HILLS_SOUTH_EDGE_LAT else None
    others = [x for x in stations if x not in lafd.values()] + [x for x in lafd.values() if x["excluded"]]
    stations = sorted((x for x in lafd.values() if not x["excluded"]), key=lambda x: x["number"])
    print(f"LAFD stations used: {len(stations)}; other entries kept for reference: {len(others)}")
    for x in stations:
        print(f"   {x['name']:<18} {x['lat']:.4f}, {x['lng']:.4f}  snap {x['snap_m']} m")

    # --- buildings -> nearest road node
    blds = json.loads((DEMO / "buildings.json").read_text())["buildings"]
    bnode, far = {}, 0
    for b in blds:
        node, d = grid.nearest(b["lng"], b["lat"])
        bnode[b["id"]] = node
        far += d > 150
    print(f"buildings snapped: {len(bnode):,} ({far} more than 150 m from a road)")

    # --- sanity: route from every station to the 5 buildings with the most people in the fire's path
    adjw = defaultdict(list)
    for a, b, m, f in edges:
        adjw[a].append((b, m))
        adjw[b].append((a, m))

    def dijkstra(src):
        dist = {src: 0.0}
        pq = [(0.0, src)]
        while pq:
            d, u = heapq.heappop(pq)
            if d > dist.get(u, float("inf")):
                continue
            for v, m in adjw[u]:
                if d + m < dist.get(v, float("inf")):
                    dist[v] = d + m
                    heapq.heappush(pq, (d + m, v))
        return dist

    targets = sorted((b for b in blds if b["fire_arrival_min"] is not None), key=lambda b: -b["people_need_help_est"])[:5]
    for x in stations[:3]:
        dist = dijkstra(x["node"])
        for b in targets[:2]:
            road = dist.get(bnode[b["id"]])
            straight = meters((x["lng"], x["lat"]), (b["lng"], b["lat"]))
            print(f"   route {x['name'][:28]:<28} -> {b['id']}: road {road / 1000 if road else float('nan'):.2f} km "
                  f"vs straight {straight / 1000:.2f} km")

    write_atomic(DEMO / "roads.json", {"nodes": nodes, "edges": edges, "edge_fields": ["from", "to", "meters", "fire_min"],
                                       "building_node": bnode, "source": "OpenStreetMap contributors (ODbL)"})
    write_atomic(DEMO / "stations.json", {"stations": stations, "other_agencies_and_helispots": others,
                                          "source": "OpenStreetMap contributors (ODbL)"})
    print("size roads.json:", (DEMO / "roads.json").stat().st_size // 1024, "KB")


if __name__ == "__main__":
    main()
