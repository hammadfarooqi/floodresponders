from copy import deepcopy

import pytest

from app.risk.score import BuildingForRisk, score_building


@pytest.fixture
def building() -> BuildingForRisk:
    return {
        "id": "sample-building-01",
        "property_type": "commercial",
        "floors": 5,
        "elevators": 1,
        "tenants": 80,
        "egress": {
            "stairwells": 2,
            "exits": 3,
            "fire_escapes": 1,
            "ladder_windows": 4,
        },
    }


def test_senior_housing_scores_higher(building):
    senior = {**building, "property_type": "senior_housing"}

    assert (
        score_building(senior, 0.8, 12)["score"]
        > score_building(building, 0.8, 12)["score"]
    )


@pytest.mark.parametrize(
    "route", ["stairwells", "exits", "fire_escapes", "ladder_windows"]
)
def test_fewer_egress_options_raise_score(building, route):
    reduced = deepcopy(building)
    reduced["egress"][route] -= 1

    assert (
        score_building(reduced, 0.8, 12)["score"]
        > score_building(building, 0.8, 12)["score"]
    )


@pytest.mark.parametrize(
    ("field", "value"), [("floors", 8), ("elevators", 0), ("tenants", 120)]
)
def test_harder_to_evacuate_buildings_score_higher(building, field, value):
    harder = {**building, field: value}

    assert (
        score_building(harder, 0.8, 12)["score"]
        > score_building(building, 0.8, 12)["score"]
    )


def test_sooner_arrival_raises_score(building):
    assert (
        score_building(building, 0.8, 5)["score"]
        > score_building(building, 0.8, 20)["score"]
    )


def test_risk_score_shape_and_formula(building):
    risk = score_building(building, exposure=0.8, eta_minutes=15)
    difficulty = 0.2 * (4 / 9) + 0.15 * (2 / 9) + 0.15 * (80 / 200) + 0.2 / 8

    assert risk == {
        "building_id": building["id"],
        "exposure": 0.8,
        "evac_difficulty": pytest.approx(difficulty),
        "eta_minutes": 15,
        "score": pytest.approx(0.8 * difficulty * 0.5),
    }
    assert score_building(building, 0, 15)["score"] == 0


def test_maximum_difficulty_stays_bounded(building):
    difficult = {
        **building,
        "property_type": "senior_housing",
        "floors": 50,
        "elevators": 0,
        "tenants": 1_000,
        "egress": dict.fromkeys(building["egress"], 0),
    }

    risk = score_building(difficult, 1, 0)
    assert risk["evac_difficulty"] == 1
    assert risk["score"] == 1
