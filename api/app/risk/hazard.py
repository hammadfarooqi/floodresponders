"""Estimate exposure and arrival time for the fictional Roll Call city."""

from typing import Literal, TypedDict

Origin = Literal["N", "NE", "E", "SE", "S", "SW", "W", "NW"]

CITY_CENTER_LAT = 34.101
CITY_CENTER_LNG = -118.331
CITY_HALF_HEIGHT = 0.003
CITY_HALF_WIDTH = 0.005
ORIGIN_DIRECTIONS: dict[Origin, tuple[int, int]] = {
    "N": (1, 0),
    "NE": (1, 1),
    "E": (0, 1),
    "SE": (-1, 1),
    "S": (-1, 0),
    "SW": (-1, -1),
    "W": (0, -1),
    "NW": (1, -1),
}


class Scenario(TypedDict):
    disaster_type: Literal["fire", "flood"]
    origin: Origin
    severity: int


class BuildingLocation(TypedDict):
    lat: float
    lng: float
    elevation_m: float


class HazardEstimate(TypedDict):
    exposure: float
    eta_minutes: float


def estimate_hazard(scenario: Scenario, building: BuildingLocation) -> HazardEstimate:
    """Return a demo estimate for a valid scenario and a building's location.

    Normalize the building's position within the fictional Hollywood grid.
    Project it onto the selected direction to get a fraction across the city,
    from 0 at the origin edge to 1 at the far edge. Clamp the fraction for
    buildings outside the grid. Exposure falls with distance, while ETA grows.

    Severity scales exposure linearly and shortens the time to cross the grid.
    Flood exposure is further scaled by elevation, from full at 85 m or below
    to one quarter at 140 m or above. All thresholds are demo parameters.
    """
    north = (building["lat"] - CITY_CENTER_LAT) / CITY_HALF_HEIGHT
    east = (building["lng"] - CITY_CENTER_LNG) / CITY_HALF_WIDTH
    north_direction, east_direction = ORIGIN_DIRECTIONS[scenario["origin"]]
    projection = north * north_direction + east * east_direction
    direction_extent = abs(north_direction) + abs(east_direction)
    distance = max(0.0, min(1.0, (1 - projection / direction_extent) / 2))

    severity = scenario["severity"]
    exposure = severity / 5 * (1 - 0.75 * distance)
    crossing_minutes = 60 / severity
    if scenario["disaster_type"] == "flood":
        elevation_fraction = max(0.0, min(1.0, (building["elevation_m"] - 85) / 55))
        exposure *= 1 - 0.75 * elevation_fraction
        crossing_minutes = 90 / severity

    return {"exposure": exposure, "eta_minutes": distance * crossing_minutes}
