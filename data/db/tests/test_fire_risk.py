"""Tests for fire_risk.py. All data here is made up: this repo is public, never put sponsor data in a test."""
import os
import re
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import fire_risk as fr

ORIGIN = (34.10, -118.33)                   # lat, lng
M_PER_DEG_LAT = 110_540


def north_of_origin(meters):
    return ORIGIN[0] + meters / M_PER_DEG_LAT, ORIGIN[1]


def building(meters_north=0.0, risk_score=10.0, **over):
    lat, lng = north_of_origin(meters_north)
    return {"id": "b", "lat": lat, "lng": lng, "risk_score": risk_score, **over}


def score(row, wind_from_deg=None, w=fr.WEIGHTS):
    return fr.fire_risk_scores([row], ORIGIN[0], ORIGIN[1], wind_from_deg, w)[0]


# ---------------------------------------------------------------- distance

def test_distance_is_in_meters():
    lat, lng = north_of_origin(1000)
    assert fr.offset_m(lat, lng, *ORIGIN) == pytest.approx((0, 1000), abs=0.01)
    assert fr.effective_distance_m(0, 1000) == pytest.approx(1000)
    assert fr.effective_distance_m(300, 400) == pytest.approx(500)


def test_no_wind_gives_a_circle():
    around = [fr.effective_distance_m(east, north) for east, north in ((800, 0), (-800, 0), (0, 800), (0, -800))]
    assert around == pytest.approx([800] * 4)


def test_wind_makes_downwind_buildings_count_as_closer():
    """Wind from the north (0 degrees) pushes the fire south."""
    south = fr.effective_distance_m(0, -1000, wind_from_deg=0)
    north = fr.effective_distance_m(0, 1000, wind_from_deg=0)
    east = fr.effective_distance_m(1000, 0, wind_from_deg=0)
    assert south == pytest.approx(700)          # 1000 x (1 - 0.3)
    assert north == pytest.approx(1300)         # 1000 x (1 + 0.3)
    assert east == pytest.approx(1000)          # across the wind: no change
    assert fr.effective_distance_m(-1000, 0, wind_from_deg=90) == pytest.approx(700)    # wind from the east


def test_the_oval_is_slight():
    """With the start weight, the reach downwind is less than twice the reach upwind."""
    stretch = fr.WEIGHTS["wind_stretch"]
    assert 0 < stretch < 1
    assert (1 + stretch) / (1 - stretch) < 2


# ---------------------------------------------------------------- fire factor

def test_factor_is_highest_at_the_origin_and_halves_with_distance():
    assert fr.fire_factor(0) == pytest.approx(2.0)                  # 1 + boost
    assert fr.fire_factor(1000) == pytest.approx(1.5)               # one half distance
    assert fr.fire_factor(2000) == pytest.approx(1.25)
    assert fr.fire_factor(50_000) == pytest.approx(1.0, abs=1e-6)
    assert fr.fire_factor(20_000_000) == 1.0                        # an origin on the other side of the earth


def test_factor_never_rises_with_distance_and_never_goes_below_one():
    factors = [fr.fire_factor(d) for d in (0, 10, 500, 1000, 3000, 10_000, 100_000)]
    assert factors == sorted(factors, reverse=True)
    assert all(f >= 1 for f in factors)


# ---------------------------------------------------------------- the score

def test_score_is_the_base_score_times_the_factor():
    row = score(building(meters_north=1000, risk_score=10.0))
    assert row["fire_distance_m"] == pytest.approx(1000, abs=0.5)
    assert row["fire_factor"] == pytest.approx(1.5, abs=0.001)
    assert row["fire_risk_score"] == pytest.approx(15.0, abs=0.01)


def test_a_closer_building_with_the_same_base_score_ranks_higher():
    near, far = score(building(meters_north=200)), score(building(meters_north=3000))
    assert near["fire_risk_score"] > far["fire_risk_score"] > 10.0 * 0.999


def test_a_high_risk_building_farther_away_stays_above_a_low_risk_building_at_the_fire():
    """The fire can at most double a score, so a base score 3 times higher always wins."""
    block_far = score(building(meters_north=8000, risk_score=9.0))
    house_at_fire = score(building(meters_north=0, risk_score=3.0))
    assert block_far["fire_risk_score"] > house_at_fire["fire_risk_score"]


def test_zero_stays_zero_and_not_known_stays_not_known():
    assert score(building(meters_north=0, risk_score=0.0))["fire_risk_score"] == 0
    unknown = score(building(meters_north=0, risk_score=None))
    assert unknown["fire_risk_score"] is None
    assert unknown["fire_factor"] == pytest.approx(2.0)             # the factor is still known


def test_rows_come_back_highest_first_with_not_known_last():
    rows = [building(meters_north=5000, risk_score=1.0, id="low"), building(risk_score=None, id="unknown"),
            building(meters_north=100, risk_score=1.0, id="near"), building(meters_north=5000, risk_score=50.0, id="big")]
    out = fr.fire_risk_scores(rows, *ORIGIN)
    assert [r["id"] for r in out] == ["big", "near", "low", "unknown"]
    assert "fire_risk_score" not in rows[0]                         # the input rows are not changed


def test_wind_changes_the_order_of_two_buildings_at_the_same_distance():
    north, south = building(meters_north=1500, id="north"), building(meters_north=-1500, id="south")
    assert [r["id"] for r in fr.fire_risk_scores([north, south], *ORIGIN, wind_from_deg=0)] == ["south", "north"]
    assert [r["id"] for r in fr.fire_risk_scores([south, north], *ORIGIN, wind_from_deg=180)] == ["north", "south"]


def test_weights_can_be_changed():
    strong = {**fr.WEIGHTS, "boost": 4.0, "half_distance_m": 500.0}
    assert score(building(meters_north=500), w=strong)["fire_factor"] == pytest.approx(3.0, abs=0.001)


# ---------------------------------------------------------------- the database function uses the same weights

def test_schema_sql_has_the_same_default_weights():
    """buildings_fire_risk in schema.sql repeats the rule in SQL. Its defaults must equal WEIGHTS."""
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "schema.sql")
    with open(path) as f:
        sql = f.read()
    assert "function buildings_fire_risk" in sql
    for name, value in fr.WEIGHTS.items():
        found = re.search(rf"p_{name}\s+double precision\s+default\s+([0-9.]+)", sql)
        assert found, f"p_{name} has no default in schema.sql"
        assert float(found.group(1)) == value
    # Postgres stops with "underflow" on 0.5 ^ 1100, so the SQL must limit the exponent.
    assert re.search(r"power\(0\.5,\s*least\(", sql)
