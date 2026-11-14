"""Run a local, fictional call and dispatch exercise without provider credentials."""

import json
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.resources import files
from math import hypot
from threading import Lock
from uuid import uuid4

from rollcall_agent.dispatch import handle_event
from rollcall_agent.manager_call import run_manager_call

REPORT = re.compile(
    r"\s*(?:unit|room|apartment)\s+([a-z0-9-]{1,10})\s+"
    r"(?:needs? (?:evacuation )?(?:help|assistance)(?: with)?|cannot evacuate because)\s*"
    r"[:,-]?\s*(.*)",
    re.IGNORECASE,
)
INITIAL_BUILDINGS = [
    ("juniper", "Juniper Senior Living", "+1-213-555-0101", 3, 9, 1),
    ("sycamore", "Sycamore Apartments", "+1-213-555-0102", 2, 12, 3),
    ("magnolia", "Magnolia Court", "+1-213-555-0103", 1, 8, 6),
]
CALLS = {}
CALL_LOCK = Lock()


def priority(building):
    return building["people_need_help_est"] / max(1, building["fire_arrival_min"])


def demo_match(state, _policy):
    """Simple risk-first matcher for the standalone demo."""
    trucks = [truck for truck in state["trucks"] if truck["status"] != "unavailable"]
    assignments = []
    for building in sorted(state["buildings"], key=priority, reverse=True):
        if not trucks or priority(building) == 0:
            break
        truck = min(
            trucks,
            key=lambda candidate: hypot(candidate["x"] - building["x"], candidate["y"]),
        )
        distance = hypot(truck["x"] - building["x"], truck["y"])
        assignments.append(
            {
                "truck_id": truck["id"],
                "building_id": building["id"],
                "eta_min": round(distance * 2, 1),
                "reason": "Demo risk and proximity",
            }
        )
        trucks.remove(truck)
    return assignments


def initial_state():
    state = {
        "buildings": [
            {
                "id": key,
                "name": name,
                "phone": phone,
                "people_need_help_est": people,
                "fire_arrival_min": eta,
                "x": x,
            }
            for key, name, phone, people, eta, x in INITIAL_BUILDINGS
        ],
        "trucks": [
            {"id": "Engine 12", "status": "idle", "x": 0, "y": 1},
            {"id": "Engine 7", "status": "idle", "x": 4, "y": 1},
        ],
    }
    state["assignments"] = demo_match(state, "ours")
    return state


def present(state, **details):
    return {
        "queue": sorted(state["buildings"], key=priority, reverse=True),
        "assignments": state["assignments"],
        **details,
    }


def start_call(building_id=None):
    state = initial_state()
    assignment = state["assignments"][0]
    building_id = building_id or assignment["building_id"]
    target = next(
        (building for building in state["buildings"] if building["id"] == building_id),
        None,
    )
    if target is None:
        raise ValueError("Unknown demo building")
    caller = next(
        (
            item["truck_id"]
            for item in state["assignments"]
            if item["building_id"] == building_id
        ),
        "Roll Call dispatch",
    )
    call_id = str(uuid4())
    with CALL_LOCK:
        if len(CALLS) >= 50:
            del CALLS[next(iter(CALLS))]
        CALLS[call_id] = (building_id, state)
    return present(
        state,
        call_id=call_id,
        destination=target,
        transcript=[
            {
                "speaker": "agent",
                "text": f"Hello, this is Roll Call calling on behalf of {caller}. "
                "Does anyone need evacuation assistance? Please give the count, unit, and type of help.",
            }
        ],
    )


def submit_report(call_id, count, transcript):
    if type(count) is not int or not 1 <= count <= 100:
        raise ValueError("Enter a count from 1 to 100")
    if not isinstance(transcript, str) or len(transcript) > 500:
        raise ValueError("Enter up to 500 characters")
    parsed = REPORT.fullmatch(transcript.strip())
    if parsed is None or not parsed[2].strip(" ."):
        raise ValueError(
            "Include a unit and the kind of help, such as Unit 3B needs help with stairs"
        )
    with CALL_LOCK:
        if call_id not in CALLS:
            raise ValueError("Start a demo call first")
        building_id, state = CALLS[call_id]
        target = next(
            building for building in state["buildings"] if building["id"] == building_id
        )
        assigned = next(
            (
                item
                for item in state["assignments"]
                if item["building_id"] == building_id
            ),
            None,
        )
        responder = {"id": assigned["truck_id"] if assigned else "Roll Call dispatch"}
        call = run_manager_call(
            target,
            responder,
            {"disaster_type": "fire"},
            simulated_residents=(
                {"unit": parsed[1].upper(), "need": parsed[2].strip(" .")},
            ),
        )
        event = {
            "type": "tenant_stuck",
            "building_id": building_id,
            "count": count,
            "note": transcript,
        }
        result = handle_event(state, event, match=demo_match)
        target["people_need_help_est"] = max(count, target["people_need_help_est"])
        target["reported_needs_help"] = count
        state["assignments"] = result["actions"][0]["assignments"]
        del CALLS[call_id]
        return present(
            state,
            call_id=call_id,
            destination=target,
            actions=result["actions"],
            **call,
        )


class DemoHandler(BaseHTTPRequestHandler):
    def send_content(self, body, content_type, status=200):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, payload, status=200):
        self.send_content(json.dumps(payload).encode(), "application/json", status)

    def do_GET(self):
        if self.path != "/":
            self.send_error(404)
            return
        page = (
            files("rollcall_agent").joinpath("manager_dispatch_demo.html").read_bytes()
        )
        self.send_content(page, "text/html; charset=utf-8")

    def do_POST(self):
        if self.path not in ("/start", "/report"):
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 4096:
                raise ValueError("Report size is invalid")
            report = json.loads(self.rfile.read(length))
            if not isinstance(report, dict):
                raise TypeError("Expected a report object")
            result = (
                start_call(report.get("building_id"))
                if self.path == "/start"
                else submit_report(
                    report["call_id"], report["count"], report["transcript"]
                )
            )
        except (KeyError, TypeError, ValueError) as exc:
            self.send_json({"error": str(exc)}, 400)
            return
        self.send_json(result)


if __name__ == "__main__":
    with ThreadingHTTPServer(("127.0.0.1", 3022), DemoHandler) as server:
        print("Manager dispatch demo at http://127.0.0.1:3022", flush=True)
        server.serve_forever()
