"""Trace the Sunset Fire (8 Jan 2025) LAFD evacuation areas as polygons along real streets (OpenStreetMap).

LAFD boundaries (KTLA, KCRA, 8-9 Jan 2025):
  Mandatory order: Laurel Canyon Blvd (W), Mulholland Dr (N), US-101 (E), Hollywood Blvd (S).
  Warning: north of Sunset Blvd, east of Coldwater Canyon Dr. LAFD gave no east or north edge; we close it at
  US-101 and Mulholland Dr, the same edges as the order (assumption, marked in the output).

Each edge is the shortest path along that road's OSM ways between its two corner points, so curvy roads such as
Mulholland Dr are followed exactly. Writes data/boundaries/sunset_fire_2025_evacuation.geojson.

Run: python3 data/pipeline/evac_zones.py
"""
from __future__ import annotations

import heapq
import json
import math
import re
import urllib.parse
import urllib.request
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "boundaries" / "sunset_fire_2025_evacuation.geojson"
BBOX = (34.070, -118.425, 34.145, -118.315)  # south, west, north, east
ROADS = {  # name -> OSM filter
    "hollywood": '["name"~"Hollywood Boulevard$"]',
    "sunset": '["name"~"Sunset Boulevard$"]',  # OSM has both "Sunset Boulevard" and "West Sunset Boulevard"
    "laurel": '["name"~"Laurel Canyon Boulevard$"]',
    "coldwater": '["name"~"Coldwater Canyon (Drive|Avenue)$"]',
    "mulholland": '["name"~"Mulholland Drive$"]',
    "us101": '["highway"="motorway"]["ref"~"US 101"]',
}


def overpass() -> dict:
    s, w, n, e = BBOX
    q = "[out:json][timeout:60];(" + "".join(
        f'way["highway"]{flt}({s},{w},{n},{e});' if "highway" not in flt else f"way{flt}({s},{w},{n},{e});"
        for flt in ROADS.values()) + ");out body;>;out skel qt;"
    req = urllib.request.Request("https://overpass-api.de/api/interpreter",
                                 data=urllib.parse.urlencode({"data": q}).encode(),
                                 headers={"User-Agent": "rollcall-hackathon/0.1"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def m(a, b):  # meters between (lat, lon) points
    kx = 111_320 * math.cos(math.radians(a[0]))
    return math.hypot((a[1] - b[1]) * kx, (a[0] - b[0]) * 110_540)


def build_graphs(osm):
    nodes = {el["id"]: (el["lat"], el["lon"]) for el in osm["elements"] if el["type"] == "node"}
    graphs = {k: {} for k in ROADS}
    for el in osm["elements"]:
        if el["type"] != "way":
            continue
        t = el.get("tags", {})
        for key, flt in ROADS.items():
            ok = ("US 101" in t.get("ref", "") and t.get("highway") == "motorway") if key == "us101" \
                else re.search(flt.split('"')[3], t.get("name", "")) is not None
            if not ok:
                continue
            g = graphs[key]
            for a, b in zip(el["nodes"], el["nodes"][1:]):
                if a in nodes and b in nodes:
                    d = m(nodes[a], nodes[b])
                    g.setdefault(a, []).append((b, d))
                    g.setdefault(b, []).append((a, d))  # treat as two-way for tracing
    # OSM splits divided roads and ramps into separate ways; join same-road nodes that are under 25 m apart
    for g in graphs.values():
        ids = list(g)
        for i, a in enumerate(ids):
            for b in ids[i + 1:]:
                d = m(nodes[a], nodes[b])
                if d < 25:
                    g[a].append((b, d))
                    g[b].append((a, d))
    return nodes, graphs


def closest_pair(nodes, g1, g2):
    best = (float("inf"), None, None)
    n2 = list(g2)
    for a in g1:
        for b in n2:
            d = m(nodes[a], nodes[b])
            if d < best[0]:
                best = (d, a, b)
    return best


def path(nodes, g, src, dst):
    dist, prev, pq = {src: 0.0}, {}, [(0.0, src)]
    while pq:
        d, u = heapq.heappop(pq)
        if u == dst:
            break
        if d > dist.get(u, float("inf")):
            continue
        for v, w in g.get(u, []):
            if d + w < dist.get(v, float("inf")):
                dist[v], prev[v] = d + w, u
                heapq.heappush(pq, (d + w, v))
    if dst not in dist:
        raise RuntimeError("roads are not connected between the corners")
    out = [dst]
    while out[-1] != src:
        out.append(prev[out[-1]])
    return [nodes[n] for n in reversed(out)]


def ring(nodes, graphs, edges):
    """edges: road keys in order around the polygon; corner i joins edges[i-1] and edges[i]."""
    corners = []
    for i, key in enumerate(edges):
        prev_key = edges[i - 1]
        gap, a, b = closest_pair(nodes, graphs[prev_key], graphs[key])
        print(f"   corner {prev_key} x {key}: gap {gap:.0f} m")
        corners.append((a, b))  # a on prev road, b on this road
    pts = []
    for i, key in enumerate(edges):
        start = corners[i][1]
        end = corners[(i + 1) % len(edges)][0]
        pts += path(nodes, graphs[key], start, end)
    pts.append(pts[0])
    return [[round(lon, 6), round(lat, 6)] for lat, lon in pts]


def main():
    osm = overpass()
    nodes, graphs = build_graphs(osm)
    print("road nodes:", {k: len(g) for k, g in graphs.items()})
    feats = []
    for name, edges, note in [
        ("Mandatory evacuation order", ["hollywood", "us101", "mulholland", "laurel"],
         "LAFD: Laurel Canyon Blvd to US-101, Mulholland Dr to Hollywood Blvd"),
        ("Evacuation warning", ["sunset", "us101", "mulholland", "coldwater"],
         "LAFD: north of Sunset Blvd, east of Coldwater Canyon Dr. East (US-101) and north (Mulholland) edges assumed"),
    ]:
        print(name)
        feats.append({"type": "Feature", "properties": {"name": name, "fire": "Sunset Fire", "date": "2025-01-08",
                                                         "note": note},
                      "geometry": {"type": "Polygon", "coordinates": [ring(nodes, graphs, edges)]}})
    OUT.write_text(json.dumps({"type": "FeatureCollection", "features": feats}))
    print("->", OUT)


if __name__ == "__main__":
    main()
