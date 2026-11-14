"""Step 2: enrich CoStar buildings with Matterport (egress) and Vexcel (elevation, roof, footprint).

Every API response is cached under data/cache/ (gitignored), so a re-run only calls the API for new ids.

Run: python3 data/pipeline/enrich.py matterport la
     python3 data/pipeline/enrich.py vexcel la
     python3 data/pipeline/enrich.py footprints la
"""
from __future__ import annotations

import collections
import json
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "probe"))
from matterport import gql  # noqa: E402
from vexcel import property_at  # noqa: E402

DATA = Path(__file__).resolve().parents[1]
CACHE = DATA / "cache"
lock = threading.Lock()
done = [0]


def tick(total, label):
    with lock:
        done[0] += 1
        if done[0] % 100 == 0 or done[0] == total:
            print(f"  {label}: {done[0]}/{total}", flush=True)


# ---------------------------------------------------------------- Matterport
MP_FIELDS = """id name geolocation { lat long }
  floors { label rooms { classifications { label } } edges { openings { type } } }"""


def mp_summary(model: dict | None) -> dict:
    if not model:
        return {"ok": False}
    rooms = collections.Counter()
    openings = collections.Counter()
    floors = model.get("floors") or []
    for f in floors:
        for r in f.get("rooms") or []:
            for c in r.get("classifications") or []:
                rooms[c["label"]] += 1
        for e in f.get("edges") or []:
            for o in e.get("openings") or []:
                openings[o["type"]] += 1
    return {"ok": True, "name": model.get("name"), "floors": len(floors),
            "staircases": rooms.get("Staircase", 0), "windows": openings.get("window", 0),
            "doorways": openings.get("doorway", 0), "rooms": dict(rooms)}


def mp_batch(ids: list[str]) -> None:
    q = "{ " + " ".join(f'm{i}: model(id:"{mid}") {{ {MP_FIELDS} }}' for i, mid in enumerate(ids)) + " }"
    d = gql(q)
    data = d.get("data") or {}
    for i, mid in enumerate(ids):
        (CACHE / "matterport" / f"{mid}.json").write_text(json.dumps(mp_summary(data.get(f"m{i}"))))


def run_matterport(city: str) -> None:
    (CACHE / "matterport").mkdir(parents=True, exist_ok=True)
    rows = json.loads((DATA / "processed" / f"costar_{city}.json").read_text())
    ids = sorted({m for r in rows for m in r["matterport_ids"]})
    todo = [m for m in ids if not (CACHE / "matterport" / f"{m}.json").exists()]
    print(f"matterport {city}: {len(ids)} scans, {len(todo)} to fetch")
    batches = [todo[i:i + 20] for i in range(0, len(todo), 20)]

    def work(b):
        try:
            mp_batch(b)
        except Exception as e:  # keep going; failed ids are retried on the next run
            print("  batch failed:", e, flush=True)
        tick(len(batches), "batches")

    with ThreadPoolExecutor(4) as ex:
        list(ex.map(work, batches))


# ---------------------------------------------------------------- Vexcel
VX_KEEP = ["footprint.area", "ground-elevation.value", "building-type.class", "primary-structure",
           "roof-characteristics.material.class", "roof-characteristics.shape.value",
           "roof-characteristics.condition", "roof-defects.structural-damage.detected",
           "defensible-space.zone1-tree", "defensible-space.zone2-tree", "footprint-wkt", "footprint.wkt"]


def vx_one(b: dict) -> None:
    path = CACHE / "vexcel" / f"{b['id']}.json"
    status, d = property_at(b["lat"], b["lng"], "precomputed")
    out = {"status": status}
    if status == 200 and isinstance(d, dict) and d.get("features"):
        f = d["features"][0]
        a = f["properties"]
        out.update({
            "inside_parcel": a.get("request-information.inside-parcel"),
            "collection": a.get("metadata.collection"),
            "parcel_geometry": f.get("geometry"),
            "structures": [{k: s.get(k) for k in VX_KEEP if k in s} for s in a.get("structures") or []],
        })
    elif status != 404:
        out["error"] = str(d)[:300]
        if status in (401, 429) or status >= 500:
            return  # do not cache transient or auth failures
    path.write_text(json.dumps(out))


def run_vexcel(city: str) -> None:
    (CACHE / "vexcel").mkdir(parents=True, exist_ok=True)
    rows = json.loads((DATA / "processed" / f"costar_{city}.json").read_text())
    todo = [r for r in rows if r["lat"] and not (CACHE / "vexcel" / f"{r['id']}.json").exists()]
    print(f"vexcel {city}: {len(rows)} buildings, {len(todo)} to fetch")

    def work(b):
        try:
            vx_one(b)
        except Exception as e:
            print("  failed", b["id"], e, flush=True)
        tick(len(todo), "buildings")

    with ThreadPoolExecutor(4) as ex:
        list(ex.map(work, todo))


def fp_one(b: dict) -> None:
    status, d = property_at(b["lat"], b["lng"], "footprint-wkt")
    if status in (401, 429) or status >= 500:
        return
    wkts = []
    if status == 200 and isinstance(d, dict) and d.get("features"):
        wkts = [s.get("footprint.wkt") for s in d["features"][0]["properties"].get("structures") or []]
    (CACHE / "vexcel_fp" / f"{b['id']}.json").write_text(json.dumps({"status": status, "wkts": [w for w in wkts if w]}))


def run_footprints(city: str) -> None:
    """Building outlines (WKT) for every structure on the building's parcel."""
    (CACHE / "vexcel_fp").mkdir(parents=True, exist_ok=True)
    rows = json.loads((DATA / "processed" / f"costar_{city}.json").read_text())
    todo = [r for r in rows if r["lat"] and not (CACHE / "vexcel_fp" / f"{r['id']}.json").exists()]
    print(f"footprints {city}: {len(rows)} buildings, {len(todo)} to fetch")

    def work(b):
        try:
            fp_one(b)
        except Exception as e:
            print("  failed", b["id"], e, flush=True)
        tick(len(todo), "buildings")

    with ThreadPoolExecutor(4) as ex:
        list(ex.map(work, todo))


if __name__ == "__main__":
    source, city = sys.argv[1], sys.argv[2]
    {"matterport": run_matterport, "vexcel": run_vexcel, "footprints": run_footprints}[source](city)
