"""Vexcel API 2.0 probe (stdlib only). See the hackathon quickstart for the full flow.

Usage:
  python3 data/probe/vexcel.py property LAT LON [include] [out.json]
      include defaults to "precomputed"; use "precomputed,calculated" for roof height/elevation (slow)
  python3 data/probe/vexcel.py area LAT LON BUFFER_M [include]   # every parcel near a point
  python3 data/probe/vexcel.py get PATH key=value ...              # any GET endpoint
"""
from __future__ import annotations

import json
import os
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from _env import load_env

API = "https://api.vexcelgroup.com/v2"
LAYERS = "urban,urban-r,wide-area,urban-g"


def send(method: str, path: str, params: dict | None = None, body: dict | None = None):
    """Return (status, parsed JSON or raw bytes). Retries 429 with backoff."""
    load_env()
    url = f"{API}/{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    data = json.dumps(body).encode() if body is not None else None
    headers = {"X-API-KEY": os.environ["VEXCEL_API_KEY"]}
    if data:
        headers["Content-Type"] = "application/json"
    for attempt in range(6):
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                raw = r.read()
                status = r.status
        except urllib.error.HTTPError as e:
            raw, status = e.read(), e.code
        if status != 429 or attempt == 5:
            break
        time.sleep(min(2 ** attempt, 30) + random.random())
    try:
        return status, json.loads(raw)
    except ValueError:
        return status, raw


def property_at(lat: float, lon: float, include: str = "precomputed", buffer_m: float | None = None):
    params = {"wkt": f"POINT({lon} {lat})", "srid": 4326, "layer": LAYERS, "latest": "true",
              "include": include, "unit-system": "metric"}
    if buffer_m:
        params["buffer-meter"] = buffer_m
    return send("GET", "property/extract", params=params)


if __name__ == "__main__":
    cmd, *rest = sys.argv[1:]
    if cmd == "property":
        lat, lon = float(rest[0]), float(rest[1])
        include = rest[2] if len(rest) > 2 else "precomputed"
        status, d = property_at(lat, lon, include)
        print("HTTP", status)
        out = rest[3] if len(rest) > 3 else None
        if out:
            with open(out, "w") as f:
                json.dump(d, f, indent=1)
            print("saved", out)
        else:
            print(json.dumps(d, indent=1)[:6000])
    elif cmd == "area":
        lat, lon, buf = float(rest[0]), float(rest[1]), float(rest[2])
        status, d = property_at(lat, lon, rest[3] if len(rest) > 3 else "precomputed", buf)
        print("HTTP", status, json.dumps(d)[:3000])
    elif cmd == "get":
        params = dict(kv.split("=", 1) for kv in rest[1:])
        status, d = send("GET", rest[0], params=params)
        print("HTTP", status, json.dumps(d, indent=1)[:4000] if not isinstance(d, bytes) else d[:300])
