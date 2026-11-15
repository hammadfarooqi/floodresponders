"""Join Rasul's static risk score (Supabase table `buildings`) to the demo buildings (data/demo/buildings.json).

The two tables have different ids (DATABASE.md problem 19), but both come from the same Vexcel footprints, so a
building is matched to the nearest Supabase building centroid within MAX_M meters. The browser never calls Supabase:
the result goes to data/demo/risk_join.json (gitignored, like all of data/demo/).

    python3 data/pipeline/join_risk.py            # needs SUPABASE_URL and SUPABASE_SECRET_KEY in the root .env

Output: {"stats": {...}, "buildings": {<demo id>: {"risk_score", "people_at_risk", "structure_factor", "source",
"d_m", "fire_hazard_zone"}}}. risk_score and people_at_risk are null where Supabase has no people count
(DATABASE.md problem 30); the simulation then keeps its own estimate.
Standard library only.
"""
import json
import math
import os
import sys
import urllib.request
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEMO = ROOT / "data" / "demo"
MAX_M = 10.0          # a match must be this close (centroid to centroid)
CELL = 0.0002         # grid cell for the nearest search, degrees (~20 m)
COLUMNS = "id,lat,lng,costar_id,units_source,risk_score,people_at_risk,structure_factor,fire_hazard_zone"


def env(name):
    if os.environ.get(name):
        return os.environ[name]
    for line in (ROOT / ".env").read_text().splitlines():
        if line.startswith(name + "="):
            return line.split("=", 1)[1].strip().strip('"')
    sys.exit(f"{name} is not set (root .env)")


def fetch_all(url, key):
    rows, page = [], 1000
    while True:
        req = urllib.request.Request(f"{url}/rest/v1/buildings?select={COLUMNS}&order=id&limit={page}&offset={len(rows)}",
                                     headers={"apikey": key, "Authorization": f"Bearer {key}"})
        with urllib.request.urlopen(req, timeout=60) as r:
            batch = json.load(r)
        rows += batch
        print(f"\r  {len(rows):,} rows", end="", file=sys.stderr)
        if len(batch) < page:
            print(file=sys.stderr)
            return rows


def meters(lat1, lng1, lat2, lng2):
    return math.hypot((lng2 - lng1) * 111_320 * math.cos(math.radians(lat1)), (lat2 - lat1) * 110_540)


def source(row):
    """Where the people count behind the score comes from (for the /console queue)."""
    s = row.get("units_source")
    return {"costar": "CoStar", "assessor": "Assessor"}.get(s, "estimate" if s else "estimate")


def main():
    url, key = env("SUPABASE_URL"), env("SUPABASE_SECRET_KEY")
    rows = fetch_all(url, key)
    grid = defaultdict(list)
    for r in rows:
        if r["lat"] is not None and r["lng"] is not None:
            grid[(int(r["lat"] / CELL), int(r["lng"] / CELL))].append(r)
    demo = json.loads((DEMO / "buildings.json").read_text())["buildings"]
    out, dists, n_sim, n_sim_hit, n_score = {}, [], 0, 0, 0
    for b in demo:
        gi, gj = int(b["lat"] / CELL), int(b["lng"] / CELL)
        best, bd = None, MAX_M
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for r in grid.get((gi + di, gj + dj), ()):
                    d = meters(b["lat"], b["lng"], r["lat"], r["lng"])
                    if d < bd:
                        best, bd = r, d
        in_sim = b.get("fire_arrival_min") is not None and (b.get("people_est") or 0) > 0
        n_sim += in_sim
        if not best:
            continue
        n_sim_hit += in_sim
        n_score += in_sim and best["risk_score"] is not None
        dists.append(bd)
        out[b["id"]] = {"risk_score": best["risk_score"], "people_at_risk": best["people_at_risk"],
                        "structure_factor": best["structure_factor"], "source": source(best),
                        "fire_hazard_zone": best["fire_hazard_zone"], "d_m": round(bd, 1), "sb_id": best["id"]}
    dists.sort()
    stats = {"supabase_rows": len(rows), "demo_buildings": len(demo), "matched": len(out),
             "sim_buildings": n_sim, "sim_matched": n_sim_hit, "sim_with_score": n_score,
             "median_d_m": round(dists[len(dists) // 2], 2) if dists else None,
             "p95_d_m": round(dists[int(len(dists) * 0.95)], 2) if dists else None}
    (DEMO / "risk_join.json").write_text(json.dumps({"stats": stats, "buildings": out}))
    print(json.dumps(stats, indent=1))


if __name__ == "__main__":
    main()
