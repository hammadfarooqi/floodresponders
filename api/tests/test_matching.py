from fastapi.testclient import TestClient

from app.main import create_app
from app.matching import MatchState, match


def demo_state():
    return {
        "now_min": 5,
        "truck_speed_kmh": 40,
        "buildings": [
            {
                "id": "urgent",
                "lat": 34.11,
                "lng": -118.34,
                "people_est": 20,
                "people_need_help_est": 20,
                "fire_arrival_min": 10,
            },
            {
                "id": "near",
                "lat": 34.1,
                "lng": -118.33,
                "people_est": 40,
                "people_need_help_est": 30,
                "fire_arrival_min": 120,
            },
        ],
        "trucks": [
            {
                "id": "engine-1",
                "station_id": "station-1",
                "lat": 34.1,
                "lng": -118.33,
                "status": "idle",
                "building_id": None,
            },
        ],
    }


def test_risk_first_and_nearest_use_the_same_state():
    state = MatchState.model_validate(demo_state())
    assert match(state, "ours")[0].building_id == "urgent"
    nearest = match(state, "nearest")
    assert nearest[0].building_id == "near"
    assert nearest[0].eta_min == 0
    assert state.trucks[0].status == "idle"


def test_nearest_keeps_assignments_and_ours_can_replan():
    payload = demo_state()
    payload["trucks"][0].update(status="en_route", building_id="near")
    state = MatchState.model_validate(payload)
    assert match(state, "nearest") == []
    assert match(state, "ours")[0].building_id == "urgent"
    payload["trucks"][0]["status"] = "on_scene"
    assert match(MatchState.model_validate(payload), "ours") == []


def test_reserved_burned_and_empty_buildings_are_excluded():
    payload = demo_state()
    urgent = payload["buildings"][0]
    payload["buildings"].extend(
        [
            {**urgent, "id": "burned", "fire_arrival_min": 5},
            {**urgent, "id": "empty", "people_est": 0},
            {**urgent, "id": "clear", "people_need_help_est": 0},
        ]
    )
    payload["trucks"].append(
        {
            **payload["trucks"][0],
            "id": "engine-2",
            "status": "on_scene",
            "building_id": "urgent",
        }
    )
    for policy in ("ours", "nearest"):
        assignments = match(MatchState.model_validate(payload), policy)
        assert [(item.truck_id, item.building_id) for item in assignments] == [
            ("engine-1", "near")
        ]


def test_match_route_and_browser_preflight():
    with TestClient(create_app(use_mock_data=True)) as client:
        preflight = client.options(
            "/api/match",
            headers={
                "Origin": "http://localhost:3016",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "Content-Type",
            },
        )
        assert preflight.status_code == 200
        assert (
            preflight.headers["access-control-allow-origin"] == "http://localhost:3016"
        )
        response = client.post(
            "/api/match", json={"state": demo_state(), "policy": "ours"}
        )
        assert response.status_code == 200
        assert response.json()["assignments"][0]["building_id"] == "urgent"
        invalid = demo_state()
        invalid["truck_speed_kmh"] = 0
        assert (
            client.post(
                "/api/match", json={"state": invalid, "policy": "ours"}
            ).status_code
            == 422
        )
