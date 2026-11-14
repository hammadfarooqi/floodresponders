"""Combine demo hazard estimates with a building's evacuation difficulty."""

from typing import TypedDict


class Egress(TypedDict):
    stairwells: int
    exits: int
    fire_escapes: int
    ladder_windows: int


class BuildingForRisk(TypedDict):
    id: str
    property_type: str
    floors: int
    elevators: int
    tenants: int
    egress: Egress


class RiskScore(TypedDict):
    building_id: str
    exposure: float
    evac_difficulty: float
    eta_minutes: float
    score: float


def evacuation_difficulty(building: BuildingForRisk) -> float:
    """Blend normalized occupancy, vertical access, and egress penalties."""
    senior_housing = float(building["property_type"] == "senior_housing")
    floors_above_ground = max(0, building["floors"] - 1)
    floor_penalty = min(1.0, floors_above_ground / 9)
    elevator_penalty = floor_penalty / (1 + building["elevators"])
    tenant_penalty = min(1.0, building["tenants"] / 200)

    egress = building["egress"]
    routes = egress["stairwells"] + egress["exits"] + egress["fire_escapes"]
    egress_penalty = 1 / (1 + routes + egress["ladder_windows"] / 4)

    return (
        0.30 * senior_housing
        + 0.20 * floor_penalty
        + 0.15 * elevator_penalty
        + 0.15 * tenant_penalty
        + 0.20 * egress_penalty
    )


def score_building(
    building: BuildingForRisk, exposure: float, eta_minutes: float
) -> RiskScore:
    """Return the demo risk score for exposure in [0, 1] and nonnegative ETA."""
    difficulty = evacuation_difficulty(building)
    urgency = 1 / (1 + eta_minutes / 15)
    return {
        "building_id": building["id"],
        "exposure": exposure,
        "evac_difficulty": difficulty,
        "eta_minutes": eta_minutes,
        "score": exposure * difficulty * urgency,
    }
