from fastapi.testclient import TestClient
from test_matching import demo_state

from app.main import create_app


def post_event(state, event):
    with TestClient(create_app(use_mock_data=True)) as client:
        return client.post("/api/agent/event", json={"state": state, "event": event})


def test_tenant_report_reassigns_the_truck():
    state = demo_state()
    state["buildings"][0]["people_need_help_est"] = 1
    state["buildings"][1]["people_need_help_est"] = 1
    state["trucks"][0].update(status="en_route", building_id="near")
    event = {
        "type": "tenant_stuck",
        "building_id": "urgent",
        "count": 12,
        "note": "Needs help at the stairs",
    }

    response = post_event(state, event)

    assert response.status_code == 200
    result = response.json()
    assert result["actions"][0]["assignments"][0]["building_id"] == "urgent"
    assert {action["id"] for action in result["actions"][1:]} == {
        "engine-1",
        "urgent",
        "near",
    }
    assert "12 residents" in result["transcript"][0]["text"]


def test_decline_reassigns_without_cancelling_an_on_scene_truck():
    state = demo_state()
    state["trucks"][0].update(status="en_route", building_id="urgent")
    state["trucks"].extend(
        [
            {
                **state["trucks"][0],
                "id": "engine-2",
                "status": "idle",
                "building_id": None,
            },
            {
                **state["trucks"][0],
                "id": "engine-3",
                "status": "on_scene",
                "building_id": "near",
            },
        ]
    )
    event = {
        "type": "driver_declines",
        "truck_id": "engine-1",
        "building_id": "urgent",
        "reason": "Busy",
    }

    response = post_event(state, event)

    assert response.status_code == 200
    result = response.json()
    assert [
        (a["truck_id"], a["building_id"]) for a in result["actions"][0]["assignments"]
    ] == [("engine-2", "urgent")]
    assert {a["id"] for a in result["actions"][1:]} == {
        "engine-1",
        "engine-2",
        "urgent",
    }


def test_rejects_stale_decline_and_zero_count():
    state = demo_state()
    response = post_event(
        state,
        {
            "type": "driver_declines",
            "truck_id": "engine-1",
            "building_id": "urgent",
            "reason": "Busy",
        },
    )
    assert response.status_code == 409
    assert (
        post_event(
            state,
            {
                "type": "tenant_stuck",
                "building_id": "urgent",
                "count": 0,
                "note": "",
            },
        ).status_code
        == 422
    )
