# Greater Los Angeles public hazard samples

From the repository root, run `python3 data/fetch_public_feeds.py` to refresh these samples using the Python standard library. Both sources are filtered for Greater Los Angeles (west −119, south 33.6, east −117.55, north 34.75).

- `fema_flood_zones.geojson` contains up to 20 simplified polygons from the [FEMA National Flood Hazard Layer, layer 28](https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28). The query selects high-risk flood zones that intersect the bounds. The returned polygons can extend beyond the bounds. FEMA requires no key.
- `firms_fire_sample.csv` contains July 2023 VIIRS Suomi-NPP satellite detections from the [NASA FIRMS training sample](https://firms.modaps.eosdis.nasa.gov/content/notebooks/sample_viirs_snpp_071223.csv). The public download requires no key. Acquisition date and time are in UTC.
- Set `FIRMS_MAP_KEY` in your shell and run with `--live-fire` to save up to 100 detections from the past five days to `firms_fire_live.csv`. Request the key through the [NASA FIRMS Area API](https://firms.modaps.eosdis.nasa.gov/api/area/). An empty CSV body after the header means the query returned no detections in the area.

These files demonstrate feed formats. FEMA polygons describe mapped flood risk and FIRMS points describe satellite thermal detections. Neither provides an incident perimeter or arrival time.
