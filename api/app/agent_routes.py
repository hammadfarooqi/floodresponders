"""Dispatch events for the browser simulation."""

from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from rollcall_agent.dispatch import handle_event

from app.matching import Assignment, MatchState, match

router = APIRouter()


class DriverDeclines(BaseModel):
    type: Literal["driver_declines"]
    truck_id: str
    building_id: str
    reason: str


class TenantStuck(BaseModel):
    type: Literal["tenant_stuck"]
    building_id: str
    count: Annotated[int, Field(gt=0, strict=True)]
    note: str


class AgentEventRequest(BaseModel):
    state: MatchState
    event: Annotated[DriverDeclines | TenantStuck, Field(discriminator="type")]


class Rematch(BaseModel):
    type: Literal["rematch"]
    assignments: list[Assignment]


class Notify(BaseModel):
    type: Literal["notify"]
    to: Literal["truck", "supervisor"]
    id: str
    message: str


class TranscriptTurn(BaseModel):
    speaker: Literal["agent", "manager"]
    text: str


class AgentEventResponse(BaseModel):
    actions: list[Annotated[Rematch | Notify, Field(discriminator="type")]]
    transcript: list[TranscriptTurn]


def rematch(state: dict, _policy: str) -> list[dict]:
    return [
        item.model_dump() for item in match(MatchState.model_validate(state), "ours")
    ]


@router.post("/api/agent/event")
def apply_agent_event(request: AgentEventRequest) -> AgentEventResponse:
    state, event = request.state, request.event
    building = next(
        (site for site in state.buildings if site.id == event.building_id), None
    )
    if building is None:
        raise HTTPException(status_code=404, detail="Unknown building")
    if isinstance(event, DriverDeclines):
        truck = next((unit for unit in state.trucks if unit.id == event.truck_id), None)
        if truck is None:
            raise HTTPException(status_code=404, detail="Unknown truck")
        if truck.building_id != building.id or truck.status not in (
            "en_route",
            "on_scene",
        ):
            raise HTTPException(
                status_code=409,
                detail="The truck is no longer assigned to this building",
            )
    elif building.people_est == 0 or (
        building.fire_arrival_min is not None
        and building.fire_arrival_min <= state.now_min
    ):
        raise HTTPException(
            status_code=409,
            detail="The building is no longer eligible for an evacuation assignment",
        )

    snapshot = state.model_dump()
    snapshot["assignments"] = [
        {"truck_id": truck.id, "building_id": truck.building_id}
        for truck in state.trucks
        if truck.status in ("en_route", "on_scene") and truck.building_id is not None
    ]
    return AgentEventResponse.model_validate(
        handle_event(snapshot, event.model_dump(), match=rematch)
    )
