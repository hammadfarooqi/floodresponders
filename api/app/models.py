"""JSON types for the Plan v2 demo data endpoints."""

from typing import Annotated, Literal

from pydantic import BaseModel, Field

Longitude = Annotated[float, Field(ge=-180, le=180)]
Latitude = Annotated[float, Field(ge=-90, le=90)]
Position = tuple[Longitude, Latitude]
Count = Annotated[int, Field(ge=0)]
NonNegative = Annotated[float, Field(ge=0)]


class ManagerContact(BaseModel):
    company: str | None
    phone: str | None


class CoStarBuilding(BaseModel):
    id: str
    name: str
    address: str
    stories: Count | None
    units: Count | None
    is_walkup: bool | None
    elevators: Count | None
    is_senior: bool
    manager: ManagerContact


class DemoBuilding(BaseModel):
    id: str
    lat: Latitude
    lng: Longitude
    footprint: Annotated[list[Position], Field(min_length=3)]
    height_m: NonNegative
    ground_elevation_m: float
    use: Literal["residential", "commercial", "other", "none"]
    units: Count | None
    people_est: Count
    people_need_help_est: Count
    fire_arrival_min: NonNegative | None
    costar: CoStarBuilding | None
    matterport_ids: list[str]


class BuildingsResponse(BaseModel):
    buildings: list[DemoBuilding]


class FireFront(BaseModel):
    type: Literal["Polygon"]
    coordinates: list[Annotated[list[Position], Field(min_length=4)]]


class FireTimeline(BaseModel):
    origin: Position
    wind_from_deg: Annotated[float, Field(ge=0, le=360)]
    step_min: Annotated[float, Field(gt=0)]
    fronts: list[FireFront]


class Station(BaseModel):
    id: str
    name: str
    lat: Latitude
    lng: Longitude


class StationsResponse(BaseModel):
    stations: list[Station]


class RoadGraph(BaseModel):
    nodes: list[Position]
    edges: list[tuple[Count, Count, NonNegative]]
