"""Issue #45: fire timeline for the demo. The real Sunset Fire origin with a stronger wind toward Hollywood.

Model (simple on purpose, every number is a labeled assumption):
- Grid of CELL_M cells. Fire spreads from cell to cell (16 directions); the travel time on an edge is
  distance / rate. The arrival time of every cell is the shortest travel time from the origin (Dijkstra).
- Rate = head rate x wind factor(direction) x fuel factor(cell).
  Wind factor: an ellipse with length-to-breadth ratio LB, head of the ellipse pointing downwind.
  Fuel: cells with almost no buildings are brush (hills, parks) and burn fast; built-up cells burn slower
  (building to building), and slower again as they get denser (streets and lawns are gaps).
- The fire can only burn inside the allowed area (Hollywood plan area + Sunset Fire evacuation warning area),
  so it never runs off the area we show.
- The head rate is tuned so that the front reaches the target point (Sunset Blvd, middle of Hollywood) at
  DURATION_MIN, then the fire stops (crews hold the line).
Not modeled: slope, fuel moisture, spotting, suppression before the stop. Say so in the demo.

Writes data/demo/fire_timeline.json (FireTimeline + arrival grid) and fills fire_arrival_min in
data/demo/buildings.json. Run after demo_buildings.py:  python3 data/pipeline/fire_timeline.py
"""
from __future__ import annotations

import heapq
import json
import math
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_map import _in_ring, _rings  # noqa: E402

DATA = Path(__file__).resolve().parents[1]
DEMO, BOUNDS = DATA / "demo", DATA / "boundaries"

# ---- assumptions (shown in the UI) ----
ORIGIN = (-118.3510, 34.1128)        # Runyon Canyon, Sunset Fire start (8 Jan 2025), approximate
TARGET = (-118.3350, 34.0982)        # Sunset Blvd, middle of the Hollywood area: the front stops here
if os.environ.get("FIRE_TARGET"):     # e.g. FIRE_TARGET="-118.3350,34.1016" (Hollywood Blvd): a smaller, slower fire
    TARGET = tuple(float(v) for v in os.environ["FIRE_TARGET"].split(","))
WIND_TO_DEG = None                    # None = blow from the origin toward the target
LB = 1.6                               # ellipse length-to-breadth ratio
URBAN_FACTOR = 0.25                   # built-up cells burn at this share of the brush rate ...
DENSITY_SLOWDOWN = 0.5                # ... and slower as building cover grows
BRUSH_MAX_COVER = 0.05                # cells with < 5% building cover count as brush
DURATION_MIN = 180                    # simulated fire length
# FIRE_SPEED: after tuning, the spread rate is multiplied by this. 1 = the front reaches TARGET at DURATION_MIN;
# 0.5 = half as fast, so in the same time it reaches less far and later (the fire still stops at DURATION_MIN).
FIRE_SPEED = float(os.environ.get("FIRE_SPEED", "1"))
ORDER_LEAD_MIN = 45                   # what-if evacuation order: where the fire would reach 45 min later
WARNING_LEAD_MIN = 120                # what-if evacuation warning: where it would reach 2 h later
ZONE_LB = 3.0                         # evacuation areas are drawn downwind-heavy: projection uses a longer ellipse
STEP_MIN = 3                          # one front polygon per step
CELL_M = 30
BBOX = (-118.405, 34.083, -118.275, 34.140)   # lon/lat working box


def trace_rings(inside, nx, ny, x0, y0, dx, dy, tol_m=25):
    """Outline of a set of grid cells as closed rings [[lng, lat], ...] (cell sides between in and out), simplified."""
    from collections import defaultdict
    nxt = defaultdict(list)
    for i in range(nx):
        for j in range(ny):
            if not inside[i][j]:
                continue
            # counter-clockwise edges with the cell on the left; keep sides whose neighbor is outside
            if j == 0 or not inside[i][j - 1]:
                nxt[(i, j)].append((i + 1, j))
            if i == nx - 1 or not inside[i + 1][j]:
                nxt[(i + 1, j)].append((i + 1, j + 1))
            if j == ny - 1 or not inside[i][j + 1]:
                nxt[(i + 1, j + 1)].append((i, j + 1))
            if i == 0 or not inside[i - 1][j]:
                nxt[(i, j + 1)].append((i, j))
    rings = []
    while nxt:
        start = next(iter(nxt))
        ring, cur = [start], start
        while True:
            outs = nxt[cur]
            nv = outs.pop()
            if not outs:
                del nxt[cur]
            cur = nv
            if cur == start:
                break
            ring.append(cur)
        if len(ring) < 4:
            continue
        pts = [[x0 + a * dx, y0 + b * dy] for a, b in ring] + [[x0 + ring[0][0] * dx, y0 + ring[0][1] * dy]]
        pts = _simplify(pts, tol_m)
        rings.append([[round(x, 6), round(y, 6)] for x, y in pts])
    return [r for r in rings if len(r) >= 4]


def _simplify(ring, tol_m):
    kx = 111_320 * math.cos(math.radians(34.1))
    P = [(x * kx, y * 110_540) for x, y in ring]
    keep = [False] * len(P)
    keep[0] = keep[-1] = True
    st = [(0, len(P) - 1)]
    while st:
        a, b = st.pop()
        (ax, ay), (bx, by) = P[a], P[b]
        ddx, ddy = bx - ax, by - ay
        n2 = ddx * ddx + ddy * ddy
        best, idx = 0.0, -1
        for k in range(a + 1, b):
            px, py = P[k]
            t = max(0, min(1, ((px - ax) * ddx + (py - ay) * ddy) / n2)) if n2 else 0
            d = math.hypot(px - ax - t * ddx, py - ay - t * ddy)
            if d > best:
                best, idx = d, k
        if best > tol_m:
            keep[idx] = True
            st += [(a, idx), (idx, b)]
    return [p for p, k in zip(ring, keep) if k]


def write_atomic(path: Path, obj):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, separators=(",", ":")))
    os.replace(tmp, path)


def main():
    x0, y0, x1, y1 = BBOX
    kx = 111_320 * math.cos(math.radians((y0 + y1) / 2))
    ky = 110_540
    dx, dy = CELL_M / kx, CELL_M / ky
    nx, ny = int((x1 - x0) / dx) + 1, int((y1 - y0) / dy) + 1
    cell = lambda lng, lat: (int((lng - x0) / dx), int((lat - y0) / dy))  # noqa: E731
    center = lambda i, j: (x0 + (i + 0.5) * dx, y0 + (j + 0.5) * dy)      # noqa: E731
    print(f"grid {nx} x {ny} = {nx * ny:,} cells of {CELL_M} m")

    # allowed area
    polys = []
    for f in json.loads((BOUNDS / "la_community_plan_areas.geojson").read_text())["features"]:
        if f["properties"].get("NAME_ALF") == "Hollywood":
            polys += _rings(f["geometry"])
    for f in json.loads((BOUNDS / "sunset_fire_2025_evacuation.geojson").read_text())["features"]:
        polys += _rings(f["geometry"])
    allowed = [[any(_in_ring(*center(i, j), p[0]) for p in polys) for j in range(ny)] for i in range(nx)]

    # building cover per cell (footprint area assigned to the centroid cell)
    cover = [[0.0] * ny for _ in range(nx)]
    buildings = json.loads((DEMO / "buildings.json").read_text())["buildings"]
    for b in buildings:
        ring = b["footprint"]
        area = 0.5 * abs(sum((ring[k][0] * kx) * (ring[k + 1][1] * ky) - (ring[k + 1][0] * kx) * (ring[k][1] * ky)
                             for k in range(len(ring) - 1)))
        i, j = cell(b["lng"], b["lat"])
        if 0 <= i < nx and 0 <= j < ny:
            cover[i][j] += area / (CELL_M * CELL_M)

    # Smooth building cover over a (2R+1)^2-cell window (~150 m): streets and yards between buildings are part
    # of the built-up area, not brush. Without this, the fire runs through the gaps at brush speed.
    R = 2
    raw = cover
    cover = [[0.0] * ny for _ in range(nx)]
    for i in range(nx):
        for j in range(ny):
            tot = n = 0
            for a in range(max(0, i - R), min(nx, i + R + 1)):
                col = raw[a]
                for b in range(max(0, j - R), min(ny, j + R + 1)):
                    tot += col[b]
                    n += 1
            cover[i][j] = tot / n

    def fuel(i, j):
        c = min(cover[i][j], 1.0)
        return 1.0 if c < BRUSH_MAX_COVER else URBAN_FACTOR / (1 + DENSITY_SLOWDOWN * c)

    ox, oy = ORIGIN
    tx, ty = TARGET
    wind = WIND_TO_DEG if WIND_TO_DEG is not None else math.degrees(math.atan2((tx - ox) * kx, (ty - oy) * ky))
    e = math.sqrt(1 - 1 / LB ** 2)

    def wind_factor(bearing_deg):  # rate relative to the head rate, ellipse with the origin at the rear focus
        th = math.radians(bearing_deg - wind)
        return (1 - e) / (1 - e * math.cos(th))

    steps = [(a, b) for a in range(-2, 3) for b in range(-2, 3) if (a, b) != (0, 0) and math.gcd(abs(a), abs(b)) == 1]
    edge = [(a, b, CELL_M * math.hypot(a, b), wind_factor(math.degrees(math.atan2(a, b)))) for a, b in steps]

    def arrival(head_m_per_min, limit_min=DURATION_MIN * 1.6, clip=True, edges=None, seeds=None):
        edges = edges or edge
        INF = float("inf")
        t = [[INF] * ny for _ in range(nx)]
        if seeds is None:
            si, sj = cell(ox, oy)
            seeds = [(0.0, si, sj)]
        pq = []
        for d0, si, sj in seeds:
            t[si][sj] = d0
            pq.append((d0, si, sj))
        heapq.heapify(pq)
        while pq:
            d, i, j = heapq.heappop(pq)
            if d > t[i][j] or d > limit_min:
                continue
            for a, b, dist, wf in edges:
                ni, nj = i + a, j + b
                if not (0 <= ni < nx and 0 <= nj < ny) or (clip and not allowed[ni][nj]):
                    continue
                rate = head_m_per_min * wf * 0.5 * (fuel(i, j) + fuel(ni, nj))
                nd = d + dist / rate
                if nd < t[ni][nj]:
                    t[ni][nj] = nd
                    heapq.heappush(pq, (nd, ni, nj))
        return t

    # tune the head rate so the front reaches TARGET at DURATION_MIN (bisection; arrival ~ 1/rate)
    ti, tj = cell(tx, ty)
    lo, hi = 5.0, 200.0                         # m/min
    for _ in range(14):
        mid = (lo + hi) / 2
        at = arrival(mid)[ti][tj]
        lo, hi = (mid, hi) if at > DURATION_MIN else (lo, mid)
    head = hi * FIRE_SPEED
    t = arrival(head)
    print(f"FIRE_SPEED {FIRE_SPEED}; head rate {head:.1f} m/min ({head * 0.06:.2f} km/h in brush); wind toward {wind:.0f} deg; "
          f"target reached at {t[ti][tj]:.0f} min")

    # fronts: per step, the burned cells as row runs merged into rectangles (MultiPolygon)
    fronts = []
    for k in range(0, DURATION_MIN // STEP_MIN + 1):
        tm = k * STEP_MIN
        rects = []
        for j in range(ny):
            i = 0
            while i < nx:
                if t[i][j] <= tm:
                    s = i
                    while i < nx and t[i][j] <= tm:
                        i += 1
                    xa, xb = round(x0 + s * dx, 6), round(x0 + i * dx, 6)
                    ya, yb = round(y0 + j * dy, 6), round(y0 + (j + 1) * dy, 6)
                    rects.append([[[xa, ya], [xb, ya], [xb, yb], [xa, yb], [xa, ya]]])
                else:
                    i += 1
        fronts.append({"type": "MultiPolygon", "coordinates": rects})

    # arrival per building
    hit = 0
    for b in buildings:
        i, j = cell(b["lng"], b["lat"])
        a = t[i][j] if 0 <= i < nx and 0 <= j < ny else float("inf")
        b["fire_arrival_min"] = round(a, 1) if a <= DURATION_MIN else None
        hit += b["fire_arrival_min"] is not None
    write_atomic(DEMO / "buildings.json", {"buildings": buildings})

    grid = [[(round(t[i][j], 1) if t[i][j] <= DURATION_MIN else None) for i in range(nx)] for j in range(ny)]
    write_atomic(DEMO / "fire_timeline.json", {
        "origin": list(ORIGIN), "target": list(TARGET), "wind_to_deg": round(wind, 1),
        "wind_from_deg": round((wind + 180) % 360, 1), "step_min": STEP_MIN, "duration_min": DURATION_MIN,
        "fronts": fronts,
        "grid": {"bbox": list(BBOX), "nx": nx, "ny": ny, "cell_m": CELL_M, "arrival_min_rows": grid},
        "assumptions": {"head_rate_m_per_min": round(head, 1), "fire_speed": FIRE_SPEED, "length_to_breadth": LB, "urban_factor": URBAN_FACTOR,
                        "density_slowdown": DENSITY_SLOWDOWN, "brush_max_cover": BRUSH_MAX_COVER,
                        "not_modeled": "slope, fuel moisture, spotting, suppression before the stop"}})
    # For the map: burned cells with their arrival time (one source; the page filters by the current time),
    # and the building map file gets the arrival time as property "fa".
    cells = []
    for j in range(ny):
        for i in range(nx):
            if t[i][j] <= DURATION_MIN:
                xa, ya = round(x0 + i * dx, 6), round(y0 + j * dy, 6)
                xb, yb = round(xa + dx, 6), round(ya + dy, 6)
                cells.append({"type": "Feature", "properties": {"t": round(t[i][j], 1)},
                              "geometry": {"type": "Polygon", "coordinates": [[[xa, ya], [xb, ya], [xb, yb], [xa, yb], [xa, ya]]]}})
    write_atomic(DEMO / "fire_cells.geojson", {"type": "FeatureCollection", "features": cells})
    fa = {b["id"]: b["fire_arrival_min"] for b in buildings}
    bm = json.loads((DEMO / "buildings_map.geojson").read_text())
    for f in bm["features"]:
        f["properties"]["fa"] = fa.get(f["properties"]["id"])
    write_atomic(DEMO / "buildings_map.geojson", bm)
    # Small list for the map: buildings the fire reaches, sorted by arrival time [[id, minutes], ...]
    write_atomic(DEMO / "building_arrivals.json",
                 sorted(([b["id"], b["fire_arrival_min"]] for b in buildings if b["fire_arrival_min"] is not None),
                        key=lambda x: x[1]))

    # What-if evacuation areas, shaped by the same wind-driven spread: where the fire WOULD reach if it were not
    # stopped. Order = within ORDER_LEAD_MIN after the end, warning = within WARNING_LEAD_MIN. Not clipped to the
    # allowed area (orders cover what could burn, not what we chose to show burning).
    ez = math.sqrt(1 - 1 / ZONE_LB ** 2)
    zedge = [(a, b, dist, (1 - ez) / (1 - ez * math.cos(math.radians(math.degrees(math.atan2(a, b)) - wind))))
             for a, b, dist, _ in edge]
    # Project forward from the fire's perimeter at the end (every burned cell is a seed at DURATION_MIN), with a
    # downwind-heavy ellipse: the areas contain everything burned plus where the fire would go next.
    seeds = [(t[i][j], i, j) for i in range(nx) for j in range(ny) if t[i][j] <= DURATION_MIN]
    seeds = [(max(d, DURATION_MIN), i, j) for d, i, j in seeds]
    tp = arrival(head, limit_min=DURATION_MIN + WARNING_LEAD_MIN + 5, clip=False, edges=zedge, seeds=seeds)
    zones = []
    for name, lead in (("Evacuation warning (what-if)", WARNING_LEAD_MIN), ("Mandatory evacuation order (what-if)", ORDER_LEAD_MIN)):
        inside = [[tp[i][j] <= DURATION_MIN + lead for j in range(ny)] for i in range(nx)]
        rings = trace_rings(inside, nx, ny, x0, y0, dx, dy)
        zones.append({"type": "Feature", "properties": {"name": name, "lead_min": lead,
                      "note": f"cells the unstopped fire would reach within {lead} min after the {DURATION_MIN}-min mark"},
                      "geometry": {"type": "MultiPolygon", "coordinates": [[r] for r in rings]}})
    write_atomic(DEMO / "evac_whatif.geojson", {"type": "FeatureCollection", "features": zones})
    for z in zones:
        cells_in = sum(1 for i in range(nx) for j in range(ny) if tp[i][j] <= DURATION_MIN + z["properties"]["lead_min"])
        bz = sum(1 for b in buildings if (lambda c: 0 <= c[0] < nx and 0 <= c[1] < ny and tp[c[0]][c[1]] <= DURATION_MIN + z["properties"]["lead_min"])(cell(b["lng"], b["lat"])))
        print(f"{z['properties']['name']}: {cells_in * CELL_M * CELL_M / 4047:,.0f} acres, {bz:,} buildings")

    people = sum(b["people_est"] for b in buildings if b["fire_arrival_min"] is not None)
    need = sum(b["people_need_help_est"] for b in buildings if b["fire_arrival_min"] is not None)
    cs = [b for b in buildings if b["fire_arrival_min"] is not None and b["costar"]]
    print(f"burned area at {DURATION_MIN} min: {sum(1 for r in grid for v in r if v is not None) * CELL_M * CELL_M / 4047:,.0f} acres")
    print(f"buildings reached: {hit:,} (CoStar {len(cs)}), people in them {people:,}, needing help {need:,}")
    print("size fire_timeline.json:", (DEMO / "fire_timeline.json").stat().st_size // 1024, "KB")


if __name__ == "__main__":
    main()
