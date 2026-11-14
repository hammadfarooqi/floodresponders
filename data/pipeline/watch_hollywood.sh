#!/bin/bash
# Rebuild the Hollywood map from whatever tiles are cached, every 60 s, while area_fetch.py is running.
cd "$(dirname "$0")/../.."
while true; do
  running=$(pgrep -f "area_fetch.py hollywood$" >/dev/null && echo 1 || echo 0)
  python3 data/pipeline/area_fetch.py hollywood --merge-only | tail -1
  python3 data/pipeline/build_hollywood_map.py | grep -E "all area|map ->"
  echo "--- $(date +%H:%M:%S) tiles cached: $(ls data/cache/vexcel_area | wc -l | tr -d ' ')/520"
  [ "$running" = 0 ] && echo "fetch finished; final build done" && break
  sleep 60
done
