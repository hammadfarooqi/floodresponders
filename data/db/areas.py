"""Give each buildings row the value of the area it stands in: the fire hazard zone and the census tract.

Pure functions, standard library only. No network and no file access here: load_supabase.py does that.
The rules are described in DATABASE.md. Change a rule in both places.
"""
BAND_DEG = 0.0005                       # height of a latitude band of the edge index, about 55 m
FIRE_ZONE = {"Very High": "very_high", "High": "high", "Moderate": "moderate"}      # all else: 'none'
TRACT_NOT_KNOWN = -999                  # the vulnerability index uses this for "no value"


def make_area(rings):
    """Index the edges of a shape by latitude band, so that a point is tested against few edges.

    rings: [[[lng, lat], ...], ...]. A ring inside another ring is a hole (even-odd rule), in any order.
    The fire hazard zones have about 100,000 edges; without the index, 40,000 buildings take hours.
    """
    bands = {}
    for ring in rings:
        for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
            if y1 == y2:
                continue                                # a level edge never crosses a level line
            for band in range(int(min(y1, y2) // BAND_DEG), int(max(y1, y2) // BAND_DEG) + 1):
                bands.setdefault(band, []).append((x1, y1, x2, y2))
    xs = [p[0] for ring in rings for p in ring]
    ys = [p[1] for ring in rings for p in ring]
    return {"bounds": (min(xs), min(ys), max(xs), max(ys)), "bands": bands}


def contains(area, lng, lat):
    west, south, east, north = area["bounds"]
    if not (west <= lng <= east and south <= lat <= north):
        return False
    inside = False
    for x1, y1, x2, y2 in area["bands"].get(int(lat // BAND_DEG), ()):
        if (y1 > lat) != (y2 > lat) and lng < (x2 - x1) * (lat - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def _known(value):
    return None if value is None or value == TRACT_NOT_KNOWN else value


def add_areas(rows, zone_features, tract_features):
    """Fill fire_hazard_zone, census_tract and the three tract shares of each row, from its lat and lng.

    zone_features: features of the CAL FIRE hazard zone layer. tract_features: features of the CDC/ATSDR Social
    Vulnerability Index tract layer. Both in the shape an ArcGIS service returns, coordinates in degrees.
    """
    zones = [(FIRE_ZONE[f["attributes"]["FHSZ_Description"]], make_area(f["geometry"]["rings"]))
             for f in zone_features if f["attributes"].get("FHSZ_Description") in FIRE_ZONE]
    tracts = [(f["attributes"], make_area(f["geometry"]["rings"])) for f in tract_features]
    for row in rows:
        lng, lat = row["lng"], row["lat"]
        row["fire_hazard_zone"] = next((name for name, area in zones if contains(area, lng, lat)), "none")
        tract = next((a for a, area in tracts if contains(area, lng, lat)), {})
        row["census_tract"] = tract.get("FIPS")
        row["tract_pct_age65"] = _known(tract.get("EP_AGE65"))
        row["tract_pct_disability"] = _known(tract.get("EP_DISABL"))
        row["tract_pct_no_vehicle"] = _known(tract.get("EP_NOVEH"))
    return rows
