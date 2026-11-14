"""Apply simulated incoming reports and produce dispatch actions."""

from collections.abc import Callable
from copy import deepcopy

Matcher = Callable[[dict, str], list[dict]]


def handle_event(state: dict, event: dict, *, match: Matcher) -> dict:
    """Re-match a copy of the simulation state and return actions and a transcript."""
    updated = deepcopy(state)
    building_id = event["building_id"]
    buildings = {building["id"]: building for building in updated["buildings"]}
    if building_id not in buildings:
        raise ValueError("Unknown building")

    if event["type"] == "tenant_stuck":
        count = event["count"]
        if type(count) is not int or count < 1:
            raise ValueError("Expected a positive count of residents needing help")
        building = buildings[building_id]
        building["people_need_help_est"] = max(count, building["people_need_help_est"])
        building["reported_needs_help"] = count
        report = (
            f"The manager reported {count} residents needing help at {building_id}."
        )
    elif event["type"] == "driver_declines":
        truck_id = event["truck_id"]
        truck = next(
            (truck for truck in updated["trucks"] if truck["id"] == truck_id), None
        )
        if truck is None:
            raise ValueError("Unknown truck")
        truck["status"] = "unavailable"
        truck["building_id"] = None
        report = f"{truck_id} declined the assignment to {building_id}."
    else:
        raise ValueError("Unsupported dispatch event")

    assignments = match(updated, "ours")
    before = {
        item["truck_id"]: item["building_id"] for item in state.get("assignments", [])
    }
    after = {item["truck_id"]: item["building_id"] for item in assignments}
    actions = [{"type": "rematch", "assignments": assignments}]
    affected = {building_id}
    for truck_id in sorted(before.keys() | after.keys()):
        old, new = before.get(truck_id), after.get(truck_id)
        if old == new:
            continue
        affected.update(target for target in (old, new) if target is not None)
        message = (
            f"Your new assignment is {new}."
            if new
            else "Your previous assignment has been cleared."
        )
        actions.append(
            {"type": "notify", "to": "truck", "id": truck_id, "message": message}
        )

    for target in sorted(affected):
        assigned = next(
            (truck_id for truck_id, building in after.items() if building == target),
            None,
        )
        message = (
            f"{assigned} is assigned to your building."
            if assigned
            else "Your building is waiting for a truck."
        )
        actions.append(
            {"type": "notify", "to": "supervisor", "id": target, "message": message}
        )

    return {
        "actions": actions,
        "transcript": [
            {"speaker": "agent", "text": report},
            {"speaker": "agent", "text": "I updated the assignments."},
        ],
    }
