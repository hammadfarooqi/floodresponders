"""Tests for areas.py. All shapes and values here are made up."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import areas as ar


def square(x, y, size):
    return [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]


def zone(description, *rings):
    return {"attributes": {"FHSZ_Description": description}, "geometry": {"rings": list(rings)}}


def tract(fips, x, y, size=0.01, age65=20.0, disability=10.0, no_vehicle=15.0):
    return {"attributes": {"FIPS": fips, "EP_AGE65": age65, "EP_DISABL": disability, "EP_NOVEH": no_vehicle},
            "geometry": {"rings": [square(x, y, size)]}}


def row(lng, lat):
    return {"lng": lng, "lat": lat}


def test_point_in_a_tall_shape_is_found_on_every_latitude():
    area = ar.make_area([[[0, 0], [0.01, 0], [0.005, 0.05], [0, 0]]])          # a triangle 0.05 degrees tall
    assert ar.contains(area, 0.005, 0.001) and ar.contains(area, 0.005, 0.04)
    assert not ar.contains(area, 0.009, 0.04)                                 # beside the narrow top
    assert not ar.contains(area, 0.005, 0.06) and not ar.contains(area, 0.02, 0.001)


def test_a_hole_is_outside():
    area = ar.make_area([square(0, 0, 0.01), square(0.004, 0.004, 0.002)])
    assert ar.contains(area, 0.001, 0.001) and not ar.contains(area, 0.005, 0.005)


def test_fire_hazard_zone_of_a_building():
    zones = [zone("Very High", square(0, 0, 0.01)), zone("High", square(0.01, 0, 0.01)),
             zone("Moderate", square(0.02, 0, 0.01)), zone("NonWildland", square(0.03, 0, 0.01))]
    rows = [row(0.005, 0.005), row(0.015, 0.005), row(0.025, 0.005), row(0.035, 0.005), row(0.5, 0.5)]
    ar.add_areas(rows, zones, [])
    assert [r["fire_hazard_zone"] for r in rows] == ["very_high", "high", "moderate", "none", "none"]


def test_tract_values_of_a_building():
    rows = [row(0.005, 0.005), row(0.015, 0.005), row(0.5, 0.5)]
    ar.add_areas(rows, [], [tract("06037000001", 0, 0), tract("06037000002", 0.01, 0, age65=-999.0, no_vehicle=40.5)])
    assert rows[0]["census_tract"] == "06037000001"
    assert (rows[0]["tract_pct_age65"], rows[0]["tract_pct_disability"], rows[0]["tract_pct_no_vehicle"]) == (20.0, 10.0, 15.0)
    assert rows[1]["census_tract"] == "06037000002"
    assert rows[1]["tract_pct_age65"] is None and rows[1]["tract_pct_no_vehicle"] == 40.5     # -999 = not known
    assert rows[2]["census_tract"] is None and rows[2]["tract_pct_age65"] is None
