"""Matterport GraphQL probe.

Usage:
  python3 data/probe/matterport.py types ModelRoom Opening ...   # list fields of types
  python3 data/probe/matterport.py enum OpeningType               # list enum values
  python3 data/probe/matterport.py query '{ models(query:"*") { totalResults } }'
"""
from __future__ import annotations

import base64
import json
import os
import sys
import urllib.request

from _env import load_env

URL = "https://api.matterport.com/api/models/graph"


def gql(query: str, variables: dict | None = None) -> dict:
    load_env()
    auth = base64.b64encode(
        f"{os.environ['MATTERPORT_API_KEY']}:{os.environ['MATTERPORT_API_TOKEN']}".encode()
    ).decode()
    req = urllib.request.Request(
        URL,
        data=json.dumps({"query": query, "variables": variables or {}}).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Basic {auth}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        return {"http_error": e.code, "body": e.read().decode()[:2000]}


def type_fields(name: str) -> str:
    d = gql('query($n:String!){ __type(name:$n){ fields { name args { name } } } }', {"n": name})
    t = (d.get("data") or {}).get("__type")
    if not t or not t.get("fields"):
        return f"{name}: {d}"
    parts = []
    for f in t["fields"]:
        args = ",".join(a["name"] for a in f["args"])
        parts.append(f["name"] + (f"({args})" if args else ""))
    return f"{name}: " + ", ".join(parts)


if __name__ == "__main__":
    cmd, *rest = sys.argv[1:]
    if cmd == "types":
        for n in rest:
            print(type_fields(n))
    elif cmd == "enum":
        for n in rest:
            d = gql('query($n:String!){ __type(name:$n){ enumValues { name } } }', {"n": n})
            print(n, [v["name"] for v in d["data"]["__type"]["enumValues"]])
    elif cmd == "query":
        print(json.dumps(gql(rest[0]), indent=1))
