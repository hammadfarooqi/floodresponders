"""Deterministic matching policies for the local Roll Call simulation."""

from math import asin, cos, radians, sin, sqrt
from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.models import Count, Latitude, Longitude, NonNegative

Policy = Literal["ours", "nearest"]


class MatchBuilding(BaseModel):
    id: str
    lat: Latitude
    lng: Longitude
    people_est: Count
    people_need_help_est: Count
    fire_arrival_min: NonNegative | None


class MatchTruck(BaseModel):
    id: str
    station_id: str
    lat: Latitude
    lng: Longitude
    status: Literal["idle", "en_route", "on_scene", "unavailable"]
    building_id: str | None


class MatchState(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)

    now_min: NonNegative
    buildings: list[MatchBuilding]
    trucks: list[MatchTruck]
    truck_speed_kmh: Annotated[float, Field(gt=0, allow_inf_nan=False)]

    @model_validator(mode="after")
    def check_ids(self) -> Self:
        for items in (self.buildings, self.trucks):
            if len({item.id for item in items}) != len(items):
                raise ValueError(
                    "Building and truck IDs must be unique within their lists"
                )
        return self


class Assignment(BaseModel):
    truck_id: str
    building_id: str
    eta_min: NonNegative
    reason: str


def distance_km(truck: MatchTruck, building: MatchBuilding) -> float:
    a, b = radians(truck.lat), radians(building.lat)
    angle = (
        sin((b - a) / 2) ** 2
        + cos(a) * cos(b) * sin(radians(building.lng - truck.lng) / 2) ** 2
    )
    return 12_742 * asin(sqrt(min(1.0, angle)))


def match(state: MatchState, policy: Policy) -> list[Assignment]:
    """Return new assignments, leaving existing on-scene work with its truck."""
    reserved_statuses = (
        {"on_scene", "en_route"} if policy == "nearest" else {"on_scene"}
    )
    reserved = {
        truck.building_id for truck in state.trucks if truck.status in reserved_statuses
    }
    eligible = {
        building.id: building
        for building in state.buildings
        if building.id not in reserved
        and building.people_need_help_est > 0
        and building.people_est > 0
        and (
            building.fire_arrival_min is None
            or building.fire_arrival_min > state.now_min
        )
    }
    available = {
        truck.id: truck
        for truck in state.trucks
        if truck.status == "idle" or (policy == "ours" and truck.status == "en_route")
    }
    assignments = []

    def assign(truck: MatchTruck, building: MatchBuilding, reason: str) -> None:
        assignments.append(
            Assignment(
                truck_id=truck.id,
                building_id=building.id,
                eta_min=distance_km(truck, building) * 60 / state.truck_speed_kmh,
                reason=reason,
            )
        )
        del available[truck.id]
        del eligible[building.id]

    if policy == "nearest":
        for truck in sorted(available.values(), key=lambda unit: unit.id):
            if not eligible:
                break
            building = min(
                eligible.values(), key=lambda site: (distance_km(truck, site), site.id)
            )
            assign(truck, building, "Nearest building needing assistance")
        return assignments

    def risk(building: MatchBuilding) -> float:
        if building.fire_arrival_min is None:
            return 0.0
        minutes_left = building.fire_arrival_min - state.now_min
        people = min(building.people_est, building.people_need_help_est)
        return people / (1 + minutes_left)

    for building in sorted(eligible.values(), key=lambda site: (-risk(site), site.id)):
        if not available:
            break
        truck = min(
            available.values(), key=lambda unit: (distance_km(unit, building), unit.id)
        )
        assign(truck, building, "Estimated people needing help and fire urgency")
    return assignments
