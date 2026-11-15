"""Risk score of each building for one fire origin.

    fire_risk_score = risk_score x fire_factor
    fire_factor     = 1 + boost x 0.5 ^ (effective distance / half distance)

risk_score is the stored score from risk_score.py (building data only). fire_factor is 1 far from the origin and
1 + boost at the origin, so the fire raises a score and never replaces it: a building with a score of 0 stays at 0,
and a building with a high score that is farther away can stay above a low one next to the fire.

The reach of the fire is a circle around the origin. With a wind direction it is a slight oval that is longer
downwind. This is a rule of thumb, not a fire model: it has no terrain, no fuel and no time.

Pure functions, standard library only. The Postgres function buildings_fire_risk in schema.sql repeats this rule,
and DATABASE.md describes it. Change a rule in all three places.
"""
import math

# Assumptions, not measurements. The defaults of buildings_fire_risk in schema.sql must be the same values
# (a test checks this).
WEIGHTS = {
    "boost": 1.0,                   # the factor at the origin is 1 + boost
    "half_distance_m": 1000.0,      # each time the effective distance grows by this, the added part halves
    "wind_stretch": 0.3,            # 0 = circle. Downwind distances count x (1 - this), upwind x (1 + this)
}

M_PER_DEG_LAT = 110_540
M_PER_DEG_LNG_AT_EQUATOR = 111_320


def offset_m(lat, lng, origin_lat, origin_lng):
    """(meters east, meters north) of a point from the origin. Flat-earth math: good for a city, not a state."""
    east = (lng - origin_lng) * math.cos(math.radians(origin_lat)) * M_PER_DEG_LNG_AT_EQUATOR
    return east, (lat - origin_lat) * M_PER_DEG_LAT


def effective_distance_m(east_m, north_m, wind_from_deg=None, w=WEIGHTS):
    """Distance from the origin, counted shorter downwind and longer upwind.

    wind_from_deg: compass direction the wind comes from (0 = north, 90 = east). None = no wind, a circle.
    The points with one effective distance form an ellipse with the origin at one focus.
    """
    distance = math.hypot(east_m, north_m)
    if wind_from_deg is None:
        return distance
    toward_wind = east_m * math.sin(math.radians(wind_from_deg)) + north_m * math.cos(math.radians(wind_from_deg))
    return distance + w["wind_stretch"] * toward_wind


def fire_factor(effective_m, w=WEIGHTS):
    """1 + boost at the origin, then down toward 1 with distance."""
    return 1 + w["boost"] * 0.5 ** (effective_m / w["half_distance_m"])


def fire_risk_scores(rows, origin_lat, origin_lng, wind_from_deg=None, w=WEIGHTS):
    """A copy of every row with fire_distance_m, fire_factor and fire_risk_score, highest score first.

    rows: dicts with lat, lng and risk_score. A null risk_score (people not known) gives a null fire_risk_score,
    and those rows come last.
    """
    out = []
    for row in rows:
        east, north = offset_m(row["lat"], row["lng"], origin_lat, origin_lng)
        factor = fire_factor(effective_distance_m(east, north, wind_from_deg, w), w)
        base = row.get("risk_score")
        out.append({**row, "fire_distance_m": round(math.hypot(east, north), 1), "fire_factor": round(factor, 3),
                    "fire_risk_score": None if base is None else round(float(base) * factor, 3)})
    out.sort(key=lambda r: (r["fire_risk_score"] is None, -(r["fire_risk_score"] or 0)))
    return out
