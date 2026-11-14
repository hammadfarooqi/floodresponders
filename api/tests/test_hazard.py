import pytest

from app.risk.hazard import estimate_hazard


@pytest.mark.parametrize("disaster_type", ["fire", "flood"])
def test_higher_severity_increases_exposure_and_reduces_eta(disaster_type):
    building = {"lat": 34.101, "lng": -118.331, "elevation_m": 100.0}
    mild = estimate_hazard(
        {"disaster_type": disaster_type, "origin": "N", "severity": 1}, building
    )
    severe = estimate_hazard(
        {"disaster_type": disaster_type, "origin": "N", "severity": 5}, building
    )

    assert 0 < mild["exposure"] < severe["exposure"] <= 1
    assert 0 < severe["eta_minutes"] < mild["eta_minutes"]


@pytest.mark.parametrize(
    ("origin", "latitude_offset", "longitude_offset"),
    [
        ("N", 0.002, 0),
        ("NE", 0.002, 0.004),
        ("E", 0, 0.004),
        ("SE", -0.002, 0.004),
        ("S", -0.002, 0),
        ("SW", -0.002, -0.004),
        ("W", 0, -0.004),
        ("NW", 0.002, -0.004),
    ],
)
@pytest.mark.parametrize("disaster_type", ["fire", "flood"])
def test_hazard_reaches_buildings_near_origin_first(
    origin, latitude_offset, longitude_offset, disaster_type
):
    scenario = {"disaster_type": disaster_type, "origin": origin, "severity": 3}
    near = {
        "lat": 34.101 + latitude_offset,
        "lng": -118.331 + longitude_offset,
        "elevation_m": 100.0,
    }
    far = {
        "lat": 34.101 - latitude_offset,
        "lng": -118.331 - longitude_offset,
        "elevation_m": 100.0,
    }

    near_estimate = estimate_hazard(scenario, near)
    far_estimate = estimate_hazard(scenario, far)

    assert near_estimate["eta_minutes"] < far_estimate["eta_minutes"]
    assert near_estimate["exposure"] > far_estimate["exposure"]


def test_lower_elevation_increases_flood_exposure():
    scenario = {"disaster_type": "flood", "origin": "W", "severity": 3}
    low = {"lat": 34.101, "lng": -118.331, "elevation_m": 90.0}
    high = {**low, "elevation_m": 130.0}

    assert (
        estimate_hazard(scenario, low)["exposure"]
        > estimate_hazard(scenario, high)["exposure"]
    )


def test_outside_grid_exposure_and_eta_remain_bounded():
    scenario = {"disaster_type": "flood", "origin": "N", "severity": 5}
    north = {"lat": 34.12, "lng": -118.331, "elevation_m": 0.0}
    south = {"lat": 34.08, "lng": -118.331, "elevation_m": 300.0}

    assert estimate_hazard(scenario, north) == {"exposure": 1.0, "eta_minutes": 0.0}
    assert estimate_hazard(scenario, south) == {"exposure": 0.0625, "eta_minutes": 18.0}
