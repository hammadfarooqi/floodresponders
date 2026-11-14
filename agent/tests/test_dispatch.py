from rollcall_agent.dispatch import handle_event
from rollcall_agent.manager_dispatch_demo import (
    demo_match,
    initial_state,
    start_call,
    submit_report,
)


def test_manager_report_updates_priority_and_assigns_a_truck():
    call = start_call("magnolia")
    assert call["queue"][0]["id"] == "juniper"
    assert call["destination"]["phone"] == "+1-213-555-0103"

    result = submit_report(call["call_id"], 8, "Unit 3B needs help with stairs.")

    assert result["call_id"] == call["call_id"]
    assert result["queue"][0]["id"] == "magnolia"
    assert result["residents_needing_help"] == [{"unit": "3B", "need": "stairs"}]
    assert result["assignments"][0]["building_id"] == "magnolia"
    assert any(action.get("id") == "Engine 7" for action in result["actions"])


def test_driver_declines_and_matcher_receives_updated_state():
    state = initial_state()
    assert state["assignments"][0]["truck_id"] == "Engine 12"

    result = handle_event(
        state,
        {
            "type": "driver_declines",
            "truck_id": "Engine 12",
            "building_id": "juniper",
            "reason": "Busy",
        },
        match=demo_match,
    )

    assert result["actions"][0]["assignments"][0]["truck_id"] == "Engine 7"
    assert state["trucks"][0]["status"] == "idle"
