"""Download small public flood and fire samples for Greater Los Angeles."""

import argparse
import csv
import io
import json
import os
from pathlib import Path
from urllib.error import URLError
from urllib.parse import quote, urlencode
from urllib.request import urlopen

AREA = "-119,33.6,-117.55,34.75"
FEMA_LAYER = "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28"
FIRMS_API = "https://firms.modaps.eosdis.nasa.gov/api/area/csv"
FIRMS_SAMPLE = "https://firms.modaps.eosdis.nasa.gov/content/notebooks/sample_viirs_snpp_071223.csv"
OUTPUT = Path(__file__).resolve().parent / "public_feeds"
FIRE_COLUMNS = ("latitude", "longitude", "acq_date", "acq_time", "confidence", "frp")


def download(url, source):
    try:
        with urlopen(url, timeout=40) as response:
            return response.read().decode("utf-8-sig")
    except (URLError, OSError) as error:
        # FIRMS credentials are part of its HTTPS request URL.
        raise ValueError(
            f"Could not download {source} ({type(error).__name__})."
        ) from None


def flood_zones():
    params = {
        "f": "geojson",
        "where": "SFHA_TF = 'T'",
        "geometry": AREA,
        "geometryType": "esriGeometryEnvelope",
        "spatialRel": "esriSpatialRelIntersects",
        "inSR": 4326,
        "outSR": 4326,
        "outFields": "OBJECTID,FLD_ZONE,ZONE_SUBTY,SFHA_TF",
        "orderByFields": "OBJECTID",
        "resultRecordCount": 20,
        "maxAllowableOffset": 0.0003,
        "geometryPrecision": 5,
    }
    result = json.loads(
        download(f"{FEMA_LAYER}/query?{urlencode(params)}", "FEMA NFHL")
    )
    if result.get("type") != "FeatureCollection" or not isinstance(
        result.get("features"), list
    ):
        raise ValueError("FEMA did not return a GeoJSON feature collection.")
    return {"type": "FeatureCollection", "features": result["features"]}


def fire_detections(key):
    url = FIRMS_SAMPLE
    if key:
        url = f"{FIRMS_API}/{quote(key, safe='')}/VIIRS_SNPP_NRT/{AREA}/5"
    content = download(url, "NASA FIRMS")
    reader = csv.DictReader(io.StringIO(content))
    if not set(FIRE_COLUMNS).issubset(reader.fieldnames or ()):
        raise ValueError("NASA FIRMS did not return the expected detection CSV.")

    west, south, east, north = map(float, AREA.split(","))
    rows = [
        row
        for row in reader
        if south <= float(row["latitude"]) <= north
        and west <= float(row["longitude"]) <= east
    ]
    rows.sort(key=lambda row: (row["acq_date"], row["acq_time"]), reverse=True)
    output = io.StringIO()
    writer = csv.DictWriter(
        output, fieldnames=FIRE_COLUMNS, extrasaction="ignore", lineterminator="\n"
    )
    writer.writeheader()
    writer.writerows(rows[:100])
    return output.getvalue()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--live-fire", action="store_true", help="Use the latest FIRMS detections."
    )
    parser.add_argument("--output", type=Path, default=OUTPUT)
    args = parser.parse_args()
    key = os.environ.get("FIRMS_MAP_KEY") if args.live_fire else None
    if args.live_fire and not key:
        parser.error("Set FIRMS_MAP_KEY to use --live-fire.")

    try:
        floods = flood_zones()
        fires = fire_detections(key)
    except ValueError as error:
        parser.exit(1, f"Unable to refresh public feeds: {error}\n")

    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "fema_flood_zones.geojson").write_text(
        json.dumps(floods, separators=(",", ":")) + "\n", encoding="utf-8"
    )
    fire_filename = "firms_fire_live.csv" if args.live_fire else "firms_fire_sample.csv"
    (args.output / fire_filename).write_text(fires, encoding="utf-8")
    print(
        f"Saved {len(floods['features'])} flood zones and {len(fires.splitlines()) - 1} fire detections."
    )


if __name__ == "__main__":
    main()
